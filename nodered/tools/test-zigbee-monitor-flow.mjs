#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";

const flows = JSON.parse(fs.readFileSync(new URL("../flows.json", import.meta.url), "utf8"));
const byId = new Map(flows.map((node) => [node.id, node]));
const TAB = "monitoramento_zigbee_tab";
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

assert.equal(byId.get(TAB)?.label, "monitoramento_zigbee");
assert.ok(tabNodes.length >= 100);
for (const id of [
  "zigbee_policy_switch", "zigbee_network_policy_available", "zigbee_network_raw_switch",
  "zigbee_network_online_incident", "zigbee_network_recovery_stable",
  "zigbee_network_offline_incident", "zigbee_network_reminder_due", "zigbee_network_failure_stable",
  "zigbee_network_event_switch", "zigbee_publication_test_gate",
  "zigbee_component_policy_available", "zigbee_component_valid", "zigbee_component_availability_switch",
  "zigbee_component_offline_incident", "zigbee_component_online_incident",
  "zigbee_component_reminder_offline", "zigbee_component_reminder_due",
  "zigbee_component_event_switch", "zigbee_notification_test_gate",
  "zigbee_route_error_valid", "zigbee_route_policy_available", "zigbee_route_decision",
  "zigbee_route_event_switch", "zigbee_route_recovery_test_gate",
  "zigbee_route_scan_policy_available", "zigbee_route_scan_response_valid", "zigbee_route_scan_response_status",
  "zigbee_route_configure_test_gate",
  "zigbee_route_response_policy_available", "zigbee_route_response_valid", "zigbee_route_response_status",
]) assert.equal(byId.get(id)?.type, "switch", `decisão visual ausente: ${id}`);

const validate = getFunction("zigbee_policy_validate");
const store = getFunction("zigbee_policy_store");
const load = getFunction("zigbee_network_policy_load");
const normalizeObservation = getFunction("zigbee_network_observation_normalize");
const storeObservation = getFunction("zigbee_network_observation_store");
const readNetwork = getFunction("zigbee_network_state_read");
const mutateNetwork = getFunction("zigbee_network_state_mutate");
const finalizeNetwork = getFunction("zigbee_network_finalize");
const networkNotification = getFunction("zigbee_network_notification_build");
const restore = getFunction("zigbee_restore_history");
const expandPublications = getFunction("zigbee_publications_expand");
const normalizeComponent = getFunction("zigbee_component_normalize");
const readComponent = getFunction("zigbee_component_state_read");
const mutateComponent = getFunction("zigbee_component_state_mutate");
const expandReminders = getFunction("zigbee_component_reminders_expand");
const componentNotification = getFunction("zigbee_component_notification_build");
const normalizeRouteError = getFunction("zigbee_route_error_normalize");
const readRoute = getFunction("zigbee_route_state_read");
const mutateRoute = getFunction("zigbee_route_state_mutate");
const buildRouteRequest = getFunction("zigbee_route_recovery_request_build");
const buildConfigureRequest = getFunction("zigbee_route_configure_request_build");
const normalizeRouteResponse = getFunction("zigbee_route_response_normalize");
const routeNotification = getFunction("zigbee_route_notification_build");
const dry = getFunction("zigbee_dry_run_terminal");
const defaults = {
  failure_confirmation_s: 30, recovery_confirmation_s: 60, reminder_interval_h: 24,
  route_recovery_cooldown_min: 15, route_recovery_max_attempts: 3, startup_grace_s: 180, route_stability_s: 300,
};
const flow = context();
let msg = validate({ payload: defaults }, flow, nodeMock, globalMock);
assert.equal(msg.policy_valid, true);
store(msg, flow, nodeMock, globalMock);
assert.deepEqual(load({}, flow, nodeMock, globalMock).policy, { version: 2, ...defaults });
for (const payload of [
  { ...defaults, failure_confirmation_s: 0 }, { ...defaults, failure_confirmation_s: 301 },
  { ...defaults, recovery_confirmation_s: 0 }, { ...defaults, recovery_confirmation_s: 601 },
  { ...defaults, reminder_interval_h: 0 }, { ...defaults, reminder_interval_h: 169 },
  { ...defaults, reminder_interval_h: 1.5 },
  { ...defaults, route_recovery_cooldown_min: 0 }, { ...defaults, route_recovery_cooldown_min: 1441 },
  { ...defaults, route_recovery_max_attempts: 0 }, { ...defaults, route_recovery_max_attempts: 6 },
]) assert.equal(validate({ payload }, flow, nodeMock, globalMock).policy_valid, false);
assert.equal(validate({ payload: { ...defaults, failure_confirmation_s: 1, recovery_confirmation_s: 1, reminder_interval_h: 1, route_recovery_cooldown_min: 1, route_recovery_max_attempts: 1 } }, flow, nodeMock, globalMock).policy_valid, true);
assert.equal(validate({ payload: { ...defaults, failure_confirmation_s: 300, recovery_confirmation_s: 600, reminder_interval_h: 168, route_recovery_cooldown_min: 1440, route_recovery_max_attempts: 5 } }, flow, nodeMock, globalMock).policy_valid, true);
assert.deepEqual(load({}, flow, nodeMock, globalMock).policy, { version: 2, ...defaults }, "inválido não substitui política");

let now = Date.UTC(2026, 0, 1, 0, 0, 0);
function observe(targetFlow, state, at = now, testMode = false) {
  let current = normalizeObservation({ payload: state, monitor_now: at, _zigbee_test: testMode }, targetFlow, nodeMock, globalMock);
  assert.equal(current.zigbee_observation_valid, true);
  return storeObservation(current, targetFlow, nodeMock, globalMock);
}
function networkCycle(targetFlow, at = now, testMode = false) {
  let current = load({ monitor_now: at, _zigbee_test: testMode }, targetFlow, nodeMock, globalMock);
  current = readNetwork(current, targetFlow, nodeMock, globalMock);
  current.zigbee_event = "none";
  if (current.zigbee_raw_state === "online") {
    if (!current.zigbee_state.incident_open) current.zigbee_state_action = "baseline_online";
    else if (current.zigbee_stable_for_ms >= current.policy.recovery_confirmation_s * 1000) {
      current.zigbee_state_action = "recover_online";
      current.zigbee_event = "network_recovery";
    } else current.zigbee_state_action = "mark_recovering";
  } else {
    if (current.zigbee_state.incident_open) {
      if (current.zigbee_now >= current.zigbee_next_reminder_ms) {
        current.zigbee_state_action = "network_reminder";
        current.zigbee_event = "network_reminder";
      } else current.zigbee_state_action = "keep_offline";
    } else if (current.zigbee_stable_for_ms >= current.policy.failure_confirmation_s * 1000) {
      current.zigbee_state_action = "open_failure";
      current.zigbee_event = "network_down";
    } else current.zigbee_state_action = "mark_checking";
  }
  current = mutateNetwork(current, targetFlow, nodeMock, globalMock);
  return finalizeNetwork(current, targetFlow, nodeMock, globalMock);
}

observe(flow, "online", now);
let result = networkCycle(flow, now);
assert.equal(result.zigbee_state.phase, "online");
const unknownFlow = context({ persistent: { zigbee_monitor_policy_v2: { version: 2, ...defaults } } });
assert.equal(networkCycle(unknownFlow, now).zigbee_event, "none");
assert.equal(networkCycle(unknownFlow, now + 29000).zigbee_event, "none");
assert.equal(networkCycle(unknownFlow, now + 30000).zigbee_event, "network_down", "fonte desconhecida por 30 s preserva falha fechada");
observe(flow, "offline", now + 10000);
assert.equal(networkCycle(flow, now + 39000).zigbee_event, "none", "29 s não confirma queda");
result = networkCycle(flow, now + 40000);
assert.equal(result.zigbee_event, "network_down", "limite exato de 30 s confirma queda");
assert.equal(networkNotification(result, flow, nodeMock, globalMock).notification.id, "zigbee_network_failure");
assert.equal(networkCycle(flow, now + 41000).zigbee_event, "none", "offline repetido não duplica");
result = networkCycle(flow, now + 40000 + 86400000);
assert.equal(result.zigbee_event, "network_reminder", "lembrete exato em 24 h");
assert.equal(networkCycle(flow, now + 40001 + 86400000).zigbee_event, "none", "lembrete não duplica");
observe(flow, "online", now + 50000 + 86400000);
assert.equal(networkCycle(flow, now + 109000 + 86400000).zigbee_state.phase, "recovering");
result = networkCycle(flow, now + 110000 + 86400000);
assert.equal(result.zigbee_event, "network_recovery", "limite exato de 60 s confirma retorno");
assert.equal(networkNotification(result, flow, nodeMock, globalMock).notification.dismiss_id, "zigbee_network_failure");
assert.equal(expandPublications(result, flow, nodeMock, globalMock).length, 3);

observe(flow, "offline", now + 120000 + 86400000);
result = networkCycle(flow, now + 150000 + 86400000);
assert.equal(result.zigbee_event, "network_down");
const restarted = context({ persistent: {
  zigbee_monitor_policy_v2: flow.get("zigbee_monitor_policy_v2", "persistent"),
  zigbee_network_monitor_state_v1: flow.get("zigbee_network_monitor_state_v1", "persistent"),
  zigbee_network_monitor_history_v1: flow.get("zigbee_network_monitor_history_v1", "persistent"),
}, memoryOnly: { zigbee_bridge_observation: { state: "offline", changed_at: now + 120000 + 86400000 } } });
assert.equal(networkCycle(restarted, now + 151000 + 86400000).zigbee_event, "none", "restart não duplica queda");
observe(restarted, "online", now + 160000 + 86400000);
assert.equal(networkCycle(restarted, now + 220000 + 86400000).zigbee_event, "network_recovery");

const restored = context();
restore({ payload: { last_outage: new Date(0).toISOString(), last_recovery: new Date(120000).toISOString(), last_outage_duration_s: 120 } }, restored, nodeMock, globalMock);
assert.equal(restored.get("zigbee_network_monitor_history_v1", "persistent").last_outage_duration_s, 120);

function componentCycle(targetFlow, availability, at, testMode = false) {
  let current = load({ topic: "zigbee2mqtt/example_component/availability", payload: availability, monitor_now: at, _zigbee_test: testMode }, targetFlow, nodeMock, globalMock);
  current = normalizeComponent(current, targetFlow, nodeMock, globalMock);
  assert.equal(current.zigbee_component_valid, true);
  current = readComponent(current, targetFlow, nodeMock, globalMock);
  current.zigbee_component_event = "none";
  if (current.zigbee_component_availability === "offline") {
    current.zigbee_component_action = current.zigbee_component_current.offline ? "touch" : "open";
    if (!current.zigbee_component_current.offline) current.zigbee_component_event = "down";
  } else {
    current.zigbee_component_action = current.zigbee_component_current.offline ? "recover" : "baseline";
    if (current.zigbee_component_current.offline) current.zigbee_component_event = "recovery";
  }
  return mutateComponent(current, targetFlow, nodeMock, globalMock);
}
const componentFlow = context({ persistent: { zigbee_monitor_policy_v2: { version: 2, ...defaults } } });
result = componentCycle(componentFlow, "offline", now);
assert.equal(result.zigbee_component_event, "down");
assert.match(componentNotification(result, componentFlow, nodeMock, globalMock).notification.id, /^zigbee_component_example_component_/);
assert.equal(componentCycle(componentFlow, "offline", now + 1000).zigbee_component_event, "none", "componente duplicado é suprimido");
let reminderInput = load({ monitor_now: now + 86400000 }, componentFlow, nodeMock, globalMock);
let reminders = expandReminders(reminderInput, componentFlow, nodeMock, globalMock)[0];
assert.equal(reminders.length, 1);
result = reminders[0];
assert.equal(result.zigbee_now >= result.zigbee_component_next_reminder_ms, true);
result.zigbee_component_action = "reminder";
result.zigbee_component_event = "reminder";
result = mutateComponent(result, componentFlow, nodeMock, globalMock);
assert.match(componentNotification(result, componentFlow, nodeMock, globalMock).notification.title, /continua/);
assert.equal(componentCycle(componentFlow, "online", now + 86401000).zigbee_component_event, "recovery");
assert.equal(componentCycle(componentFlow, "online", now + 86402000).zigbee_component_event, "none");
assert.equal(normalizeComponent({ topic: "zigbee2mqtt/example_component/state", payload: "offline" }, componentFlow, nodeMock, globalMock).zigbee_component_valid, false);
assert.equal(normalizeObservation({ payload: "unknown" }, flow, nodeMock, globalMock).zigbee_observation_valid, false);

function routeErrorCycle(targetFlow, at, testMode = false) {
  let current = load({
    payload: { level: "error", message: "Publish 'set' 'state' to 'teste_rota' failed: NWK_NO_ROUTE (0xcd)" },
    monitor_now: at, _zigbee_test: testMode,
  }, targetFlow, nodeMock, globalMock);
  current = normalizeRouteError(current, targetFlow, nodeMock, globalMock);
  assert.equal(current.zigbee_route_valid, true);
  current = readRoute(current, targetFlow, nodeMock, globalMock);
  if (!current.zigbee_route_current.incident_open) {
    current.zigbee_route_action = "open";
    current.zigbee_route_event = "route_failure";
  } else if (current.zigbee_route_current.attempts < current.policy.route_recovery_max_attempts && current.zigbee_route_now >= current.zigbee_route_deadline) {
    current.zigbee_route_action = "retry";
    current.zigbee_route_event = "route_retry";
  } else {
    current.zigbee_route_action = "touch";
    current.zigbee_route_event = "none";
  }
  return mutateRoute(current, targetFlow, nodeMock, globalMock);
}
function routeResponse(targetFlow, transaction, status, at) {
  let current = load({ payload: { status, transaction, ...(status === "error" ? { error: "NWK_NO_ROUTE" } : {}) }, monitor_now: at }, targetFlow, nodeMock, globalMock);
  current = normalizeRouteResponse(current, targetFlow, nodeMock, globalMock);
  assert.equal(current.zigbee_route_response_valid, true);
  current.zigbee_route_action = status === "ok" ? "verify" : "recovery_failed";
  current.zigbee_route_event = status === "ok" ? "none" : "route_recovery_failed";
  return mutateRoute(current, targetFlow, nodeMock, globalMock);
}
const routeFlow = context({ persistent: { zigbee_monitor_policy_v2: { version: 2, ...defaults } } });
result = routeErrorCycle(routeFlow, now, true);
assert.equal(result.zigbee_route_event, "route_failure");
assert.equal(result.zigbee_route_current.attempts, 1);
assert.match(result.zigbee_route_transaction, /^nodered-zigbee-route-test-/);
assert.match(routeNotification(result, routeFlow, nodeMock, globalMock).notification.message, /recuperação automática foi iniciada/);
let request = buildRouteRequest(structuredClone(result), routeFlow, nodeMock, globalMock);
assert.equal(request.topic, "zigbee2mqtt/bridge/request/networkmap");
assert.equal(request.payload.type, "raw");
assert.equal(request.payload.routes, true);
assert.equal(byId.get("zigbee_route_recovery_mqtt").retain, "false");
assert.equal(routeErrorCycle(routeFlow, now + 1000, true).zigbee_route_event, "none", "NWK duplicado é suprimido");
let scanResponse = normalizeRouteResponse({ topic: "zigbee2mqtt/bridge/response/networkmap", payload: { status: "ok", transaction: request.payload.transaction }, monitor_now: now + 1500 }, routeFlow, nodeMock, globalMock);
assert.equal(scanResponse.zigbee_route_response_valid, true);
let configureRequest = buildConfigureRequest(scanResponse, routeFlow, nodeMock, globalMock);
assert.equal(configureRequest.topic, "zigbee2mqtt/bridge/request/device/configure");
assert.equal(configureRequest.payload.id, "teste_rota");
assert.equal(configureRequest.payload.transaction, request.payload.transaction);
assert.equal(byId.get("zigbee_route_configure_mqtt").retain, "false");
result = routeResponse(routeFlow, configureRequest.payload.transaction, "error", now + 2000);
assert.equal(result.zigbee_route_current.phase, "failed");
assert.equal(routeNotification(result, routeFlow, nodeMock, globalMock), null, "tentativa intermediária não notifica");
assert.equal(routeErrorCycle(routeFlow, now + 899999, true).zigbee_route_event, "none", "cooldown impede retry antecipado");
result = routeErrorCycle(routeFlow, now + 902000, true);
assert.equal(result.zigbee_route_event, "route_retry");
assert.equal(result.zigbee_route_current.attempts, 2);
request = buildRouteRequest(structuredClone(result), routeFlow, nodeMock, globalMock);
scanResponse = normalizeRouteResponse({ topic: "zigbee2mqtt/bridge/response/networkmap", payload: { status: "ok", transaction: request.payload.transaction }, monitor_now: now + 902500 }, routeFlow, nodeMock, globalMock);
assert.equal(scanResponse.zigbee_route_response_valid, true);
configureRequest = buildConfigureRequest(scanResponse, routeFlow, nodeMock, globalMock);
result = routeResponse(routeFlow, configureRequest.payload.transaction, "ok", now + 903000);
assert.equal(result.zigbee_route_current.incident_open, true);
assert.equal(result.zigbee_route_event, "none");
assert.equal(routeNotification(result, routeFlow, nodeMock, globalMock), null, "configure ok não é recuperação comprovada");
const interruptedRouteFlow = context({ persistent: { zigbee_monitor_policy_v2: { version: 2, ...defaults } } });
result = routeErrorCycle(interruptedRouteFlow, now, true);
assert.equal(result.zigbee_route_current.phase, "scanning");
assert.equal(result.zigbee_route_current.next_retry_at, new Date(now + 900000).toISOString());
assert.equal(routeErrorCycle(interruptedRouteFlow, now + 899999, true).zigbee_route_event, "none", "operação sem resposta respeita cooldown");
result = routeErrorCycle(interruptedRouteFlow, now + 900001, true);
assert.equal(result.zigbee_route_event, "route_retry", "operação interrompida pelo coordenador pode ser retomada");
assert.equal(result.zigbee_route_current.attempts, 2);
assert.equal(normalizeRouteError({ payload: { level: "error", message: "unrelated" } }, routeFlow, nodeMock, globalMock).zigbee_route_valid, false);
assert.equal(normalizeRouteResponse({ topic: "zigbee2mqtt/bridge/response/networkmap", payload: { status: "ok", transaction: "external" } }, routeFlow, nodeMock, globalMock).zigbee_route_response_valid, false);

const testFlow = context({ persistent: { zigbee_monitor_policy_v2: { version: 2, ...defaults } } });
observe(testFlow, "offline", now, true);
result = networkCycle(testFlow, now + 30000, true);
assert.equal(result._zigbee_test, true);
assert.equal(testFlow.get("zigbee_network_monitor_state_v1", "persistent"), undefined, "teste não altera produção");
dry(result, testFlow, nodeMock, globalMock);
assert.equal(testFlow.get("zigbee_monitor_last_dry_run_v1__test")?.dispatched, undefined);
assert.equal(testFlow.get("zigbee_last_dry_run_v1__test").dispatched, false);
assert.deepEqual(byId.get("zigbee_notification_test_gate").wires[0], ["zigbee_notification_dry_out"]);
assert.deepEqual(byId.get("zigbee_publication_test_gate").wires[0], ["zigbee_publication_dry_out"]);
assert.deepEqual(byId.get("zigbee_route_recovery_test_gate").wires[0], ["zigbee_route_recovery_dry_out"]);
assert.deepEqual(byId.get("zigbee_route_configure_test_gate").wires[0], ["zigbee_route_configure_dry_out"]);
assert.equal(byId.get("zigbee_mqtt_publish").retain, "true");
assert.equal(byId.get("zigbee_tick").repeat, "10");
const discovery = getFunction("zigbee_discovery")({}, flow, nodeMock, globalMock);
assert.equal(discovery[0].length, 2);
assert.match(discovery[0][0].payload, /node_red_zigbee_network/);
const maxFunctionSize = Math.max(...tabNodes.filter((node) => node.type === "function").map((node) => node.func.length));
for (const node of tabNodes.filter(n => n.type === "function")) {
  const limit = ["zigbee_route_state_mutate", "zigbee_network_state_read"].includes(node.id) ? 4000 : 2000;
  assert.ok(node.func.length < limit, `JavaScript residual grande: ${node.id} (${node.func.length})`);
}

console.log("Zigbee monitor visual flow tests passed.");
