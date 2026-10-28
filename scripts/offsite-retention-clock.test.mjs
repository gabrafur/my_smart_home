import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { applyComposeRetention, planComposeRetention, runDailyCycleCommand, COMPOSE_RETENTION_SERIES } from "./offsite-backup.mjs";
import { captureWithOrderedStops } from "./mqtt-maintenance-backup.mjs";

const source = fs.readFileSync(new URL("./offsite-backup.mjs", import.meta.url), "utf8");
const begin = "export async function runDailyCycle(";
const end = "\nasync function main()";
assert.equal(source.split(begin).length, 2);
assert.equal(source.split(end).length, 2);
// Execute the unchanged orchestration body with effect boundaries replaced.
// The VM receives neither real fs, Docker, credentials nor network functions.
const cycleSource = source.slice(source.indexOf(begin), source.indexOf(end)).replace("export ", "");
const start = Date.parse("2026-01-01T18:00:00Z");
const agentId = "onedrive.synthetic";
const policy = {
  compose_bundle: { coverage: ["synthetic"], retention_policy: { maximum_daily_compose_backups: 90, maximum_age_days: 90 } },
  daily_orchestration: { maximum_service_outage_seconds: 600, maximum_backup_manager_ready_wait_seconds: 180 },
};

function backupAt(date, id = "synthetic-new") {
  return { backup_id: id, name: "Daily off-site Compose v1 2026-01-01", date,
    homeassistant_included: true, database_included: false, addons: [], folders: [],
    agents: { [agentId]: { protected: true, size: 4096 } } };
}
function registryFor(backups) {
  return { schema_version: 1, series: COMPOSE_RETENTION_SERIES, entries: backups.map(b => ({
    series: COMPOSE_RETENTION_SERIES, backup_id: b.backup_id, name: b.name,
    backup_timestamp: b.date, size_bytes: 4096, protected: true,
  })) };
}

function cycleHarness(options = {}) {
  let tick = start;
  let created;
  const events = [];
  let retentionCalls = 0;
  const fixtureServices = options.metadataMaintenance||options.metadataPolicyOnly ? ["homeassistant", "mosquitto", "nodered"] : ["synthetic-service"];
  const cyclePolicy=structuredClone(policy),manifest={items:[{logical_name:'synthetic',service_must_be_stopped:fixtureServices}]};
  if((options.metadataMaintenance&&!options.missingMetadataPolicy)||options.metadataPolicyOnly){
    cyclePolicy.compose_bundle.mqtt_metadata={schema_version:1,enabled:true,component_manifest_sha256:'a'.repeat(64),restore_authority:'data_only_disabled'};
    cyclePolicy.compose_bundle.coverage.push('mqtt_observation_metadata');
    manifest.items.push({logical_name:'mqtt_observation_metadata',service_must_be_stopped:['mosquitto','nodered']});
  }
  class FixedDate extends Date {
    constructor(...args) { super(...(args.length ? args : [tick])); }
    static now() { return tick; }
  }
  const context = {
    Date: FixedDate, Set, Map, Number, Object, JSON, Math, path,
    repoRoot: "/synthetic-only", defaultPolicyFile: "/synthetic-policy", os: { tmpdir: () => "/synthetic-tmp" },
    dailyCycleReadiness: () => ({ ready: true }),
    configuration:()=>({manifest,policy:cyclePolicy}),
    loadManifest: () => manifest,
    readPolicy: () => cyclePolicy, validateOffsitePolicy: p => p,
    defaultRunningServices: () => new Set(fixtureServices),
    captureWithOrderedStops,
    loadBackupMaintenance: () => options.metadataMaintenance ? {
      operation_id:'a'.repeat(32),snapshot_component_manifest_sha256:options.metadataHashMismatch?'b'.repeat(64):'a'.repeat(64),
      ...(!options.legacyMetadataContract?{snapshot:async directory=>{
        events.push('mqtt-export-start');assert(directory.startsWith('/synthetic-tmp/offsite-bundle-'));
        if(options.snapshotBarrier)await options.snapshotBarrier;
        if(options.snapshotFailure)throw new Error('synthetic snapshot transport failed');
        events.push('mqtt-export-complete');return {destination:directory};
      }}:{}),
      prepare: () => events.push("mqtt-prepare"),
      resume: () => {
        events.push("mqtt-resume");
        if (options.metadataRestoreFailure) throw new Error("synthetic metadata restoration failed");
      },
    } : null,
    fail: message => { throw new Error(message); },
    runChecked: (_command, args) => {
      if (args[0] === "compose") { events.push(args[1]); if (args[1] === "stop") tick += 10_000; }
      return "";
    },
    captureOffsiteBundle: (_target, args) => {
      events.push("capture"); assert.equal(args.createdAt, new Date(start).toISOString());
      if(options.metadataMaintenance){assert(events.includes('mqtt-export-complete'));assert.equal(args.mqttSnapshot.operation_id,'a'.repeat(32));}
      tick += 20_000;
      if (options.captureFailure) throw new Error("synthetic capture failed");
      return { captured: true, components: cyclePolicy.compose_bundle.coverage.length };
    },
    waitForServices: async (_services, deadline) => {
      events.push("services-ready"); tick = start + (options.outageTimeout ? 600_001 : 90_000);
      assert.equal(deadline, start + 600_000);
      if (tick > deadline) throw new Error("service readiness deadline exceeded");
    },
    spawnSync: () => ({ status: 1 }), fs: {mkdirSync:()=>{},rmSync: () => events.push("cleanup") },
    readHomeAssistantToken: () => "synthetic-token", readHomeAssistantBackupCredentials: () => ({ agent_id: agentId, password: "synthetic" }),
    requestBackupGenerationWhenIdle: async args => {
      events.push("generate"); assert.equal(args.timeoutMs, 180_000); tick += 120_000;
      if (options.managerTimeout) throw new Error("synthetic manager timeout");
      created = backupAt(options.invalidDate ? "invalid" : new Date(tick + (options.futureDate ? 1 : 0)).toISOString());
      return { backup_job_id: created.backup_id };
    },
    homeAssistantWebSocketRequest: async (_token, message) => {
      assert.equal(message.type, "backup/info");
      if (options.uploadTimeout) return { state: "create_backup", backups: [], agent_errors: {} };
      if (options.incompleteUpload) return { state: "idle", backups: [{ ...created, failed_folders: ["synthetic"] }], agent_errors: {} };
      events.push("remote-receipt-checked");
      return { state: "idle", backups: [created, ...(options.extraBackups ?? [])], agent_errors: {} };
    },
    delay: async ms => { tick += ms; },
    COMPOSE_BACKUP_NAME_PREFIX: "Daily off-site Compose v1 ",
    applyComposeRetention: async args => {
      retentionCalls++;
      assert(events.includes("remote-receipt-checked"));
      assert.equal(args.now.getTime(), options.rollbackClock ? start : tick);
      if (options.applyRetention) {
        const result = await options.applyRetention(args);
        events.push("retention");
        return result;
      }
      const plan = planComposeRetention({ backups: args.backups, agentId,
        registry: registryFor(options.missingRegistry ? [] : [created]), now: args.now,
        newVerifiedBackupId: created.backup_id, requireNewVerifiedBackup: true });
      events.push("retention");
      assert.equal(plan.eligible_backup_ids.length, 0);
      return { eligible: 0, pruned: 0, mode: "observe_only" };
    },
  };
  vm.createContext(context);
  const run = vm.runInContext(`${options.cycleBody ?? cycleSource}\nrunDailyCycle`, context);
  return { run, events, retentionCalls: () => retentionCalls, time: () => tick };
}

test("cycle uses post-verification time for retention and preserves capture start time", async () => {
  const h = cycleHarness(); const result = await h.run();
  assert.equal(result.remote_verified, true); assert.equal(result.outage_seconds, 90);
  assert.equal(result.mqtt_coordination, "not_installed");
  assert.equal(result.retention_pruned, 0); assert.equal(result.retention_mode, "observe_only"); assert.equal(h.retentionCalls(), 1);
  assert.deepEqual(h.events.filter(e => e !== "cleanup"), ["stop", "capture", "start", "services-ready", "generate", "remote-receipt-checked", "retention"]);
  assert.equal(h.time(), start + 210_000);
});

test("actual cycle body verifies coordinated resume before generating or retaining the remote backup", async () => {
  const h = cycleHarness({ metadataMaintenance: true }); const result = await h.run();
  assert.equal(result.mqtt_coordination, "verified");
  assert(h.events.indexOf("mqtt-prepare") < h.events.indexOf("capture"));
  assert(h.events.indexOf('mqtt-export-complete')<h.events.indexOf('capture'));
  assert(h.events.indexOf("capture") < h.events.indexOf("mqtt-resume"));
  assert(h.events.indexOf("mqtt-resume") < h.events.indexOf("generate"));
});

test('actual cycle refuses an incomplete installed metadata contract before stopping services',async()=>{
  for(const option of ['missingMetadataPolicy','legacyMetadataContract','metadataHashMismatch']){
    const h=cycleHarness({metadataMaintenance:true,[option]:true});await assert.rejects(h.run(),/metadata snapshot backup contract/);
    assert.deepEqual(h.events,[]);assert.equal(h.retentionCalls(),0);
  }
  const absent=cycleHarness({metadataPolicyOnly:true});await assert.rejects(absent.run(),/metadata snapshot backup contract/);
  assert.deepEqual(absent.events,[]);
});
test('actual cycle restores services after snapshot transport failure without generating a remote copy',async()=>{
  const h=cycleHarness({metadataMaintenance:true,snapshotFailure:true});await assert.rejects(h.run(),/snapshot transport failed/);
  assert(h.events.includes('mqtt-resume'));assert(h.events.includes('services-ready'));
  assert(!h.events.includes('capture'));assert(!h.events.includes('generate'));assert.equal(h.retentionCalls(),0);
});
test('actual cycle waits for metadata export before capture and resume',async()=>{
  let release;const snapshotBarrier=new Promise(resolve=>{release=resolve;}),h=cycleHarness({metadataMaintenance:true,snapshotBarrier});
  const running=h.run();await new Promise(resolve=>setImmediate(resolve));
  assert(h.events.includes('mqtt-export-start'));assert(!h.events.includes('capture'));assert(!h.events.includes('mqtt-resume'));
  release();assert.equal((await running).remote_verified,true);
});

test("unconfirmed metadata resume prevents remote generation and retention in the actual cycle body", async () => {
  const h = cycleHarness({ metadataMaintenance: true, metadataRestoreFailure: true });
  await assert.rejects(h.run(), /metadata restoration failed/);
  assert(!h.events.includes("generate"));assert.equal(h.retentionCalls(), 0);
});

for (const [name, option, error] of [
  ["capture failure", "captureFailure", /capture failed/],
  ["service outage deadline", "outageTimeout", /readiness deadline/],
  ["backup manager deadline", "managerTimeout", /manager timeout/],
  ["incomplete upload", "incompleteUpload", /incomplete external backup/],
  ["45 minute upload deadline", "uploadTimeout", /upload verification timed out/],
]) {
  test(`${name} prevents retention`, async () => {
    const h = cycleHarness({ [option]: true });
    await assert.rejects(h.run, error); assert.equal(h.retentionCalls(), 0);
    if (option === "uploadTimeout") assert.equal(h.time(), start + 210_000 + 45 * 60_000);
  });
}

for (const option of ["futureDate", "invalidDate", "missingRegistry"]) {
  test(`${option} still refuses the new backup at retention`, async () => {
    const h = cycleHarness({ [option]: true });
    await assert.rejects(h.run, /newly verified Compose backup/);
    assert(!h.events.includes("retention"));
  });
}

test("age cutoff remains strict and the newest verified copy is preserved", () => {
  const now = new Date(start); const cutoff = start - 90 * 86400_000;
  const backups = [backupAt(now.toISOString()), backupAt(new Date(cutoff).toISOString(), "at-cutoff"), backupAt(new Date(cutoff - 1).toISOString(), "older")];
  const result = planComposeRetention({ backups, agentId, registry: registryFor(backups), now,
    newVerifiedBackupId: backups[0].backup_id, requireNewVerifiedBackup: true });
  assert.deepEqual(result.eligible_backup_ids, ["older"]);
});

test("real retention implementation makes zero requests before strict proof", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "offsite-clock-synthetic-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const old = backupAt(new Date(start - 91 * 86400_000).toISOString(), "old-eligible");
  for (const kind of ["future", "invalid", "missing-inventory", "unprotected", "invalid-clock"]) {
    const fresh = backupAt(kind === "invalid" ? "invalid" : new Date(start + (kind === "future" ? 1 : 0)).toISOString());
    if (kind === "unprotected") fresh.agents[agentId].protected = false;
    const stateFile = path.join(dir, `${kind}.json`);
    fs.writeFileSync(stateFile, JSON.stringify(registryFor([old])), { mode: 0o600 });
    const requests = [];
    await assert.rejects(() => applyComposeRetention({ agentId, policy, stateFile,
      backups: kind === "missing-inventory" ? [old] : [old, fresh], newVerifiedBackup: fresh,
      now: kind === "invalid-clock" ? new Date(NaN) : new Date(start),
      request: async (_token, message) => { requests.push(message); throw new Error("unexpected request"); },
    }));
    assert.deepEqual(requests, [], kind);
  }
});

function isolatedRegistry(t, backups = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "offsite-observe-synthetic-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const stateFile = path.join(dir, "registry.json");
  fs.writeFileSync(stateFile, `${JSON.stringify(registryFor(backups))}\n`, { mode: 0o600 });
  const requests = [];
  return { dir, stateFile, requests,
    read: () => JSON.parse(fs.readFileSync(stateFile, "utf8")),
    apply: args => applyComposeRetention({ ...args, stateFile,
      request: async (_token, message) => { requests.push(message); throw new Error("remote effect forbidden"); } }),
  };
}

async function dailyOutput(result) {
  const mainSource = source.slice(source.indexOf("async function main()"), source.indexOf("\nif (process.argv[1]"));
  let output = "";
  const context = { process: { argv: ["node", "synthetic", "daily-cycle"], stdout: { write: text => { output += text; } } },
    runDailyCycle: async () => result };
  context.runDailyCycleCommand = () => runDailyCycleCommand({
    cycle: context.runDailyCycle, write: context.process.stdout.write,
  });
  vm.createContext(context);
  await vm.runInContext(`${mainSource}\nmain()`, context);
  return { output, exitCode: context.process.exitCode ?? 0 };
}

test("cycle completes verified capture with eligible copies but no prune or remote retention request", async t => {
  const old = backupAt(new Date(start - 91 * 86400_000).toISOString(), "old-eligible");
  const absent = backupAt(new Date(start - 92 * 86400_000).toISOString(), "not-in-inventory");
  const store = isolatedRegistry(t, [old, absent]);
  const h = cycleHarness({ extraBackups: [old], applyRetention: store.apply });
  const result = await h.run();
  assert.equal(result.ready, true); assert.equal(result.reason, "completed");
  assert.equal(result.capture_verified, true); assert.equal(result.remote_verified, true);
  assert.equal(result.protected, true); assert.equal(result.retention_eligible, 1);
  assert.equal(result.retention_pruned, 0); assert.equal(result.retention_mode, "observe_only");
  assert.deepEqual(store.requests, []);
  assert.deepEqual(store.read().entries.map(e => e.backup_id).sort(), ["old-eligible", "not-in-inventory", "synthetic-new"].sort());
  assert.equal(fs.statSync(store.stateFile).mode & 0o777, 0o600);
  const summary = await dailyOutput(result);
  assert.equal(summary.exitCode, 0);
  assert.match(summary.output, /capture_verified=true remote_verified=true protected=true reason=completed/);
  assert.match(summary.output, /retention_eligible=1 retention_pruned=0 retention_mode=observe_only mqtt_coordination=not_installed\n$/);
});

test("not-ready cycle result never claims verified capture or observation", async () => {
  const summary = await dailyOutput({ ready: false, components: 0, capture_verified: false,
    remote_verified: false, protected: false, reason: "daily-offsite-backup-not-active" });
  assert.equal(summary.exitCode, 75);
  assert.match(summary.output, /capture_verified=false remote_verified=false protected=false/);
  assert.match(summary.output, /retention_mode=not_run mqtt_coordination=unknown\n$/);
});

test("observation preserves old entries and registering the same receipt does not duplicate it", async t => {
  const old = backupAt(new Date(start - 91 * 86400_000).toISOString(), "old-eligible");
  const fresh = backupAt(new Date(start).toISOString());
  const store = isolatedRegistry(t, [old]);
  const args = { agentId, policy, backups: [old, fresh], newVerifiedBackup: fresh, now: new Date(start) };
  assert.deepEqual(await store.apply(args), { eligible: 1, pruned: 0, mode: "observe_only" });
  const first = fs.readFileSync(store.stateFile, "utf8");
  await store.apply(args);
  assert.equal(fs.readFileSync(store.stateFile, "utf8"), first);
  assert.deepEqual(store.requests, []);
});

test("cycle registry rename failure preserves previous bytes and never retries backup or deletes", async t => {
  const old = backupAt(new Date(start - 91 * 86400_000).toISOString(), "old-eligible");
  const store = isolatedRegistry(t, [old]);
  const original = fs.readFileSync(store.stateFile, "utf8");
  const rename = fs.renameSync;
  t.mock.method(fs, "renameSync", (from, to) => {
    if (to === store.stateFile) throw new Error("synthetic registry rename failed");
    return rename(from, to);
  });
  const h = cycleHarness({ extraBackups: [old], applyRetention: store.apply });
  await assert.rejects(h.run, /registry rename failed/);
  assert.equal(fs.readFileSync(store.stateFile, "utf8"), original);
  assert.deepEqual(fs.readdirSync(store.dir), ["registry.json"]);
  assert.deepEqual(store.requests, []);
  assert.equal(h.events.filter(e => e === "generate").length, 1);
  assert.equal(h.events.filter(e => e === "start").length, 1);
  assert(!h.events.includes("retention"));
});

test("uncertain registry commit preserves new and previous receipts and never claims success or repeats", async t => {
  const old = backupAt(new Date(start - 91 * 86400_000).toISOString(), "old-eligible");
  const store = isolatedRegistry(t, [old]);
  const rename = fs.renameSync;
  t.mock.method(fs, "renameSync", (from, to) => {
    const result = rename(from, to);
    if (to === store.stateFile) throw new Error("synthetic commit outcome uncertain");
    return result;
  });
  const h = cycleHarness({ extraBackups: [old], applyRetention: store.apply });
  await assert.rejects(h.run, /commit outcome uncertain/);
  assert.deepEqual(store.read().entries.map(e => e.backup_id).sort(), ["old-eligible", "synthetic-new"]);
  assert.deepEqual(store.requests, []);
  assert.equal(h.events.filter(e => e === "generate").length, 1);
  assert(!h.events.includes("retention"));
});

test("strict future-time failure retains receipts without deleting or treating the cycle as complete", async t => {
  const old = backupAt(new Date(start - 91 * 86400_000).toISOString(), "old-eligible");
  const store = isolatedRegistry(t, [old]);
  const h = cycleHarness({ futureDate: true, extraBackups: [old], applyRetention: store.apply });
  await assert.rejects(h.run, /newly verified Compose backup/);
  assert.deepEqual(store.read().entries.map(e => e.backup_id).sort(), ["old-eligible", "synthetic-new"]);
  assert.deepEqual(store.requests, []);
  assert.equal(h.events.filter(e => e === "generate").length, 1);
});

test("clock rollback retains the observation barrier and fails without remote deletion", async t => {
  const old = backupAt(new Date(start - 91 * 86400_000).toISOString(), "old-eligible");
  const store = isolatedRegistry(t, [old]);
  assert.equal(cycleSource.split("now: new Date(),").length, 2);
  const h = cycleHarness({ rollbackClock: true,
    cycleBody: cycleSource.replace("now: new Date(),", "now,"),
    extraBackups: [old], applyRetention: store.apply });
  await assert.rejects(h.run, /newly verified Compose backup/);
  assert.deepEqual(store.requests, []);
  assert.deepEqual(store.read().entries.map(e => e.backup_id).sort(), ["old-eligible", "synthetic-new"]);
  assert.equal(h.events.filter(e => e === "generate").length, 1);
});

test("capture and service restoration failure cannot reach upload or observation", async () => {
  const h = cycleHarness({ captureFailure: true, outageTimeout: true });
  await assert.rejects(h.run, /service readiness deadline exceeded/);
  assert.deepEqual(h.events, ["stop", "capture", "start", "services-ready", "cleanup"]);
  assert.equal(h.retentionCalls(), 0);
});
