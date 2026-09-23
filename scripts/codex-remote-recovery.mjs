#!/usr/bin/env node

import fs from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const sleep = (milliseconds) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);

function listenerLine(controlSocket, output) {
  // New Codex releases publish an alias to a protected physical Unix socket.
  // ss reports the physical path, never the alias used by clients.
  let physicalSocket = controlSocket;
  try { physicalSocket = fs.realpathSync(controlSocket); } catch { /* absent or legacy socket */ }
  return String(output).split(/\r?\n/).find((line) =>
    line.trim().split(/\s+/).includes(physicalSocket));
}

export function listenerReady(controlSocket, run = spawnSync) {
  const result = run("ss", ["-xl"], { encoding: "utf8", timeout: 5000 });
  return result?.status === 0 && Boolean(listenerLine(controlSocket, result.stdout));
}

export function listenerPids(controlSocket, run = spawnSync) {
  const result = run("ss", ["-xlpn"], { encoding: "utf8", timeout: 5000 });
  if (result?.status !== 0) return [];
  const line = listenerLine(controlSocket, result.stdout);
  if (!line) return [];
  return [...line.matchAll(/pid=(\d+)/g)].map((match) => Number(match[1]));
}

function processIsCodexAppServer(pid, readFile = fs.readFileSync) {
  try {
    const args = readFile(`/proc/${pid}/cmdline`).toString().split("\0").filter(Boolean);
    const listenIndex = args.indexOf("--listen");
    return args.includes("app-server") && listenIndex >= 0 && args[listenIndex + 1]?.startsWith("unix://");
  } catch {
    return false;
  }
}

function startCodexRemote({ codexBin, controlSocket, run, launch, wait }) {
  // Codex owns stale socket/alias reconciliation; never unlink a live alias.
  const child = launch(codexBin, ["-c", "features.code_mode_host=true", "app-server", "--listen", `unix://${controlSocket}`], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (listenerReady(controlSocket, run)) return { status: "recovered", action: "start", reason: "app_server_started" };
    wait(250);
  }
  return { status: "failed", action: "start", reason: "startup_timeout" };
}

export function recoverCodexRemote({
  codexBin = process.env.CODEX_REMOTE_CODEX_BIN || "/home/gabriel/.local/bin/codex",
  controlSocket = process.env.CODEX_REMOTE_CONTROL_SOCKET || "/home/gabriel/.codex/app-server-control/app-server-control.sock",
  run = spawnSync,
  launch = spawn,
  wait = sleep,
} = {}) {
  if (listenerReady(controlSocket, run)) return { status: "healthy", action: "none", reason: "app_server_ready" };
  const version = run(codexBin, ["--version"], { encoding: "utf8", timeout: 10_000 });
  if (version?.status !== 0) return { status: "failed", action: "none", reason: "binary_unavailable" };
  return startCodexRemote({ codexBin, controlSocket, run, launch, wait });
}

export function restartCodexRemote({
  codexBin = process.env.CODEX_REMOTE_CODEX_BIN || "/home/gabriel/.local/bin/codex",
  controlSocket = process.env.CODEX_REMOTE_CONTROL_SOCKET || "/home/gabriel/.codex/app-server-control/app-server-control.sock",
  run = spawnSync,
  launch = spawn,
  wait = sleep,
  readFile = fs.readFileSync,
  terminate = process.kill,
} = {}) {
  const version = run(codexBin, ["--version"], { encoding: "utf8", timeout: 10_000 });
  if (version?.status !== 0) return { status: "failed", action: "restart", reason: "binary_unavailable" };

  if (listenerReady(controlSocket, run)) {
    const pids = listenerPids(controlSocket, run);
    if (pids.length !== 1 || !processIsCodexAppServer(pids[0], readFile)) {
      return { status: "failed", action: "restart", reason: "listener_owner_unverified" };
    }
    try {
      terminate(pids[0], "SIGTERM");
    } catch {
      return { status: "failed", action: "restart", reason: "shutdown_failed" };
    }
    for (let attempt = 0; attempt < 40 && listenerReady(controlSocket, run); attempt += 1) wait(250);
    if (listenerReady(controlSocket, run)) {
      return { status: "failed", action: "restart", reason: "shutdown_timeout" };
    }
  }

  const started = startCodexRemote({ codexBin, controlSocket, run, launch, wait });
  if (started.status === "failed") return { ...started, action: "restart" };
  return { status: "recovered", action: "restart", reason: "app_server_restarted" };
}

export function main(argv = process.argv.slice(2)) {
  if (argv.length !== 1 || !new Set(["--recover", "--restart"]).has(argv[0])) {
    throw new Error("Use --recover ou --restart");
  }
  const result = argv[0] === "--restart" ? restartCodexRemote() : recoverCodexRemote();
  process.stdout.write(`codex-remote-recovery status=${result.status} action=${result.action} reason=${result.reason}\n`);
  if (result.status === "failed") process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); } catch (error) { console.error(`codex-remote-recovery status=failed action=none reason=${error.message}`); process.exitCode = 1; }
}
