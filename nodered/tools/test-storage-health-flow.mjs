#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";

const flowsPath = process.argv[2] ?? new URL("../flows.json", import.meta.url);
const flows = JSON.parse(fs.readFileSync(flowsPath, "utf8"));
const byId = new Map(flows.map((node) => [node.id, node]));
const tabNodes = flows.filter((node) => node.z === "storage_health_tab");
const compile = (id) => {
  const node = byId.get(id);
  assert.equal(node?.type, "function", `function ausente: ${id}`);
  return new Function("msg", "flow", "node", node.func);
};
function context() {
  const stores = { default: new Map(), persistent: new Map(), memoryOnly: new Map() };
  return {
    stores,
    get(key, store = "default") { return stores[store].get(key); },
    set(key, value, store = "default") { stores[store].set(key, structuredClone(value)); },
  };
}
const nodeMock = { status() {}, log() {}, warn() {}, error() {} };
const call = (fn, msg, flow) => fn(msg, flow, nodeMock);
const f = {
  validate: compile("storage_visual_policy_validate"), store: compile("storage_visual_policy_store"),
  load: compile("storage_visual_policy_load"), normalize: compile("storage_visual_input_normalize"),
  history: compile("storage_visual_history_analyze"), alert: compile("storage_visual_alert_build"),
  state: compile("storage_visual_state_finalize"), attributes: compile("storage_visual_attributes_build"),
  mqtt: compile("storage_visual_mqtt_build"), finalize: compile("storage_visual_output_route"), invalid: compile("storage_visual_invalid_finalize"),
  ack: compile("storage_notification_ack"), gate: compile("storage_auto_gate"),
};
const defaults = { warning_pct: 70, high_pct: 80, critical_pct: 90, hysteresis_pp: 3,
  notification_cooldown_h: 12, command_error_cooldown_h: 6, trend_24h_pp: 5, trend_7d_pp: 10,
  auto_remediation_cooldown_h: 6, sample_interval_min: 15, history_retention_days: 8 };
const NOW = Date.parse("2026-08-13T12:00:00Z");
const metric = (used, free = 20, categories = undefined) => ({
  used_percent: used, used_gb: 30, free_gb: free, inode_used_percent: 13, filesystem: "/",
  collected_at: new Date(NOW).toISOString(), maintenance_last_at: "1970-01-01T00:05:00Z",
  maintenance_reclaimed_bytes: 157286400, categories,
});
function configured() {
  const flow = context();
  call(f.store, call(f.validate, { payload: defaults }, flow), flow);
  return flow;
}
function evaluate(flow, payload, now = NOW, testMode = false) {
  let msg = call(f.load, { payload, testNow: now, test_mode: testMode }, flow);
  msg = call(f.normalize, msg, flow);
  if (!msg.storage.valid) return call(f.invalid, msg, flow);
  msg = call(f.history, msg, flow);
  const s = msg.storage;
  s.raw_severity = s.used >= msg.policy.critical_pct ? "critical" : s.used >= msg.policy.high_pct ? "high" : s.used >= msg.policy.warning_pct ? "warning" : "normal";
  s.severity = s.previous === "critical" && s.used >= msg.policy.critical_pct - msg.policy.hysteresis_pp ? "critical" :
    s.previous === "high" && s.used >= msg.policy.high_pct - msg.policy.hysteresis_pp && s.raw_severity !== "critical" ? "high" :
      s.previous === "warning" && s.used >= msg.policy.warning_pct - msg.policy.hysteresis_pp && s.raw_severity === "normal" ? "warning" : s.raw_severity;
  s.accelerated = (s.growth24h !== null && s.growth24h >= msg.policy.trend_24h_pp) || (s.growth7d !== null && s.growth7d >= msg.policy.trend_7d_pp);
  s.recovered = s.severity === "normal" && s.previous !== "normal";
  s.escalated = (s.severity === "critical" && s.previous !== "critical") ||
    (s.severity === "high" && ["normal", "warning"].includes(s.previous)) || (s.severity === "warning" && s.previous === "normal");
  s.capacity_due = s.escalated || (s.severity !== "normal" && s.now - Number(s.state.lastNotificationAt || 0) >= msg.policy.notification_cooldown_h * 3600000);
  s.trend_due = s.now - Number(s.state.lastTrendNotificationAt || 0) >= msg.policy.notification_cooldown_h * 3600000;
  s.remediation_needed = s.accelerated || s.severity !== "normal";
  s.remediation_due = s.remediation_needed && s.now - Number(s.state.lastAutoRemediationAt || 0) >= msg.policy.auto_remediation_cooldown_h * 3600000;
  s.alert_kind = s.recovered ? "recovery" : s.capacity_due ? "capacity" : s.accelerated && s.trend_due ? "trend" : "none";
  msg = call(f.alert, msg, flow);
  msg = call(f.state, msg, flow);
  msg = call(f.attributes, msg, flow);
  msg = call(f.mqtt, msg, flow);
  return call(f.finalize, msg, flow);
}
const accept = (flow, alert) => call(f.ack, alert, flow);

for (const id of [
  "storage_visual_policy_switch", "storage_visual_policy_available", "storage_visual_metrics_valid",
  "storage_visual_error_due", "storage_visual_raw_severity", "storage_visual_keep_critical",
  "storage_visual_keep_high", "storage_visual_keep_warning", "storage_visual_recovery_gate",
  "storage_visual_capacity_gate", "storage_visual_trend_gate", "storage_visual_remediation_gate",
  "storage_visual_remediation_cooldown",
]) assert.equal(byId.get(id)?.type, "switch", `decisão visual ausente: ${id}`);

const policyFlow = configured();
assert.deepEqual(call(f.load, {}, policyFlow).policy, { version: 2, ...defaults });
assert.deepEqual(policyFlow.stores.persistent.get("storage_health_config_v1").thresholds, { warning: 70, high: 80, critical: 90 });
for (const payload of [
  { ...defaults, warning_pct: 0 }, { ...defaults, high_pct: 70 }, { ...defaults, critical_pct: 80 },
  { ...defaults, hysteresis_pp: 21 }, { ...defaults, notification_cooldown_h: 0 },
  { ...defaults, trend_24h_pp: 0 }, { ...defaults, sample_interval_min: 121 }, { ...defaults, history_retention_days: 1 },
]) assert.equal(call(f.validate, { payload }, policyFlow).policy_valid, false);
assert.equal(call(f.validate, { payload: { ...defaults, warning_pct: 1, high_pct: 2, critical_pct: 3, hysteresis_pp: 0 } }, policyFlow).policy_valid, true);
assert.equal(call(f.validate, { payload: { ...defaults, warning_pct: 98, high_pct: 99, critical_pct: 100, hysteresis_pp: 20 } }, policyFlow).policy_valid, true);
assert.deepEqual(call(f.load, {}, policyFlow).policy, { version: 2, ...defaults }, "inválido não substitui política");

let flow = configured();
let result = evaluate(flow, metric(69));
assert.equal(flow.stores.persistent.get("storage_health_state_v1").severity, "normal");
assert.equal(result[1], null);
assert.equal(result[0].find((message) => message.topic.endsWith("/status")).payload, "normal");

flow = configured();
result = evaluate(flow, metric(70));
assert.equal(flow.stores.persistent.get("storage_health_state_v1").severity, "warning");
assert.match(result[1].payload.message, /70\.0%/);
accept(flow, result[1]);
assert.equal(evaluate(flow, metric(68), NOW + 900000)[1], null, "histerese mantém warning sem duplicar");
result = evaluate(flow, metric(66.9), NOW + 1800000);
assert.match(result[1].payload.message, /back to normal/);

flow = configured();
flow.stores.persistent.set("storage_health_history_v1", [{ ts: NOW - 86400000, used: 55 }]);
flow.stores.persistent.set("storage_health_category_history_v1", [{ ts: NOW - 86400000, values: { docker: 12000000000, recorder: 4000000000 } }]);
result = evaluate(flow, metric(64, 20, { docker: 16000000000, recorder: 4100000000 }));
assert.equal(flow.stores.persistent.get("storage_health_state_v1").growthCause, "Docker");
assert.match(result[1].payload.message, /causa provavel: Docker \+3\.7 GiB\/24h/);
assert.equal(result[3].storageAutoRemediation, true);
assert.equal(result[3].payload.reason, "accelerated-growth");

flow = configured();
result = evaluate(flow, { used_percent: "unknown", free_gb: -1 });
assert.match(result[1].payload.message, /metricas validas/);
accept(flow, result[1]);
assert.equal(evaluate(flow, {}, NOW + 60000)[1], null, "erro respeita cooldown após aceite");

flow = configured();
flow.stores.persistent.set("storage_health_history_v1", [{ ts: NOW - 86400000, used: 55 }]);
result = evaluate(flow, metric(64), NOW, true);
assert.deepEqual(result[0], []);
assert.equal(result[1], null);
assert.equal(result[3].test_mode, true);
const dry = call(f.gate, result[3], flow);
assert.equal(dry[0], null);
assert.equal(dry[1], null);
assert.equal(dry[2].payload.dispatched, false);

assert.equal(byId.get("storage_health_tick")?.repeat, "900");
assert.equal(byId.get("storage_daily_maintenance")?.crontab, "23 */6 * * *");
assert.equal(byId.get("storage_exec_maintenance")?.command, "/opt/storage-health-maintenance.sh --apply");
assert.equal(byId.get("storage_request_host_maintenance")?.command, "/opt/request-host-storage-maintenance.sh");
assert.equal(byId.get("storage_exec_inspection")?.command, "/opt/storage-health-maintenance.sh --dry-run --deep");
for (const id of ["storage_notify", "storage_notify_secondary"]) assert.equal(byId.get(id)?.action, "public_bindings.call");
assert.equal(byId.has("storage_evaluate"), false);
for (const node of tabNodes.filter((entry) => entry.type === "function" && !["storage_discovery", "storage_visual_history_analyze"].includes(entry.id))) {
  assert.ok(node.func.length < 2000, `JavaScript residual grande: ${node.id}`);
}
console.log("Storage visual policy: bounds, thresholds, hysteresis, trend, recovery, invalid input and dry-run passed.");
