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
  temporaryMinimumAgeSeconds: 2 * 60 * 60,
  temporaryCleanupAvailablePercent: 60,
  temporaryCleanupMinimumKiB: 256 * 1024,
  maximumTemporaryReclaimKiB: 768 * 1024,
  maximumTemporaryDirectories: 1000,
  maximumTemporaryEntriesPerDirectory: 100_000,
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

export function loadTemporaryPrefixes(filePath) {
  const prefixes = String(fs.readFileSync(filePath, "utf8"))
    .split("\n")
    .map((line) => line.replace(/#.*$/, "").trim())
    .filter(Boolean);
  if (prefixes.length === 0) throw new Error("temporary_prefix_file_empty");
  if (prefixes.some((prefix) => !/^[A-Za-z0-9][A-Za-z0-9._-]*[-.]$/.test(prefix))) {
    throw new Error("temporary_prefix_invalid");
  }
  return [...new Set(prefixes)];
}

function pathWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

export function readProcessEntries(
  procRoot,
  {
    attempts = 3,
    retryDelayMs = 25,
    readDirectory = fs.readdirSync,
    wait = (delayMs) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs),
  } = {},
) {
  const retryableCodes = new Set(["EAGAIN", "EBUSY", "EINTR", "EMFILE", "ENFILE"]);
  const boundedAttempts = Math.max(1, Math.min(3, Number(attempts) || 1));
  for (let attempt = 1; attempt <= boundedAttempts; attempt += 1) {
    try {
      return readDirectory(procRoot);
    } catch (error) {
      if (attempt === boundedAttempts || !retryableCodes.has(error?.code)) {
        throw new Error("temporary_process_scan_unavailable_" + String(error?.code ?? "unknown").replace(/[^A-Za-z0-9_]/g, "_"), { cause: error });
      }
      wait(Math.max(0, Number(retryDelayMs) || 0) * attempt);
    }
  }
  throw new Error("temporary_process_scan_unavailable");
}

function activeTemporaryRoots({ procRoot, temporaryRoot, ownerUid }) {
  const active = new Set();
  const mark = (target) => {
    const normalized = String(target ?? "").replace(/ \(deleted\)$/, "");
    if (!pathWithin(temporaryRoot, normalized)) return;
    const [name] = path.relative(temporaryRoot, normalized).split(path.sep);
    if (name) active.add(path.join(temporaryRoot, name));
  };
  const processes = readProcessEntries(procRoot);
  for (const processEntry of processes) {
    if (!/^\d+$/.test(processEntry)) continue;
    const processRoot = path.join(procRoot, processEntry);
    const processUid = Number(readText(path.join(processRoot, "status"))?.match(/^Uid:\s+(\d+)/m)?.[1]);
    if (!Number.isFinite(processUid) || processUid !== ownerUid) continue;
    for (const linkName of ["cwd", "root"]) {
      try { mark(fs.readlinkSync(path.join(processRoot, linkName))); } catch { /* process changed */ }
    }
    for (const argument of String(readText(path.join(processRoot, "cmdline")) ?? "").split("\0")) mark(argument);
    let descriptors = [];
    try { descriptors = fs.readdirSync(path.join(processRoot, "fd")); } catch { /* inaccessible process */ }
    for (const descriptor of descriptors) {
      try { mark(fs.readlinkSync(path.join(processRoot, "fd", descriptor))); } catch { /* descriptor changed */ }
    }
  }
  return active;
}

function temporaryTreeMetrics(root, ownerUid, maximumEntries) {
  const rootStat = fs.lstatSync(root);
  const device = rootStat.dev;
  const pending = [root];
  let entries = 0;
  let allocatedBytes = 0;
  let newestMtimeMs = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    const stat = fs.lstatSync(current);
    entries += 1;
    if (entries > maximumEntries || stat.uid !== ownerUid || stat.dev !== device) {
      return { safe: false, entries, allocatedBytes, newestMtimeMs };
    }
    allocatedBytes += Number(stat.blocks ?? 0) * 512;
    newestMtimeMs = Math.max(newestMtimeMs, stat.mtimeMs);
    if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
    for (const name of fs.readdirSync(current)) pending.push(path.join(current, name));
  }
  return { safe: true, entries, allocatedBytes, newestMtimeMs, device, inode: rootStat.ino };
}

export function reclaimTemporaryArtifacts({
  snapshot,
  temporaryRoot = os.tmpdir(),
  prefixFile,
  procRoot = "/proc",
  nowMs = Date.now(),
  dryRun = false,
  config: overrides = {},
} = {}) {
  const config = { ...DEFAULT_CONFIG, ...overrides };
  const root = fs.realpathSync(temporaryRoot);
  const prefixes = loadTemporaryPrefixes(prefixFile);
  const ownerUid = snapshot.selfUid;
  const active = activeTemporaryRoots({ procRoot, temporaryRoot: root, ownerUid });
  const cutoff = nowMs - config.temporaryMinimumAgeSeconds * 1000;
  const candidates = [];
  for (const name of fs.readdirSync(root)) {
    if (!prefixes.some((prefix) => name.startsWith(prefix))) continue;
    const candidatePath = path.join(root, name);
    let stat;
    try { stat = fs.lstatSync(candidatePath); } catch { continue; }
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== ownerUid || active.has(candidatePath)) continue;
    let real;
    let metrics;
    try {
      real = fs.realpathSync(candidatePath);
      if (!pathWithin(root, real) || path.dirname(real) !== root) continue;
      metrics = temporaryTreeMetrics(real, ownerUid, config.maximumTemporaryEntriesPerDirectory);
    } catch {
      continue;
    }
    if (!metrics.safe || metrics.newestMtimeMs > cutoff) continue;
    candidates.push({ name, path: real, ...metrics });
  }
  candidates.sort((left, right) => left.newestMtimeMs - right.newestMtimeMs || left.name.localeCompare(right.name));
  const eligibleBytes = candidates.reduce((sum, item) => sum + item.allocatedBytes, 0);
  const availablePercent = (snapshot.availableKiB / snapshot.totalKiB) * 100;
  const shouldReclaim = availablePercent < config.temporaryCleanupAvailablePercent ||
    eligibleBytes >= config.temporaryCleanupMinimumKiB * 1024;
  const result = {
    eligibleCount: candidates.length,
    eligibleBytes,
    selectedCount: 0,
    selectedBytes: 0,
    removedCount: 0,
    reclaimedBytes: 0,
    errors: 0,
    triggered: shouldReclaim,
  };
  if (!shouldReclaim) return result;

  const maximumBytes = config.maximumTemporaryReclaimKiB * 1024;
  const selected = [];
  for (const candidate of candidates) {
    if (selected.length >= config.maximumTemporaryDirectories) break;
    if (candidate.allocatedBytes > maximumBytes - result.selectedBytes) continue;
    selected.push(candidate);
    result.selectedCount += 1;
    result.selectedBytes += candidate.allocatedBytes;
  }
  if (dryRun) return result;

  let currentActive = activeTemporaryRoots({ procRoot, temporaryRoot: root, ownerUid });
  for (const [index, candidate] of selected.entries()) {
    if (currentActive.has(candidate.path)) continue;
    const quarantine = path.join(root, `host-memory-guardian-delete-${process.pid}-${index}`);
    try {
      const fresh = fs.lstatSync(candidate.path);
      if (!fresh.isDirectory() || fresh.isSymbolicLink() || fresh.uid !== ownerUid ||
          fresh.dev !== candidate.device || fresh.ino !== candidate.inode) continue;
      fs.renameSync(candidate.path, quarantine);
      fs.rmSync(quarantine, { recursive: true, force: false });
      result.removedCount += 1;
      result.reclaimedBytes += candidate.allocatedBytes;
    } catch {
      result.errors += 1;
      try {
        if (fs.existsSync(quarantine) && !fs.existsSync(candidate.path)) fs.renameSync(quarantine, candidate.path);
      } catch { /* preserve the error count and leave the quarantine allowlisted */ }
    }
    if ((index + 1) % 100 === 0) currentActive = activeTemporaryRoots({ procRoot, temporaryRoot: root, ownerUid });
  }
  return result;
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
  for (const entry of readProcessEntries(procRoot)) {
    if (!/^\d+$/.test(entry)) continue;
    const record = readProcess(procRoot, Number(entry), uptimeSeconds, clockTicks, ssOutput);
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

function formatResult(decision, snapshot, terminated = 0, temporary = {}) {
  const fields = [
    "memory-guardian",
    `status=${decision.status}`,
    `available_mib=${Math.round(snapshot.availableKiB / 1024)}`,
    `available_percent=${((snapshot.availableKiB / snapshot.totalKiB) * 100).toFixed(1)}`,
    `candidate_pid=${decision.candidate?.pid ?? "none"}`,
    `candidate_mib=${Math.round((decision.candidate?.rssKiB ?? 0) / 1024)}`,
    `terminated=${terminated}`,
    `temp_removed=${Number(temporary.removedCount ?? 0)}`,
    `temp_reclaimed_mib=${Math.round(Number(temporary.reclaimedBytes ?? 0) / 1024 / 1024)}`,
    `cleanup_errors=${Number(temporary.errors ?? 0)}`,
  ];
  return fields.join(" ");
}

function parseArgs(argv) {
  const options = {
    dryRun: false,
    scenario: null,
    stateFile: null,
    procRoot: "/proc",
    temporaryRoot: null,
    temporaryPrefixFile: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--dry-run") options.dryRun = true;
    else if (["--scenario", "--state-file", "--proc-root", "--temporary-root", "--temporary-prefix-file"].includes(argument)) {
      const value = argv[index + 1];
      if (!value) throw new Error(`missing_value_for_${argument.slice(2)}`);
      const key = {
        "--scenario": "scenario",
        "--state-file": "stateFile",
        "--proc-root": "procRoot",
        "--temporary-root": "temporaryRoot",
        "--temporary-prefix-file": "temporaryPrefixFile",
      }[argument];
      options[key] = value;
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
  const temporaryPrefixFile = options.temporaryPrefixFile ?? path.join(here, "temporary-artifact-prefixes.txt");
  const previousState = loadState(stateFile);
  const nowMs = Date.now();
  let snapshot = options.scenario
    ? scenarioSnapshot(options.scenario, nowMs)
    : collectSnapshot({ procRoot: options.procRoot, nowMs });
  const temporary = options.scenario
    ? { eligibleCount: 0, eligibleBytes: 0, selectedCount: 0, selectedBytes: 0, removedCount: 0, reclaimedBytes: 0, errors: 0, triggered: false }
    : reclaimTemporaryArtifacts({
        snapshot,
        temporaryRoot: options.temporaryRoot ?? os.tmpdir(),
        prefixFile: temporaryPrefixFile,
        procRoot: options.procRoot,
        nowMs,
        dryRun: options.dryRun,
      });
  if (temporary.removedCount > 0) snapshot = collectSnapshot({ procRoot: options.procRoot, nowMs: Date.now() });
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
  if (temporary.errors > 0) {
    result.decision = { ...result.decision, status: "cleanup_partial" };
  } else if (temporary.removedCount > 0 && result.decision.status !== "terminated") {
    result.decision = { ...result.decision, status: "reclaimed" };
  } else if (options.dryRun && temporary.selectedCount > 0 && result.decision.status === "healthy") {
    result.decision = { ...result.decision, status: "would_reclaim" };
  }
  saveState(stateFile, result.state);
  console.log(formatResult(result.decision, snapshot, result.terminated, temporary));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`memory-guardian status=failed reason=${String(error?.message ?? error).replace(/[^A-Za-z0-9_.:-]+/g, "_").slice(0, 120)}`);
    process.exitCode = 1;
  });
}
