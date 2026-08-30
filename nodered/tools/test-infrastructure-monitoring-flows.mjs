#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";

const flows = JSON.parse(fs.readFileSync(new URL("../flows.json", import.meta.url), "utf8"));

function getFunction(id) {
  const node = flows.find((item) => item.id === id);
  assert.equal(node?.type, "function", `Function node ausente: ${id}`);
  return new Function("msg", "flow", "node", "global", node.func);
}

function context(defaultStore = new Map(), memoryStore = new Map(), persistentStore = defaultStore) {
  return {
    stores: { default: defaultStore, memoryOnly: memoryStore, persistent: persistentStore },
    get(key, store = "default") {
      return this.stores[store].get(key);
    },
    set(key, value, store = "default") {
      this.stores[store].set(key, structuredClone(value));
    },
  };
}

const nodeMock = { status() {}, warn() {}, error(error) { throw new Error(String(error)); } };
const globalMock = { get() { return undefined; } };

function run(fn, flow, msg) {
  return fn(msg, flow, nodeMock, globalMock);
}

function pingResult(okCount, now) {
  const targets = ["1.1.1.1", "8.8.8.8", "9.9.9.9"];
  return {
    monitor_now: now,
    payload: {
      checked_at: new Date(now).toISOString(),
      results: targets.map((address, index) => ({
        name: `target-${index}`,
        address,
        ok: index < okCount,
      })),
    },
  };
}

const internet = getFunction("internet_evaluate");
const restoreInternetHistory = getFunction("internet_restore_history");
const internetFlow = context();
assert.match(flows.find((item) => item.id === "internet_evaluate").func, /persistent/);
assert.match(flows.find((item) => item.id === "zigbee_network_evaluate").func, /persistent/);
assert.match(flows.find((item) => item.id === "zigbee_component_evaluate").func, /persistent/);
assert.match(flows.find((item) => item.id === "tuya_device_evaluate").func, /persistent/);
let now = Date.UTC(2026, 7, 13, 12, 0, 0);

// Healthy baseline and one external host failing: still online, no recovery.
let result = run(internet, internetFlow, pingResult(3, now));
assert.equal(result[0], null);
assert.equal(result[1], null);
assert.equal(internetFlow.get("internet_monitor_state_v1").phase, "online");
result = run(internet, internetFlow, pingResult(2, now += 30_000));
assert.equal(result[0], null);
assert.equal(internetFlow.get("internet_monitor_state_v1").phase, "online");

// Three consecutive failed cycles confirm one incident.
for (let attempt = 1; attempt <= 3; attempt += 1) {
  result = run(internet, internetFlow, pingResult(0, now += 30_000));
  assert.equal(Boolean(result[0]), attempt === 3);
}
assert.equal(internetFlow.get("internet_monitor_state_v1").phase, "offline");
result = run(internet, internetFlow, pingResult(0, now += 30_000));
assert.equal(result[0], null, "offline contínuo não pode duplicar queda");

// One positive cycle is recovering; oscillation returns to offline; two positives recover.
result = run(internet, internetFlow, pingResult(3, now += 30_000));
assert.equal(result[1], null);
assert.equal(internetFlow.get("internet_monitor_state_v1").phase, "recovering");
run(internet, internetFlow, pingResult(0, now += 30_000));
assert.equal(internetFlow.get("internet_monitor_state_v1").phase, "offline");
run(internet, internetFlow, pingResult(3, now += 30_000));
result = run(internet, internetFlow, pingResult(3, now += 30_000));
assert.ok(result[1], "dois sucessos devem notificar recuperação");
assert.ok(internetFlow.get("internet_monitor_state_v1").last_outage_duration_s > 0);
result = run(internet, internetFlow, pingResult(3, now += 30_000));
assert.equal(result[1], null, "online contínuo não pode duplicar recuperação");

// A second outage is a distinct incident.
run(internet, internetFlow, pingResult(1, now += 30_000));
run(internet, internetFlow, pingResult(1, now += 30_000));
result = run(internet, internetFlow, pingResult(1, now += 30_000));
assert.ok(result[0], "segunda queda deve gerar novo alerta");

// Simulate Node-RED restart: persistent incident remains, volatile memory is empty.
const restartedInternetFlow = context(internetFlow.stores.default, new Map());
result = run(internet, restartedInternetFlow, pingResult(3, now += 30_000));
assert.equal(result[1], null);
result = run(internet, restartedInternetFlow, pingResult(3, now += 30_000));
assert.ok(result[1], "incidente persistido deve recuperar sem nova queda");

// Retained attributes are a second copy of historical fields. They must repair
// a missing flow context before the next health publication replaces them.
const recoveredInternetFlow = context();
const retainedInternet = {
  last_outage: "2026-08-13T20:00:51.226Z",
  last_recovery: "2026-08-13T20:08:19.281Z",
  last_outage_duration_s: 448,
};
run(restoreInternetHistory, recoveredInternetFlow, { payload: JSON.stringify(retainedInternet) });
result = run(internet, recoveredInternetFlow, pingResult(3, now += 30_000));
const recoveredInternetAttributes = JSON.parse(result[2].find((message) => message.topic.endsWith("/attributes")).payload);
assert.equal(recoveredInternetAttributes.last_outage, retainedInternet.last_outage);
assert.equal(recoveredInternetAttributes.last_recovery, retainedInternet.last_recovery);
assert.equal(recoveredInternetAttributes.last_outage_duration_s, 448);
run(restoreInternetHistory, recoveredInternetFlow, {
  payload: JSON.stringify({ last_outage: null, last_recovery: null, last_outage_duration_s: null }),
});
assert.equal(recoveredInternetFlow.get("internet_monitor_history_v1").last_outage_duration_s, 448);

// The production ping node uses only IP literals and a volatile no-overlap lock.
const pingNode = flows.find((item) => item.id === "internet_ping");
for (const address of ["1.1.1.1", "8.8.8.8", "9.9.9.9"]) assert.match(pingNode.func, new RegExp(address.replaceAll(".", "\\.")));
assert.doesNotMatch(pingNode.func, /https?:|\.com|\.net|dns/i);
assert.match(pingNode.func, /internet_ping_cycle_running/);
assert.match(pingNode.func, /memoryOnly/);

// Exercise the asynchronous lock with the real Function-node code. A second
// input is ignored while three target callbacks are pending, and a synchronous
// spawn exception must not release the lock before the other callbacks finish.
const pingFunction = getFunction("internet_ping");
async function testPingLock({ throwFirst = false } = {}) {
  const pingFlow = context();
  let calls = 0;
  let active = 0;
  let peak = 0;
  let sends = 0;
  let done = 0;
  const fakeChildProcess = {
    execFile(_file, _args, _options, callback) {
      calls += 1;
      if (throwFirst && calls === 1) throw new Error("simulated synchronous spawn failure");
      active += 1;
      peak = Math.max(peak, active);
      setTimeout(() => {
        active -= 1;
        callback(null, "ok", "");
      }, 25);
    },
  };
  const asyncNode = {
    status() {}, warn() {}, error() {},
    send() { sends += 1; },
    done() { done += 1; },
  };
  const asyncGlobal = { get(key) { return key === "childProcess" ? fakeChildProcess : undefined; } };

  pingFunction({}, pingFlow, asyncNode, asyncGlobal);
  assert.equal(pingFlow.get("internet_ping_cycle_running", "memoryOnly"), true);
  assert.equal(pingFunction({}, pingFlow, asyncNode, asyncGlobal), null);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(pingFlow.get("internet_ping_cycle_running", "memoryOnly"), true);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(pingFlow.get("internet_ping_cycle_running", "memoryOnly"), false);
  assert.equal(calls, 3);
  assert.ok(peak <= 3);
  assert.equal(sends, 1);
  assert.equal(done, 1);

  pingFunction({}, pingFlow, asyncNode, asyncGlobal);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(calls, 6);
  assert.equal(sends, 2);
  assert.equal(done, 2);
  assert.equal(active, 0);
}
await testPingLock();
await testPingLock({ throwFirst: true });

const observeZigbee = getFunction("zigbee_store_observation");
const zigbee = getFunction("zigbee_network_evaluate");
const restoreZigbeeHistory = getFunction("zigbee_restore_history");
const zigbeeComponent = getFunction("zigbee_component_evaluate");
const zigbeeComponentReminders = getFunction("zigbee_component_reminders");
const zigbeeFlow = context();
now = Date.UTC(2026, 7, 13, 13, 0, 0);
zigbeeFlow.set("zigbee_bridge_observation", { state: "unknown", changed_at: now }, "memoryOnly");

// Startup online establishes baseline without a false recovery.
run(observeZigbee, zigbeeFlow, { payload: "online", monitor_now: now + 1_000 });
result = run(zigbee, zigbeeFlow, { monitor_now: now + 1_000 });
assert.equal(result[0], null);
assert.equal(result[1], null);
assert.equal(zigbeeFlow.get("zigbee_network_monitor_state_v1").phase, "online");

const recoveredZigbeeFlow = context();
run(restoreZigbeeHistory, recoveredZigbeeFlow, {
  payload: JSON.stringify({
    last_outage: "2026-08-12T10:00:00.000Z",
    last_recovery: "2026-08-12T10:02:00.000Z",
    last_outage_duration_s: 120,
  }),
});
recoveredZigbeeFlow.set("zigbee_bridge_observation", { state: "online", changed_at: now }, "memoryOnly");
result = run(zigbee, recoveredZigbeeFlow, { monitor_now: now });
const recoveredZigbeeAttributes = JSON.parse(result[2].find((message) => message.topic.endsWith("/attributes")).payload);
assert.equal(recoveredZigbeeAttributes.last_outage, "2026-08-12T10:00:00.000Z");
assert.equal(recoveredZigbeeAttributes.last_recovery, "2026-08-12T10:02:00.000Z");

// A transient failure under 30 seconds is ignored.
run(observeZigbee, zigbeeFlow, { payload: "offline", monitor_now: now + 10_000 });
result = run(zigbee, zigbeeFlow, { monitor_now: now + 39_000 });
assert.equal(result[0], null);
run(observeZigbee, zigbeeFlow, { payload: "online", monitor_now: now + 40_000 });
result = run(zigbee, zigbeeFlow, { monitor_now: now + 40_000 });
assert.equal(result[0], null);

// 30 seconds offline and 60 seconds online preserve the previous behavior.
run(observeZigbee, zigbeeFlow, { payload: "offline", monitor_now: now + 50_000 });
result = run(zigbee, zigbeeFlow, { monitor_now: now + 80_000 });
assert.ok(result[0]);
result = run(zigbee, zigbeeFlow, { monitor_now: now + 90_000 });
assert.equal(result[0], null, "queda Zigbee não pode duplicar");
run(observeZigbee, zigbeeFlow, { payload: "online", monitor_now: now + 100_000 });
result = run(zigbee, zigbeeFlow, { monitor_now: now + 159_000 });
assert.equal(result[1], null);
result = run(zigbee, zigbeeFlow, { monitor_now: now + 160_000 });
assert.ok(result[1]);

// A persisted Zigbee incident survives Node-RED restart without duplicate down.
run(observeZigbee, zigbeeFlow, { payload: "offline", monitor_now: now + 170_000 });
result = run(zigbee, zigbeeFlow, { monitor_now: now + 200_000 });
assert.ok(result[0]);
const restartedZigbeeFlow = context(zigbeeFlow.stores.default, new Map());
restartedZigbeeFlow.set("zigbee_bridge_observation", { state: "online", changed_at: now + 210_000 }, "memoryOnly");
result = run(zigbee, restartedZigbeeFlow, { monitor_now: now + 269_000 });
assert.equal(result[1], null);
result = run(zigbee, restartedZigbeeFlow, { monitor_now: now + 270_000 });
assert.ok(result[1], "restart deve recuperar incidente persistido uma única vez");

// An unresolved Zigbee network incident repeats the same alert every 24 hours.
const zigbeeReminderFlow = context();
zigbeeReminderFlow.set("zigbee_bridge_observation", { state: "offline", changed_at: now }, "memoryOnly");
result = run(zigbee, zigbeeReminderFlow, { monitor_now: now + 30_000 });
assert.equal(result[0].notification.id, "zigbee_network_failure");
result = run(zigbee, zigbeeReminderFlow, { monitor_now: now + 30_000 + 24 * 60 * 60 * 1000 - 1 });
assert.equal(result[0], null);
result = run(zigbee, zigbeeReminderFlow, { monitor_now: now + 30_000 + 24 * 60 * 60 * 1000 });
assert.equal(result[0].notification.id, "zigbee_network_failure");
assert.match(result[0].notification.title, /persiste/);
result = run(zigbee, zigbeeReminderFlow, { monitor_now: now + 30_000 + 24 * 60 * 60 * 1000 + 1 });
assert.equal(result[0], null, "lembrete Zigbee de 24 h não pode duplicar no mesmo período");

// Component retained online at startup is silent; offline/duplicate/online is one pair.
const componentTopic = "zigbee2mqtt/teste/sensor/availability";
result = run(zigbeeComponent, zigbeeFlow, { topic: componentTopic, payload: "online", monitor_now: now });
assert.equal(result, null);
result = run(zigbeeComponent, zigbeeFlow, { topic: componentTopic, payload: { state: "offline" }, monitor_now: now + 1_000 });
assert.ok(result[0]);
result = run(zigbeeComponent, zigbeeFlow, { topic: componentTopic, payload: "offline", monitor_now: now + 2_000 });
assert.equal(result, null);
result = run(zigbeeComponent, zigbeeFlow, { topic: componentTopic, payload: "online", monitor_now: now + 3_000 });
assert.ok(result[1]);
result = run(zigbeeComponent, zigbeeFlow, { topic: componentTopic, payload: "online", monitor_now: now + 4_000 });
assert.equal(result, null);
result = run(zigbeeComponent, zigbeeFlow, { topic: componentTopic, payload: "offline", monitor_now: now + 5_000 });
assert.ok(result[0], "nova queda do componente após recuperação deve alertar");

// Component reminders are driven by the periodic tick even without a new MQTT availability message.
const componentReminderFlow = context();
const componentReminderStart = now + 300_000;
run(zigbeeComponent, componentReminderFlow, { topic: componentTopic, payload: "offline", monitor_now: componentReminderStart });
result = run(zigbeeComponentReminders, componentReminderFlow, { monitor_now: componentReminderStart + 24 * 60 * 60 * 1000 - 1 });
assert.equal(result, null);
result = run(zigbeeComponentReminders, componentReminderFlow, { monitor_now: componentReminderStart + 24 * 60 * 60 * 1000 });
assert.equal(result[0].length, 1);
assert.match(result[0][0].notification.title, /continua indisponível/);
result = run(zigbeeComponentReminders, componentReminderFlow, { monitor_now: componentReminderStart + 24 * 60 * 60 * 1000 + 1 });
assert.equal(result, null);
run(zigbeeComponent, componentReminderFlow, { topic: componentTopic, payload: "online", monitor_now: componentReminderStart + 24 * 60 * 60 * 1000 + 2 });
result = run(zigbeeComponentReminders, componentReminderFlow, { monitor_now: componentReminderStart + 48 * 60 * 60 * 1000 });
assert.equal(result, null, "componente recuperado não pode gerar lembrete");

// Hierarchical friendly names keep the complete path and cannot collide after slugification.
const hierarchicalFlow = context();
const hierarchical = [
  "andar1/cozinha/sensor",
  "externo/portao/sensor",
  // This name deliberately has the same readable slug as the first one.
  "andar1-cozinha/sensor",
].map((component, index) => run(zigbeeComponent, hierarchicalFlow, {
  topic: `zigbee2mqtt/${component}/availability`,
  payload: "offline",
  monitor_now: now + 10_000 + index,
})[0].notification);
assert.equal(new Set(hierarchical.map((item) => item.id)).size, hierarchical.length);
assert.match(hierarchical[0].message, /andar1\/cozinha\/sensor/);
assert.match(hierarchical[1].message, /externo\/portao\/sensor/);

const tuya = getFunction("tuya_device_evaluate");
const tuyaQueryFailure = getFunction("tuya_query_failure");
const tuyaFlow = context();
const tuyaEntities = [
  { entity_id: "sensor.comedouro_nivel", device_id: "device-feeder", platform: "tuya", disabled_by: null, original_name: "Nível" },
  { entity_id: "button.comedouro_alimentar", device_id: "device-feeder", platform: "tuya", disabled_by: null, original_name: "Alimentar" },
  { entity_id: "switch.rele_local", device_id: "device-relay", platform: "localtuya", disabled_by: null, original_name: "Relé" },
  { entity_id: "sensor.tuya_desabilitado", device_id: "device-disabled", platform: "tuya", disabled_by: "integration", original_name: "Desabilitado" },
  { entity_id: "sensor.zigbee_ignorado", device_id: "device-zigbee", platform: "mqtt", disabled_by: null, original_name: "Zigbee" },
];
const tuyaDevices = [
  { id: "device-feeder", name_by_user: "Comedouro" },
  { id: "device-relay", name: "Relé local" },
  { id: "device-disabled", name: "Desabilitado" },
];
function tuyaSnapshot(clock, feederState = "42", relayState = "on") {
  return {
    monitor_now: clock,
    tuya_entity_registry: structuredClone(tuyaEntities),
    tuya_device_registry: structuredClone(tuyaDevices),
    tuya_states: [
      { entity_id: "sensor.comedouro_nivel", state: feederState, attributes: { friendly_name: "Comedouro Nível" } },
      { entity_id: "button.comedouro_alimentar", state: "unknown", attributes: {} },
      { entity_id: "switch.rele_local", state: relayState, attributes: { friendly_name: "Relé local" } },
    ],
  };
}

let tuyaNow = Date.UTC(2026, 7, 13, 14, 0, 0);
result = run(tuya, tuyaFlow, tuyaSnapshot(tuyaNow));
assert.equal(result[0], null);
assert.equal(result[1], null);
let tuyaAttributes = JSON.parse(result[2].find((message) => message.topic.endsWith("/attributes")).payload);
assert.equal(tuyaAttributes.state, "online");
assert.equal(tuyaAttributes.monitored_device_count, 2, "plataformas alheias e entidades desabilitadas devem ser ignoradas");

// A transient unavailable is visible as checking, but only 30 seconds opens an incident.
result = run(tuya, tuyaFlow, tuyaSnapshot(tuyaNow += 10_000, "unavailable"));
assert.equal(result[0], null);
tuyaAttributes = JSON.parse(result[2].find((message) => message.topic.endsWith("/attributes")).payload);
assert.equal(tuyaAttributes.state, "checking");
result = run(tuya, tuyaFlow, tuyaSnapshot(tuyaNow += 29_000, "unavailable"));
assert.equal(result[0], null);
result = run(tuya, tuyaFlow, tuyaSnapshot(tuyaNow += 1_000, "unavailable"));
assert.equal(result[0].length, 1);
assert.match(result[0][0].notification.message, /Comedouro/);
assert.equal(tuyaFlow.get("tuya_device_incidents_v1", "persistent")["device-feeder"].incident_open, true);
result = run(tuya, tuyaFlow, tuyaSnapshot(tuyaNow += 30_000, "unavailable"));
assert.equal(result[0], null, "indisponibilidade Tuya contínua não pode duplicar alerta");

// Recovery is notified only after 60 stable seconds and dismisses the down alert.
result = run(tuya, tuyaFlow, tuyaSnapshot(tuyaNow += 10_000, "42"));
assert.equal(result[1], null);
result = run(tuya, tuyaFlow, tuyaSnapshot(tuyaNow += 59_000, "42"));
assert.equal(result[1], null);
result = run(tuya, tuyaFlow, tuyaSnapshot(tuyaNow += 1_000, "42"));
assert.equal(result[1].length, 1);
assert.equal(result[1][0].notification.dismiss_id, result[1][0].notification.id.replace(/_recovered$/, ""));

// A persistent incident survives restart; volatile observations restart the 60-second confirmation.
run(tuya, tuyaFlow, tuyaSnapshot(tuyaNow += 10_000, "unavailable"));
result = run(tuya, tuyaFlow, tuyaSnapshot(tuyaNow += 30_000, "unavailable"));
assert.equal(result[0].length, 1);
const restartedTuyaFlow = context(tuyaFlow.stores.default, new Map());
result = run(tuya, restartedTuyaFlow, tuyaSnapshot(tuyaNow += 10_000, "42"));
assert.equal(result[1], null);
result = run(tuya, restartedTuyaFlow, tuyaSnapshot(tuyaNow += 60_000, "42"));
assert.equal(result[1].length, 1);

// An unresolved Tuya incident repeats the same alert every 24 hours.
const tuyaReminderFlow = context();
const tuyaReminderStart = Date.UTC(2026, 7, 14, 14, 0, 0);
run(tuya, tuyaReminderFlow, tuyaSnapshot(tuyaReminderStart, "42"));
run(tuya, tuyaReminderFlow, tuyaSnapshot(tuyaReminderStart + 10_000, "unavailable"));
result = run(tuya, tuyaReminderFlow, tuyaSnapshot(tuyaReminderStart + 40_000, "unavailable"));
const tuyaFailureId = result[0][0].notification.id;
result = run(tuya, tuyaReminderFlow, tuyaSnapshot(tuyaReminderStart + 40_000 + 24 * 60 * 60 * 1000 - 1, "unavailable"));
assert.equal(result[0], null);
result = run(tuya, tuyaReminderFlow, tuyaSnapshot(tuyaReminderStart + 40_000 + 24 * 60 * 60 * 1000, "unavailable"));
assert.equal(result[0][0].notification.id, tuyaFailureId);
assert.match(result[0][0].notification.title, /continua indisponível/);
result = run(tuya, tuyaReminderFlow, tuyaSnapshot(tuyaReminderStart + 40_001 + 24 * 60 * 60 * 1000, "unavailable"));
assert.equal(result[0], null, "lembrete Tuya de 24 h não pode duplicar no mesmo período");

const queryFailurePublications = run(tuyaQueryFailure, context(), {
  monitor_now: tuyaNow,
  error: { message: "Home Assistant disconnected" },
})[0];
assert.equal(queryFailurePublications.find((message) => message.topic.endsWith("/state")).payload, "checking");
assert.equal(queryFailurePublications.find((message) => message.topic.endsWith("/connection")).payload, "OFF");

// Home Assistant 2026.x prefixes device names unless discovery explicitly
// supplies default_entity_id. Keep all infrastructure entity IDs stable.
const discoveryMessages = [
  ...run(getFunction("internet_discovery"), context(), {})[0],
  ...run(getFunction("zigbee_discovery"), context(), {})[0],
  ...run(getFunction("tuya_discovery"), context(), {})[0],
];
const discoveryByTopic = new Map(discoveryMessages.map((message) => [message.topic, JSON.parse(message.payload)]));
assert.equal(discoveryByTopic.get("homeassistant/binary_sensor/internet_connection/config")?.default_entity_id, "binary_sensor.internet_connection");
assert.equal(discoveryByTopic.get("homeassistant/sensor/internet_connection_state/config")?.default_entity_id, "sensor.internet_connection_state");
assert.equal(discoveryByTopic.get("homeassistant/binary_sensor/zigbee_network/config")?.default_entity_id, "binary_sensor.zigbee_network");
assert.equal(discoveryByTopic.get("homeassistant/sensor/zigbee_network_state/config")?.default_entity_id, "sensor.zigbee_network_state");
assert.equal(discoveryByTopic.get("homeassistant/binary_sensor/tuya_devices/config")?.default_entity_id, "binary_sensor.tuya_devices");
assert.equal(discoveryByTopic.get("homeassistant/sensor/tuya_devices_state/config")?.default_entity_id, "sensor.tuya_devices_state");

// Structural review: unique ids, valid wires, shared notifier and left-to-right layout.
const ids = flows.map((item) => item.id);
assert.equal(new Set(ids).size, ids.length, "IDs de nodes devem ser únicos");
const idSet = new Set(ids);
for (const item of flows) {
  for (const output of item.wires || []) {
    for (const target of output) assert.ok(idSet.has(target), `wire órfão: ${item.id} -> ${target}`);
  }
}
for (const item of flows.filter((entry) => entry.type === "group" && ["monitoramento_internet_tab", "monitoramento_vpn_tab", "monitoramento_zigbee_tab", "monitoramento_tuya_tab"].includes(entry.z))) {
  for (const member of item.nodes) {
    const memberNode = flows.find((entry) => entry.id === member);
    assert.ok(memberNode, `grupo ${item.id} contém node ausente: ${member}`);
    assert.equal(memberNode.g, item.id, `node ${member} não referencia seu grupo`);
  }
}
assert.equal(flows.filter((item) => item.type === "subflow:infra_notify_all_mobiles").length, 10);
for (const [id, role, action] of [
  ["infra_notify_mobile", "mobile_primary", "notify_3"],
  ["infra_notify_mobile_secondary", "mobile_secondary", "notify_2"],
  ["infra_notify_echo", "mobile_primary", "notify"],
]) {
  const notifier = flows.find((item) => item.id === id);
  assert.equal(notifier?.action, "public_bindings.call");
  assert.equal(notifier?.domain, "public_bindings");
  assert.equal(notifier?.service, "call");
  assert.deepEqual(notifier?.entityId, []);
  assert.match(notifier?.data ?? "", new RegExp(`"role":"${role}"`));
  assert.match(notifier?.data ?? "", new RegExp(`"action":"${action}"`));
}
assert.deepEqual(flows.find((item) => item.id === "infra_notify_route")?.wires[1], [
  "infra_notify_mobile",
  "infra_notify_mobile_secondary",
  "infra_notify_echo",
]);
assert.match(flows.find((item) => item.id === "infra_notify_echo")?.data ?? "", /notification\.title/);
assert.match(flows.find((item) => item.id === "infra_notify_echo")?.data ?? "", /notification\.message/);
assert.ok(flows.find((item) => item.id === "internet_ping").x < flows.find((item) => item.id === "internet_evaluate").x);
assert.ok(flows.find((item) => item.id === "zigbee_store_observation").x < flows.find((item) => item.id === "zigbee_network_evaluate").x);
assert.deepEqual(JSON.parse(flows.find((item) => item.id === "tuya_entity_registry").data), { type: "config/entity_registry/list" });
assert.deepEqual(JSON.parse(flows.find((item) => item.id === "tuya_device_registry").data), { type: "config/device_registry/list" });
assert.deepEqual(JSON.parse(flows.find((item) => item.id === "tuya_states").data), { type: "get_states" });
assert.ok(flows.find((item) => item.id === "tuya_entity_registry").x < flows.find((item) => item.id === "tuya_device_evaluate").x);

console.log("Infrastructure monitoring tests: state, restart, dedupe and layout scenarios passed.");
