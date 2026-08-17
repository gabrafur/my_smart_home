#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const flows = JSON.parse(fs.readFileSync(path.resolve(here, "..", "flows.json"), "utf8"));
const node = (id) => {
  const found = flows.find((entry) => entry.id === id);
  assert.ok(found, `missing node ${id}`);
  return found;
};

function memoryFlow(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    get: (key) => values.get(key),
    set: (key, value) => values.set(key, value),
    values,
  };
}

function runtimeNode() {
  return {
    statuses: [], logs: [], errors: [],
    status(value) { this.statuses.push(value); },
    log(value) { this.logs.push(value); },
    error(value) { this.errors.push(value); },
  };
}

function compile(id) {
  return new Function("msg", "flow", "node", "context", "env", node(id).func);
}

function configuredFlow() {
  const flow = memoryFlow();
  compile("storage_set_config")({}, flow, runtimeNode(), {}, {});
  return flow;
}

const NOW = Date.parse("2026-08-13T12:00:00Z");
const health = compile("storage_evaluate");
const metric = (used, free = 20) => ({
  used_percent: used,
  used_gb: 30,
  free_gb: free,
  inode_used_percent: 13,
  filesystem: "/",
  collected_at: new Date(NOW).toISOString(),
});
const evaluate = (flow, used, now = NOW, free = 20) => health(
  { payload: metric(used, free), testNow: now }, flow, runtimeNode(), {}, {},
);

assert.equal(node("storage_health_tick").repeat, "900");
assert.equal(node("storage_manual_health").type, "server-state-changed");
assert.deepEqual(node("storage_manual_health").entities.entity, ["input_button.storage_health_manual_run"]);
assert.deepEqual(node("storage_manual_health").wires, [["storage_exec_maintenance", "storage_read_ha"]]);
assert.equal(node("storage_exec_maintenance").command, "/opt/storage-health-maintenance.sh --apply");
assert.equal(node("storage_exec_inspection").command, "/opt/storage-health-maintenance.sh --dry-run --deep");
for (const [id, role, action] of [
  ["storage_notify", "mobile_primary", "notify_3"],
  ["storage_notify_secondary", "mobile_secondary", "notify_2"],
]) {
  assert.equal(node(id).action, "public_bindings.call");
  assert.equal(node(id).domain, "public_bindings");
  assert.equal(node(id).service, "call");
  assert.deepEqual(node(id).entityId, []);
  assert.match(node(id).data, new RegExp(`\"role\":\"${role}\"`));
  assert.match(node(id).data, new RegExp(`\"action\":\"${action}\"`));
}
assert.ok(!JSON.stringify(node("storage_exec_maintenance")).includes("docker.sock"));

{
  const flow = configuredFlow();
  const config = flow.get("storage_health_config_v1");
  assert.deepEqual(config.thresholds, { warning: 70, high: 80, critical: 90 });
  assert.equal(config.hysteresisPercentagePoints, 3);
  assert.equal(config.notificationCooldownMs, 12 * 60 * 60 * 1000);
}

{
  const flow = configuredFlow();
  const [mqtt, alert] = evaluate(flow, 69);
  assert.equal(flow.get("storage_health_state_v1").severity, "normal");
  assert.equal(alert, null);
  assert.equal(mqtt.find((message) => message.topic.endsWith("/status")).payload, "normal");
  assert.equal(mqtt.find((message) => message.topic.endsWith("growth_24h_available")).payload, "offline");
  assert.equal(mqtt.find((message) => message.topic.endsWith("growth_7d_available")).payload, "offline");
  assert.equal(mqtt.some((message) => message.topic.endsWith("/growth_24h")), false);
  assert.equal(mqtt.some((message) => message.topic.endsWith("/growth_7d")), false);
}

{
  const flow = configuredFlow();
  let result = evaluate(flow, 70);
  assert.equal(flow.get("storage_health_state_v1").severity, "warning");
  assert.match(result[1].payload.message, /70\.0%/);
  result = evaluate(flow, 68, NOW + 15 * 60 * 1000);
  assert.equal(flow.get("storage_health_state_v1").severity, "warning", "warning must remain inside hysteresis band");
  assert.equal(result[1], null, "no duplicate alert inside cooldown");
  result = evaluate(flow, 66.9, NOW + 30 * 60 * 1000);
  assert.equal(flow.get("storage_health_state_v1").severity, "normal");
  assert.match(result[1].payload.message, /back to normal/);
}

{
  const flow = configuredFlow();
  evaluate(flow, 80);
  assert.equal(flow.get("storage_health_state_v1").severity, "high");
  const critical = evaluate(flow, 99.9, NOW + 15 * 60 * 1000, 0.05);
  assert.equal(flow.get("storage_health_state_v1").severity, "critical");
  assert.match(critical[1].payload.message, /critical/);
}

{
  const flow = configuredFlow();
  evaluate(flow, 71);
  assert.equal(evaluate(flow, 71, NOW + 11 * 60 * 60 * 1000)[1], null);
  assert.ok(evaluate(flow, 71, NOW + 12 * 60 * 60 * 1000)[1], "cooldown reminder should fire after 12h");
}

{
  const flow = configuredFlow();
  flow.set("storage_health_history_v1", [{ ts: NOW - 24 * 60 * 60 * 1000, used: 40 }]);
  const result = evaluate(flow, 48.4);
  assert.equal(flow.get("storage_health_state_v1").growth24h, 8.4);
  assert.match(result[1].payload.message, /\+8\.4 pp\/24h/);
}

{
  const flow = configuredFlow();
  flow.set("storage_health_history_v1", [{ ts: NOW - 24 * 60 * 60 * 1000, used: 64 }]);
  const thresholdAlert = evaluate(flow, 71);
  assert.match(thresholdAlert[1].payload.message, /warning/);
  const nextCheck = evaluate(flow, 71, NOW + 15 * 60 * 1000);
  assert.equal(nextCheck[1], null, "trend included in a threshold alert must not alert again on the next check");
}

{
  const flow = configuredFlow();
  flow.set("storage_health_history_v1", [{ ts: NOW - 7 * 24 * 60 * 60 * 1000, used: 35 }]);
  evaluate(flow, 46);
  const state = flow.get("storage_health_state_v1");
  assert.equal(state.growth24h, null, "a seven-day-old sample cannot masquerade as a 24h sample");
  assert.equal(state.growth7d, 11);
  assert.equal(
    evaluate(flow, 46, NOW + 15 * 60 * 1000)[0].find((message) => message.topic.endsWith("/growth_7d")).payload,
    "11",
  );
}

{
  const flow = configuredFlow();
  const result = health({ payload: { used_percent: "unknown", free_gb: -1 }, testNow: NOW }, flow, runtimeNode(), {}, {});
  assert.equal(result[0], null);
  assert.match(result[1].payload.message, /metricas validas/);
  assert.equal(health({ payload: {}, testNow: NOW + 60_000 }, flow, runtimeNode(), {}, {})[1], null, "invalid metric alert must respect cooldown");
}

{
  const parse = compile("storage_parse_maintenance");
  const output = parse({ payload: "START|mode=apply\nRESULT|status=success|at=1999-01-01T04:17:00Z|mode=apply|before_bytes=1000|after_bytes=500|reclaimed_bytes=500" }, memoryFlow(), runtimeNode(), {}, {});
  assert.equal(output[0][0].topic, "smart_home/raspberry/storage/last_maintenance");
  assert.equal(output[0][1].payload, "0");
  assert.equal(parse({ payload: "RESULT|status=success|at=x|mode=dry-run|reclaimed_bytes=0" }, memoryFlow(), runtimeNode(), {}, {}), null);
}

{
  const complete = compile("storage_maintenance_complete");
  const flow = configuredFlow();
  assert.equal(complete({ payload: { code: 0 } }, flow, runtimeNode(), {}, {}), null);
  const failed = complete({ payload: { code: 7 } }, flow, runtimeNode(), {}, {});
  assert.match(failed.payload.message, /codigo 7/);
  assert.equal(complete({ payload: { code: 7 } }, flow, runtimeNode(), {}, {}), null, "maintenance errors must respect cooldown");
}

{
  const script = path.resolve(here, "..", "..", "scripts", "storage-health-maintenance.sh");
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "storage-maintenance-test-"));
  const backups = path.join(fixture, "backups", "codex-flows");
  const logs = path.join(fixture, ".npm", "_logs");
  fs.mkdirSync(backups, { recursive: true });
  fs.mkdirSync(logs, { recursive: true });
  const oldBackup = path.join(backups, "old.json");
  const freshBackup = path.join(backups, "fresh.json");
  fs.writeFileSync(oldBackup, "old");
  fs.writeFileSync(freshBackup, "fresh");
  const oldDate = new Date(NOW - 40 * 24 * 60 * 60 * 1000);
  fs.utimesSync(oldBackup, oldDate, oldDate);
  const env = {
    ...process.env,
    STORAGE_MAINTENANCE_DATA_ROOT: fixture,
    STORAGE_MAINTENANCE_LOCK_DIR: path.join(fixture, "lock"),
  };
  const dryRun = spawnSync(script, ["--dry-run", "--deep"], { encoding: "utf8", env });
  assert.equal(dryRun.status, 0, dryRun.stderr);
  assert.match(dryRun.stdout, /CANDIDATE\|action=old_flow_backup/);
  assert.ok(fs.existsSync(oldBackup), "dry-run must not delete");
  const apply = spawnSync(script, ["--apply"], { encoding: "utf8", env });
  assert.equal(apply.status, 0, apply.stderr);
  assert.ok(!fs.existsSync(oldBackup), "apply must remove only the allowlisted old file");
  assert.ok(fs.existsSync(freshBackup), "fresh backup must remain");
  const empty = spawnSync(script, ["--apply"], { encoding: "utf8", env });
  assert.equal(empty.status, 0, empty.stderr);
  assert.match(empty.stdout, /RESULT\|status=success/);
  const refused = spawnSync(script, ["--dry-run"], { encoding: "utf8", env: { ...process.env, STORAGE_MAINTENANCE_DATA_ROOT: "/" } });
  assert.notEqual(refused.status, 0, "DATA_ROOT=/ must be refused");
  const invalidRetention = spawnSync(script, ["--dry-run"], {
    encoding: "utf8",
    env: { ...env, STORAGE_BACKUP_RETENTION_DAYS: "1:2:3" },
  });
  assert.notEqual(invalidRetention.status, 0, "malformed retention values must be refused");
  fs.mkdirSync(path.join(fixture, "lock"));
  const locked = spawnSync(script, ["--dry-run"], { encoding: "utf8", env });
  assert.equal(locked.status, 0, locked.stderr);
  assert.match(locked.stdout, /RESULT\|status=skipped\|.*reason=already_running/);
  fs.rmdirSync(path.join(fixture, "lock"));
  fs.chmodSync(backups, 0o000);
  const unreadable = spawnSync(script, ["--dry-run"], { encoding: "utf8", env });
  fs.chmodSync(backups, 0o700);
  assert.notEqual(unreadable.status, 0, "unreadable allowlisted paths must fail");
  assert.doesNotMatch(unreadable.stdout, /RESULT\|status=success/, "permission errors must not report success");
  fs.rmSync(fixture, { recursive: true, force: true });
}

console.log("Storage Health flow tests passed");
