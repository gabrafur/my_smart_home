#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const DEFAULT_CONFIG = Object.freeze({
  actionAvailableKiB: 1536 * 1024,
  actionAvailablePercent: 20,
  minimumAgeSeconds: 30 * 60,
  minimumTreeRssKiB: 256 * 1024,
  observationSeconds: 45,
  maximumIdleCpuTicksPerSecond: 0.5,
  cooldownSeconds: 15 * 60,
  terminateGraceMs: 2000,
});

const ESSENTIAL_PATTERN = /(?:^|\s|\/)(?:systemd|sshd|dockerd|containerd|tailscaled|node-red|homeassistant|mosquitto|zigbee2mqtt|matter-server)(?:\s|$)/i;
const EXTENSION_HOST_PROCESS_PATTERN = /(?:^|\s)\S*bootstrap-fork(?:\s|$)/;
const EXTENSION_HOST_TYPE_PATTERN = /(?:^|\s)--type=extensionHost(?:\s|$)/;

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

export function parseMeminfo(text) {
  const values = new Map();
  for (const line of String(text ?? "").split("\n")) {
    const match = line.match(/^([A-Za-z_()]+):\s+(\d+)\s+kB$/);
    if (match) values.set(match[1], Number(match[2]));
  }
  const totalKiB = values.get("MemTotal");
  const availableKiB = values.get("MemAvailable");
  if (!Number.isFinite(totalKiB) || !Number.isFinite(availableKiB) || totalKiB <= 0) {
    throw new Error("meminfo_missing_required_fields");
  }
  return { totalKiB, availableKiB };
}

export function parseProcStat(text) {
  const value = String(text ?? "").trim();
  const close = value.lastIndexOf(") ");
  if (close < 0) throw new Error("invalid_proc_stat");
  const pid = Number(value.slice(0, value.indexOf(" ")));
  const fields = value.slice(close + 2).split(/\s+/);
  const ppid = Number(fields[1]);
  const userTicks = Number(fields[11]);
  const systemTicks = Number(fields[12]);
  const startTicks = Number(fields[19]);
  if (![pid, ppid, userTicks, systemTicks, startTicks].every(Number.isFinite)) {
    throw new Error("invalid_proc_stat_fields");
  }
  return { pid, ppid, cpuTicks: userTicks + systemTicks, startTicks };
}

function parseStatus(text) {
  const uid = Number(String(text ?? "").match(/^Uid:\s+(\d+)/m)?.[1]);
  const rssKiB = Number(String(text ?? "").match(/^VmRSS:\s+(\d+)\s+kB$/m)?.[1] ?? 0);
  if (!Number.isFinite(uid)) throw new Error("invalid_proc_status");
  return { uid, rssKiB: Number.isFinite(rssKiB) ? rssKiB : 0 };
}

function parseEnvironment(text) {
  const values = new Map();
  for (const entry of String(text ?? "").split("\0")) {
    const separator = entry.indexOf("=");
    if (separator > 0) values.set(entry.slice(0, separator), entry.slice(separator + 1));
  }
  return values;
}

export function parseSshConnection(value) {
  const fields = String(value ?? "").trim().split(/\s+/);
  if (fields.length !== 4 || !/^\d+$/.test(fields[1]) || !/^\d+$/.test(fields[3])) return null;
  return {
    clientAddress: fields[0],
    clientPort: Number(fields[1]),
    serverAddress: fields[2],
    serverPort: Number(fields[3]),
  };
}

function endpointVariants(address, port) {
  return [`${address}:${port}`, `[${address}]:${port}`];
}

export function sshConnectionState(connection, ssOutput) {
  if (!connection || typeof ssOutput !== "string") return "unknown";
  const clients = endpointVariants(connection.clientAddress, connection.clientPort);
  const servers = endpointVariants(connection.serverAddress, connection.serverPort);
  const connected = ssOutput.split("\n").some((line) => {
    const fields = line.trim().split(/\s+/);
    return clients.some((endpoint) => fields.includes(endpoint)) &&
      servers.some((endpoint) => fields.includes(endpoint));
  });
  return connected ? "connected" : "disconnected";
}

export function isVscodeExtensionHost(processRecord) {
  const command = processRecord?.cmdline ?? "";
  return processRecord?.uid >= 0 &&
    command.includes("/.vscode-server/") &&
    EXTENSION_HOST_PROCESS_PATTERN.test(command) &&
    EXTENSION_HOST_TYPE_PATTERN.test(command);
}

function getClockTicks() {
  const result = spawnSync("/usr/bin/getconf", ["CLK_TCK"], { encoding: "utf8", timeout: 2000 });
  const ticks = Number(result.stdout?.trim());
  return result.status === 0 && Number.isFinite(ticks) && ticks > 0 ? ticks : 100;
}

function getEstablishedConnections() {
  const result = spawnSync("/usr/bin/ss", ["-Htn", "state", "established"], {
    encoding: "utf8",
    timeout: 3000,
  });
  return result.status === 0 ? result.stdout : null;
}

function readProcess(procRoot, pid, uptimeSeconds, clockTicks, ssOutput) {
  const base = path.join(procRoot, String(pid));
  const statText = readText(path.join(base, "stat"));
  const statusText = readText(path.join(base, "status"));
  const cmdlineText = readText(path.join(base, "cmdline"));
  if (statText == null || statusText == null || cmdlineText == null) return null;
  try {
    const stat = parseProcStat(statText);
    const status = parseStatus(statusText);
    const cmdline = cmdlineText.split("\0").filter(Boolean).join(" ");
    const environment = parseEnvironment(readText(path.join(base, "environ")));
    const sshConnection = parseSshConnection(environment.get("SSH_CONNECTION"));
    return {
      ...stat,
      ...status,
      cmdline,
      ageSeconds: Math.max(0, uptimeSeconds - stat.startTicks / clockTicks),
      sshConnection,
      connectionState: sshConnectionState(sshConnection, ssOutput),
    };
  } catch {
    return null;
  }
}

export function collectSnapshot({ procRoot = "/proc", nowMs = Date.now() } = {}) {
  const meminfo = parseMeminfo(fs.readFileSync(path.join(procRoot, "meminfo"), "utf8"));
  const uptimeSeconds = Number(fs.readFileSync(path.join(procRoot, "uptime"), "utf8").split(/\s+/)[0]);
  if (!Number.isFinite(uptimeSeconds)) throw new Error("invalid_uptime");
  const clockTicks = getClockTicks();
  const ssOutput = getEstablishedConnections();
  const processes = [];
  for (const entry of fs.readdirSync(procRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    const record = readProcess(procRoot, Number(entry.name), uptimeSeconds, clockTicks, ssOutput);
    if (record) processes.push(record);
  }
  return {
    ...meminfo,
    nowMs,
    selfUid: typeof process.getuid === "function" ? process.getuid() : -1,
    clockTicks,
    processes,
  };
}

function processTree(root, processes) {
  const children = new Map();
  for (const item of processes) {
    if (!children.has(item.ppid)) children.set(item.ppid, []);
    children.get(item.ppid).push(item);
  }
  const records = [];
  const queue = [{ item: root, depth: 0 }];
  const seen = new Set();
  while (queue.length > 0) {
    const current = queue.shift();
    if (seen.has(current.item.pid)) continue;
    seen.add(current.item.pid);
    records.push({ ...current.item, depth: current.depth });
    for (const child of children.get(current.item.pid) ?? []) {
      queue.push({ item: child, depth: current.depth + 1 });
    }
  }
  return records;
}

function pressure(snapshot, config) {
  const availablePercent = (snapshot.availableKiB / snapshot.totalKiB) * 100;
  return {
    availablePercent,
    active:
      snapshot.availableKiB < config.actionAvailableKiB &&
      availablePercent < config.actionAvailablePercent,
  };
}

function candidateKey(candidate) {
  return `${candidate.pid}:${candidate.startTicks}`;
}

function safeTree(candidate, snapshot, config) {
  const tree = processTree(candidate, snapshot.processes);
  const rssKiB = tree.reduce((sum, item) => sum + item.rssKiB, 0);
  const cpuTicks = tree.reduce((sum, item) => sum + item.cpuTicks, 0);
  const safeUid = tree.every((item) => item.uid === snapshot.selfUid);
  const essential = tree.some((item) => ESSENTIAL_PATTERN.test(item.cmdline));
  return {
    tree,
    rssKiB,
    cpuTicks,
    safe: safeUid && !essential && rssKiB >= config.minimumTreeRssKiB,
  };
}

export function evaluateSnapshot(snapshot, previousState = {}, overrides = {}) {
  const config = { ...DEFAULT_CONFIG, ...overrides };
  const memory = pressure(snapshot, config);
  const base = {
    version: 1,
    checkedAt: snapshot.nowMs,
    availableKiB: snapshot.availableKiB,
    availablePercent: memory.availablePercent,
    observations: {},
    lastActionAt: Number(previousState.lastActionAt ?? 0),
  };
  const hosts = snapshot.processes
    .filter((item) => item.uid === snapshot.selfUid && isVscodeExtensionHost(item))
    .sort((left, right) => left.startTicks - right.startTicks);
  const connectedHosts = hosts.filter((item) => item.connectionState === "connected");
  const newestConnected = connectedHosts.at(-1);
  const candidates = hosts
    .filter((item) =>
      item.connectionState === "disconnected" &&
      item.ageSeconds >= config.minimumAgeSeconds &&
      (!newestConnected || item.startTicks < newestConnected.startTicks),
    )
    .map((item) => ({ item, details: safeTree(item, snapshot, config) }))
    .filter(({ details }) => details.safe)
    .sort((left, right) => left.item.startTicks - right.item.startTicks);
  if (candidates.length === 0) {
    if (!memory.active) {
      return { state: base, decision: { status: "healthy", action: "none" } };
    }
    if (hosts.length < 2 || connectedHosts.length === 0) {
      return { state: base, decision: { status: "pressure_no_safe_duplicate", action: "none" } };
    }
    return { state: base, decision: { status: "pressure_no_safe_candidate", action: "none" } };
  }

  const selected = candidates[0];
  const key = candidateKey(selected.item);
  const prior = previousState.observations?.[key];
  base.observations[key] = {
    firstSeenAt: Number(prior?.firstSeenAt ?? snapshot.nowMs),
    lastSeenAt: snapshot.nowMs,
    cpuTicks: selected.details.cpuTicks,
  };
  const elapsedSeconds = prior ? (snapshot.nowMs - Number(prior.lastSeenAt ?? prior.firstSeenAt)) / 1000 : 0;
  const observedSeconds = prior ? (snapshot.nowMs - Number(prior.firstSeenAt)) / 1000 : 0;
  const cpuDelta = prior ? Math.max(0, selected.details.cpuTicks - Number(prior.cpuTicks ?? 0)) : 0;
  const idle = prior && elapsedSeconds > 0 && cpuDelta <= config.maximumIdleCpuTicksPerSecond * elapsedSeconds;

  const candidate = {
    pid: selected.item.pid,
    startTicks: selected.item.startTicks,
    rssKiB: selected.details.rssKiB,
    tree: selected.details.tree.map(({ pid, startTicks, uid, depth, cmdline }) => ({
      pid,
      startTicks,
      uid,
      depth,
      essential: ESSENTIAL_PATTERN.test(cmdline),
    })),
  };
  if (!prior || observedSeconds < config.observationSeconds || !idle) {
    if (prior && !idle) base.observations[key].firstSeenAt = snapshot.nowMs;
    return {
      state: base,
      decision: { status: idle || !prior ? "candidate_observed" : "candidate_active", action: "none", candidate },
    };
  }
  if (snapshot.nowMs - base.lastActionAt < config.cooldownSeconds * 1000) {
    return { state: base, decision: { status: "pressure_cooldown", action: "none", candidate } };
  }
  return { state: base, decision: { status: "terminate", action: "terminate", candidate } };
}

function loadState(stateFile) {
  try {
    const value = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

function saveState(stateFile, state) {
  fs.mkdirSync(path.dirname(stateFile), { recursive: true, mode: 0o770 });
  const temporary = `${stateFile}.${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, stateFile);
}

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function sameProcess(procRoot, expected) {
  const stat = readText(path.join(procRoot, String(expected.pid), "stat"));
  const status = readText(path.join(procRoot, String(expected.pid), "status"));
  if (stat == null || status == null) return false;
  try {
    return parseProcStat(stat).startTicks === expected.startTicks && parseStatus(status).uid === expected.uid;
  } catch {
    return false;
  }
}

export function terminateCandidate(candidate, {
  procRoot = "/proc",
  signal = process.kill,
  graceMs = DEFAULT_CONFIG.terminateGraceMs,
} = {}) {
  const ordered = [...candidate.tree].sort((left, right) => right.depth - left.depth);
  if (ordered.some((item) => item.essential)) throw new Error("essential_descendant_detected");
  const signaled = [];
  for (const item of ordered) {
    if (item.pid === process.pid || !sameProcess(procRoot, item)) continue;
    try {
      signal(item.pid, "SIGTERM");
      signaled.push(item);
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  }
  if (graceMs > 0) sleep(graceMs);
  for (const item of signaled) {
    if (!sameProcess(procRoot, item)) continue;
    try {
      signal(item.pid, "SIGKILL");
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  }
  return signaled.length;
}

function scenarioSnapshot(name, nowMs) {
  const base = {
    totalKiB: 8 * 1024 * 1024,
    availableKiB: name === "healthy" ? 4 * 1024 * 1024 : 1024 * 1024,
    nowMs,
    selfUid: 1001,
    clockTicks: 100,
    processes: [],
  };
  const host = (pid, startTicks, connectionState, rssKiB, cpuTicks) => ({
    pid,
    ppid: 1,
    uid: 1001,
    startTicks,
    cpuTicks,
    rssKiB,
    ageSeconds: 7200,
    connectionState,
    cmdline: "/home/user/.vscode-server/server/node bootstrap-fork --type=extensionHost --transformURIs",
  });
  if (name === "pressure_single") base.processes.push(host(200, 20_000, "connected", 600_000, 100));
  if (name === "pressure_duplicate") {
    base.processes.push(host(100, 10_000, "disconnected", 600_000, 100));
    base.processes.push(host(200, 20_000, "connected", 600_000, 100));
  }
  return base;
}

function formatResult(decision, snapshot, terminated = 0) {
  const fields = [
    "memory-guardian",
    `status=${decision.status}`,
    `available_mib=${Math.round(snapshot.availableKiB / 1024)}`,
    `available_percent=${((snapshot.availableKiB / snapshot.totalKiB) * 100).toFixed(1)}`,
    `candidate_pid=${decision.candidate?.pid ?? "none"}`,
    `candidate_mib=${Math.round((decision.candidate?.rssKiB ?? 0) / 1024)}`,
    `terminated=${terminated}`,
  ];
  return fields.join(" ");
}

function parseArgs(argv) {
  const options = { dryRun: false, scenario: null, stateFile: null, procRoot: "/proc" };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--dry-run") options.dryRun = true;
    else if (["--scenario", "--state-file", "--proc-root"].includes(argument)) {
      const value = argv[index + 1];
      if (!value) throw new Error(`missing_value_for_${argument.slice(2)}`);
      options[argument === "--scenario" ? "scenario" : argument === "--state-file" ? "stateFile" : "procRoot"] = value;
      index += 1;
    } else throw new Error(`unknown_argument_${argument}`);
  }
  if (options.scenario && !options.dryRun) throw new Error("scenario_requires_dry_run");
  return options;
}

export function runGuardian({ snapshot, previousState, dryRun = false, config = {}, terminate = terminateCandidate }) {
  const evaluated = evaluateSnapshot(snapshot, previousState, config);
  let { decision, state } = evaluated;
  let terminated = 0;
  if (decision.action === "terminate") {
    if (dryRun) {
      decision = { ...decision, status: "would_terminate", action: "none" };
    } else {
      terminated = terminate(decision.candidate);
      state = { ...state, observations: {}, lastActionAt: snapshot.nowMs };
      decision = { ...decision, status: "terminated" };
    }
  }
  return { decision, state, terminated };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.dirname(here);
  const stateFile = options.stateFile ?? path.join(repoRoot, ".local-state", "host-memory-guardian", "state.json");
  const previousState = loadState(stateFile);
  const nowMs = Date.now();
  const snapshot = options.scenario
    ? scenarioSnapshot(options.scenario, nowMs)
    : collectSnapshot({ procRoot: options.procRoot, nowMs });
  const result = runGuardian({
    snapshot,
    previousState,
    dryRun: options.dryRun,
    terminate: (candidate) => {
      const fresh = collectSnapshot({ procRoot: options.procRoot, nowMs: Date.now() });
      const revalidated = evaluateSnapshot(fresh, previousState);
      if (
        revalidated.decision.action !== "terminate" ||
        revalidated.decision.candidate?.pid !== candidate.pid ||
        revalidated.decision.candidate?.startTicks !== candidate.startTicks
      ) throw new Error("candidate_revalidation_failed");
      return terminateCandidate(revalidated.decision.candidate, { procRoot: options.procRoot });
    },
  });
  saveState(stateFile, result.state);
  console.log(formatResult(result.decision, snapshot, result.terminated));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`memory-guardian status=failed reason=${String(error?.message ?? error).replace(/[^A-Za-z0-9_.:-]+/g, "_").slice(0, 120)}`);
    process.exitCode = 1;
  });
}
