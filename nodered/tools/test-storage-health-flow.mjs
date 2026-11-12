#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";

const flowsPath = process.argv[2] ?? new URL("../flows.json", import.meta.url);
const flows = JSON.parse(fs.readFileSync(flowsPath, "utf8"));
const byId = new Map(flows.map((node) => [node.id, node]));
const logicalWireTargets = (id, output = 0) => (byId.get(id)?.wires?.[output] ?? []).flatMap((targetId) => {
  const target = byId.get(targetId);
  const generatedRoute = target?.notification_hub_wire_route || /^notification_hub_wire_out_[a-f0-9]{12}$/.test(target?.id ?? "");
  if (target?.type !== "link out" || !generatedRoute) return [targetId];
  return (target.links ?? []).flatMap((linkInId) => byId.get(linkInId)?.wires?.[0] ?? []);
});
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
  seed: compile("storage_visual_history_seed"), history: compile("storage_visual_history_analyze"), alert: compile("storage_visual_alert_build"),
  state: compile("storage_visual_state_finalize"), attributes: compile("storage_visual_attributes_build"),
  mqtt: compile("storage_visual_mqtt_build"), finalize: compile("storage_visual_output_route"), invalid: compile("storage_visual_invalid_finalize"),
  ack: compile("storage_notification_ack"), gate: compile("storage_auto_gate"),
  collection: compile("storage_visual_collection_assess"), retry: compile("storage_visual_retry_build"),
  retryGuard: compile("storage_visual_retry_guard"), notification: compile("storage_visual_notification_prepare"),
};
const defaults = { warning_pct: 70, high_pct: 80, critical_pct: 90, hysteresis_pp: 3,
  notification_cooldown_h: 24, command_error_cooldown_h: 6, trend_24h_pp: 5, trend_7d_pp: 10,
  auto_remediation_cooldown_h: 6, sample_interval_min: 15, history_retention_days: 8,
  collection_retry_delay_s: 60, collection_max_retries: 3, metric_max_age_s: 300 };
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
  // Nominal samples are fresh at each polling time; stale cases are explicit below.
  if (payload.collected_at === new Date(NOW).toISOString()) payload = { ...payload, collected_at: new Date(now).toISOString() };
  let msg = call(f.load, { payload, testNow: now, test_mode: testMode }, flow);
  msg = call(f.normalize, msg, flow);
  msg = call(f.collection, msg, flow);
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
  s.capacity_due = s.escalated || (s.severity !== "normal" && s.now - Math.max(Number(s.state.lastNotificationAt || 0), Number(s.state.lastTrendNotificationAt || 0)) >= msg.policy.notification_cooldown_h * 3600000);
  s.trend_due = s.now - Math.max(Number(s.state.lastNotificationAt || 0), Number(s.state.lastTrendNotificationAt || 0)) >= msg.policy.notification_cooldown_h * 3600000;
  s.remediation_needed = s.accelerated || s.severity !== "normal";
  s.remediation_due = s.remediation_needed && s.now - Number(s.state.lastAutoRemediationAt || 0) >= msg.policy.auto_remediation_cooldown_h * 3600000;
  s.alert_kind = s.recovered ? "recovery" : s.capacity_due ? "capacity" : s.accelerated && s.trend_due ? "trend" : "none";
  msg = call(f.alert, msg, flow);
  msg = call(f.state, msg, flow);
  msg = call(f.attributes, msg, flow);
  msg = call(f.mqtt, msg, flow);
  return call(f.finalize, msg, flow);
}
const accept = (flow, alert) => { for (const channel of ["mobile", "persistent", "logbook"]) call(f.ack, { ...alert, notification_delivery: { channel } }, flow); };

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
flow.stores.persistent.set("storage_health_history_v1", [{ ts: NOW - 86400000, used: 55, source: "production" }]);
flow.stores.persistent.set("storage_health_category_history_v1", [{ ts: NOW - 86400000, source: "production", values: { docker: 12000000000, recorder: 4000000000 } }]);
result = evaluate(flow, metric(64, 20, { docker: 16000000000, recorder: 4100000000 }));
assert.equal(flow.stores.persistent.get("storage_health_state_v1").growthCause, "Docker");
assert.match(result[1].payload.message, /causa provavel: Docker \+3\.7 GiB\/24h/);
assert.equal(result[3].storageAutoRemediation, true);
assert.equal(result[3].payload.reason, "accelerated-growth");

flow = configured();
const originalNow = Date.now;
Date.now = () => NOW;
call(f.seed, { payload: [
  { state: "50", last_updated: new Date(NOW - 604800000).toISOString() },
  { state: "55", last_updated: new Date(NOW - 86400000).toISOString() },
  { state: null, last_updated: new Date(NOW - 172800000).toISOString() },
  { state: "unavailable", last_updated: new Date(NOW - 43200000).toISOString() },
  { state: "80", last_updated: new Date(NOW + 86400000).toISOString() },
] }, flow);
Date.now = originalNow;
result = evaluate(flow, metric(64));
assert.equal(flow.stores.persistent.get("storage_health_state_v1").growth24h, 9);
assert.equal(flow.stores.persistent.get("storage_health_state_v1").growth7d, 14);
assert.equal(flow.stores.persistent.get("storage_health_state_v1").historyCoverageHours, 168);
assert.equal(result[0].find((message) => message.topic.endsWith("/history_coverage_hours")).payload, "168");

flow = configured();
result = evaluate(flow, { used_percent: "unknown", free_gb: -1 });
assert.equal(result[1], null, "primeira falha não alerta sobre o disco");
assert.equal(result[3].storage.retry_due, true);
for (let i = 1; i <= 3; i++) result = evaluate(flow, {}, NOW + i * 60000);
assert.match(result[1].payload.message, /não confirma defeito/);
accept(flow, result[1]);
assert.equal(evaluate(flow, {}, NOW + 240000)[1], null, "erro respeita cooldown após aceite");

flow = configured();
flow.stores.persistent.set("storage_health_history_v1", [{ ts: NOW - 86400000, used: 55, source: "production" }]);
flow.stores.default.set("storage_health_history_v1__test", [{ ts: NOW - 86400000, used: 55, source: "test" }]);
const productionHistory = structuredClone(flow.stores.persistent.get("storage_health_history_v1"));
result = evaluate(flow, metric(64), NOW, true);
assert.deepEqual(result[0], []);
assert.equal(result[1], null);
assert.equal(result[3].test_mode, true);
const dry = call(f.gate, result[3], flow);
assert.equal(dry[0], null);
assert.equal(dry[1], null);
assert.equal(dry[2].payload.dispatched, false);
assert.deepEqual(flow.stores.persistent.get("storage_health_history_v1"), productionHistory, "teste não altera histórico de produção");
assert.equal(flow.stores.persistent.has("storage_health_state_v1"), false, "teste não altera estado de produção");
assert.equal(flow.stores.default.get("storage_health_state_v1__test").severity, "normal");

flow = configured();
flow.stores.persistent.set("storage_health_history_v1", [{ ts: NOW - 86400000, used: 55, source: "production" }]);
flow.stores.persistent.set("storage_health_category_history_v1", [{ ts: NOW - 86400000, source: "production", values: { manualSnapshots: 1000000000 } }]);
result = evaluate(flow, metric(64, 20, { manualSnapshots: 3000000000, backupArchives: 2000000000 }));
assert.equal(flow.stores.persistent.get("storage_health_state_v1").growthCause, "snapshots manuais do Home Assistant");

assert.equal(byId.get("storage_health_tick")?.repeat, "900");
assert.equal(byId.get("storage_visual_history_seed_tick")?.crontab, "10 02 * * *");
assert.equal(byId.get("storage_visual_history_seed_tick")?.onceDelay, "12");
assert.equal(byId.get("storage_visual_history_fetch")?.type, "api-get-history");
assert.equal(byId.get("storage_visual_history_fetch")?.entityId, "sensor.raspberry_pi_storage_usage");
assert.equal(byId.get("storage_visual_history_fetch")?.relativeTime, "8 days");
assert.deepEqual(logicalWireTargets("storage_visual_history_seed_in"), ["storage_read_ha"]);
assert.match(byId.get("storage_discovery")?.func ?? "", /raspberry_storage_history_coverage/);
assert.match(byId.get("storage_discovery")?.func ?? "", /sensor\.raspberry_pi_storage_history_coverage/);
assert.equal(byId.get("storage_daily_maintenance")?.crontab, "23 */6 * * *");
assert.equal(byId.get("storage_exec_maintenance")?.command, "/opt/storage-health-maintenance.sh --apply");
assert.equal(byId.get("storage_request_host_maintenance")?.command, "/opt/request-host-storage-maintenance.sh");
assert.equal(byId.get("storage_exec_inspection")?.command, "/opt/storage-health-maintenance.sh --dry-run --deep");
for (const [id, recipient] of [["storage_notify", "resident_primary"]]) {
  assert.equal(byId.get(id)?.type, "change");
  assert.match(byId.get(id).rules.map((rule) => String(rule.to ?? "")).join("\n"), new RegExp(`"recipients":\\["${recipient}"\\]`));
  assert.deepEqual(byId.get(`${id}__hub_call`)?.links, ["notification_hub_mobile_in"]);
}
assert.equal(byId.has("storage_evaluate"), false);
assert.equal(byId.has("storage_notify_secondary"), false);
assert.equal(byId.has("storage_notify_secondary__hub_call"), false);
for (const node of tabNodes.filter((entry) => entry.type === "function" && !["storage_discovery", "storage_visual_history_analyze"].includes(entry.id))) {
  assert.ok(node.func.length < 2000, `JavaScript residual grande: ${node.id}`);
}
console.log("Storage visual policy: bounds, thresholds, hysteresis, trend, recovery, invalid input and dry-run passed.");

// Regression: one reading must not fan out to both high and warning.
assert.equal(byId.get("storage_visual_raw_severity").checkall, "false");
flow = configured();
result = evaluate(flow, metric(81)); accept(flow, result[1]);
for (const hours of [0.25, 1, 6, 12, 23]) assert.equal(evaluate(flow, metric(81), NOW+hours*3600000)[1], null);
result=evaluate(flow, metric(81), NOW+86400000); assert.ok(result[1]); accept(flow,result[1]);
result=evaluate(flow, metric(91), NOW+86400000+60000); assert.ok(result[1], "escalation remains immediate");accept(flow,result[1]);
result=evaluate(flow,metric(60),NOW+86400000+120000); assert.ok(result[1], "recovery remains immediate");
flow=configured();flow.set("storage_health_policy_v2",{version:2,...defaults,notification_cooldown_h:12},"persistent");
flow.set("storage_health_state_v1",{severity:"high",lastNotificationAt:NOW},"persistent");
assert.equal(call(f.load,{},flow).policy.notification_cooldown_h,24);assert.equal(flow.get("storage_health_state_v1","persistent").lastNotificationAt,NOW);

// Execute the actual JSONata reminder rules, rather than only the JS test model.
const { createRequire } = await import("node:module");
const jsonata = createRequire(import.meta.url)("jsonata");
const facts = byId.get("storage_visual_facts").rules;
for (const field of ["storage.capacity_due", "storage.trend_due"]) {
 const expression=jsonata(facts.find(r=>r.p===field).to);
 const sample={policy:{notification_cooldown_h:24},storage:{severity:"high",escalated:false,now:NOW+3600000,state:{lastNotificationAt:NOW,lastTrendNotificationAt:0}}};
 assert.equal(await expression.evaluate(sample),false);
 sample.storage.now=NOW+86400000;assert.equal(await expression.evaluate(sample),true);
 sample.storage.now=NOW+60000;sample.storage.escalated=true;
 assert.equal(await expression.evaluate(sample),field==="storage.capacity_due");
}

// Execute actual collection/retry adapters: no capacity decisions on invalid facts.
for (const value of [null, '', ' ', false, [], {}, 'unknown', 'unavailable', Infinity, -1, 101]) {
  const ctx = configured();
  const sample = metric(value);
  const normalized = call(f.normalize, call(f.load, { payload: sample, testNow: NOW }, ctx), ctx);
  assert.equal(normalized.storage.valid, false, `invalid numeric reading: ${JSON.stringify(value)}`);
  const output = evaluate(ctx, sample);
  assert.equal(output[1], null); assert.equal(output[3]?.storage.retry_due, true);
  assert.equal(ctx.get('storage_health_history_v1', 'persistent'), undefined);
}
flow = configured();
let normalized = call(f.normalize, call(f.load, { payload: { ...metric(95), collected_at: new Date(NOW - 301000).toISOString() }, testNow: NOW }, flow), flow);
assert.equal(normalized.storage.valid, false, 'stale critical reading is not a disk alarm');
normalized = call(f.normalize, call(f.load, { payload: metric(95), storageReadError: true, testNow: NOW }, flow), flow);
assert.equal(normalized.storage.valid, false, 'API failures never authorize cleanup');
flow = configured();
evaluate(flow, metric(81));
const beforeSeverity = flow.get('storage_health_state_v1', 'persistent').severity;
result = evaluate(flow, {}, NOW + 1000);
const timer = call(f.retry, result[3], flow);
assert.equal(timer.delay, 60000); assert.equal(timer.storageRetry.attempt, 1);
assert.deepEqual(call(f.retryGuard, timer, flow), {});
assert.equal(evaluate(flow, {}, NOW + 2000)[3], null, 'overlapping polls do not schedule another timer');
assert.equal(flow.get('storage_health_state_v1', 'persistent').severity, beforeSeverity);
result = evaluate(flow, metric(81), NOW + 3000);
assert.equal(call(f.retryGuard, timer, flow), null, 'valid reading cancels stale queued retry');
assert.notEqual(result[1]?.payload.title, 'Raspberry Pi - storage indisponivel');
flow = configured();
for (let i = 0; i <= 3; i++) result = evaluate(flow, {}, NOW + i * 60000);
const confirmedAlert = result[1];
assert.ok(confirmedAlert.collection_error); assert.equal(result[3], null, 'bounded retries');
call(f.ack, { ...confirmedAlert, notification_delivery: { channel: 'mobile' } }, flow);
assert.ok(flow.get('storage_health_state_v1', 'persistent').pendingAlert, 'mobile alone cannot acknowledge persistence');
call(f.ack, { ...confirmedAlert, notification_delivery: { channel: 'persistent' } }, flow);
assert.ok(flow.get('storage_health_state_v1', 'persistent').pendingAlert, 'history also requires acceptance');
call(f.ack, { ...confirmedAlert, storageNotificationChannel: 'logbook' }, flow);
assert.equal(flow.get('storage_health_state_v1', 'persistent').pendingAlert, null);
result = evaluate(flow, metric(60), NOW + 240000);
assert.match(result[1].payload.title, /leitura.*normalizada/);
assert.equal(flow.get('storage_health_state_v1', 'persistent').collectionStatus, 'ok');
assert.equal(evaluate(flow, metric(60), NOW + 241000)[1], null, 'collection recovery once');
const firstNotice = call(f.notification, structuredClone(confirmedAlert), flow);
const secondNotice = call(f.notification, structuredClone(result[1]), flow);
assert.notEqual(firstNotice.payload.notification_id, secondNotice.payload.notification_id);
assert.match(firstNotice.payload.message, /Ocorrência:/);
const persistentIdRule = byId.get('storage_notify_persistent').rules.find(r => r.p === 'notification');
assert.match(persistentIdRule.to, /payload.notification_id/);
assert.equal(byId.get('storage_visual_retry_delay').pauseType, 'delayv');
assert.deepEqual(logicalWireTargets('storage_visual_retry_read_in'), ['storage_read_ha']);
assert.deepEqual(byId.get('storage_visual_read_catch').scope, ['storage_read_ha']);
flow = configured();
const realState = structuredClone(flow.stores.persistent);
for (let i = 0; i <= 3; i++) {
  result = evaluate(flow, {}, NOW + i * 60000, true);
  assert.deepEqual(result[0], []); assert.equal(result[1], null);
  assert.equal(result[2].test_mode, true);
  if (result[3]) assert.equal(call(f.retry, result[3], flow).test_mode, true);
}
assert.deepEqual(flow.stores.persistent, realState, 'synthetic failures never mutate production');
console.log('Storage collection: strict metrics, freshness, bounded retry, recovery, persistence and dry-run passed.');

assert.equal(byId.get('storage_visual_logbook').action, 'logbook.log');
assert.equal(byId.get('storage_visual_logbook').queue, 'all');
assert.equal(byId.get('storage_visual_notification_test_gate').property, 'test_mode');
