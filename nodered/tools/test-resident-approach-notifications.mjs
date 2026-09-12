#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";

const flows = JSON.parse(fs.readFileSync(new URL("../flows.json", import.meta.url), "utf8"));
const byId = new Map(flows.map((node) => [node.id, node]));
const TAB = "resident_notifications_tab";

function getFunction(id) {
  const flowNode = byId.get(id);
  assert.equal(flowNode?.type, "function", `function ausente: ${id}`);
  return new Function("msg", "flow", "node", "global", flowNode.func);
}

function context(initial = {}) {
  const stores = {
    default: new Map(Object.entries(initial.default ?? {})),
    persistent: new Map(Object.entries(initial.persistent ?? {})),
  };
  return {
    stores,
    get(key, store = "default") { return stores[store].get(key); },
    set(key, value, store = "default") { stores[store].set(key, structuredClone(value)); },
  };
}

function nodeMock() {
  return {
    errors: [], warnings: [], statuses: [],
    error(value) { this.errors.push(String(value)); },
    warn(value) { this.warnings.push(String(value)); },
    status(value) { this.statuses.push(value); },
  };
}

const tab = byId.get(TAB);
assert.equal(tab?.label, "notificacoes_chegadas_residentes");
const tabNodes = flows.filter((node) => node.z === TAB);
assert.ok(tabNodes.length >= 60);
assert.equal(tabNodes.filter((node) => node.type === "server-state-changed").length, 0);
assert.match(tab.info, /security\.arrival\.v1/);
assert.match(tab.info, /Testes manuais nunca enviam push/);

for (const id of [
  "resident_notifications_policy_switch",
  "resident_notifications_contract_switch",
  "resident_notifications_kind_switch",
  "resident_notifications_policy_available",
  "resident_notifications_direction_switch",
  "resident_notifications_cycle_switch",
  "resident_notifications_stage_switch",
  "resident_notifications_source_switch",
  "resident_notifications_event_time_switch",
  "resident_notifications_future_switch",
  "resident_notifications_stale_switch",
  "resident_notifications_duplicate_switch",
  "resident_notifications_test_gate",
  "resident_notifications_recipient_switch",
  "resident_notifications_retry_switch",
]) assert.equal(byId.get(id)?.type, "switch", `decisão visual ausente: ${id}`);

const policyControls = [
  ["resident_notifications_policy_dedupe", "dedupe_ttl_ms", "600000"],
  ["resident_notifications_policy_age", "max_event_age_ms", "900000"],
  ["resident_notifications_policy_future", "future_tolerance_ms", "60000"],
  ["resident_notifications_policy_retry", "service_retry_seconds", "60"],
];
assert.match(byId.get("resident_notifications_config_group")?.name ?? "", /PARÂMETROS AJUSTÁVEIS/);
for (const [id, topic, payload] of policyControls) {
  const control = byId.get(id);
  assert.equal(control?.props.find((item) => item.p === "topic")?.v, topic);
  assert.equal(control?.props.find((item) => item.p === "payload")?.v, payload);
  assert.deepEqual(byId.get(id)?.wires, [["resident_notifications_policy_join"]]);
}

const peopleOut = byId.get("people_location_notification_out_v1");
const canonicalIn = byId.get("resident_notifications_canonical_in_v1");
const peopleFinalizer = byId.get("554cb653b2fa4504");
const peopleClassifier = byId.get("people_location_classify_near_home_v1");
assert.ok(peopleOut.links.includes(canonicalIn.id));
assert.ok(canonicalIn.links.includes(peopleOut.id));
assert.ok(peopleFinalizer.wires[1].includes(peopleOut.id), "avisos devem receber apenas retorno confirmado");
assert.ok(!peopleClassifier.wires.flat().includes(peopleOut.id), "classificação bruta não pode decidir aviso");

const validatePolicy = getFunction("resident_notifications_policy_validate");
const storePolicy = getFunction("resident_notifications_policy_store");
const loadPolicy = getFunction("resident_notifications_policy_load");
const normalize = getFunction("resident_notifications_prepare");
const readState = getFunction("resident_notifications_state_read");
const reserve = getFunction("resident_notifications_state_write");
const buildMessage = getFunction("resident_notifications_message_build");
const acknowledge = getFunction("resident_notifications_delivery_ack");
const failDelivery = getFunction("resident_notifications_delivery_failure");
const dryRun = getFunction("resident_notifications_dry_run_terminal");
const flow = context();
const mock = nodeMock();
const privateBindings = context({
  default: {
    publicBindings: {
      roles: {
        resident_primary: { source_alias: "example_primary" },
        resident_secondary: { source_alias: "example_secondary" },
      },
    },
  },
});
const NOW = Date.parse("2026-09-12T01:00:00.000Z");
const originalNow = Date.now;
Date.now = () => NOW;

const defaults = {
  dedupe_ttl_ms: 600000,
  max_event_age_ms: 900000,
  future_tolerance_ms: 60000,
  service_retry_seconds: 60,
};
let message = validatePolicy({ payload: defaults }, flow, mock, {});
assert.equal(message.policy_valid, true);
assert.equal(storePolicy(message, flow, mock, {}), null);
message = loadPolicy({}, flow, mock, {});
assert.equal(message.policy_available, true);
assert.deepEqual(message.policy, { version: 2, ...defaults });

for (const payload of [
  { ...defaults, dedupe_ttl_ms: 59999 },
  { ...defaults, dedupe_ttl_ms: 3600001 },
  { ...defaults, max_event_age_ms: 59999 },
  { ...defaults, future_tolerance_ms: -1 },
  { ...defaults, future_tolerance_ms: 300001 },
  { ...defaults, service_retry_seconds: 9 },
  { ...defaults, service_retry_seconds: 601 },
  { ...defaults, max_event_age_ms: 60000, future_tolerance_ms: 60000 },
]) assert.equal(validatePolicy({ payload }, flow, mock, {}).policy_valid, false);
assert.equal(validatePolicy({ payload: { ...defaults, dedupe_ttl_ms: 60000, max_event_age_ms: 60000, future_tolerance_ms: 0, service_retry_seconds: 10 } }, flow, mock, {}).policy_valid, true);
assert.equal(validatePolicy({ payload: { ...defaults, dedupe_ttl_ms: 3600000, max_event_age_ms: 3600000, future_tolerance_ms: 300000, service_retry_seconds: 600 } }, flow, mock, {}).policy_valid, true);
assert.deepEqual(loadPolicy({}, flow, mock, {}).policy, { version: 2, ...defaults }, "inválidos não substituem a última política");

function arrival(source, stage = "approach", offset = 0, testMode = false, overrides = {}) {
  return {
    _location_test: testMode,
    policy: { version: 2, ...defaults },
    payload: {
      contract: "security.arrival.v1",
      kind: "arrival",
      source,
      arriving: [source],
      arrival_source_type: "person",
      arrival_stage: stage,
      arrival_previous_state: "not_home",
      arrival_direction: "returning",
      external_cycle_confirmed: true,
      event_at: NOW + offset,
      test_mode: testMode,
      ...overrides,
    },
  };
}

function recipient(msg) {
  msg.resident_recipient = msg.resident_source === "resident_primary"
    ? "resident_secondary"
    : "resident_primary";
  return msg;
}

message = recipient(normalize(arrival("resident_secondary"), flow, mock, {}));
assert.equal(message.arrival_contract_valid, true);
assert.equal(message.arrival_kind_valid, true);
assert.equal(message.arrival_returning, true);
assert.equal(message.arrival_external_cycle_confirmed, true);
assert.equal(message.arrival_event_time_valid, true);
assert.equal(message.event_at, NOW);
message = readState(message, flow, mock, {});
assert.equal(message.notification_duplicate, false);
message = reserve(message, flow, mock, {});
message = buildMessage(message, flow, mock, privateBindings);
assert.equal(message.payload.recipient, "resident_primary");
assert.equal(message.payload.message, "Example Secondary está perto de casa.");
assert.equal(message.payload.dispatched, false);
assert.equal(acknowledge(message, flow, mock, {}), null);

const persisted = structuredClone(flow.get("resident_notification_delivery_v2", "persistent"));
const restarted = context({ persistent: { resident_notification_delivery_v2: persisted } });
let repeated = readState(recipient(normalize(arrival("resident_secondary"), restarted, mock, {})), restarted, mock, {});
assert.equal(repeated.notification_duplicate, true, "recibo deve sobreviver ao restart");

let directHome = recipient(normalize(arrival("resident_secondary", "home", 1000), flow, mock, {}));
assert.equal(directHome.arrival_stage, "home");
directHome = readState(directHome, flow, mock, {});
assert.equal(directHome.notification_duplicate, false, "not_home → home deve avisar");
directHome = reserve(directHome, flow, mock, {});
directHome = buildMessage(directHome, flow, mock, privateBindings);
assert.equal(directHome.payload.message, "Example Secondary chegou em casa.");

for (const [overrides, field] of [
  [{ contract: "other.v1" }, "arrival_contract_valid"],
  [{ kind: "departure" }, "arrival_kind_valid"],
  [{ arrival_source_type: "vehicle_primary" }, "arrival_kind_valid"],
  [{ arrival_direction: "leaving" }, "arrival_returning"],
  [{ external_cycle_confirmed: false }, "arrival_external_cycle_confirmed"],
  [{ event_at: "invalid" }, "arrival_event_time_valid"],
]) assert.equal(normalize(arrival("resident_primary", "approach", 0, false, overrides), flow, mock, {})[field], false);
assert.ok(NOW - normalize(arrival("resident_primary", "approach", -900001), flow, mock, {}).event_at > defaults.max_event_age_ms);
assert.ok(normalize(arrival("resident_primary", "approach", 60001), flow, mock, {}).event_at > NOW + defaults.future_tolerance_ms);
assert.equal(NOW - normalize(arrival("resident_primary", "approach", -900000), flow, mock, {}).event_at, defaults.max_event_age_ms);
assert.equal(normalize(arrival("resident_primary", "approach", 60000), flow, mock, {}).event_at, NOW + defaults.future_tolerance_ms);

let failed = recipient(normalize(arrival("resident_primary", "approach", 2000), flow, mock, {}));
failed = readState(failed, flow, mock, {});
failed = reserve(failed, flow, mock, {});
failed = failDelivery(failed, flow, mock, {});
assert.equal(failed.notification_retry_allowed, true);
assert.equal(failed.notification_retry_count, 1);
assert.equal(failed.delay, 60000);
assert.equal(flow.get("resident_notification_delivery_v2", "persistent").residents.resident_primary.pending_key, null);
failed.notification_retry_count = 2;
failed = failDelivery(failed, flow, mock, {});
assert.equal(failed.notification_retry_allowed, false, "terceira falha deve encerrar retries");

let synthetic = recipient(normalize(arrival("resident_primary", "home", 5000, true), flow, mock, {}));
synthetic = readState(synthetic, flow, mock, {});
synthetic = reserve(synthetic, flow, mock, {});
synthetic = buildMessage(synthetic, flow, mock, privateBindings);
assert.equal(synthetic.payload.message, "[TESTE] Example Primary chegou em casa.");
assert.equal(synthetic.payload.simulated, true);
assert.equal(dryRun(synthetic, flow, mock, {}), null);
assert.equal(flow.get("resident_notifications_last_dry_run_v1__test").dispatched, false);
assert.equal(readState(recipient(normalize(arrival("resident_primary", "home", 5000, true), flow, mock, {})), flow, mock, {}).notification_duplicate, true);

for (const id of ["resident_notifications_notify_primary", "resident_notifications_notify_secondary"]) {
  const service = byId.get(id);
  assert.equal(service.type, "api-call-service");
  assert.match(service.data, /"title":"Casa inteligente"/);
  assert.doesNotMatch(service.data, /payload.test_mode|notification_delivery_under_test/);
}
for (const id of [
  "resident_notifications_test_primary",
  "resident_notifications_test_home",
  "resident_notifications_test_secondary",
  "resident_notifications_test_direction",
  "resident_notifications_test_unavailable",
  "resident_notifications_test_stale",
  "resident_notifications_test_future",
  "resident_notifications_test_duplicate",
]) assert.deepEqual(byId.get(id).wires, [["resident_notifications_test_adapter"]]);
assert.deepEqual(byId.get("resident_notifications_test_gate").wires[0], ["resident_notifications_dry_run_out"]);
assert.equal((byId.get("resident_notifications_dry_run_terminal").wires ?? []).flat().length, 0);
assert.deepEqual(byId.get("resident_notifications_delivery_catch").scope.sort(), ["resident_notifications_notify_primary", "resident_notifications_notify_secondary"].sort());
assert.deepEqual(byId.get("resident_notifications_delivery_ack").wires, []);

const maxFunctionSize = Math.max(...tabNodes.filter((node) => node.type === "function").map((node) => node.func.length));
assert.ok(maxFunctionSize < 1500, `JavaScript residual grande: ${maxFunctionSize}`);

Date.now = originalNow;
console.log("Resident notification canonical-arrival tests passed.");
