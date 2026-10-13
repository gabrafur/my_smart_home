import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

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
  restoreOffsiteBundle,
  verifyOffsiteBundle,
} from "./offsite-backup.mjs";
import { createSyntheticBundle, loadManifest } from "./restore.mjs";

test("off-site plan classifies every private component and is explicitly active", () => {
  const plan = buildOffsitePlan({ envPath: "" });
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
  const policy = JSON.parse(fs.readFileSync(defaultPolicyFile, "utf8"));
  assert.deepEqual(policy.daily_orchestration.activation_evidence, {
    node_red_reloaded_at: "2026-10-13T14:15:49-03:00",
    node_red_reload_seconds: 32,
    node_red_health: "healthy",
    loaded_flow_sha256: "22249bd2407c669d157a74b5cc6b29e1867352732808802078881d57a642d989",
    other_services_restarted: false,
    startup_cycle_dispatched: false,
    first_scheduled_run_status: "pending",
  });
  assert.deepEqual(plan.completed_confirmations,
    [
      "homeassistant-microsoft-oauth-and-destination-connection-verified",
      "homeassistant-encrypted-external-backup-verified",
      "homeassistant-isolated-structural-restore-verified",
      "compose-encrypted-external-backup-verified",
      "compose-isolated-file-restore-verified",
      "daily-service-stop-window-approved",
      "compose-retention-recycle-bin-approved",
    ]);
});

test("daily cycle is ready after the approved deployment and scoped retention", () => {
  const readiness = dailyCycleReadiness();
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
  const plan = buildOffsitePlan({ envPath: "" });
  assert.deepEqual(plan.surfaces.homeassistant.requested_permissions,
    ["Files.ReadWrite.AppFolder", "offline_access", "openid"]);
  assert.equal(plan.surfaces.homeassistant.app_folder_only, true);
  assert.equal(plan.surfaces.homeassistant.encryption_enabled, true);
  assert.equal(plan.surfaces.homeassistant.delete_files_permanently, false);
  assert.deepEqual(plan.surfaces.homeassistant.runtime_verification, {
    checked_at: "2026-10-13T12:12:32-03:00",
    method: "authenticated-home-assistant-websocket-api",
    integration_connected: true,
    backup_location_available: true,
    selected_for_automatic_backups: false,
    completed_external_upload: true,
    encryption_enabled: true,
    delete_files_permanently: "unknown",
    limitation: "isolated-structural-restore-verified-functional-services-not-tested",
  });
  assert.deepEqual(plan.surfaces.homeassistant.last_verified_external_backup, {
    backup_timestamp: "2026-10-13T12:15:16-03:00",
    destination: "personal-onedrive-app-folder",
    size_bytes: 549232640,
    protected: true,
    homeassistant_included: true,
    database_included: true,
    additional_folders: [],
    local_backups_preserved: 2,
    restore_tested: true,
    restore_scope: "isolated-archive-registries-and-sqlite-integrity",
    downloaded_decrypted_size_bytes: 549222400,
    functional_services_tested: false,
  });
  assert.equal(plan.surfaces.compose_bundle.transport,
    "homeassistant-encrypted-backup-wrapper");
  assert.deepEqual(plan.surfaces.compose_bundle.homeassistant_wrapper.requested_permissions,
    ["Files.ReadWrite.AppFolder", "offline_access", "openid"]);
  assert.equal(plan.surfaces.compose_bundle.homeassistant_wrapper.protected_required, true);
  assert.equal(plan.surfaces.compose_bundle.homeassistant_wrapper.remote_only, true);
  assert.equal(plan.surfaces.compose_bundle.rclone_fallback.configured, false);
  assert.deepEqual(plan.surfaces.compose_bundle.retention_policy, {
    status: "approved-active",
    approved_at: "2026-10-13T14:43:35-03:00",
    measured_at: "2026-10-13T14:30:32-03:00",
    quota_measurement_metadata_only: true,
    remote_backup_count: 2,
    protected_backup_count: 2,
    current_remote_backup_bytes: 975380480,
    quota_total_bytes: 1104880336896,
    quota_used_bytes: 335222197453,
    quota_remaining_bytes: 769658139443,
    quota_deleted_bytes_at_measurement: 0,
    maximum_daily_compose_backups: 90,
    maximum_age_days: 90,
    estimated_daily_compose_backup_bytes: 426147840,
    estimated_retained_compose_bytes: 38353305600,
    estimated_total_with_one_full_homeassistant_backup_bytes: 38902538240,
    estimated_recycle_bin_bytes_for_30_days: 12784435200,
    estimated_total_with_recycle_bin_and_one_full_backup_bytes: 51686973440,
    estimated_percent_of_current_free_space: 5.05,
    estimated_percent_with_recycle_bin_of_current_free_space: 6.72,
    deletion_enabled: true,
    delete_permanently: false,
    move_to_onedrive_recycle_bin: true,
    empty_recycle_bin: false,
    scope: "exact-daily-offsite-compose-backups-only",
    series: "daily-offsite-compose-v1",
    strict_registry_required: true,
    preserve_latest_verified_backup: true,
    prune_only_after_new_verified_backup: true,
  });
  assert.deepEqual(plan.surfaces.compose_bundle.rclone_fallback.rejected_default_scopes,
    ["Files.ReadWrite.All", "Sites.Read.All"]);
  assert.deepEqual(plan.surfaces.compose_bundle.last_verified_external_backup, {
    backup_timestamp: "2026-10-13T13:14:48-03:00",
    destination: "personal-onedrive-app-folder",
    size_bytes: 426147840,
    downloaded_decrypted_size_bytes: 426137600,
    protected: true,
    homeassistant_included: true,
    database_included: false,
    components: 13,
    files: 218,
    payload_bytes: 3199322,
    checksums_verified: true,
    restore_tested: true,
    restore_scope: "isolated-file-restore",
    functional_services_tested: false,
    local_backups_preserved: 2,
    remote_backups_present: 2,
  });
});

test("Compose retention is recycle-bin-only and exposes every stop window", () => {
  const plan = buildOffsitePlan({ envPath: "" });
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
  const policy = JSON.parse(fs.readFileSync(defaultPolicyFile, "utf8"));
  policy.homeassistant.coverage = ["homeassistant_state"];
  policy.compose_bundle.coverage = ["environment_config"];
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
  const policy = JSON.parse(fs.readFileSync(defaultPolicyFile, "utf8"));
  const variants = [
    (candidate) => { candidate.active = false; },
    (candidate) => { candidate.compose_bundle.sync_allowed = true; },
    (candidate) => { candidate.compose_bundle.automatic_delete = false; },
    (candidate) => { candidate.homeassistant.delete_files_permanently = true; },
    (candidate) => { candidate.compose_bundle.retention_policy.delete_permanently = true; },
    (candidate) => { candidate.compose_bundle.retention_policy.empty_recycle_bin = true; },
    (candidate) => { candidate.compose_bundle.retention_policy.strict_registry_required = false; },
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
  const now = new Date("2026-10-13T18:00:00.000Z");
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
    agents: { "onedrive.test": { protected: true, size: 426147840 } },
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
    size_bytes: 426147840,
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
    now: new Date("2026-10-13T18:00:00.000Z"),
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
    now: new Date("2026-10-13T18:00:00.000Z"),
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
    now: new Date("2026-10-13T18:00:00.000Z"),
    newVerifiedBackupId: fixtures[0].backup.backup_id,
    requireNewVerifiedBackup: true,
  });
  assert.deepEqual(plan.eligible_backup_ids, [fixtures[2].backup.backup_id]);
  assert.equal(plan.preserved_latest_verified, true);
});

test("retention excludes prior HA, unregistered, mismatched, and unprotected backups", () => {
  const valid = retentionFixture(0, 0);
  const wrongAgent = retentionFixture(1, 24, { agents: { "onedrive.other": { protected: true, size: 426147840 } } });
  const unprotected = retentionFixture(2, 48, { agents: { "onedrive.test": { protected: false, size: 426147840 } } });
  const fullHomeAssistant = retentionFixture(3, 72, { database_included: true });
  const wrongName = retentionFixture(4, 96, { name: "Daily off-site Compose state 2026-10-09" });
  const unregistered = retentionFixture(5, 120);
  const registered = [valid, wrongAgent, unprotected, fullHomeAssistant, wrongName];
  const plan = planComposeRetention({
    backups: [...registered, unregistered].map(({ backup }) => backup),
    agentId: "onedrive.test",
    registry: retentionRegistry(registered),
    now: new Date("2026-10-13T18:00:00.000Z"),
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
    now: new Date("2026-10-13T18:00:00.000Z"),
    newVerifiedBackupId: "not-registered",
    requireNewVerifiedBackup: true,
  }), /newly verified Compose backup/);
});

test("retention moves only eligible registered IDs and updates its private registry", async (t) => {
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
    now: new Date("2026-10-13T18:00:00.000Z"),
    request,
  });
  assert.deepEqual(result, { eligible: 2, pruned: 2 });
  assert.deepEqual(deleted, fixtures.slice(90).map(({ backup }) => backup.backup_id));
  const stored = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.equal(stored.entries.length, 90);
  assert.equal(fs.statSync(stateFile).mode & 0o777, 0o600);
  assert(stored.entries.some((entry) => entry.backup_id === fixtures[0].backup.backup_id));
  assert(stored.entries.every((entry) => !deleted.includes(entry.backup_id)));
});

test("dated Compose bundle is verified against the canonical manifest subset", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "offsite-bundle-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const manifest = loadManifest();
  const policy = JSON.parse(fs.readFileSync(defaultPolicyFile, "utf8"));
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
  const verified = verifyOffsiteBundle(bundle);
  assert.equal(verified.valid, true);
  assert.equal(verified.components, policy.compose_bundle.coverage.length);
});

test("off-site verifier rejects an incomplete otherwise valid subset", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "offsite-incomplete-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const manifest = loadManifest();
  const policy = JSON.parse(fs.readFileSync(defaultPolicyFile, "utf8"));
  const subset = composeBundleManifest(manifest, policy);
  const first = subset.items[0];
  const payload = first.kind === "file" ? "synthetic\n" : { "state.bin": "synthetic\n" };
  const bundle = path.join(root, "bundle");
  createSyntheticBundle(bundle, subset, { [first.logical_name]: payload });
  assert.throws(() => verifyOffsiteBundle(bundle), /required bundle component missing|complete approved Compose coverage/);
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
  const policy = JSON.parse(fs.readFileSync(defaultPolicyFile, "utf8"));
  createSyntheticPrivateSources(root, manifest, policy.compose_bundle.coverage);
  const bundle = path.join(root, "bundle");
  const capture = captureOffsiteBundle(bundle, {
    root,
    runningServices: new Set(),
    repositoryCommit: "0".repeat(40),
    repositoryBranch: "synthetic-capture",
    createdAt: "2026-10-13T15:30:00.000Z",
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
  const restored = restoreOffsiteBundle(bundle, destination, { repositoryRoot: root });
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
    runningServices: new Set(["nodered"]),
    repositoryCommit: "0".repeat(40),
  }), /requires stopped services: nodered/);
});
