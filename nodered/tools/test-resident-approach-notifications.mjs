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
assert.ok(tabNodes.length >= 70);
assert.equal(tabNodes.filter((node) => node.type === "server-state-changed").length, 0);
assert.match(tab.info, /Testes manuais nunca enviam push/);

for (const id of [
  "resident_notifications_policy_switch",
  "resident_notifications_policy_available",
  "resident_notifications_source_switch",
  "resident_notifications_states_switch",
  "resident_notifications_future_switch",
  "resident_notifications_stale_switch",
  "resident_notifications_current_switch",
  "resident_notifications_approach_switch",
  "resident_notifications_previous_switch",
  "resident_notifications_notified_switch",
  "resident_notifications_duplicate_switch",
  "resident_notifications_state_action_switch",
  "resident_notifications_test_gate",
  "resident_notifications_recipient_switch",
]) assert.equal(byId.get(id)?.type, "switch", `decisão visual ausente: ${id}`);

const peopleOut = byId.get("people_location_notification_out_v1");
const canonicalIn = byId.get("resident_notifications_canonical_in_v1");
assert.ok(peopleOut.links.includes(canonicalIn.id));
assert.ok(canonicalIn.links.includes(peopleOut.id));

const validatePolicy = getFunction("resident_notifications_policy_validate");
const storePolicy = getFunction("resident_notifications_policy_store");
const loadPolicy = getFunction("resident_notifications_policy_load");
const normalize = getFunction("resident_notifications_prepare");
const readState = getFunction("resident_notifications_state_read");
const writeState = getFunction("resident_notifications_state_write");
const buildMessage = getFunction("resident_notifications_message_build");
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
  approach_zone: "near_home",
  dedupe_ttl_ms: 600000,
  max_event_age_ms: 900000,
  future_tolerance_ms: 60000,
};
let message = validatePolicy({ payload: defaults }, flow, mock, {});
assert.equal(message.policy_valid, true);
assert.equal(storePolicy(message, flow, mock, {}), null);
message = loadPolicy({}, flow, mock, {});
assert.equal(message.policy_available, true);
assert.deepEqual(message.policy, { version: 1, ...defaults });

for (const payload of [
  { ...defaults, dedupe_ttl_ms: 59999 },
  { ...defaults, dedupe_ttl_ms: 3600001 },
  { ...defaults, max_event_age_ms: 59999 },
  { ...defaults, future_tolerance_ms: -1 },
  { ...defaults, future_tolerance_ms: 300001 },
  { ...defaults, max_event_age_ms: 60000, future_tolerance_ms: 60000 },
  { ...defaults, approach_zone: "" },
]) assert.equal(validatePolicy({ payload }, flow, mock, {}).policy_valid, false);
assert.equal(validatePolicy({ payload: { ...defaults, dedupe_ttl_ms: 60000, max_event_age_ms: 60000, future_tolerance_ms: 0 } }, flow, mock, {}).policy_valid, true);
assert.equal(validatePolicy({ payload: { ...defaults, dedupe_ttl_ms: 3600000, max_event_age_ms: 3600000, future_tolerance_ms: 300000 } }, flow, mock, {}).policy_valid, true);
assert.deepEqual(loadPolicy({}, flow, mock, {}).policy, { version: 1, ...defaults }, "inválidos não substituem a última política");

function approach(source, previous = "not_home", current = "near_home", offset = 0, testMode = false) {
  return {
    _location_test: testMode,
    resident_recipient: source === "resident_primary" ? "resident_secondary" : "resident_primary",
    policy: { version: 1, ...defaults },
    payload: {
      source,
      trigger_state: current,
      trigger_prev_state: previous,
      observed_at: new Date(NOW + offset).toISOString(),
      test_mode: testMode,
    },
  };
}

message = normalize(approach("resident_secondary"), flow, mock, {});
assert.equal(message.resident_states_available, true);
assert.equal(message.event_at, NOW);
message = readState(message, flow, mock, {});
assert.equal(message.notification_previously_sent, false);
assert.equal(message.notification_duplicate, false);
message.notification_state_action = "notified";
message = writeState(message, flow, mock, {});
message = buildMessage(message, flow, mock, privateBindings);
assert.equal(message.payload.recipient, "resident_primary");
assert.equal(message.payload.message, "Example Secondary está perto de casa.");
assert.equal(message.payload.dispatched, false);

const persisted = structuredClone(flow.get("resident_approach_notification_recovery_v1", "persistent"));
const restarted = context({ persistent: { resident_approach_notification_recovery_v1: persisted } });
let repeated = readState(normalize(approach("resident_secondary"), restarted, mock, {}), restarted, mock, {});
assert.equal(repeated.notification_previously_sent, true);
assert.equal(repeated.notification_duplicate, true);

let rearm = readState(normalize(approach("resident_secondary", "near_home", "not_home", 1000), restarted, mock, {}), restarted, mock, {});
rearm.notification_state_action = "rearm";
writeState(rearm, restarted, mock, {});
let nextCycle = readState(normalize(approach("resident_secondary", "not_home", "near_home", 2000), restarted, mock, {}), restarted, mock, {});
assert.equal(nextCycle.notification_previously_sent, false);
assert.equal(nextCycle.notification_duplicate, false);

assert.equal(normalize(approach("resident_primary", "unavailable"), flow, mock, {}).resident_states_available, false);
assert.ok(NOW - normalize(approach("resident_primary", "not_home", "near_home", -900001), flow, mock, {}).event_at > defaults.max_event_age_ms);
assert.ok(normalize(approach("resident_primary", "not_home", "near_home", 60001), flow, mock, {}).event_at > NOW + defaults.future_tolerance_ms);
assert.equal(NOW - normalize(approach("resident_primary", "not_home", "near_home", -900000), flow, mock, {}).event_at, defaults.max_event_age_ms);
assert.equal(normalize(approach("resident_primary", "not_home", "near_home", 60000), flow, mock, {}).event_at, NOW + defaults.future_tolerance_ms);

let synthetic = normalize(approach("resident_primary", "not_home", "near_home", 5000, true), flow, mock, {});
synthetic = readState(synthetic, flow, mock, {});
synthetic.notification_state_action = "notified";
synthetic = writeState(synthetic, flow, mock, {});
synthetic = buildMessage(synthetic, flow, mock, privateBindings);
assert.equal(synthetic.payload.message, "[TESTE] Example Primary está perto de casa.");
assert.equal(synthetic.payload.simulated, true);
assert.equal(dryRun(synthetic, flow, mock, {}), null);
assert.equal(flow.get("resident_notifications_last_dry_run_v1__test").dispatched, false);

for (const id of ["resident_notifications_notify_primary", "resident_notifications_notify_secondary"]) {
  const service = byId.get(id);
  assert.equal(service.type, "api-call-service");
  assert.match(service.data, /"title":"Casa inteligente"/);
  assert.doesNotMatch(service.data, /payload.test_mode|notification_delivery_under_test/);
}
for (const id of [
  "resident_notifications_test_primary",
  "resident_notifications_test_secondary",
  "resident_notifications_test_departure",
  "resident_notifications_test_unavailable",
  "resident_notifications_test_stale",
  "resident_notifications_test_future",
]) assert.deepEqual(byId.get(id).wires, [["resident_notifications_test_adapter"]]);
assert.deepEqual(byId.get("resident_notifications_test_gate").wires[0], ["resident_notifications_dry_run_out"]);
assert.equal((byId.get("resident_notifications_dry_run_terminal").wires ?? []).flat().length, 0);

const maxFunctionSize = Math.max(...tabNodes.filter((node) => node.type === "function").map((node) => node.func.length));
assert.ok(maxFunctionSize < 1500, `JavaScript residual grande: ${maxFunctionSize}`);

Date.now = originalNow;
console.log("Resident notification visual flow tests passed.");
