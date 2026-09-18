#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";

const flowSource = globalThis.process.argv[2] ?? new URL("../flows.json", import.meta.url);
const flows = JSON.parse(fs.readFileSync(flowSource, "utf8"));
const byId = new Map(flows.map((node) => [node.id, node]));
const TAB = "monitoramento_internet_tab";

function getFunction(id) {
  const flowNode = byId.get(id);
  assert.equal(flowNode?.type, "function", `function ausente: ${id}`);
  return new Function("msg", "flow", "node", "global", flowNode.func);
}
function context(initial = {}) {
  const stores = {
    default: new Map(Object.entries(initial.default ?? {})),
    persistent: new Map(Object.entries(initial.persistent ?? {})),
    memoryOnly: new Map(Object.entries(initial.memoryOnly ?? {})),
  };
  return {
    stores,
    get(key, store = "default") { return stores[store].get(key); },
    set(key, value, store = "default") { stores[store].set(key, structuredClone(value)); },
  };
}
const nodeMock = { status() {}, warn() {}, error(error) { throw new Error(String(error)); }, done() {}, send() {} };
const globalMock = { get() { return undefined; } };
const tabNodes = flows.filter((node) => node.z === TAB);
assert.equal(byId.get(TAB)?.label, "monitoramento_internet");
assert.ok(tabNodes.length >= 65);

for (const id of [
  "internet_policy_switch",
  "internet_policy_available",
  "internet_source_switch",
  "internet_reachable_switch",
  "internet_success_incident_switch",
  "internet_failure_incident_switch",
  "internet_action_switch",
  "internet_recovery_threshold",
  "internet_failure_threshold",
  "internet_phase_switch",
  "internet_notification_event",
  "internet_notification_test_gate",
  "internet_publication_test_gate",
  "internet_remote_internet_online",
  "internet_remote_health_switch",
  "internet_remote_failure_incident",
  "internet_remote_failure_threshold",
  "internet_remote_recoverable",
  "internet_remote_request_due",
  "internet_remote_request_gate",
  "internet_remote_alert_test_gate",
  "internet_remote_dismiss_test_gate",
]) assert.equal(byId.get(id)?.type, "switch", `decisão visual ausente: ${id}`);

const validate = getFunction("internet_policy_validate");
const store = getFunction("internet_policy_store");
const load = getFunction("internet_policy_load");
const normalize = getFunction("internet_results_normalize");
const read = getFunction("internet_state_read");
const mutate = getFunction("internet_state_mutate");
const finalize = getFunction("internet_finalize");
const buildNotification = getFunction("internet_notification_build");
const expand = getFunction("internet_publications_expand");
const restore = getFunction("internet_restore_history");
const dry = getFunction("internet_dry_run_terminal");
const remoteIngest = getFunction("internet_remote_access_report_ingest");
const remoteFacts = getFunction("internet_remote_facts_read");
const remoteMutate = getFunction("internet_remote_state_mutate");
const remoteAlert = getFunction("internet_remote_alert_build");
const remoteDry = getFunction("internet_remote_dry_run_terminal");
const targets = [
  { name: "cloudflare", address: "1.1.1.1" },
  { name: "google", address: "8.8.8.8" },
  { name: "quad9", address: "9.9.9.9" },
];
const defaults = {
  targets,
  required_responses: 2,
  failure_cycles: 3,
  recovery_cycles: 2,
  ping_timeout_s: 2,
  exec_timeout_ms: 3000,
  remote_access_failure_cycles: 1,
  remote_access_report_stale_s: 180,
  remote_access_recovery_cooldown_s: 300,
};
const flow = context();
let message = validate({ payload: defaults }, flow, nodeMock, globalMock);
assert.equal(message.policy_valid, true);
assert.equal(store(message, flow, nodeMock, globalMock), null);
assert.deepEqual(load({}, flow, nodeMock, globalMock).policy, { version: 1, ...defaults });
for (const payload of [
  { ...defaults, required_responses: 0 },
  { ...defaults, required_responses: 4 },
  { ...defaults, failure_cycles: 0 },
  { ...defaults, recovery_cycles: 11 },
  { ...defaults, ping_timeout_s: 0 },
  { ...defaults, exec_timeout_ms: 2000 },
  { ...defaults, remote_access_failure_cycles: 0 },
  { ...defaults, remote_access_report_stale_s: 29 },
  { ...defaults, remote_access_recovery_cooldown_s: 59 },
  { ...defaults, targets: targets.slice(0, 2) },
  { ...defaults, targets: [targets[0], targets[0], targets[2]] },
]) assert.equal(validate({ payload }, flow, nodeMock, globalMock).policy_valid, false);
assert.equal(validate({ payload: { ...defaults, required_responses: 1, failure_cycles: 1, recovery_cycles: 1, ping_timeout_s: 1, exec_timeout_ms: 1001, remote_access_failure_cycles: 1, remote_access_report_stale_s: 30, remote_access_recovery_cooldown_s: 60 } }, flow, nodeMock, globalMock).policy_valid, true);
assert.equal(validate({ payload: { ...defaults, required_responses: 3, failure_cycles: 10, recovery_cycles: 10, ping_timeout_s: 10, exec_timeout_ms: 15000, remote_access_failure_cycles: 5, remote_access_report_stale_s: 900, remote_access_recovery_cooldown_s: 3600 } }, flow, nodeMock, globalMock).policy_valid, true);
assert.deepEqual(load({}, flow, nodeMock, globalMock).policy, { version: 1, ...defaults }, "inválidos não substituem política");

let now = Date.UTC(2026, 8, 12, 1, 0, 0);
function sample(okCount, testMode = false) {
  return {
    _internet_test: testMode,
    monitor_now: now,
    policy: { version: 1, ...defaults },
    payload: {
      test_mode: testMode,
      checked_at: new Date(now).toISOString(),
      results: targets.map((target, index) => ({ ...target, ok: index < okCount })),
    },
  };
}
function process(targetFlow, okCount, testMode = false) {
  let msg = normalize(sample(okCount, testMode), targetFlow, nodeMock, globalMock);
  msg = read(msg, targetFlow, nodeMock, globalMock);
  const reachable = msg.internet_targets_ok >= msg.policy.required_responses;
  if (reachable) {
    msg.internet_state_action = msg.internet_incident_open ? "success_incident" : "healthy_baseline";
    msg.internet_event = "none";
  } else {
    msg.internet_state_action = msg.internet_incident_open ? "failure_open" : "failure_candidate";
    msg.internet_event = "none";
  }
  msg = mutate(msg, targetFlow, nodeMock, globalMock);
  if (msg.internet_state_action === "success_incident" &&
      msg.internet_state.consecutive_successes >= msg.policy.recovery_cycles) {
    msg.internet_state_action = "recover_online";
    msg.internet_event = "recovery";
    msg = mutate(msg, targetFlow, nodeMock, globalMock);
  } else if (msg.internet_state_action === "failure_candidate" &&
      msg.internet_state.consecutive_failures >= msg.policy.failure_cycles) {
    msg.internet_state_action = "open_failure";
    msg.internet_event = "down";
    msg = mutate(msg, targetFlow, nodeMock, globalMock);
  }
  return finalize(msg, targetFlow, nodeMock, globalMock);
}

let result = process(flow, 3);
assert.equal(result.internet_state.phase, "online");
assert.equal(result.internet_event, "none");
now += 30000;
result = process(flow, 2);
assert.equal(result.internet_state.phase, "online", "quorum exato permanece online");
for (let attempt = 1; attempt <= 3; attempt += 1) {
  now += 30000;
  result = process(flow, 0);
  assert.equal(result.internet_event === "down", attempt === 3);
}
assert.equal(result.internet_state.phase, "offline");
const down = buildNotification(result, flow, nodeMock, globalMock);
assert.equal(down.notification.id, "internet_connection_failure");
assert.match(down.notification.message, /3 ciclos/);
now += 30000;
assert.equal(process(flow, 0).internet_event, "none", "offline contínuo não duplica alerta");
now += 30000;
assert.equal(process(flow, 3).internet_state.phase, "recovering");
now += 30000;
result = process(flow, 0);
assert.equal(result.internet_state.phase, "offline", "oscilação reinicia sucessos");
now += 30000;
process(flow, 3);
now += 30000;
result = process(flow, 3);
assert.equal(result.internet_event, "recovery");
assert.equal(result.internet_state.phase, "online");
assert.ok(result.internet_state.last_outage_duration_s > 0);
assert.equal(buildNotification(result, flow, nodeMock, globalMock).notification.dismiss_id, "internet_connection_failure");
assert.equal(expand(result, flow, nodeMock, globalMock).length, 3);

for (let attempt = 0; attempt < 3; attempt += 1) {
  now += 30000;
  result = process(flow, 0);
}
const persistedState = structuredClone(flow.get("internet_monitor_state_v1", "persistent"));
const persistedHistory = structuredClone(flow.get("internet_monitor_history_v1", "persistent"));
const restarted = context({ persistent: {
  internet_monitor_state_v1: persistedState,
  internet_monitor_history_v1: persistedHistory,
  internet_monitor_policy_v1: flow.get("internet_monitor_policy_v1", "persistent"),
} });
now += 30000;
assert.equal(process(restarted, 3).internet_event, "none");
now += 30000;
assert.equal(process(restarted, 3).internet_event, "recovery", "incidente sobrevive ao restart");

const recovered = context();
restore({ payload: JSON.stringify({
  last_outage: "2026-08-13T20:00:51.226Z",
  last_recovery: "2026-08-13T20:08:19.281Z",
  last_outage_duration_s: 448,
}) }, recovered, nodeMock, globalMock);
assert.equal(recovered.get("internet_monitor_history_v1", "persistent").last_outage_duration_s, 448);

const testFlow = context({ persistent: { internet_monitor_policy_v1: flow.get("internet_monitor_policy_v1", "persistent") } });
result = process(testFlow, 0, true);
assert.equal(result._internet_test, true);
assert.equal(flow.get("internet_monitor_state_v1__test"), undefined, "teste não contamina produção");
dry(result, testFlow, nodeMock, globalMock);
assert.equal(testFlow.get("internet_monitor_last_dry_run_v1__test").dispatched, false);
assert.deepEqual(byId.get("internet_notification_test_gate").wires[0], ["internet_dry_out"]);
assert.deepEqual(byId.get("internet_publication_test_gate").wires[0], ["internet_publication_dry_out"]);

const remoteFlow = context({ persistent: {
  internet_monitor_policy_v1: flow.get("internet_monitor_policy_v1", "persistent"),
  internet_monitor_state_v1: { phase: "online" },
} });
const remoteReport = (healthy, checkedAt, testMode = false) => ({
  schema_version: 1,
  test_mode: testMode,
  checked_at: checkedAt,
  services: {
    remote_shell: { healthy: true, reason: "service_active" },
    codex_remote: { installed: true, healthy, reason: healthy ? "app_server_ready" : "app_server_absent" },
  },
});
const remoteNow = Date.UTC(2026, 8, 18, 20, 0, 0);
let remoteMsg = remoteIngest({ payload: remoteReport(false, new Date(remoteNow).toISOString()) }, remoteFlow, nodeMock, globalMock);
remoteMsg = load(remoteMsg, remoteFlow, nodeMock, globalMock);
remoteMsg.remote_access_now = remoteNow;
remoteMsg = remoteFacts(remoteMsg, remoteFlow, nodeMock, globalMock);
assert.equal(remoteMsg.remote_access.codex_recoverable, true);
assert.equal(remoteMsg.remote_access.request_due, true);
remoteMsg.remote_access_state_action = "failure";
remoteMsg = remoteMutate(remoteMsg, remoteFlow, nodeMock, globalMock);
assert.equal(remoteMsg.remote_access_state.consecutive_failures, 1);
remoteMsg.remote_access_state_action = "open";
remoteMsg = remoteMutate(remoteMsg, remoteFlow, nodeMock, globalMock);
assert.equal(remoteMsg.remote_access_event, "down");
assert.equal(remoteMsg.remote_access_state.incident_open, true);
const alert = remoteAlert(remoteMsg, remoteFlow, nodeMock, globalMock);
assert.equal(alert.payload.incident_key, "remote_access_ssh_unavailable");
assert.match(alert.alert.message, /monitoramento_vpn/);
remoteMsg.remote_access_state_action = "request";
remoteMsg = remoteMutate(remoteMsg, remoteFlow, nodeMock, globalMock);
assert.equal(remoteMsg.remote_access_state.last_request_at, remoteNow);

let recoveredRemote = remoteIngest({ payload: remoteReport(true, new Date(remoteNow + 60_000).toISOString()) }, remoteFlow, nodeMock, globalMock);
recoveredRemote = load(recoveredRemote, remoteFlow, nodeMock, globalMock);
recoveredRemote.remote_access_now = remoteNow + 60_000;
recoveredRemote = remoteFacts(recoveredRemote, remoteFlow, nodeMock, globalMock);
recoveredRemote.remote_access_state_action = "healthy";
recoveredRemote = remoteMutate(recoveredRemote, remoteFlow, nodeMock, globalMock);
assert.equal(recoveredRemote.remote_access_event, "recovery");
assert.equal(recoveredRemote.remote_access_state.incident_open, false);

const remoteTestFlow = context({ default: { internet_monitor_state_v1__test: { phase: "online" } }, persistent: {
  internet_monitor_policy_v1: flow.get("internet_monitor_policy_v1", "persistent"),
} });
let remoteTest = remoteIngest({ _internet_test: true, payload: remoteReport(false, new Date(remoteNow).toISOString(), true) }, remoteTestFlow, nodeMock, globalMock);
remoteTest = load(remoteTest, remoteTestFlow, nodeMock, globalMock);
remoteTest.remote_access_now = remoteNow;
remoteTest = remoteFacts(remoteTest, remoteTestFlow, nodeMock, globalMock);
remoteTest.remote_access_state_action = "failure";
remoteTest = remoteMutate(remoteTest, remoteTestFlow, nodeMock, globalMock);
remoteTest.remote_access_state_action = "open";
remoteTest = remoteMutate(remoteTest, remoteTestFlow, nodeMock, globalMock);
remoteDry(remoteTest, remoteTestFlow, nodeMock, globalMock);
assert.equal(remoteTestFlow.get("internet_remote_access_last_dry_run_v1__test").dispatched, false);
assert.equal(remoteTestFlow.get("internet_remote_access_state_v1", "persistent"), undefined, "TESTE não contamina recovery real");
assert.deepEqual(byId.get("internet_remote_request_gate").wires[0], ["internet_remote_dry_out"]);
assert.deepEqual(byId.get("internet_remote_alert_test_gate").wires[0], ["internet_remote_dry_out"]);
assert.deepEqual(byId.get("internet_remote_dismiss_test_gate").wires[0], ["internet_remote_dry_out"]);
assert.equal(byId.get("internet_remote_alert_dismiss").type, "change", "dismiss deve usar o hub persistente");
assert.equal(byId.get("internet_remote_alert_dismiss__hub_call").type, "link call", "chamada do hub persistente ausente");
assert.equal(byId.get("internet_remote_request_worker").command, "/opt/request-host-codex-remote-recovery.sh");

const ping = getFunction("internet_ping");
async function testLock(throwFirst = false) {
  const pingFlow = context();
  let calls = 0;
  let active = 0;
  let sends = 0;
  const childProcess = {
    execFile(_file, args, options, callback) {
      calls += 1;
      assert.equal(args[4], "2");
      assert.ok(targets.some((target) => target.address === args[5]));
      assert.equal(options.timeout, 3000);
      if (throwFirst && calls === 1) throw new Error("spawn");
      active += 1;
      setTimeout(() => { active -= 1; callback(null, "ok", ""); }, 20);
    },
  };
  const asyncNode = { status() {}, error() {}, done() {}, send() { sends += 1; } };
  const asyncGlobal = { get(key) { return key === "childProcess" ? childProcess : undefined; } };
  const input = { policy: { version: 1, ...defaults } };
  ping(structuredClone(input), pingFlow, asyncNode, asyncGlobal);
  assert.equal(pingFlow.get("internet_ping_cycle_running", "memoryOnly"), true);
  assert.equal(ping(structuredClone(input), pingFlow, asyncNode, asyncGlobal), null);
  await new Promise((resolve) => setTimeout(resolve, 45));
  assert.equal(pingFlow.get("internet_ping_cycle_running", "memoryOnly"), false);
  assert.equal(calls, 3);
  assert.equal(active, 0);
  assert.equal(sends, 1);
}
await testLock();
await testLock(true);

const discoveryMessages = getFunction("internet_discovery")({}, flow, nodeMock, globalMock);
assert.equal(discoveryMessages[0].length, 2);
assert.match(discoveryMessages[0][0].payload, /node_red_internet_connection/);
assert.equal(byId.get("internet_mqtt_publish").retain, "true");
assert.equal(byId.get("internet_cycle").repeat, "30");
const maxFunctionSize = Math.max(...tabNodes.filter((node) => node.type === "function").map((node) => node.func.length));
assert.ok(maxFunctionSize < 2000, `JavaScript residual grande: ${maxFunctionSize}`);

console.log("Internet monitor visual flow tests passed.");
