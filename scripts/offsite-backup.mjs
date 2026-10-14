#!/usr/bin/env node

import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { probeService } from "./container-readiness.mjs";
import { applyRestore, loadManifest, verifyBundle } from "./restore.mjs";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const defaultPolicyFile = path.join(repoRoot, ".local-secrets/offsite-backup-policy.json");
const require = createRequire(import.meta.url);
const WebSocket = require("../nodered/node_modules/ws");
export const COMPOSE_RETENTION_SERIES = "daily-offsite-compose-v1";
export const COMPOSE_BACKUP_NAME_PREFIX = "Daily off-site Compose v1 ";
const retentionStateFile = path.join(repoRoot, ".local-state", "offsite-backup-retention.json");
const composeBackupNamePattern = /^Daily off-site Compose v1 \d{4}-\d{2}-\d{2}$/;

function fail(message) {
  throw new Error(message);
}

function writePrivateJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function currentGitValue(args, fallback) {
  const result = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });
  return result.status === 0 && result.stdout.trim() ? result.stdout.trim() : fallback;
}

function runChecked(command, args, { timeout = 120_000 } = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    timeout,
    maxBuffer: 32 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) fail(`${path.basename(command)} operation failed`);
  return result.stdout.trim();
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function readHomeAssistantBackupCredentials() {
  const script = [
    "import json",
    "c=json.load(open('/config/.storage/backup'))['data']['config']",
    "agents=[a for a,v in c['agents'].items() if a.startswith('onedrive.') and v.get('protected') is True]",
    "assert len(agents)==1",
    "entries=json.load(open('/config/.storage/core.config_entries'))['data']['entries']",
    "matching=[e for e in entries if e.get('domain')=='onedrive' and e.get('disabled_by') is None]",
    "assert len(matching)==1 and matching[0].get('options',{}).get('delete_permanently',False) is False",
    "p=c['create_backup'].get('password')",
    "assert isinstance(p,str) and p",
    "print(json.dumps({'agent_id':agents[0],'password':p}))",
  ].join(";");
  const output = runChecked("docker", ["exec", "homeassistant", "python", "-c", script]);
  try {
    return JSON.parse(output);
  } catch {
    fail("Home Assistant protected backup configuration is invalid");
  }
}

function readHomeAssistantToken() {
  const tokenFile = process.env.OFFSITE_BACKUP_HA_TOKEN_FILE
    || path.join(repoRoot, ".local-secrets/ha-long-lived-token.txt");
  const token = fs.readFileSync(tokenFile, "utf8").trim();
  if (!token) fail("Home Assistant token is unavailable");
  return token;
}

function homeAssistantWebSocketRequest(token, request, timeout = 30_000) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket("ws://127.0.0.1:8123/api/websocket");
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close();
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error("Home Assistant WebSocket timed out")), timeout);
    socket.on("message", (raw) => {
      let message;
      try { message = JSON.parse(raw); } catch { finish(new Error("Home Assistant returned invalid JSON")); return; }
      if (message.type === "auth_required") {
        socket.send(JSON.stringify({ type: "auth", access_token: token }));
      } else if (message.type === "auth_invalid") {
        finish(new Error("Home Assistant authentication failed"));
      } else if (message.type === "auth_ok") {
        socket.send(JSON.stringify({ id: 1, ...request }));
      } else if (message.id === 1 && message.type === "result") {
        if (!message.success) finish(new Error(`Home Assistant backup request failed: ${message.error?.code ?? "unknown"}`));
        else finish(null, message.result);
      }
    });
    socket.on("error", () => finish(new Error("Home Assistant WebSocket is unavailable")));
  });
}

const knownBackupManagerBusyStates = new Set([
  "blocked",
  "create_backup",
  "receive_backup",
  "restore_backup",
]);

function backupManagerTimeoutReason(state) {
  if (state === "blocked") return "Home Assistant startup is still blocked";
  if (state === "create_backup") return "another backup is already active";
  if (state === "receive_backup") return "a backup receive operation is already active";
  if (state === "restore_backup") return "a backup restore operation is already active";
  return "the backup manager did not become idle";
}

export async function waitForBackupManagerIdle({
  token,
  timeoutMs,
  pollIntervalMs = 3000,
  request = homeAssistantWebSocketRequest,
  clock = () => Date.now(),
  wait = delay,
}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1
      || !Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1
      || typeof request !== "function" || typeof clock !== "function" || typeof wait !== "function") {
    fail("Home Assistant backup manager readiness inputs are invalid");
  }
  const deadline = clock() + timeoutMs;
  let lastState = "unknown";
  while (true) {
    const queryBudget = deadline - clock();
    if (queryBudget <= 0) break;
    let info;
    try {
      info = await request(token, { type: "backup/info" }, Math.min(30_000, queryBudget));
    } catch {
      fail("Home Assistant backup manager readiness query failed");
    }
    if (!info || typeof info.state !== "string" || !Array.isArray(info.backups)
        || !info.agent_errors || typeof info.agent_errors !== "object"
        || Array.isArray(info.agent_errors)) {
      fail("Home Assistant backup manager readiness response is invalid");
    }
    if (Object.keys(info.agent_errors).length > 0) {
      fail("Home Assistant backup manager readiness reported agent errors");
    }
    if (info.state === "idle") {
      if (clock() <= deadline) return info;
      break;
    }
    if (!knownBackupManagerBusyStates.has(info.state)) {
      fail("Home Assistant backup manager returned an unsupported state");
    }
    lastState = info.state;
    const remaining = deadline - clock();
    if (remaining <= 0) break;
    await wait(Math.min(pollIntervalMs, remaining));
  }
  fail(`Home Assistant backup manager readiness timed out: ${backupManagerTimeoutReason(lastState)}`);
}

export async function requestBackupGenerationWhenIdle({
  token,
  generationRequest,
  timeoutMs,
  pollIntervalMs = 3000,
  request = homeAssistantWebSocketRequest,
  clock = () => Date.now(),
  wait = delay,
}) {
  if (generationRequest?.type !== "backup/generate") {
    fail("Home Assistant backup generation request is invalid");
  }
  await waitForBackupManagerIdle({
    token,
    timeoutMs,
    pollIntervalMs,
    request,
    clock,
    wait,
  });
  return request(token, generationRequest);
}

function inspectContainer(service) {
  const output = runChecked("docker", ["inspect", service, "--format", "{{json .State}}"]).trim();
  return JSON.parse(output);
}

function tcpReady(host, port, timeout = 3000) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const finish = (value) => { socket.destroy(); resolve(value); };
    socket.setTimeout(timeout, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

async function serviceReady(service) {
  let state;
  try { state = inspectContainer(service); } catch { return false; }
  if (state.Running !== true || state.Restarting === true) return false;
  if (service === "homeassistant") return state.Health?.Status === "healthy";
  if (["nodered", "mosquitto", "zigbee2mqtt"].includes(service)) return probeService(service) === true;
  if (service === "matter_server") return tcpReady("127.0.0.1", 5580);
  if (service === "appdaemon") return tcpReady("127.0.0.1", 5050);
  if (service === "portainer") {
    const address = runChecked("docker", ["inspect", service, "--format", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}"]);
    return Boolean(address) && tcpReady(address, 9000);
  }
  return false;
}

async function waitForServices(services, deadline) {
  while (Date.now() < deadline) {
    let ready = true;
    for (const service of services) {
      if (!await serviceReady(service)) { ready = false; break; }
    }
    if (ready) return;
    await delay(3000);
  }
  fail("service readiness deadline exceeded");
}

function assertSafePrivateOutput(target, root) {
  const resolved = path.resolve(target);
  const tempRoot = path.resolve(os.tmpdir());
  const stagingRoot = path.resolve(root, "homeassistant/backups");
  const relativeTemp = path.relative(tempRoot, resolved);
  const relativeStaging = path.relative(stagingRoot, resolved);
  const inTemp = relativeTemp && !relativeTemp.startsWith("..") && !path.isAbsolute(relativeTemp)
    && /(?:^|\/)(?:offsite-bundle|restore-test|offsite-staging)[^/]*/.test(relativeTemp.split(path.sep).join("/"));
  const inStaging = relativeStaging && !relativeStaging.startsWith("..") && !path.isAbsolute(relativeStaging)
    && relativeStaging.split(path.sep)[0].startsWith("offsite-staging-");
  if (!inTemp && !inStaging) fail("off-site output must use a private temporary or Home Assistant staging directory");
  if (fs.existsSync(resolved)) fail("off-site output already exists");
  return resolved;
}

function secureTree(target) {
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink()) fail("private source contains a symlink");
  if (stat.isFile()) {
    fs.chmodSync(target, 0o600);
    return [target];
  }
  if (!stat.isDirectory()) fail("private source contains an unsupported filesystem object");
  fs.chmodSync(target, 0o700);
  return fs.readdirSync(target, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => secureTree(path.join(target, entry.name)));
}

const containerSnapshotSources = {
  private_bindings: ["homeassistant", "/run/private-bindings/.", "directory"],
  nodered_credentials: ["nodered", "/data/flows_cred.json", "file"],
  nodered_context: ["nodered", "/data/context/.", "directory"],
  mosquitto_credentials: ["mosquitto", "/mosquitto/config/password.txt", "file"],
  mosquitto_persistence: ["mosquitto", "/mosquitto/data/.", "directory"],
  zigbee_configuration: ["zigbee2mqtt", "/app/data/configuration.yaml", "file"],
  zigbee_database: ["zigbee2mqtt", "/app/data/database.db", "file"],
  zigbee_coordinator_backup: ["zigbee2mqtt", "/app/data/coordinator_backup.json", "file"],
  zigbee_runtime_state: ["zigbee2mqtt", "/app/data/state.json", "file"],
  matter_fabric: ["matter_server", "/data/.", "directory"],
  portainer_state: ["portainer", "/data/.", "directory"],
  appdaemon_secrets: ["appdaemon", "/conf/secrets.yaml", "file"],
};

function copyFromStoppedContainer(logicalName, destination) {
  const mapping = containerSnapshotSources[logicalName];
  if (!mapping) fail(`no stopped-container snapshot mapping for ${logicalName}`);
  const [container, source, kind] = mapping;
  const archive = spawnSync("docker", ["cp", `${container}:${source}`, "-"], {
    encoding: null,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (archive.status !== 0 || !archive.stdout?.length) fail(`unable to snapshot stopped container for ${logicalName}`);
  const listing = spawnSync("tar", ["-tf", "-"], { input: archive.stdout, encoding: "utf8" });
  if (listing.status !== 0) fail(`container snapshot archive is invalid for ${logicalName}`);
  for (const entry of listing.stdout.split(/\r?\n/).filter(Boolean)) {
    const normalized = path.posix.normalize(entry.replace(/^\.\//, ""));
    if (!normalized || normalized === ".." || normalized.startsWith("../") || path.posix.isAbsolute(normalized)) {
      fail(`container snapshot archive contains an unsafe path for ${logicalName}`);
    }
  }
  const extractRoot = fs.mkdtempSync(path.join(path.dirname(destination), ".container-copy-"));
  const extracted = spawnSync("tar", ["--no-same-owner", "--no-same-permissions", "-xf", "-", "-C", extractRoot], {
    input: archive.stdout,
    encoding: "utf8",
  });
  if (extracted.status !== 0) fail(`unable to extract stopped container snapshot for ${logicalName}`);
  if (kind === "directory") {
    fs.renameSync(extractRoot, destination);
    return;
  }
  const extractedFiles = secureTree(extractRoot);
  if (extractedFiles.length !== 1) fail(`stopped container file snapshot is ambiguous for ${logicalName}`);
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  fs.copyFileSync(extractedFiles[0], destination, fs.constants.COPYFILE_EXCL);
  fs.rmSync(extractRoot, { recursive: true, force: true });
}

function defaultRunningServices() {
  const result = spawnSync("docker", ["compose", "ps", "--status", "running", "--services"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (result.status !== 0) fail("unable to inspect Compose service state");
  return new Set(result.stdout.split(/\r?\n/).filter(Boolean));
}

function readPolicy(file = defaultPolicyFile) {
  let policy;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()
        || process.platform !== "win32" && path.resolve(file) === defaultPolicyFile && (stat.mode & 0o077) !== 0) {
      fail("off-site backup policy path is unsafe");
    }
    policy = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    fail("off-site backup policy is missing or invalid");
  }
  return policy;
}

function emptyRetentionState() {
  return { schema_version: 1, series: COMPOSE_RETENTION_SERIES, entries: [] };
}

function validateRetentionState(state) {
  if (!state || state.schema_version !== 1 || state.series !== COMPOSE_RETENTION_SERIES
      || !Array.isArray(state.entries)) fail("off-site retention registry is invalid");
  const ids = new Set();
  for (const entry of state.entries) {
    if (entry?.series !== COMPOSE_RETENTION_SERIES
        || typeof entry.backup_id !== "string" || !entry.backup_id
        || typeof entry.name !== "string" || !composeBackupNamePattern.test(entry.name)
        || typeof entry.backup_timestamp !== "string"
        || !Number.isSafeInteger(entry.size_bytes) || entry.size_bytes <= 0
        || entry.protected !== true || ids.has(entry.backup_id)) {
      fail("off-site retention registry entry is invalid");
    }
    ids.add(entry.backup_id);
  }
  return state;
}

function readRetentionState(file = retentionStateFile) {
  if (!fs.existsSync(file)) return emptyRetentionState();
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
    fail("off-site retention registry path is unsafe");
  }
  try {
    return validateRetentionState(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch (error) {
    if (error?.message?.startsWith("off-site retention")) throw error;
    fail("off-site retention registry is unreadable");
  }
}

function writeRetentionState(state, file = retentionStateFile) {
  validateRetentionState(state);
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const directoryStat = fs.lstatSync(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    fail("off-site retention registry directory is unsafe");
  }
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, file);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

function backupMatchesRegistryEntry(backup, entry, agentId) {
  const agents = backup?.agents && typeof backup.agents === "object"
    ? Object.keys(backup.agents) : [];
  const agent = backup?.agents?.[agentId];
  return backup?.backup_id === entry.backup_id
    && backup.name === entry.name
    && composeBackupNamePattern.test(backup.name)
    && backup.date === entry.backup_timestamp
    && backup.homeassistant_included === true
    && backup.database_included === false
    && Array.isArray(backup.addons) && backup.addons.length === 0
    && Array.isArray(backup.folders) && backup.folders.length === 0
    && agents.length === 1 && agents[0] === agentId
    && agent?.protected === true
    && agent.size === entry.size_bytes
    && !backup.failed_agent_ids?.length
    && !backup.failed_folders?.length
    && !backup.failed_addons?.length;
}

function retentionRegistryEntry(backup, agentId) {
  const agent = backup?.agents?.[agentId];
  const entry = {
    series: COMPOSE_RETENTION_SERIES,
    backup_id: backup?.backup_id,
    name: backup?.name,
    backup_timestamp: backup?.date,
    size_bytes: agent?.size,
    protected: agent?.protected,
  };
  validateRetentionState({ schema_version: 1, series: COMPOSE_RETENTION_SERIES, entries: [entry] });
  if (!backupMatchesRegistryEntry(backup, entry, agentId)) {
    fail("new Compose backup does not satisfy the strict retention signature");
  }
  return entry;
}

export function planComposeRetention({
  backups,
  agentId,
  registry,
  now = new Date(),
  maximumBackups = 90,
  maximumAgeDays = 90,
  newVerifiedBackupId = null,
  requireNewVerifiedBackup = false,
}) {
  if (!Array.isArray(backups) || typeof agentId !== "string" || !agentId
      || !Number.isInteger(maximumBackups) || maximumBackups < 1
      || !Number.isInteger(maximumAgeDays) || maximumAgeDays < 1) {
    fail("off-site retention inputs are invalid");
  }
  const state = validateRetentionState(structuredClone(registry));
  const byId = new Map(backups.map((backup) => [backup.backup_id, backup]));
  const matched = state.entries
    .filter((entry) => backupMatchesRegistryEntry(byId.get(entry.backup_id), entry, agentId))
    .map((entry) => ({ entry, backup: byId.get(entry.backup_id), timestamp: Date.parse(entry.backup_timestamp) }))
    .filter((candidate) => Number.isFinite(candidate.timestamp) && candidate.timestamp <= now.getTime())
    .sort((left, right) => right.timestamp - left.timestamp || left.entry.backup_id.localeCompare(right.entry.backup_id));
  if (requireNewVerifiedBackup && !matched.some((candidate) => candidate.entry.backup_id === newVerifiedBackupId)) {
    fail("retention requires the newly verified Compose backup in the strict registry");
  }
  const preservedId = newVerifiedBackupId ?? matched[0]?.entry.backup_id ?? null;
  const cutoff = now.getTime() - maximumAgeDays * 24 * 60 * 60 * 1000;
  const eligible = matched.filter((candidate, index) => candidate.entry.backup_id !== preservedId
    && (index >= maximumBackups || candidate.timestamp < cutoff));
  return {
    registered: state.entries.length,
    matched: matched.length,
    excluded: backups.length - matched.length,
    preserved_latest_verified: preservedId !== null,
    eligible_backup_ids: eligible.map((candidate) => candidate.entry.backup_id),
    retained_after_prune: matched.length - eligible.length,
  };
}

export async function applyComposeRetention({
  token,
  agentId,
  backups,
  newVerifiedBackup,
  policy,
  stateFile = retentionStateFile,
  now = new Date(),
  request = homeAssistantWebSocketRequest,
}) {
  const entry = retentionRegistryEntry(newVerifiedBackup, agentId);
  const registry = readRetentionState(stateFile);
  registry.entries = [
    ...registry.entries.filter((candidate) => candidate.backup_id !== entry.backup_id),
    entry,
  ];
  writeRetentionState(registry, stateFile);

  const retention = policy.compose_bundle.retention_policy;
  const plan = planComposeRetention({
    backups,
    agentId,
    registry,
    now,
    maximumBackups: retention.maximum_daily_compose_backups,
    maximumAgeDays: retention.maximum_age_days,
    newVerifiedBackupId: entry.backup_id,
    requireNewVerifiedBackup: true,
  });
  const pruned = [];
  for (const backupId of plan.eligible_backup_ids) {
    const result = await request(token, { type: "backup/delete", backup_id: backupId });
    if (!result?.agent_errors || Object.keys(result.agent_errors).length > 0) {
      fail("Home Assistant could not move an eligible Compose backup to the recycle bin");
    }
    pruned.push(backupId);
  }
  if (pruned.length) {
    const refreshed = await request(token, { type: "backup/info" });
    if (!Array.isArray(refreshed?.backups)
        || pruned.some((backupId) => refreshed.backups.some((backup) => backup.backup_id === backupId))) {
      fail("Home Assistant did not confirm retention removal");
    }
    registry.entries = registry.entries.filter((candidate) => !pruned.includes(candidate.backup_id));
    writeRetentionState(registry, stateFile);
  }
  return { eligible: plan.eligible_backup_ids.length, pruned: pruned.length };
}

export async function retentionDryRun({
  policyFile = defaultPolicyFile,
  stateFile = retentionStateFile,
  now = new Date(),
} = {}) {
  const manifest = loadManifest(path.join(repoRoot, "restore/private-state-manifest.yaml"));
  const policy = validateOffsitePolicy(readPolicy(policyFile), manifest);
  const token = readHomeAssistantToken();
  const credentials = readHomeAssistantBackupCredentials();
  const info = await homeAssistantWebSocketRequest(token, { type: "backup/info" });
  if (!Array.isArray(info?.backups) || Object.keys(info.agent_errors ?? {}).length > 0) {
    fail("Home Assistant backup inventory is incomplete");
  }
  const retention = policy.compose_bundle.retention_policy;
  const plan = planComposeRetention({
    backups: info.backups,
    agentId: credentials.agent_id,
    registry: readRetentionState(stateFile),
    now,
    maximumBackups: retention.maximum_daily_compose_backups,
    maximumAgeDays: retention.maximum_age_days,
  });
  return {
    operation: "offsite-retention-dry-run",
    series: COMPOSE_RETENTION_SERIES,
    registered: plan.registered,
    matched: plan.matched,
    excluded: plan.excluded,
    eligible: plan.eligible_backup_ids.length,
    retained_after_prune: plan.retained_after_prune,
    deletes_performed: 0,
  };
}

function assertStringArray(value, label) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry)) {
    fail(`${label} must be a non-empty string array`);
  }
  if (new Set(value).size !== value.length) fail(`${label} contains duplicates`);
}

export function validateOffsitePolicy(policy, manifest) {
  const positive = (value) => Number.isSafeInteger(value) && value > 0;
  const nonnegative = (value) => Number.isSafeInteger(value) && value >= 0;
  const timestamp = (value) => typeof value === "string" && /^\d{4}-\d\d-\d\dT/.test(value)
    && Number.isFinite(Date.parse(value));
  if (!policy || policy.schema_version !== 1 || policy.active !== true) {
    fail("off-site backup policy must be explicitly activated");
  }
  if (policy.homeassistant?.method !== "official-onedrive-integration"
      || policy.homeassistant.account_type !== "personal"
      || policy.homeassistant.local_backup_source !== "homeassistant/backups"
      || policy.homeassistant.app_folder_only !== true
      || policy.homeassistant.encryption_enabled !== true
      || policy.homeassistant.delete_files_permanently !== false
      || policy.homeassistant.retention_status !== "not-covered-compose-only"
      || policy.homeassistant.oauth_status !== "verified-connected") {
    fail("Home Assistant OneDrive policy is not fail-closed");
  }
  const runtimeVerification = policy.homeassistant.runtime_verification;
  if (runtimeVerification?.method !== "authenticated-home-assistant-websocket-api"
      || !timestamp(runtimeVerification.checked_at)
      || runtimeVerification.integration_connected !== true
      || runtimeVerification.backup_location_available !== true
      || runtimeVerification.selected_for_automatic_backups !== false
      || runtimeVerification.completed_external_upload !== true
      || runtimeVerification.encryption_enabled !== true
      || runtimeVerification.delete_files_permanently !== "unknown"
      || runtimeVerification.limitation
        !== "isolated-structural-restore-verified-functional-services-not-tested") {
    fail("Home Assistant runtime verification must preserve the verified encrypted-copy boundary");
  }
  const verifiedBackup = policy.homeassistant.last_verified_external_backup;
  if (verifiedBackup?.destination !== "personal-onedrive-app-folder"
      || !timestamp(verifiedBackup.backup_timestamp)
      || !positive(verifiedBackup.size_bytes)
      || verifiedBackup.protected !== true
      || verifiedBackup.homeassistant_included !== true
      || verifiedBackup.database_included !== true
      || !Array.isArray(verifiedBackup.additional_folders)
      || !positive(verifiedBackup.local_backups_preserved)
      || verifiedBackup.restore_tested !== true
      || verifiedBackup.restore_scope !== "isolated-archive-registries-and-sqlite-integrity"
      || !positive(verifiedBackup.downloaded_decrypted_size_bytes)
      || verifiedBackup.downloaded_decrypted_size_bytes > verifiedBackup.size_bytes
      || verifiedBackup.functional_services_tested !== false) {
    fail("Home Assistant external backup receipt is incomplete");
  }
  if (JSON.stringify(policy.homeassistant.requested_permissions)
      !== JSON.stringify(["Files.ReadWrite.AppFolder", "offline_access", "openid"])) {
    fail("Home Assistant OneDrive permissions changed unexpectedly");
  }
  if (policy.compose_bundle?.transport !== "homeassistant-encrypted-backup-wrapper"
      || policy.compose_bundle.sync_allowed !== false
      || policy.compose_bundle.automatic_delete !== true
      || policy.compose_bundle.homeassistant_wrapper?.protected_required !== true
      || policy.compose_bundle.homeassistant_wrapper?.remote_only !== true
      || policy.compose_bundle.homeassistant_wrapper?.include_database !== false
      || policy.compose_bundle.homeassistant_wrapper?.schedule_unchanged !== true
      || policy.compose_bundle.homeassistant_wrapper?.retention_unchanged !== true
      || policy.compose_bundle.homeassistant_wrapper?.generic_upload_action_rejected
        !== "no-supported-download-for-roundtrip-verification") {
    fail("Compose off-site transport must use the protected Home Assistant wrapper");
  }
  const retention = policy.compose_bundle.retention_policy;
  if (policy.compose_bundle.retention_status !== "active-compose-only"
      || retention?.status !== "approved-active"
      || !timestamp(retention.approved_at)
      || retention.quota_measurement_metadata_only !== true
      || !timestamp(retention.measured_at)
      || !positive(retention.remote_backup_count)
      || retention.protected_backup_count !== retention.remote_backup_count
      || !positive(retention.current_remote_backup_bytes)
      || !positive(retention.quota_total_bytes)
      || !nonnegative(retention.quota_used_bytes)
      || !positive(retention.quota_remaining_bytes)
      || retention.quota_used_bytes + retention.quota_remaining_bytes !== retention.quota_total_bytes
      || retention.current_remote_backup_bytes > retention.quota_used_bytes
      || retention.quota_deleted_bytes_at_measurement !== 0
      || !positive(retention.maximum_daily_compose_backups) || retention.maximum_daily_compose_backups > 90
      || !positive(retention.maximum_age_days) || retention.maximum_age_days > 90
      || !positive(retention.estimated_daily_compose_backup_bytes)
      || retention.estimated_retained_compose_bytes !== retention.estimated_daily_compose_backup_bytes * retention.maximum_daily_compose_backups
      || retention.estimated_total_with_one_full_homeassistant_backup_bytes !== retention.estimated_retained_compose_bytes + verifiedBackup.size_bytes
      || retention.estimated_recycle_bin_bytes_for_30_days !== retention.estimated_daily_compose_backup_bytes * 30
      || retention.estimated_total_with_recycle_bin_and_one_full_backup_bytes !== retention.estimated_total_with_one_full_homeassistant_backup_bytes + retention.estimated_recycle_bin_bytes_for_30_days
      || retention.estimated_total_with_recycle_bin_and_one_full_backup_bytes > retention.quota_remaining_bytes
      || !Number.isFinite(retention.estimated_percent_of_current_free_space)
      || Math.abs(retention.estimated_percent_of_current_free_space - retention.estimated_total_with_one_full_homeassistant_backup_bytes * 100 / retention.quota_remaining_bytes) > 0.1
      || !Number.isFinite(retention.estimated_percent_with_recycle_bin_of_current_free_space)
      || Math.abs(retention.estimated_percent_with_recycle_bin_of_current_free_space - retention.estimated_total_with_recycle_bin_and_one_full_backup_bytes * 100 / retention.quota_remaining_bytes) > 0.1
      || retention.deletion_enabled !== true
      || retention.delete_permanently !== false
      || retention.move_to_onedrive_recycle_bin !== true
      || retention.empty_recycle_bin !== false
      || retention.scope !== "exact-daily-offsite-compose-backups-only"
      || retention.series !== COMPOSE_RETENTION_SERIES
      || retention.strict_registry_required !== true
      || retention.preserve_latest_verified_backup !== true
      || retention.prune_only_after_new_verified_backup !== true) {
    fail("Compose retention must remain strict, recycle-bin-only, and fail-closed");
  }
  if (policy.daily_orchestration?.status !== "active"
      || policy.daily_orchestration.trigger !== "after-successful-git-backup-before-any-update"
      || policy.daily_orchestration.failure_blocks_updates !== true
      || policy.daily_orchestration.mutual_exclusion_lock !== ".daily-maintenance.lock"
      || policy.daily_orchestration.service_stop_required !== true
      || typeof policy.daily_orchestration.approved_recurring_window !== "string"
      || !policy.daily_orchestration.approved_recurring_window.trim()
      || !positive(policy.daily_orchestration.maximum_service_outage_seconds)
      || policy.daily_orchestration.maximum_service_outage_seconds > 600
      || !positive(policy.daily_orchestration.expected_service_outage_seconds)
      || policy.daily_orchestration.expected_service_outage_seconds > policy.daily_orchestration.maximum_service_outage_seconds
      || !positive(policy.daily_orchestration.maximum_backup_manager_ready_wait_seconds)
      || policy.daily_orchestration.maximum_backup_manager_ready_wait_seconds > 180
      || policy.daily_orchestration.remote_retention_rotation_approved !== true
      || policy.daily_orchestration.manual_backup_deletion_allowed !== false
      || policy.daily_orchestration.quota_failure_behavior
        !== "fail-closed-block-updates-and-preserve-existing-backups"
      || policy.daily_orchestration.estimated_remote_growth_bytes_per_daily_cycle !== retention.estimated_daily_compose_backup_bytes
      || policy.daily_orchestration.estimated_remote_growth_bytes_per_30_days !== retention.estimated_recycle_bin_bytes_for_30_days
      || policy.daily_orchestration.deployed !== true
      || !timestamp(policy.daily_orchestration.activation_evidence?.node_red_reloaded_at)
      || !positive(policy.daily_orchestration.activation_evidence.node_red_reload_seconds)
      || policy.daily_orchestration.activation_evidence.node_red_reload_seconds > policy.daily_orchestration.maximum_service_outage_seconds
      || policy.daily_orchestration.activation_evidence.node_red_health !== "healthy"
      || !/^[a-f0-9]{64}$/.test(policy.daily_orchestration.activation_evidence.loaded_flow_sha256)
      || policy.daily_orchestration.activation_evidence.other_services_restarted !== false
      || policy.daily_orchestration.activation_evidence.startup_cycle_dispatched !== false
      || (policy.daily_orchestration.activation_evidence.first_scheduled_run_retention_pruned === true
        && policy.daily_orchestration.activation_evidence.first_scheduled_run_new_compose_backup !== true)) {
    fail("daily off-site orchestration must preserve the approved retention boundary");
  }
  if (JSON.stringify(policy.compose_bundle.homeassistant_wrapper.requested_permissions)
      !== JSON.stringify(policy.homeassistant.requested_permissions)) {
    fail("Compose wrapper must reuse the existing Home Assistant OneDrive permission surface");
  }
  const composeBackup = policy.compose_bundle.last_verified_external_backup;
  if (composeBackup?.destination !== "personal-onedrive-app-folder"
      || !timestamp(composeBackup.backup_timestamp)
      || composeBackup.size_bytes !== retention.estimated_daily_compose_backup_bytes
      || !positive(composeBackup.downloaded_decrypted_size_bytes)
      || composeBackup.downloaded_decrypted_size_bytes > composeBackup.size_bytes
      || composeBackup.protected !== true
      || composeBackup.homeassistant_included !== true
      || composeBackup.database_included !== false
      || !Array.isArray(policy.compose_bundle.coverage)
      || composeBackup.components !== policy.compose_bundle.coverage.length
      || !positive(composeBackup.files) || composeBackup.files < composeBackup.components
      || !positive(composeBackup.payload_bytes)
      || composeBackup.checksums_verified !== true
      || composeBackup.restore_tested !== true
      || composeBackup.restore_scope !== "isolated-file-restore"
      || composeBackup.functional_services_tested !== false
      || !positive(composeBackup.local_backups_preserved)
      || !positive(composeBackup.remote_backups_present)) {
    fail("Compose external backup receipt is incomplete");
  }
  for (const scope of ["Files.ReadWrite.All", "Sites.Read.All"]) {
    if (!policy.compose_bundle.rclone_fallback?.rejected_default_scopes?.includes(scope)) {
      fail("broad rclone default scopes must be rejected");
    }
  }
  if (policy.compose_bundle.rclone_fallback?.configured !== false
      || policy.compose_bundle.rclone_fallback?.requires_separate_authorization !== true
      || JSON.stringify(policy.compose_bundle.rclone_fallback?.proposed_scopes)
        !== JSON.stringify(["Files.ReadWrite", "offline_access"])) {
    fail("rclone must remain an unconfigured separately authorized fallback");
  }
  for (const [label, list] of [
    ["homeassistant.coverage", policy.homeassistant.coverage],
    ["compose_bundle.coverage", policy.compose_bundle.coverage],
    ["separate_approval.coverage", policy.separate_approval?.coverage],
    ["required_confirmations", policy.required_confirmations],
    ["completed_confirmations", policy.completed_confirmations],
  ]) assertStringArray(list, label);

  const itemByName = new Map(manifest.items.map((item) => [item.logical_name, item]));
  const classified = [
    ...policy.homeassistant.coverage,
    ...policy.compose_bundle.coverage,
    ...policy.separate_approval.coverage,
  ];
  if (new Set(classified).size !== classified.length) fail("off-site coverage overlaps");
  if (classified.length !== manifest.items.length || classified.some((name) => !itemByName.has(name))) {
    fail("off-site coverage must classify every private-state component exactly once");
  }
  for (const item of manifest.items) {
    if (!classified.includes(item.logical_name)) fail(`unclassified component: ${item.logical_name}`);
  }
  for (const name of policy.homeassistant.coverage) {
    if (itemByName.get(name).component !== "homeassistant") fail("Home Assistant surface contains a non-HA component");
  }
  for (const name of policy.compose_bundle.coverage) {
    if (itemByName.get(name).kind.startsWith("external-")) fail("external identity state cannot enter the default bundle");
  }
  for (const name of policy.separate_approval.coverage) {
    if (!itemByName.get(name).kind.startsWith("external-")) fail("separate approval is reserved for external state");
  }
  return policy;
}

export function composeBundleManifest(manifest, policy) {
  const itemByName = new Map(manifest.items.map((item) => [item.logical_name, item]));
  const coverage = new Set(policy.compose_bundle.coverage);
  const addDependencies = (name) => {
    const item = itemByName.get(name);
    if (!item) fail(`unknown Compose coverage component: ${name}`);
    for (const dependency of item.dependencies) {
      if (!coverage.has(dependency)) {
        coverage.add(dependency);
        addDependencies(dependency);
      }
    }
  };
  for (const name of [...coverage]) addDependencies(name);
  return {
    ...manifest,
    items: manifest.items.filter((item) => coverage.has(item.logical_name)),
  };
}

export function verifyOffsiteBundle(backupDir, {
  manifestFile = path.join(repoRoot, "restore/private-state-manifest.yaml"),
  policyFile = defaultPolicyFile,
} = {}) {
  const manifest = loadManifest(manifestFile);
  const policy = validateOffsitePolicy(readPolicy(policyFile), manifest);
  const expected = composeBundleManifest(manifest, policy);
  const result = verifyBundle(backupDir, {
    canonicalManifest: expected,
    requiredComponentNames: policy.compose_bundle.coverage,
  });
  const actual = result.metadata.components.map((component) => component.logical_name).sort();
  const required = [...policy.compose_bundle.coverage].sort();
  if (JSON.stringify(actual) !== JSON.stringify(required)) {
    fail("off-site bundle must contain the complete approved Compose coverage");
  }
  return {
    operation: "offsite-backup-verify",
    valid: true,
    components: result.components,
    files: result.files,
    bytes: result.bytes,
  };
}

export function captureOffsiteBundle(outputDir, {
  root = repoRoot,
  manifestFile = path.join(repoRoot, "restore/private-state-manifest.yaml"),
  policyFile = defaultPolicyFile,
  runningServices = null,
  copyUnreadableSource = copyFromStoppedContainer,
  repositoryCommit = currentGitValue(["rev-parse", "HEAD"], ""),
  repositoryBranch = currentGitValue(["branch", "--show-current"], "detached"),
  createdAt = new Date().toISOString(),
  architecture = process.arch,
} = {}) {
  const manifest = loadManifest(manifestFile);
  const policy = validateOffsitePolicy(readPolicy(policyFile), manifest);
  const target = assertSafePrivateOutput(outputDir, root);
  const itemByName = new Map(manifest.items.map((item) => [item.logical_name, item]));
  const items = policy.compose_bundle.coverage.map((name) => itemByName.get(name));
  const requiredStops = [...new Set(items.flatMap((item) => item.service_must_be_stopped))].sort();
  const activeServices = runningServices ?? defaultRunningServices();
  const stillRunning = requiredStops.filter((service) => activeServices.has(service));
  if (stillRunning.length) fail(`consistent capture requires stopped services: ${stillRunning.join(",")}`);
  if (!/^[0-9a-f]{40}$/.test(repositoryCommit)) fail("repository commit is unavailable");

  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  try {
    const bundleManifest = composeBundleManifest(manifest, policy);
    const manifestPath = path.join(target, "manifest.yaml");
    writePrivateJson(manifestPath, bundleManifest);
    const components = [];
    const checksumEntries = [];
    for (const item of [...items].sort((left, right) => left.restore_order - right.restore_order)) {
      const source = path.resolve(root, item.source);
      const relativePayload = `components/${item.logical_name}/payload`;
      const payload = path.join(target, ...relativePayload.split("/"));
      let sourceStat;
      try {
        sourceStat = fs.lstatSync(source);
      } catch (error) {
        if (["EACCES", "EPERM"].includes(error?.code) && containerSnapshotSources[item.logical_name]) {
          copyUnreadableSource(item.logical_name, payload);
          sourceStat = null;
        } else {
          fail(`private source is unavailable for ${item.logical_name}`);
        }
      }
      if (sourceStat) {
        if (sourceStat.isSymbolicLink()) fail(`private source symlink rejected for ${item.logical_name}`);
        if (item.kind === "file" && !sourceStat.isFile()) fail(`private source kind mismatch for ${item.logical_name}`);
        if (item.kind === "directory" && !sourceStat.isDirectory()) fail(`private source kind mismatch for ${item.logical_name}`);
        try {
          fs.mkdirSync(path.dirname(payload), { recursive: true, mode: 0o700 });
          if (sourceStat.isFile()) fs.copyFileSync(source, payload, fs.constants.COPYFILE_EXCL);
          else fs.cpSync(source, payload, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
        } catch (error) {
          if (["EACCES", "EPERM"].includes(error?.code) && containerSnapshotSources[item.logical_name]) {
            fs.rmSync(payload, { recursive: true, force: true });
            copyUnreadableSource(item.logical_name, payload);
          } else {
            throw error;
          }
        }
      }
      const files = secureTree(payload);
      const bytes = files.reduce((sum, file) => sum + fs.statSync(file).size, 0);
      components.push({ logical_name: item.logical_name, payload_path: relativePayload, kind: item.kind, bytes });
      for (const file of files) {
        const stat = fs.statSync(file);
        checksumEntries.push({
          path: path.relative(target, file).split(path.sep).join("/"),
          sha256: sha256File(file),
          bytes: stat.size,
          mode: `0${(stat.mode & 0o777).toString(8).padStart(3, "0")}`,
        });
      }
    }
    writePrivateJson(path.join(target, "checksums.json"), {
      schema_version: 1,
      algorithm: "sha256",
      files: checksumEntries,
    });
    writePrivateJson(path.join(target, "bundle.json"), {
      schema_version: 1,
      repository_commit: repositoryCommit,
      repository_branch_or_release: repositoryBranch || "detached",
      created_at_utc: createdAt,
      host_architecture: architecture,
      component_versions: {},
      container_image_digests: {},
      enabled_modules: ["core", ...[...new Set(items.map((item) => item.module))].filter((name) => name !== "core").sort()],
      components,
      manifest_sha256: sha256File(manifestPath),
      checksums: "checksums.json",
      verification_status: "verified",
      encryption_method: "external-required",
    });
    const verification = verifyOffsiteBundle(target, { manifestFile, policyFile });
    return {
      operation: "offsite-backup-capture",
      captured: true,
      requires_encrypted_outer_transport: true,
      services_confirmed_stopped: requiredStops,
      components: verification.components,
      files: verification.files,
      bytes: verification.bytes,
      values_printed: false,
    };
  } catch (error) {
    fs.rmSync(target, { recursive: true, force: true });
    throw error;
  }
}

export function restoreOffsiteBundle(backupDir, destination, {
  manifestFile = path.join(repoRoot, "restore/private-state-manifest.yaml"),
  policyFile = defaultPolicyFile,
  repositoryRoot = repoRoot,
} = {}) {
  const manifest = loadManifest(manifestFile);
  const policy = validateOffsitePolicy(readPolicy(policyFile), manifest);
  const expected = composeBundleManifest(manifest, policy);
  const result = applyRestore(backupDir, destination, {
    confirm: "RESTORE_PRIVATE_STATE",
    canonicalManifest: expected,
    requiredComponentNames: policy.compose_bundle.coverage,
    repositoryRoot,
  });
  return {
    operation: "offsite-backup-restore-test",
    restored: result.applied,
    components: result.restored.length,
    values_printed: false,
    production_untouched: true,
    functional_services_tested: false,
  };
}

function measurePath(target) {
  const visit = (current) => {
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) fail("private source contains a symlink");
    if (stat.isFile()) return { bytes: stat.size, files: 1 };
    if (!stat.isDirectory()) fail("private source contains an unsupported filesystem object");
    return fs.readdirSync(current, { withFileTypes: true }).reduce((total, entry) => {
      if (entry.isSymbolicLink()) fail("private source contains a symlink");
      const measured = visit(path.join(current, entry.name));
      return { bytes: total.bytes + measured.bytes, files: total.files + measured.files };
    }, { bytes: 0, files: 0 });
  };
  try {
    if (!fs.existsSync(target)) return { status: "missing", bytes: null, files: null };
    return { status: "measured", ...visit(target) };
  } catch (error) {
    if (["EACCES", "EPERM"].includes(error?.code)) return { status: "unreadable", bytes: null, files: null };
    throw error;
  }
}

function captureGroups(items) {
  const groups = new Map();
  for (const item of items) {
    const services = [...item.service_must_be_stopped].sort();
    const key = services.join(",") || "no-stop";
    if (!groups.has(key)) groups.set(key, { services_to_stop: services, components: [] });
    groups.get(key).components.push(item.logical_name);
  }
  return [...groups.values()].map((group) => ({
    ...group,
    components: group.components.sort(),
    requires_explicit_stop_approval: group.services_to_stop.length > 0,
  }));
}

function executableAvailable(command, envPath = process.env.PATH ?? "") {
  return envPath.split(path.delimiter).filter(Boolean).some((directory) => {
    try {
      fs.accessSync(path.join(directory, command), fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

export function buildOffsitePlan({
  root = repoRoot,
  manifestFile,
  policyFile = defaultPolicyFile,
  measure = false,
  envPath = process.env.PATH ?? "",
} = {}) {
  const resolvedManifest = manifestFile ?? path.join(root, "restore/private-state-manifest.yaml");
  const manifest = loadManifest(resolvedManifest);
  const policy = validateOffsitePolicy(readPolicy(policyFile), manifest);
  const itemByName = new Map(manifest.items.map((item) => [item.logical_name, item]));
  const composeItems = policy.compose_bundle.coverage.map((name) => itemByName.get(name));
  const measurements = measure ? Object.fromEntries(composeItems.map((item) => [
    item.logical_name,
    measurePath(path.join(root, item.source)),
  ])) : null;
  const measured = Object.values(measurements ?? {}).filter((entry) => entry.status === "measured");
  const missing = Object.entries(measurements ?? {}).filter(([, entry]) => entry.status !== "measured").map(([name]) => name);
  const homeassistantLocalBackups = measure
    ? measurePath(path.join(root, policy.homeassistant.local_backup_source))
    : null;
  return {
    operation: measure ? "offsite-backup-measure" : "offsite-backup-plan",
    status: "encrypted-copies-and-isolated-structural-restores-verified",
    active: true,
    copies_private_data: false,
    configures_credentials: false,
    requests_oauth_consent: false,
    stops_services: false,
    deletes_local_or_remote_data: false,
    surfaces: {
      homeassistant: {
        method: policy.homeassistant.method,
        coverage: policy.homeassistant.coverage,
        requested_permissions: policy.homeassistant.requested_permissions,
        app_folder_only: true,
        encryption_enabled: true,
        delete_files_permanently: false,
        oauth_status: policy.homeassistant.oauth_status,
        runtime_verification: policy.homeassistant.runtime_verification,
        last_verified_external_backup: policy.homeassistant.last_verified_external_backup,
        retention_status: policy.homeassistant.retention_status,
      },
      compose_bundle: {
        method: policy.compose_bundle.method,
        coverage: policy.compose_bundle.coverage,
        capture_groups: captureGroups(composeItems),
        transport: policy.compose_bundle.transport,
        homeassistant_wrapper: policy.compose_bundle.homeassistant_wrapper,
        rclone_fallback: policy.compose_bundle.rclone_fallback,
        sync_allowed: false,
        automatic_delete: policy.compose_bundle.automatic_delete,
        retention_status: policy.compose_bundle.retention_status,
        retention_policy: policy.compose_bundle.retention_policy,
        restic_fallback: policy.compose_bundle.restic_fallback,
        last_verified_external_backup: policy.compose_bundle.last_verified_external_backup,
      },
      separate_approval: policy.separate_approval,
    },
    tools: {
      rclone_available: executableAvailable("rclone", envPath),
      restic_available: executableAvailable("restic", envPath),
      installation_performed: false,
    },
    measurement: measure ? {
      metadata_only: true,
      homeassistant_local_backups: homeassistantLocalBackups,
      components: measurements,
      measured_bytes: measured.reduce((sum, entry) => sum + entry.bytes, 0),
      measured_files: measured.reduce((sum, entry) => sum + entry.files, 0),
      incomplete_components: missing,
    } : null,
    required_confirmations: policy.required_confirmations,
    completed_confirmations: policy.completed_confirmations,
    next_user_action: "observe the first scheduled daily execution and its fail-closed retention receipt",
  };
}

export function dailyCycleReadiness({
  manifestFile = path.join(repoRoot, "restore/private-state-manifest.yaml"),
  policyFile = defaultPolicyFile,
} = {}) {
  const manifest = loadManifest(manifestFile);
  const policy = validateOffsitePolicy(readPolicy(policyFile), manifest);
  const daily = policy.daily_orchestration;
  const ready = policy.active === true
    && daily.status === "active"
    && typeof daily.approved_recurring_window === "string"
    && daily.approved_recurring_window.length > 0
    && daily.deployed === true;
  return {
    ready,
    reason: ready ? "approved" : "daily-offsite-backup-not-active",
    components: ready ? policy.compose_bundle.coverage.length : 0,
    capture_verified: false,
    remote_verified: false,
    protected: false,
  };
}

export async function runDailyCycle({
  manifestFile = path.join(repoRoot, "restore/private-state-manifest.yaml"),
  policyFile = defaultPolicyFile,
  now = new Date(),
} = {}) {
  const readiness = dailyCycleReadiness({ manifestFile, policyFile });
  if (!readiness.ready) return readiness;

  const manifest = loadManifest(manifestFile);
  const policy = validateOffsitePolicy(readPolicy(policyFile), manifest);
  const itemByName = new Map(manifest.items.map((item) => [item.logical_name, item]));
  const services = [...new Set(policy.compose_bundle.coverage.flatMap((name) =>
    itemByName.get(name).service_must_be_stopped))].sort();
  const runningBefore = defaultRunningServices();
  const servicesToRestore = services.filter((service) => runningBefore.has(service));
  if (servicesToRestore.length !== services.length) {
    fail("all protected services must be running before the daily snapshot");
  }

  const stamp = now.toISOString().replace(/[-:.]/g, "").replace("Z", "Z");
  const temporaryRoot = path.join(os.tmpdir(), `offsite-bundle-${stamp}`);
  const bundleDir = path.join(temporaryRoot, "bundle");
  const stagingDir = path.join(repoRoot, "homeassistant/backups", `offsite-staging-${stamp}`);
  const containerStagingDir = `/config/backups/${path.basename(stagingDir)}`;
  const outageStartedAt = Date.now();
  const outageDeadline = outageStartedAt + Number(policy.daily_orchestration.maximum_service_outage_seconds) * 1000;
  let servicesStopped = false;
  let capture;
  let captureError = null;
  let restorationError = null;

  try {
    servicesStopped = true;
    runChecked("docker", ["compose", "stop", "--timeout", "30", ...servicesToRestore], { timeout: 180_000 });
    capture = captureOffsiteBundle(bundleDir, {
      manifestFile,
      policyFile,
      runningServices: new Set(),
      createdAt: now.toISOString(),
    });
  } catch (error) {
    captureError = error;
  } finally {
    if (servicesStopped) {
      try {
        runChecked("docker", ["compose", "start", ...servicesToRestore], { timeout: 180_000 });
        await waitForServices(servicesToRestore, outageDeadline);
      } catch (error) {
        restorationError = error;
      }
    }
  }
  if (restorationError) {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
    throw restorationError;
  }
  if (captureError) {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
    throw captureError;
  }
  if (!capture?.captured || capture.components !== policy.compose_bundle.coverage.length) {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
    fail("consistent off-site capture did not verify");
  }
  const outageSeconds = Math.ceil((Date.now() - outageStartedAt) / 1000);
  if (outageSeconds > policy.daily_orchestration.maximum_service_outage_seconds) {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
    fail("maximum service outage exceeded");
  }

  let remoteBackup;
  let token;
  let credentials;
  let remoteInventory;
  try {
    const stagingCheck = spawnSync("docker", ["exec", "homeassistant", "test", "-e", containerStagingDir], {
      cwd: repoRoot, stdio: "ignore", timeout: 10_000,
    });
    if (stagingCheck.status === 0) fail("Home Assistant off-site staging already exists");
    runChecked("docker", ["cp", bundleDir, `homeassistant:${containerStagingDir}`]);
    runChecked("docker", ["exec", "homeassistant", "chmod", "-R", "go-rwx", containerStagingDir]);
    token = readHomeAssistantToken();
    credentials = readHomeAssistantBackupCredentials();
    const generated = await requestBackupGenerationWhenIdle({
      token,
      timeoutMs: policy.daily_orchestration.maximum_backup_manager_ready_wait_seconds * 1000,
      generationRequest: {
        type: "backup/generate",
        agent_ids: [credentials.agent_id],
        include_all_addons: false,
        include_database: false,
        include_homeassistant: true,
        include_folders: [],
        name: `${COMPOSE_BACKUP_NAME_PREFIX}${now.toISOString().slice(0, 10)}`,
        password: credentials.password,
      },
    });
    const backupId = generated?.backup_job_id;
    if (typeof backupId !== "string" || !backupId) fail("Home Assistant did not return a backup job");
    const uploadDeadline = Date.now() + 45 * 60 * 1000;
    while (Date.now() < uploadDeadline) {
      const info = await homeAssistantWebSocketRequest(token, { type: "backup/info" });
      if (Object.keys(info?.agent_errors ?? {}).length > 0) {
        fail("Home Assistant backup inventory is incomplete");
      }
      const backup = info?.backups?.find((candidate) => candidate.backup_id === backupId);
      const agent = backup?.agents?.[credentials.agent_id];
      if (backup && agent) {
        if (backup.failed_agent_ids?.length || backup.failed_folders?.length || backup.failed_addons?.length) {
          fail("Home Assistant reported an incomplete external backup");
        }
        if (agent.protected !== true || !Number.isSafeInteger(agent.size) || agent.size <= 0
            || backup.homeassistant_included !== true || backup.database_included !== false) {
          fail("Home Assistant external backup receipt is invalid");
        }
        remoteBackup = backup;
        remoteInventory = info.backups;
        break;
      }
      if (info?.state === "idle" && backup) fail("Home Assistant external upload did not complete");
      await delay(5000);
    }
    if (!remoteBackup) fail("Home Assistant external upload verification timed out");
  } finally {
    const cleanupScript = [
      "import os,shutil,sys",
      `p=${JSON.stringify(containerStagingDir)}`,
      "root='/config/backups'",
      "ok=os.path.dirname(p)==root and os.path.basename(p).startswith('offsite-staging-') and not os.path.islink(p)",
      "sys.exit(64) if not ok else None",
      "shutil.rmtree(p) if os.path.isdir(p) else None",
    ].join(";");
    spawnSync("docker", ["exec", "homeassistant", "python", "-c", cleanupScript], {
      cwd: repoRoot, stdio: "ignore", timeout: 30_000,
    });
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }

  const retentionCredentials = readHomeAssistantBackupCredentials();
  if (retentionCredentials.agent_id !== credentials.agent_id) {
    fail("OneDrive backup agent changed before retention");
  }
  const retention = await applyComposeRetention({
    token,
    agentId: retentionCredentials.agent_id,
    backups: remoteInventory,
    newVerifiedBackup: remoteBackup,
    policy,
    now,
  });

  return {
    ready: true,
    reason: "completed",
    components: capture.components,
    capture_verified: true,
    remote_verified: true,
    protected: true,
    outage_seconds: outageSeconds,
    backup_timestamp: remoteBackup.date,
    retention_eligible: retention.eligible,
    retention_pruned: retention.pruned,
  };
}

async function main() {
  const command = process.argv[2];
  if (["plan", "measure"].includes(command) && process.argv.length === 3) {
    process.stdout.write(`${JSON.stringify(buildOffsitePlan({ measure: command === "measure" }), null, 2)}\n`);
    return;
  }
  if (command === "verify" && process.argv.length === 4 && process.argv[2] === "verify") {
    process.stdout.write(`${JSON.stringify(verifyOffsiteBundle(process.argv[3]), null, 2)}\n`);
    return;
  }
  if (command === "capture" && process.argv.length === 4) {
    process.stdout.write(`${JSON.stringify(captureOffsiteBundle(process.argv[3]), null, 2)}\n`);
    return;
  }
  if (command === "restore-test" && process.argv.length === 5) {
    process.stdout.write(`${JSON.stringify(restoreOffsiteBundle(process.argv[3], process.argv[4]), null, 2)}\n`);
    return;
  }
  if (command === "daily-cycle" && process.argv.length === 3) {
    const result = await runDailyCycle();
    process.stdout.write(`components=${result.components} capture_verified=${result.capture_verified} remote_verified=${result.remote_verified} protected=${result.protected} reason=${result.reason} outage_seconds=${result.outage_seconds ?? 0} backup_timestamp=${result.backup_timestamp ?? "none"} retention_eligible=${result.retention_eligible ?? 0} retention_pruned=${result.retention_pruned ?? 0}\n`);
    if (!result.ready) process.exitCode = 75;
    return;
  }
  if (command === "retention-dry-run" && process.argv.length === 3) {
    process.stdout.write(`${JSON.stringify(await retentionDryRun(), null, 2)}\n`);
    return;
  }
  fail("usage: offsite-backup.mjs <plan|measure|daily-cycle|retention-dry-run|verify BUNDLE_DIR|capture OUTPUT_DIR|restore-test BUNDLE_DIR DESTINATION>");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`offsite-backup: ${error.message}`);
    process.exit(1);
  });
}
