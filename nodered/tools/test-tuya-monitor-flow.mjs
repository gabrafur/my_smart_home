#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";

const flows = JSON.parse(fs.readFileSync(new URL("../flows.json", import.meta.url), "utf8"));
const byId = new Map(flows.map((node) => [node.id, node]));
const TAB = "monitoramento_tuya_tab";
const tabNodes = flows.filter((node) => node.z === TAB);
const getFunction = (id) => {
  const node = byId.get(id);
  assert.equal(node?.type, "function", `function ausente: ${id}`);
  return new Function("msg", "flow", "node", "global", node.func);
};
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
const nodeMock = { status() {}, warn() {}, error(error) { throw new Error(String(error)); } };
const globalMock = { get() { return undefined; } };

assert.equal(byId.get(TAB)?.label, "monitoramento_tuya");
assert.ok(tabNodes.length >= 95);
for (const id of [
  "tuya_policy_switch", "tuya_policy_available", "tuya_snapshot_valid", "tuya_devices_present",
  "tuya_device_raw_switch", "tuya_device_online_incident", "tuya_device_recovery_stable",
  "tuya_device_offline_incident", "tuya_device_reminder_due", "tuya_device_failure_stable",
  "tuya_summary_empty", "tuya_summary_confirmed", "tuya_summary_offline", "tuya_summary_recovering",
  "tuya_phase_switch", "tuya_publication_test_gate", "tuya_device_event_switch", "tuya_notification_test_gate",
]) assert.equal(byId.get(id)?.type, "switch", `decisão visual ausente: ${id}`);
assert.equal(byId.get("tuya_devices_split")?.type, "split");
assert.equal(byId.get("tuya_devices_join")?.type, "join");

const validatePolicy = getFunction("tuya_policy_validate");
const storePolicy = getFunction("tuya_policy_store");
const loadPolicy = getFunction("tuya_policy_load");
const validateSnapshot = getFunction("tuya_snapshot_validate");
const normalize = getFunction("tuya_devices_normalize");
const read = getFunction("tuya_device_state_read");
const mutate = getFunction("tuya_device_state_mutate");
const deviceResult = getFunction("tuya_device_result");
const facts = getFunction("tuya_summary_facts");
const publish = getFunction("tuya_summary_publish_build");
const notification = getFunction("tuya_device_notification_build");
const queryFailure = getFunction("tuya_query_failure");
const expand = getFunction("tuya_publications_expand");
const dry = getFunction("tuya_dry_run_terminal");
const defaults = { failure_confirmation_s: 30, recovery_confirmation_s: 60, reminder_interval_h: 24 };
const flow = context();
let message = validatePolicy({ payload: defaults }, flow, nodeMock, globalMock);
assert.equal(message.policy_valid, true);
storePolicy(message, flow, nodeMock, globalMock);
assert.deepEqual(loadPolicy({}, flow, nodeMock, globalMock).policy, { version: 1, ...defaults });
for (const payload of [
  { ...defaults, failure_confirmation_s: 0 }, { ...defaults, failure_confirmation_s: 301 },
  { ...defaults, recovery_confirmation_s: 0 }, { ...defaults, recovery_confirmation_s: 601 },
  { ...defaults, reminder_interval_h: 0 }, { ...defaults, reminder_interval_h: 169 },
  { ...defaults, failure_confirmation_s: "30.5" },
]) assert.equal(validatePolicy({ payload }, flow, nodeMock, globalMock).policy_valid, false);
assert.equal(validatePolicy({ payload: { failure_confirmation_s: 1, recovery_confirmation_s: 1, reminder_interval_h: 1 } }, flow, nodeMock, globalMock).policy_valid, true);
assert.equal(validatePolicy({ payload: { failure_confirmation_s: 300, recovery_confirmation_s: 600, reminder_interval_h: 168 } }, flow, nodeMock, globalMock).policy_valid, true);
assert.deepEqual(loadPolicy({}, flow, nodeMock, globalMock).policy, { version: 1, ...defaults }, "inválido não substitui política");

const entities = [
  { entity_id: "sensor.feeder_level", device_id: "device-feeder", platform: "tuya", disabled_by: null, original_name: "Nível" },
  { entity_id: "button.feeder_feed", device_id: "device-feeder", platform: "tuya", disabled_by: null, original_name: "Alimentar" },
  { entity_id: "switch.local_relay", device_id: "device-relay", platform: "localtuya", disabled_by: null, original_name: "Relé" },
  { entity_id: "sensor.disabled", device_id: "device-disabled", platform: "tuya", disabled_by: "integration", original_name: "Desabilitado" },
  { entity_id: "sensor.zigbee", device_id: "device-zigbee", platform: "mqtt", disabled_by: null, original_name: "Zigbee" },
];
const devices = [
  { id: "device-feeder", name_by_user: "Comedouro" },
  { id: "device-relay", name: "Relé local" },
  { id: "device-disabled", name: "Desabilitado" },
];
function snapshot(at, feeder = "42", relay = "on", testMode = false) {
  return {
    monitor_now: at, _tuya_test: testMode,
    tuya_entity_registry: structuredClone(entities),
    tuya_device_registry: structuredClone(devices),
    tuya_states: [
      { entity_id: "sensor.feeder_level", state: feeder, attributes: { friendly_name: "Comedouro Nível" } },
      { entity_id: "button.feeder_feed", state: "unknown", attributes: {} },
      { entity_id: "switch.local_relay", state: relay, attributes: { friendly_name: "Relé local" } },
    ],
  };
}
function cycle(targetFlow, input) {
  let root = loadPolicy(input, targetFlow, nodeMock, globalMock);
  root = validateSnapshot(root, targetFlow, nodeMock, globalMock);
  assert.equal(root.tuya_snapshot_valid, true);
  root = normalize(root, targetFlow, nodeMock, globalMock);
  const results = [];
  const events = [];
  for (const item of root.payload) {
    let current = read({ ...root, payload: structuredClone(item) }, targetFlow, nodeMock, globalMock);
    current.tuya_event = "none";
    if (current.tuya_device.raw_state === "online") {
      if (!current.tuya_device_state.incident_open) current.tuya_device_action = "baseline";
      else if (current.tuya_stable_for_ms >= current.policy.recovery_confirmation_s * 1000) {
        current.tuya_device_action = "recover";
        current.tuya_event = "recovery";
      } else current.tuya_device_action = "recovering";
    } else if (current.tuya_device_state.incident_open) {
      if (current.tuya_now >= current.tuya_next_reminder_ms) {
        current.tuya_device_action = "reminder";
        current.tuya_event = "reminder";
      } else current.tuya_device_action = "keep_offline";
    } else if (current.tuya_stable_for_ms >= current.policy.failure_confirmation_s * 1000) {
      current.tuya_device_action = "open";
      current.tuya_event = "down";
    } else current.tuya_device_action = "checking";
    current = mutate(current, targetFlow, nodeMock, globalMock);
    if (current.tuya_event !== "none") events.push(current);
    results.push(deviceResult(current, targetFlow, nodeMock, globalMock).payload);
  }
  let summary = facts({ ...root, payload: results }, targetFlow, nodeMock, globalMock);
  summary.tuya_phase = summary.tuya_monitored_count === 0 ? "checking" :
    summary.tuya_confirmed_count > 0 ? "offline" : summary.tuya_offline_count > 0 ? "checking" :
      summary.tuya_recovering_count > 0 ? "recovering" : "online";
  summary = publish(summary, targetFlow, nodeMock, globalMock);
  return { summary, events };
}

let now = Date.UTC(2026, 0, 1, 0, 0, 0);
let result = cycle(flow, snapshot(now));
assert.equal(result.summary.tuya_phase, "online");
let attrs = JSON.parse(result.summary.tuya_publications.find((item) => item.topic.endsWith("/attributes")).payload);
assert.equal(attrs.monitored_device_count, 2);
assert.deepEqual(attrs.platforms, ["localtuya", "tuya"]);
result = cycle(flow, snapshot(now + 10000, "unavailable"));
assert.equal(result.summary.tuya_phase, "checking");
assert.equal(result.events.length, 0);
assert.equal(cycle(flow, snapshot(now + 39000, "unavailable")).events.length, 0, "29 s não confirma queda");
result = cycle(flow, snapshot(now + 40000, "unavailable"));
assert.equal(result.summary.tuya_phase, "offline");
assert.equal(result.events[0].tuya_event, "down", "limite exato de 30 s confirma queda");
const down = notification(result.events[0], flow, nodeMock, globalMock);
assert.match(down.notification.message, /Comedouro/);
assert.match(down.notification.id, /^tuya_device_/);
assert.equal(cycle(flow, snapshot(now + 41000, "unavailable")).events.length, 0, "offline contínuo não duplica");
assert.equal(cycle(flow, snapshot(now + 50000, "42")).summary.tuya_phase, "recovering");
assert.equal(cycle(flow, snapshot(now + 109000, "42")).events.length, 0, "59 s não confirma retorno");
result = cycle(flow, snapshot(now + 110000, "42"));
assert.equal(result.events[0].tuya_event, "recovery", "limite exato de 60 s confirma retorno");
const recovered = notification(result.events[0], flow, nodeMock, globalMock);
assert.equal(recovered.notification.dismiss_id, recovered.notification.id.replace(/_recovered$/, ""));

cycle(flow, snapshot(now + 120000, "unavailable"));
result = cycle(flow, snapshot(now + 150000, "unavailable"));
assert.equal(result.events[0].tuya_event, "down");
assert.equal(cycle(flow, snapshot(now + 150000 + 86400000 - 1, "unavailable")).events.length, 0);
result = cycle(flow, snapshot(now + 150000 + 86400000, "unavailable"));
assert.equal(result.events[0].tuya_event, "reminder", "lembrete no limite de 24 h");
assert.match(notification(result.events[0], flow, nodeMock, globalMock).notification.title, /continua indisponível/);
assert.equal(cycle(flow, snapshot(now + 150001 + 86400000, "unavailable")).events.length, 0, "lembrete não duplica");

const restarted = context({ persistent: {
  tuya_monitor_policy_v1: flow.get("tuya_monitor_policy_v1", "persistent"),
  tuya_device_incidents_v1: flow.get("tuya_device_incidents_v1", "persistent"),
  tuya_device_monitor_summary_v1: flow.get("tuya_device_monitor_summary_v1", "persistent"),
} });
result = cycle(restarted, snapshot(now + 150010 + 86400000, "42"));
assert.equal(result.events.length, 0);
result = cycle(restarted, snapshot(now + 210010 + 86400000, "42"));
assert.equal(result.events[0].tuya_event, "recovery", "incidente persiste e recovery reinicia após restart");

const emptyEntities = snapshot(now);
emptyEntities.tuya_entity_registry = [];
result = cycle(flow, emptyEntities);
assert.equal(result.summary.tuya_phase, "checking");
assert.equal(validateSnapshot({ tuya_states: [] }, flow, nodeMock, globalMock).tuya_snapshot_valid, false);
const failure = queryFailure({ monitor_now: now, error: { message: "Home Assistant disconnected" } }, flow, nodeMock, globalMock);
assert.equal(failure.tuya_phase, "checking");
assert.equal(expand(failure, flow, nodeMock, globalMock).length, 3);

const testFlow = context({ persistent: { tuya_monitor_policy_v1: { version: 1, ...defaults } } });
result = cycle(testFlow, snapshot(now, "unavailable", "on", true));
result = cycle(testFlow, snapshot(now + 30000, "unavailable", "on", true));
assert.equal(result.events[0].tuya_event, "down");
assert.equal(testFlow.get("tuya_device_incidents_v1", "persistent"), undefined, "teste não altera produção");
dry({ ...result.summary, _tuya_test: true }, testFlow, nodeMock, globalMock);
assert.equal(testFlow.get("tuya_last_dry_run_v1__test").dispatched, false);
assert.deepEqual(byId.get("tuya_publication_test_gate").wires[0], ["tuya_publication_dry_out"]);
assert.deepEqual(byId.get("tuya_notification_test_gate").wires[0], ["tuya_notification_dry_out"]);
assert.equal(byId.get("tuya_mqtt_publish").retain, "true");
assert.equal(byId.get("tuya_cycle").repeat, "30");
const discovery = getFunction("tuya_discovery")({}, flow, nodeMock, globalMock);
assert.equal(discovery[0].length, 2);
assert.match(discovery[0][0].payload, /node_red_tuya_devices/);
const sizes = tabNodes.filter((node) => node.type === "function").map((node) => [node.id, node.func.length]);
for (const [id, size] of sizes) {
  if (id === "tuya_devices_normalize") assert.ok(size < 2200, `adaptador estrutural cresceu: ${size}`);
  else assert.ok(size < 2000, `JavaScript residual grande em ${id}: ${size}`);
}

console.log("Tuya monitor visual flow tests passed.");
