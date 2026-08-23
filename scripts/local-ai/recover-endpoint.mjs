#!/usr/bin/env node

import dgram from 'node:dgram';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const MAX_ATTEMPTS = 2;
const DEFAULT_BOOT_WAIT_MS = 20_000;
const DEFAULT_ENDPOINT_WAIT_MS = 12_000;

function readJson(filename, fallback = {}) {
  try {
    const value = JSON.parse(fs.readFileSync(filename, 'utf8'));
    return value && typeof value === 'object' ? value : fallback;
  } catch {
    return fallback;
  }
}

export function userConfig() {
  const candidates = [];
  if (process.env.LOCAL_AI_CONFIG) candidates.push(process.env.LOCAL_AI_CONFIG);
  candidates.push(path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'codex', 'local-ai.json'));
  for (const filename of candidates) {
    const config = readJson(filename, null);
    if (config) return config;
  }
  return {};
}

function privateIpv4(value) {
  const pieces = String(value || '').split('.').map(Number);
  if (pieces.length !== 4 || pieces.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return pieces[0] === 10
    || (pieces[0] === 172 && pieces[1] >= 16 && pieces[1] <= 31)
    || (pieces[0] === 192 && pieces[1] === 168);
}

export function recoverySettings(config) {
  const recovery = config?.recovery;
  const probe = config?.gpu_probe;
  let endpoint;
  try { endpoint = new URL(process.env.LOCAL_AI_ENDPOINT || config?.endpoint); } catch { return null; }
  if (recovery?.enabled !== true || !privateIpv4(endpoint.hostname)) return null;
  if (endpoint.protocol !== 'http:' || Number(endpoint.port || 80) !== 11435) return null;
  if (!probe?.container || !probe?.ssh_user || !probe?.ssh_host || !probe?.ssh_key_path) return null;
  if (String(probe.ssh_host) !== endpoint.hostname) return null;
  const wake = recovery.wake_on_lan;
  if (!wake?.mac || !privateIpv4(wake?.broadcast)) return null;
  return {
    endpoint,
    probe,
    wake,
    attempts: MAX_ATTEMPTS,
    bootWaitMs: Math.max(1_000, Math.min(Number(recovery.boot_wait_seconds || 20) * 1_000, 30_000)),
    endpointWaitMs: Math.max(2_000, Math.min(Number(recovery.endpoint_wait_seconds || 12) * 1_000, 20_000)),
  };
}

export function magicPacket(mac) {
  const normalized = String(mac || '').replace(/[^0-9a-f]/gi, '').toLowerCase();
  if (!/^[0-9a-f]{12}$/.test(normalized)) throw new Error('invalid_wol_mac');
  const address = Buffer.from(normalized, 'hex');
  const packet = Buffer.alloc(6 + 16 * address.length, 0xff);
  for (let offset = 6; offset < packet.length; offset += address.length) address.copy(packet, offset);
  return packet;
}

export function repairPowerShell(settings) {
  const listenAddress = settings.endpoint.hostname;
  const listenPort = Number(settings.endpoint.port);
  const script = `$ErrorActionPreference='Stop';$target='${listenAddress}';$listenPort=${listenPort};`
    + "$ips=@(Get-NetIPAddress -AddressFamily IPv4 | Select-Object -ExpandProperty IPAddress);if($ips -notcontains $target){throw 'target_ip_missing'};"
    + "& wsl.exe -u root -e systemctl start ollama;if($LASTEXITCODE -ne 0){throw 'ollama_start_failed'};"
    + "$listener=Get-NetTCPConnection -State Listen -LocalPort $listenPort -ErrorAction SilentlyContinue | Where-Object {$_.LocalAddress -eq $target};"
    + "if(-not $listener){& netsh interface portproxy delete v4tov4 listenport=$listenPort listenaddress=$target | Out-Null;"
    + "& netsh interface portproxy add v4tov4 listenport=$listenPort listenaddress=$target connectport=11434 connectaddress=127.0.0.1 | Out-Null;"
    + "if($LASTEXITCODE -ne 0){throw 'portproxy_add_failed'};"
    + "$name='CodexLocalAiPortproxyRepair';Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue;"
    + "$a=New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoProfile -NonInteractive -Command \"Start-Sleep -Seconds 2; Restart-Service iphlpsvc -Force; Start-Sleep -Seconds 3\"';"
    + "$p=New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest;"
    + "$s=New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 1);"
    + "Register-ScheduledTask -TaskName $name -Action $a -Principal $p -Settings $s | Out-Null;Start-ScheduledTask -TaskName $name};'RECOVERY_TRIGGERED'";
  return Buffer.from(`[Console]::OutputEncoding=[Text.Encoding]::UTF8;${script}`, 'utf16le').toString('base64');
}

function strictSshArgs(settings, remoteCommand) {
  const { probe } = settings;
  const knownHosts = probe.ssh_known_hosts_path
    || path.posix.join(path.posix.dirname(String(probe.ssh_key_path)), 'known_hosts');
  return [
    'exec', String(probe.container), 'ssh', '-i', String(probe.ssh_key_path), '-p', String(probe.ssh_port || 22),
    '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5',
    '-o', `UserKnownHostsFile=${knownHosts}`, '-o', 'StrictHostKeyChecking=yes',
    `${probe.ssh_user}@${probe.ssh_host}`, remoteCommand,
  ];
}

export function sshCommand(settings) {
  return ['docker', strictSshArgs(
    settings,
    `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${repairPowerShell(settings)}`,
  )];
}

export function cleanupSshCommand(settings) {
  const script = "Unregister-ScheduledTask -TaskName 'CodexLocalAiPortproxyRepair' -Confirm:$false -ErrorAction SilentlyContinue";
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return ['docker', strictSshArgs(
    settings,
    `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${encoded}`,
  )];
}

function sendWakePacket(wake) {
  const packet = magicPacket(wake.mac);
  const port = Number(wake.port || 9);
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    const finish = (ok) => { try { socket.close(); } catch {} resolve(ok); };
    socket.once('error', () => finish(false));
    socket.bind(() => {
      try { socket.setBroadcast(true); } catch { finish(false); return; }
      socket.send(packet, port, String(wake.broadcast), (error) => finish(!error));
    });
  });
}

function requestEndpoint(endpoint, timeout = 2_500) {
  return new Promise((resolve) => {
    const target = new URL('/api/tags', endpoint);
    const client = target.protocol === 'https:' ? https : http;
    const request = client.get(target, { timeout }, (response) => {
      response.resume();
      resolve(response.statusCode === 200);
    });
    request.on('timeout', () => request.destroy());
    request.on('error', () => resolve(false));
  });
}

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitForEndpoint(settings, dependencies) {
  const started = Date.now();
  while (Date.now() - started < settings.endpointWaitMs) {
    if (await dependencies.requestEndpoint(settings.endpoint)) return true;
    await dependencies.wait(1_000);
  }
  return false;
}

export async function recoverEndpoint(config, overrides = {}) {
  const settings = recoverySettings(config);
  if (!settings) return { recovery_attempted: false, recovery_succeeded: false, recovery_attempts: 0, reason: 'recovery_unconfigured' };
  const dependencies = {
    sendWakePacket,
    requestEndpoint,
    wait,
    runSsh: (command, args) => spawnSync(command, args, { encoding: 'utf8', timeout: 15_000, windowsHide: true }),
    cleanupSsh: (command, args) => spawnSync(command, args, { encoding: 'utf8', timeout: 10_000, windowsHide: true }),
    ...overrides,
  };
  for (let attempt = 1; attempt <= settings.attempts; attempt += 1) {
    await dependencies.sendWakePacket(settings.wake);
    if (attempt > 1) await dependencies.wait(settings.bootWaitMs);
    const [command, args] = sshCommand(settings);
    // Restarting IP Helper can close this SSH connection with exit 255. The
    // endpoint probe below is authoritative, not the transport exit code.
    try { dependencies.runSsh(command, args); } catch {}
    const endpointReady = dependencies.waitForEndpoint
      ? await dependencies.waitForEndpoint(settings, dependencies)
      : await waitForEndpoint(settings, dependencies);
    if (endpointReady) {
      const [cleanupCommand, cleanupArgs] = cleanupSshCommand(settings);
      try { dependencies.cleanupSsh(cleanupCommand, cleanupArgs); } catch {}
      return { recovery_attempted: true, recovery_succeeded: true, recovery_attempts: attempt, reason: 'endpoint_recovered' };
    }
  }
  return { recovery_attempted: true, recovery_succeeded: false, recovery_attempts: settings.attempts, reason: 'endpoint_recovery_failed' };
}

async function main() {
  if (process.env.LOCAL_AI_INVOCATION_SOURCE !== 'mcp') {
    process.stdout.write(`${JSON.stringify({ recovery_attempted: false, recovery_succeeded: false, recovery_attempts: 0, reason: 'mcp_invocation_required' })}\n`);
    return;
  }
  const result = await recoverEndpoint(userConfig());
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    process.stdout.write(`${JSON.stringify({ recovery_attempted: true, recovery_succeeded: false, recovery_attempts: MAX_ATTEMPTS, reason: 'endpoint_recovery_error' })}\n`);
  });
}
