import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  applyComposeRetention,
  buildOffsitePlan,
  captureOffsiteBundle,
  COMPOSE_BACKUP_NAME_PREFIX,
  COMPOSE_RETENTION_SERIES,
  composeBundleManifest,
  dailyCycleReadiness,
  defaultPolicyFile,
  planComposeRetention,
  requestBackupGenerationWhenIdle,
  restoreOffsiteBundle,
  verifyOffsiteBundle,
  validateOffsitePolicy,
  offsiteManifest,mqttMetadataComponent,mqttMetadataItemSha256,
} from "./offsite-backup.mjs";
import { createSyntheticBundle, loadManifest } from "./restore.mjs";
const syntheticPolicyFile = fileURLToPath(new URL("./fixtures/offsite-backup-policy.synthetic.json", import.meta.url));
const publicExampleFile = fileURLToPath(new URL("../restore/offsite-backup-policy.example.json", import.meta.url));

test("a fresh clone has no active off-site policy or upload authorization", () => {
  assert.equal(path.basename(path.dirname(defaultPolicyFile)), ".local-secrets");
  const missing = path.join(os.tmpdir(), "offsite-policy-not-configured.json");
  assert.throws(() => buildOffsitePlan({ policyFile: missing, envPath: "" }), /missing or invalid/);
  assert.throws(() => dailyCycleReadiness({ policyFile: missing }), /missing or invalid/);
  const example = JSON.parse(fs.readFileSync(publicExampleFile, "utf8"));
  assert.equal(example.active, false);
  assert.equal(example.compose_bundle.automatic_delete, false);
  assert.equal(example.compose_bundle.retention_policy.deletion_enabled, false);
  assert.equal(example.homeassistant.runtime_verification, null);
  assert.equal(example.compose_bundle.last_verified_external_backup, null);
  assert.deepEqual(example.completed_confirmations, []);
  const activatedWithoutEvidence = structuredClone(example);
  activatedWithoutEvidence.active = true;
  const manifest = loadManifest(path.join(path.dirname(publicExampleFile), "private-state-manifest.yaml"));
  assert.throws(() => validateOffsitePolicy(activatedWithoutEvidence, manifest));
});

test("off-site plan classifies every private component and is explicitly active", () => {
  const plan = buildOffsitePlan({ policyFile: syntheticPolicyFile, envPath: "" });
  const coverage = [
    ...plan.surfaces.homeassistant.coverage,
    ...plan.surfaces.compose_bundle.coverage,
    ...plan.surfaces.separate_approval.coverage,
  ];
  assert.equal(coverage.length, 19);
  assert.equal(new Set(coverage).size, 19);
  assert.equal(plan.active, true);
  assert.equal(plan.copies_private_data, false);
  assert.equal(plan.configures_credentials, false);
  assert.equal(plan.requests_oauth_consent, false);
  assert.equal(plan.stops_services, false);
  assert.equal(plan.deletes_local_or_remote_data, false);
  assert.equal(plan.status, "encrypted-copies-and-isolated-structural-restores-verified");
  assert.equal(plan.surfaces.homeassistant.oauth_status, "verified-connected");
  const policy = JSON.parse(fs.readFileSync(syntheticPolicyFile, "utf8"));
  assert.equal(policy.daily_orchestration.approved_recurring_window,
    "after-daily-git-backup-at-01:00-Etc/UTC");
  assert.equal(policy.daily_orchestration.maximum_backup_manager_ready_wait_seconds, 180);
  assert.equal(policy.daily_orchestration.activation_evidence.node_red_health, "healthy");
  assert.deepEqual(plan.completed_confirmations, ["synthetic-local-verification"]);
});

function backupManagerInfo(state, agentErrors = {}) {
  return { state, backups: [], agent_errors: agentErrors };
}

function syntheticClock() {
  let now = 0;
  return {
    clock: () => now,
    wait: async (milliseconds) => { now += milliseconds; },
  };
}

test("backup generation waits for blocked startup and sends exactly one generate request", async () => {
  const calls = [];
  const states = ["blocked", "idle"];
  const time = syntheticClock();
  const request = async (_token, message) => {
    calls.push(message.type);
    if (message.type === "backup/info") return backupManagerInfo(states.shift());
    return { backup_job_id: "synthetic-job" };
  };
  const result = await requestBackupGenerationWhenIdle({
    token: undefined,
    generationRequest: { type: "backup/generate", name: "synthetic" },
    timeoutMs: 5000,
    pollIntervalMs: 1000,
    request,
    ...time,
  });
  assert.equal(result.backup_job_id, "synthetic-job");
  assert.deepEqual(calls, ["backup/info", "backup/info", "backup/generate"]);
});

test("backup generation fails closed when startup remains blocked until timeout", async () => {
  const calls = [];
  const time = syntheticClock();
  await assert.rejects(() => requestBackupGenerationWhenIdle({
    token: undefined,
    generationRequest: { type: "backup/generate" },
    timeoutMs: 2500,
    pollIntervalMs: 1000,
    request: async (_token, message) => {
      calls.push(message.type);
      return backupManagerInfo("blocked");
    },
    ...time,
  }), /startup is still blocked/);
  assert(!calls.includes("backup/generate"));
});

test("backup generation never overlaps an already active backup", async () => {
  const calls = [];
  const time = syntheticClock();
  await assert.rejects(() => requestBackupGenerationWhenIdle({
    token: undefined,
    generationRequest: { type: "backup/generate" },
    timeoutMs: 2000,
    pollIntervalMs: 1000,
    request: async (_token, message) => {
      calls.push(message.type);
      return backupManagerInfo("create_backup");
    },
    ...time,
  }), /another backup is already active/);
  assert(!calls.includes("backup/generate"));
});

test("backup generation reports readiness query failures without retrying generation", async () => {
  const calls = [];
  await assert.rejects(() => requestBackupGenerationWhenIdle({
    token: undefined,
    generationRequest: { type: "backup/generate" },
    timeoutMs: 2000,
    request: async (_token, message) => {
      calls.push(message.type);
      throw new Error("synthetic private detail");
    },
  }), /readiness query failed/);
  assert.deepEqual(calls, ["backup/info"]);
});

test("backup generation enforces the readiness deadline across a slow query", async () => {
  const calls = [];
  let now = 0;
  await assert.rejects(() => requestBackupGenerationWhenIdle({
    token: undefined,
    generationRequest: { type: "backup/generate" },
    timeoutMs: 2000,
    clock: () => now,
    wait: async (milliseconds) => { now += milliseconds; },
    request: async (_token, message, requestTimeoutMs) => {
      calls.push([message.type, requestTimeoutMs]);
      now += 2500;
      return backupManagerInfo("idle");
    },
  }), /readiness timed out/);
  assert.deepEqual(calls, [["backup/info", 2000]]);
});

test("backup generation blocks on agent errors before any generate request", async () => {
  const calls = [];
  await assert.rejects(() => requestBackupGenerationWhenIdle({
    token: undefined,
    generationRequest: { type: "backup/generate" },
    timeoutMs: 2000,
    request: async (_token, message) => {
      calls.push(message.type);
      return backupManagerInfo("idle", { synthetic_agent: "unavailable" });
    },
  }), /reported agent errors/);
  assert.deepEqual(calls, ["backup/info"]);
});

test("daily cycle is ready after the approved deployment and scoped retention", () => {
  const readiness = dailyCycleReadiness({ policyFile: syntheticPolicyFile });
  assert.deepEqual(readiness, {
    ready: true,
    reason: "approved",
    components: 13,
    capture_verified: false,
    remote_verified: false,
    protected: false,
  });
});

test("Compose bundle reuses the protected Home Assistant OneDrive surface", () => {
  const plan = buildOffsitePlan({ policyFile: syntheticPolicyFile, envPath: "" });
  assert.deepEqual(plan.surfaces.homeassistant.requested_permissions,
    ["Files.ReadWrite.AppFolder", "offline_access", "openid"]);
  assert.equal(plan.surfaces.homeassistant.app_folder_only, true);
  assert.equal(plan.surfaces.homeassistant.encryption_enabled, true);
  assert.equal(plan.surfaces.homeassistant.delete_files_permanently, false);
  assert.equal(plan.surfaces.homeassistant.runtime_verification.completed_external_upload, true);
  assert.equal(plan.surfaces.homeassistant.last_verified_external_backup.protected, true);
  assert.equal(plan.surfaces.homeassistant.last_verified_external_backup.restore_tested, true);
  assert.equal(plan.surfaces.compose_bundle.transport,
    "homeassistant-encrypted-backup-wrapper");
  assert.deepEqual(plan.surfaces.compose_bundle.homeassistant_wrapper.requested_permissions,
    ["Files.ReadWrite.AppFolder", "offline_access", "openid"]);
  assert.equal(plan.surfaces.compose_bundle.homeassistant_wrapper.protected_required, true);
  assert.equal(plan.surfaces.compose_bundle.homeassistant_wrapper.remote_only, true);
  assert.equal(plan.surfaces.compose_bundle.rclone_fallback.configured, false);
  assert.equal(plan.surfaces.compose_bundle.retention_policy.deletion_enabled, true);
  assert.equal(plan.surfaces.compose_bundle.retention_policy.delete_permanently, false);
  assert.equal(plan.surfaces.compose_bundle.retention_policy.strict_registry_required, true);
  assert.equal(plan.surfaces.compose_bundle.retention_policy.quota_deleted_bytes_at_measurement, 0);
  assert.deepEqual(plan.surfaces.compose_bundle.rclone_fallback.rejected_default_scopes,
    ["Files.ReadWrite.All", "Sites.Read.All"]);
  assert.equal(plan.surfaces.compose_bundle.last_verified_external_backup.protected, true);
  assert.equal(plan.surfaces.compose_bundle.last_verified_external_backup.checksums_verified, true);
  assert.equal(plan.surfaces.compose_bundle.last_verified_external_backup.restore_tested, true);
});

test("Compose retention is recycle-bin-only and exposes every stop window", () => {
  const plan = buildOffsitePlan({ policyFile: syntheticPolicyFile, envPath: "" });
  assert.equal(plan.surfaces.compose_bundle.sync_allowed, false);
  assert.equal(plan.surfaces.compose_bundle.automatic_delete, true);
  assert.equal(plan.surfaces.compose_bundle.retention_status, "active-compose-only");
  assert.equal(plan.surfaces.compose_bundle.retention_policy.delete_permanently, false);
  assert.equal(plan.surfaces.compose_bundle.retention_policy.empty_recycle_bin, false);
  assert.equal(plan.surfaces.compose_bundle.retention_policy.strict_registry_required, true);
  const groups = plan.surfaces.compose_bundle.capture_groups;
  assert(groups.some((group) => group.services_to_stop.includes("zigbee2mqtt")));
  assert(groups.some((group) => group.services_to_stop.includes("mosquitto")));
  assert(groups.some((group) => group.services_to_stop.includes("nodered")));
  assert(groups.some((group) => group.services_to_stop.includes("matter_server")));
  assert(groups.filter((group) => group.services_to_stop.length > 0)
    .every((group) => group.requires_explicit_stop_approval));
});

test("measurement reads only metadata and reports missing components", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "offsite-backup-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "restore"), { recursive: true });
  fs.mkdirSync(path.join(root, "state"), { recursive: true });
  fs.writeFileSync(path.join(root, "state/value.bin"), Buffer.alloc(17));
  const manifest = {
    schema_version: 1,
    contract: "private-state-v1",
    bundle: {
      metadata_file: "bundle.json",
      manifest_file: "manifest.yaml",
      checksums_file: "checksums.json",
      components_directory: "components",
      encryption_required: true
    },
    items: [
      {
        logical_name: "homeassistant_state", component: "homeassistant", module: "core", kind: "directory",
        source: "missing-ha", destination: "missing-ha", required: true, required_when_module_enabled: false,
        criticality: "critical", owner: "owner", group: "group", permissions: "0700",
        consistency_mode: "offline-copy", service_must_be_stopped: ["homeassistant"], dependencies: [],
        restore_order: 1, fresh_install_behavior: "create", restore_behavior: "restore",
        checksum_policy: "sha256-every-file", validation: ["present"], git_policy: "ignored-private-state"
      },
      {
        logical_name: "environment_config", component: "platform", module: "core", kind: "directory",
        source: "state", destination: "state", required: true, required_when_module_enabled: false,
        criticality: "critical", owner: "owner", group: "group", permissions: "0700",
        consistency_mode: "offline-copy", service_must_be_stopped: [], dependencies: [], restore_order: 2,
        fresh_install_behavior: "create", restore_behavior: "restore", checksum_policy: "sha256-every-file",
        validation: ["present"], git_policy: "ignored-private-state"
      },
      {
        logical_name: "codex_bridge_auth", component: "ai-bridge", module: "agent-bridge", kind: "external-volume",
        source: "docker-volume://codex-bridge-auth", destination: "docker-volume://codex-bridge-auth",
        required: false, required_when_module_enabled: false, criticality: "high", owner: "owner", group: "group",
        permissions: "0700", consistency_mode: "external-snapshot", service_must_be_stopped: ["ai-bridge"],
        dependencies: [], restore_order: 3, fresh_install_behavior: "create", restore_behavior: "restore",
        checksum_policy: "sha256-every-file", validation: ["present"], git_policy: "ignored-private-state"
      }
    ]
  };
  const manifestFile = path.join(root, "restore/private-state-manifest.yaml");
  fs.writeFileSync(manifestFile, `${JSON.stringify(manifest)}\n`);
  const policy = JSON.parse(fs.readFileSync(syntheticPolicyFile, "utf8"));
  policy.homeassistant.coverage = ["homeassistant_state"];
  policy.compose_bundle.coverage = ["environment_config"];
  policy.compose_bundle.last_verified_external_backup.components = 1;
  policy.separate_approval.coverage = ["codex_bridge_auth"];
  const policyFile = path.join(root, "restore/offsite-backup-policy.json");
  fs.writeFileSync(policyFile, `${JSON.stringify(policy)}\n`);
  const plan = buildOffsitePlan({ root, manifestFile, policyFile, measure: true, envPath: "" });
  assert.equal(plan.measurement.metadata_only, true);
  assert.equal(plan.measurement.homeassistant_local_backups.status, "missing");
  assert.equal(plan.measurement.measured_bytes, 17);
  assert.equal(plan.measurement.measured_files, 1);
  assert.deepEqual(plan.measurement.incomplete_components, []);
});

test("policy rejects deactivation, sync and permanent deletion", () => {
  const policy = JSON.parse(fs.readFileSync(syntheticPolicyFile, "utf8"));
  const variants = [
    (candidate) => { candidate.active = false; },
    (candidate) => { candidate.compose_bundle.sync_allowed = true; },
    (candidate) => { candidate.compose_bundle.automatic_delete = false; },
    (candidate) => { candidate.homeassistant.delete_files_permanently = true; },
    (candidate) => { candidate.compose_bundle.retention_policy.delete_permanently = true; },
    (candidate) => { candidate.compose_bundle.retention_policy.empty_recycle_bin = true; },
    (candidate) => { candidate.compose_bundle.retention_policy.strict_registry_required = false; },
    (candidate) => { candidate.compose_bundle.retention_policy.quota_remaining_bytes = 1; },
    (candidate) => { candidate.compose_bundle.retention_policy.quota_total_bytes = -1; },
  ];
  for (const mutate of variants) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "offsite-policy-test-"));
    try {
      const candidate = structuredClone(policy);
      mutate(candidate);
      const policyFile = path.join(root, "policy.json");
      fs.writeFileSync(policyFile, `${JSON.stringify(candidate)}\n`);
      assert.throws(() => buildOffsitePlan({ policyFile, envPath: "" }), /explicitly activated|fail-closed|protected Home Assistant wrapper|strict, recycle-bin-only/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

function retentionFixture(index, hoursAgo, overrides = {}) {
  const now = new Date("2026-01-01T18:00:00.000Z");
  const date = new Date(now.getTime() - hoursAgo * 60 * 60 * 1000).toISOString();
  const name = `${COMPOSE_BACKUP_NAME_PREFIX}${date.slice(0, 10)}`;
  const backupId = `compose-${String(index).padStart(3, "0")}`;
  const backup = {
    backup_id: backupId,
    name,
    date,
    homeassistant_included: true,
    database_included: false,
    addons: [],
    folders: [],
    agents: { "onedrive.test": { protected: true, size: 4096 } },
    failed_agent_ids: [],
    failed_folders: [],
    failed_addons: [],
    ...overrides,
  };
  const entry = {
    series: COMPOSE_RETENTION_SERIES,
    backup_id: backupId,
    name,
    backup_timestamp: date,
    size_bytes: 4096,
    protected: true,
  };
  return { backup, entry };
}

function retentionRegistry(fixtures) {
  return {
    schema_version: 1,
    series: COMPOSE_RETENTION_SERIES,
    entries: fixtures.map(({ entry }) => entry),
  };
}

test("retention keeps the newest 90 recent registered Compose backups", () => {
  const fixtures = Array.from({ length: 95 }, (_, index) => retentionFixture(index, index * 12));
  const plan = planComposeRetention({
    backups: fixtures.map(({ backup }) => backup),
    agentId: "onedrive.test",
    registry: retentionRegistry(fixtures),
    now: new Date("2026-01-01T18:00:00.000Z"),
    newVerifiedBackupId: fixtures[0].backup.backup_id,
    requireNewVerifiedBackup: true,
  });
  assert.equal(plan.matched, 95);
  assert.equal(plan.eligible_backup_ids.length, 5);
  assert.deepEqual(plan.eligible_backup_ids, fixtures.slice(90).map(({ backup }) => backup.backup_id));
  assert.equal(plan.retained_after_prune, 90);
  assert(!plan.eligible_backup_ids.includes(fixtures[0].backup.backup_id));
});

test("retention does not remove recent registered backups below the cap", () => {
  const fixtures = Array.from({ length: 12 }, (_, index) => retentionFixture(index, index * 24));
  const plan = planComposeRetention({
    backups: fixtures.map(({ backup }) => backup),
    agentId: "onedrive.test",
    registry: retentionRegistry(fixtures),
    now: new Date("2026-01-01T18:00:00.000Z"),
  });
  assert.deepEqual(plan.eligible_backup_ids, []);
  assert.equal(plan.retained_after_prune, 12);
});

test("retention ages out only registered Compose backups and preserves the newest", () => {
  const fixtures = [retentionFixture(0, 0), retentionFixture(1, 89 * 24), retentionFixture(2, 91 * 24)];
  const plan = planComposeRetention({
    backups: fixtures.map(({ backup }) => backup),
    agentId: "onedrive.test",
    registry: retentionRegistry(fixtures),
    now: new Date("2026-01-01T18:00:00.000Z"),
    newVerifiedBackupId: fixtures[0].backup.backup_id,
    requireNewVerifiedBackup: true,
  });
  assert.deepEqual(plan.eligible_backup_ids, [fixtures[2].backup.backup_id]);
  assert.equal(plan.preserved_latest_verified, true);
});

test("retention excludes prior HA, unregistered, mismatched, and unprotected backups", () => {
  const valid = retentionFixture(0, 0);
  const wrongAgent = retentionFixture(1, 24, { agents: { "onedrive.other": { protected: true, size: 4096 } } });
  const unprotected = retentionFixture(2, 48, { agents: { "onedrive.test": { protected: false, size: 4096 } } });
  const fullHomeAssistant = retentionFixture(3, 72, { database_included: true });
  const wrongName = retentionFixture(4, 96, { name: "Daily off-site Compose state 2025-12-28" });
  const unregistered = retentionFixture(5, 120);
  const registered = [valid, wrongAgent, unprotected, fullHomeAssistant, wrongName];
  const plan = planComposeRetention({
    backups: [...registered, unregistered].map(({ backup }) => backup),
    agentId: "onedrive.test",
    registry: retentionRegistry(registered),
    now: new Date("2026-01-01T18:00:00.000Z"),
  });
  assert.equal(plan.registered, 5);
  assert.equal(plan.matched, 1);
  assert.equal(plan.excluded, 5);
  assert.deepEqual(plan.eligible_backup_ids, []);
});

test("retention refuses pruning without the newly verified registry entry", () => {
  const fixture = retentionFixture(0, 0);
  assert.throws(() => planComposeRetention({
    backups: [fixture.backup],
    agentId: "onedrive.test",
    registry: retentionRegistry([fixture]),
    now: new Date("2026-01-01T18:00:00.000Z"),
    newVerifiedBackupId: "not-registered",
    requireNewVerifiedBackup: true,
  }), /newly verified Compose backup/);
});

test("retention observes eligible IDs and preserves every registered copy", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "offsite-retention-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stateFile = path.join(root, "state/registry.json");
  const fixtures = Array.from({ length: 92 }, (_, index) => retentionFixture(index, index * 12));
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, `${JSON.stringify(retentionRegistry(fixtures.slice(1)), null, 2)}\n`, { mode: 0o600 });
  let liveBackups = fixtures.map(({ backup }) => backup);
  const deleted = [];
  const request = async (_token, message) => {
    if (message.type === "backup/delete") {
      deleted.push(message.backup_id);
      liveBackups = liveBackups.filter((backup) => backup.backup_id !== message.backup_id);
      return { agent_errors: {} };
    }
    assert.equal(message.type, "backup/info");
    return { backups: liveBackups, agent_errors: {} };
  };
  const result = await applyComposeRetention({
    token: undefined,
    agentId: "onedrive.test",
    backups: liveBackups,
    newVerifiedBackup: fixtures[0].backup,
    policy: { compose_bundle: { retention_policy: {
      maximum_daily_compose_backups: 90,
      maximum_age_days: 90,
    } } },
    stateFile,
    now: new Date("2026-01-01T18:00:00.000Z"),
    request,
  });
  assert.deepEqual(result, { eligible: 2, pruned: 0, mode: "observe_only" });
  assert.deepEqual(deleted, []);
  const stored = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.equal(stored.entries.length, 92);
  assert.equal(fs.statSync(stateFile).mode & 0o777, 0o600);
  assert(stored.entries.some((entry) => entry.backup_id === fixtures[0].backup.backup_id));
  assert(stored.entries.every((entry) => !deleted.includes(entry.backup_id)));
});

test("retention migrates a valid legacy registry before any deletion", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "offsite-retention-migration-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stateFile = path.join(root, "private", "registry.json");
  const legacyStateFile = path.join(root, "legacy", "registry.json");
  fs.mkdirSync(path.dirname(stateFile), { mode: 0o700 });
  fs.mkdirSync(path.dirname(legacyStateFile), { mode: 0o700 });
  const older = retentionFixture(1, 24);
  const current = retentionFixture(0, 0);
  const legacy = `${JSON.stringify(retentionRegistry([older]), null, 2)}\n`;
  fs.writeFileSync(legacyStateFile, legacy, { mode: 0o600 });
  const calls = [];
  const result = await applyComposeRetention({
    token: undefined,
    agentId: "onedrive.test",
    backups: [current.backup, older.backup],
    newVerifiedBackup: current.backup,
    policy: { compose_bundle: { retention_policy: {
      maximum_daily_compose_backups: 90,
      maximum_age_days: 90,
    } } },
    stateFile,
    legacyStateFile,
    now: new Date("2026-01-01T18:00:00.000Z"),
    request: async (_token, message) => { calls.push(message.type); throw new Error("unexpected request"); },
  });
  assert.deepEqual(result, { eligible: 0, pruned: 0, mode: "observe_only" });
  assert.deepEqual(calls, []);
  assert.equal(fs.readFileSync(legacyStateFile, "utf8"), legacy);
  const stored = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.deepEqual(stored.entries.map((entry) => entry.backup_id).sort(),
    [current.backup.backup_id, older.backup.backup_id].sort());
  assert.equal(fs.statSync(stateFile).mode & 0o777, 0o600);
});

test("retention never falls back to legacy when the private registry is invalid", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "offsite-retention-invalid-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stateFile = path.join(root, "private", "registry.json");
  const legacyStateFile = path.join(root, "legacy", "registry.json");
  fs.mkdirSync(path.dirname(stateFile), { mode: 0o700 });
  fs.mkdirSync(path.dirname(legacyStateFile), { mode: 0o700 });
  const current = retentionFixture(0, 0);
  fs.writeFileSync(stateFile, "not-json\n", { mode: 0o600 });
  fs.writeFileSync(legacyStateFile,
    `${JSON.stringify(retentionRegistry([current]), null, 2)}\n`, { mode: 0o600 });
  let requested = false;
  await assert.rejects(() => applyComposeRetention({
    token: undefined,
    agentId: "onedrive.test",
    backups: [current.backup],
    newVerifiedBackup: current.backup,
    policy: { compose_bundle: { retention_policy: {
      maximum_daily_compose_backups: 90,
      maximum_age_days: 90,
    } } },
    stateFile,
    legacyStateFile,
    request: async () => { requested = true; throw new Error("unexpected request"); },
  }), /registry is unreadable/);
  assert.equal(requested, false);
  assert.equal(fs.readFileSync(stateFile, "utf8"), "not-json\n");
});

test("retention fails closed when the new registry path is inaccessible", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "offsite-retention-path-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const blockedParent = path.join(root, "blocked");
  const stateFile = path.join(blockedParent, "registry.json");
  const legacyStateFile = path.join(root, "legacy.json");
  const current = retentionFixture(0, 0);
  fs.writeFileSync(blockedParent, "not a directory\n");
  fs.writeFileSync(legacyStateFile,
    `${JSON.stringify(retentionRegistry([current]), null, 2)}\n`, { mode: 0o600 });
  let requested = false;
  await assert.rejects(() => applyComposeRetention({
    token: undefined,
    agentId: "onedrive.test",
    backups: [current.backup],
    newVerifiedBackup: current.backup,
    policy: { compose_bundle: { retention_policy: {
      maximum_daily_compose_backups: 90,
      maximum_age_days: 90,
    } } },
    stateFile,
    legacyStateFile,
    request: async () => { requested = true; throw new Error("unexpected request"); },
  }), /registry path is unreadable/);
  assert.equal(requested, false);
});

test("dated Compose bundle is verified against the canonical manifest subset", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "offsite-bundle-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const manifest = loadManifest();
  const policy = JSON.parse(fs.readFileSync(syntheticPolicyFile, "utf8"));
  const subset = composeBundleManifest(manifest, policy);
  const itemByName = new Map(subset.items.map((item) => [item.logical_name, item]));
  const payloads = Object.fromEntries(policy.compose_bundle.coverage.map((name) => {
    const item = itemByName.get(name);
    return [name, item.kind === "file"
      ? `synthetic-${name}\n`
      : { "state.bin": `synthetic-${name}\n` }];
  }));
  const bundle = path.join(root, "bundle");
  createSyntheticBundle(bundle, subset, payloads, {
    enabledModules: ["core", "zigbee", "matter", "portainer", "appdaemon"],
  });
  const verified = verifyOffsiteBundle(bundle, { policyFile: syntheticPolicyFile });
  assert.equal(verified.valid, true);
  assert.equal(verified.components, policy.compose_bundle.coverage.length);
});

test("off-site verifier rejects an incomplete otherwise valid subset", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "offsite-incomplete-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const manifest = loadManifest();
  const policy = JSON.parse(fs.readFileSync(syntheticPolicyFile, "utf8"));
  const subset = composeBundleManifest(manifest, policy);
  const first = subset.items[0];
  const payload = first.kind === "file" ? "synthetic\n" : { "state.bin": "synthetic\n" };
  const bundle = path.join(root, "bundle");
  createSyntheticBundle(bundle, subset, { [first.logical_name]: payload });
  assert.throws(() => verifyOffsiteBundle(bundle, { policyFile: syntheticPolicyFile }), /required bundle component missing|complete approved Compose coverage/);
});

function createSyntheticPrivateSources(root, manifest, coverage) {
  const itemByName = new Map(manifest.items.map((item) => [item.logical_name, item]));
  for (const name of coverage) {
    const item = itemByName.get(name);
    const source = path.join(root, item.source);
    if (item.kind === "file") {
      fs.mkdirSync(path.dirname(source), { recursive: true, mode: 0o700 });
      fs.writeFileSync(source, `synthetic-${name}\n`, { mode: 0o600 });
    } else {
      fs.mkdirSync(source, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(source, "state.bin"), `synthetic-${name}\n`, { mode: 0o600 });
    }
  }
}

test("consistent Compose capture verifies and restores only into a temp canary", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "offsite-bundle-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const manifest = loadManifest();
  const policy = JSON.parse(fs.readFileSync(syntheticPolicyFile, "utf8"));
  createSyntheticPrivateSources(root, manifest, policy.compose_bundle.coverage);
  const bundle = path.join(root, "bundle");
  const capture = captureOffsiteBundle(bundle, {
    root,
    policyFile: syntheticPolicyFile,
    runningServices: new Set(),
    repositoryCommit: "0".repeat(40),
    repositoryBranch: "synthetic-capture",
    createdAt: "2026-01-01T15:30:00.000Z",
    architecture: process.arch,
  });
  assert.equal(capture.captured, true);
  assert.equal(capture.components, policy.compose_bundle.coverage.length);
  const metadataFile = path.join(bundle, "bundle.json");
  const metadata = JSON.parse(fs.readFileSync(metadataFile, "utf8"));
  metadata.repository_commit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), ".."),
    encoding: "utf8",
  }).trim();
  fs.writeFileSync(metadataFile, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
  const destination = path.join(root, "restore-test-target");
  const restored = restoreOffsiteBundle(bundle, destination, { repositoryRoot: root, policyFile: syntheticPolicyFile });
  assert.equal(restored.restored, true);
  assert.equal(restored.components, policy.compose_bundle.coverage.length);
  assert.equal(restored.functional_services_tested, false);
  assert.equal(fs.readFileSync(path.join(destination, ".env"), "utf8"), "synthetic-environment_config\n");
});

test("capture refuses to copy while a required service is running", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "offsite-bundle-blocked-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.throws(() => captureOffsiteBundle(path.join(root, "bundle"), {
    root,
    policyFile: syntheticPolicyFile,
    runningServices: new Set(["nodered"]),
    repositoryCommit: "0".repeat(40),
  }), /requires stopped services: nodered/);
});

for(const closed of [false,true])test(`explicit optional MQTT component (${closed?'closed unknown cut':'coordinated cut'}) is checksummed and restored only as private staged data`,t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'offsite-bundle-mqtt-component-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const base=loadManifest(),policy=JSON.parse(fs.readFileSync(syntheticPolicyFile,'utf8'));
  createSyntheticPrivateSources(root,base,policy.compose_bundle.coverage);
  policy.compose_bundle.mqtt_metadata={schema_version:1,enabled:true,component_manifest_sha256:mqttMetadataItemSha256,restore_authority:'data_only_disabled'};
  policy.compose_bundle.coverage.push(mqttMetadataComponent);
  // Synthetic fixture declarations only. Live historical receipts stay intact.
  policy.compose_bundle.last_verified_external_backup.components=14;
  const manifest=offsiteManifest(base,policy);assert.equal(manifest.items.length,base.items.length+1);
  validateOffsitePolicy(policy,manifest);
  const policyFile=path.join(root,'policy.json');fs.writeFileSync(policyFile,JSON.stringify(policy),{mode:0o600});
  const directory=path.join(root,'protected-snapshot');fs.mkdirSync(directory,{mode:0o700});
  const operation_id='a'.repeat(32),files=[];
  for(const name of ['data/state.sqlite3','data/consumer-state.json','data/manifest.json','history/maintenance.json']){
    const file=path.join(directory,name),bytes=Buffer.from('synthetic_'+name);
    fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});fs.writeFileSync(file,bytes,{mode:0o600});
    files.push({path:name,bytes:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex'),role:name.startsWith('data/')?'observer_data':'historical_maintenance_data_not_authority'});
  }
  const stable=v=>Array.isArray(v)?v.map(stable):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])])):v;
  const snapshot={schema_version:1,scope:'mqtt_metadata_backup_snapshot_v1',operation_id,captured_at_utc:'2026-10-28T10:00:00+00:00',
    consistency:closed?'closed_metadata_unknown_cut':'coordinated_metadata_cut',...(closed?{metadata_integrity:'unknown'}:{}),
    full24h_proven:false,current_authority_included:false,files};
  fs.writeFileSync(path.join(directory,'backup-snapshot.json'),JSON.stringify(stable(snapshot)),{mode:0o600});
  const bundle=path.join(root,'bundle'),options={root,policyFile,runningServices:new Set(),repositoryCommit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),mqttSnapshot:{directory,operation_id}};
  assert.equal(captureOffsiteBundle(bundle,options).components,14);
  assert.equal(verifyOffsiteBundle(bundle,{policyFile}).components,14);
  const restoredRoot=path.join(root,'restore-test-target');const restored=restoreOffsiteBundle(bundle,restoredRoot,{policyFile,repositoryRoot:root});
  assert.equal(restored.components,14);assert.equal(restored.functional_services_tested,false);
  const staged=path.join(restoredRoot,'.local-state/mqtt-observation-restored-data');
  assert.equal(fs.readFileSync(path.join(staged,'backup-snapshot.json'),'utf8'),JSON.stringify(stable(snapshot)));
  assert.equal(fs.existsSync(path.join(staged,'authorization.json')),false);
  assert.throws(()=>captureOffsiteBundle(path.join(root,'missing-snapshot'),{...options,mqttSnapshot:null}),/snapshot is required/);
  assert.throws(()=>captureOffsiteBundle(path.join(root,'unapproved-snapshot'),{...options,policyFile:syntheticPolicyFile}),/unapproved protected/);
  fs.writeFileSync(path.join(bundle,'components',mqttMetadataComponent,'payload','history','extra.json'),'untracked');
  assert.throws(()=>verifyOffsiteBundle(bundle,{policyFile}),/checksum|payload|inventory|byte count/);
});
