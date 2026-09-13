#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";

const flowsPath = process.argv[2] ?? new URL("../flows.json", import.meta.url);
const flows = JSON.parse(fs.readFileSync(flowsPath, "utf8"));
const byId = new Map(flows.map((node) => [node.id, node]));
const tabNodes = flows.filter((node) => node.z === "1f468eaeef0733dd");
const compile = (id) => {
  const node = byId.get(id);
  assert.equal(node?.type, "function", `function ausente: ${id}`);
  return new Function("msg", "flow", "node", "global", node.func);
};
function contexts() {
  const flowStores = { default: new Map(), persistent: new Map() };
  const globals = new Map();
  return {
    flow: {
      get(key, store = "default") { return flowStores[store].get(key); },
      set(key, value, store = "default") { flowStores[store].set(key, structuredClone(value)); },
    },
    global: { get(key) { return globals.get(key); }, set(key, value) { globals.set(key, structuredClone(value)); } },
    flowStores, globals,
  };
}
const nodeMock = { status() {}, warn() {}, error() {} };
const call = (fn, msg, ctx) => fn(msg, ctx.flow, nodeMock, ctx.global);
const ids = {
  policyValidate: "alarm_arrival_policy_validate", policyStore: "alarm_arrival_policy_store", policyLoad: "alarm_arrival_request_policy_load",
  normalize: "alarm_arrival_normalize", requestRead: "alarm_arrival_request_read", requestBuild: "alarm_arrival_request_build",
  ack: "alarm_arrival_notification_ack_v1", testRead: "alarm_arrival_test_read", testBuild: "alarm_arrival_test_build",
  simulate: "alarm_arrival_test_simulate_confirmation_v1", confirmationRead: "alarm_arrival_confirmation_read",
  testFinish: "alarm_arrival_test_finish", realClear: "alarm_arrival_real_clear_cancel", disarmBuild: "alarm_arrival_disarm_build",
  dryRun: "alarm_arrival_test_dry_run_terminal_v1",
};
const f = Object.fromEntries(Object.entries(ids).map(([key, id]) => [key, compile(id)]));
const defaults = { cooldown_s: 60, confirmation_ttl_s: 300, delivery_window_s: 30, test_ttl_s: 120 };

for (const id of [
  "alarm_arrival_policy_switch", "alarm_arrival_contract_gate", "alarm_arrival_kind_gate", "alarm_arrival_source_gate",
  "alarm_arrival_stage_gate", "alarm_arrival_direction_gate", "alarm_arrival_cycle_gate", "alarm_arrival_self_gate",
  "alarm_arrival_test_gate", "a305a1379c919215", "alarm_arrival_pending_gate", "alarm_arrival_inflight_gate",
  "alarm_arrival_cooldown_gate", "alarm_arrival_action_gate", "alarm_arrival_action_test_gate",
  "alarm_arrival_test_pending_gate", "alarm_arrival_test_token_gate", "alarm_arrival_test_expired_gate",
  "alarm_arrival_test_confirm_gate", "alarm_arrival_real_pending_gate", "alarm_arrival_real_expired_gate",
  "alarm_arrival_real_cancel_gate", "alarm_arrival_real_confirm_gate",
]) assert.equal(byId.get(id)?.type, "switch", `decisão visual ausente: ${id}`);

const ctx = contexts();
let msg = call(f.policyValidate, { payload: defaults }, ctx);
assert.equal(msg.policy_valid, true);
call(f.policyStore, msg, ctx);
assert.deepEqual(call(f.policyLoad, {}, ctx).policy, { version: 1, ...defaults });
for (const payload of [
  { ...defaults, cooldown_s: -1 }, { ...defaults, cooldown_s: 601 },
  { ...defaults, confirmation_ttl_s: 29 }, { ...defaults, confirmation_ttl_s: 901 },
  { ...defaults, delivery_window_s: 4 }, { ...defaults, delivery_window_s: 121 },
  { ...defaults, test_ttl_s: 29 }, { ...defaults, test_ttl_s: 601 },
]) assert.equal(call(f.policyValidate, { payload }, ctx).policy_valid, false);
assert.equal(call(f.policyValidate, { payload: { cooldown_s: 0, confirmation_ttl_s: 30, delivery_window_s: 5, test_ttl_s: 30 } }, ctx).policy_valid, true);
assert.equal(call(f.policyValidate, { payload: { cooldown_s: 600, confirmation_ttl_s: 900, delivery_window_s: 120, test_ttl_s: 600 } }, ctx).policy_valid, true);
assert.deepEqual(call(f.policyLoad, {}, ctx).policy, { version: 1, ...defaults });

const validPayload = {
  contract: "security.arrival.v1", kind: "arrival", source: "resident_primary", arriving: ["resident_primary"],
  arrival_stage: "approach", arrival_direction: "returning", external_cycle_confirmed: true,
};
msg = call(f.normalize, { payload: validPayload, arrival_now: 100000 }, ctx);
for (const field of ["arrival_contract_valid", "arrival_kind_valid", "arrival_source_valid", "arrival_stage_valid", "arrival_direction_valid", "arrival_cycle_confirmed", "arrival_self_listed"]) assert.equal(msg[field], true, field);
for (const mutation of [
  { source: "unknown" }, { arriving: [] }, { arrival_stage: "away" }, { arrival_direction: "departure" }, { external_cycle_confirmed: false },
]) {
  const invalid = call(f.normalize, { payload: { ...validPayload, ...mutation } }, contexts());
  assert.equal([
    invalid.arrival_contract_valid, invalid.arrival_kind_valid, invalid.arrival_source_valid,
    invalid.arrival_stage_valid, invalid.arrival_direction_valid, invalid.arrival_cycle_confirmed,
    invalid.arrival_self_listed,
  ].every(Boolean), false);
}

msg = call(f.policyLoad, { ...msg }, ctx);
msg = call(f.requestRead, msg, ctx);
assert.equal(msg.arrival_request.pending_active, false);
msg = call(f.requestBuild, msg, ctx);
assert.match(msg.confirm_action, /^ALARME_DESARMAR_/);
assert.equal(msg.alarmConfirmationCandidate.expiresAt, 400000);
assert.equal(ctx.flowStores.default.get("alarm_arrival_pending_confirmation"), null, "pendência aguarda aceite HA");
call(f.ack, msg, ctx);
assert.equal(ctx.flowStores.default.get("alarm_arrival_pending_confirmation").confirmAction, msg.confirm_action);
let duplicate = call(f.requestRead, call(f.policyLoad, { arrival_now: 100001 }, ctx), ctx);
assert.equal(duplicate.arrival_request.pending_active, true);

let confirmation = call(f.confirmationRead, { arrival_now: 100002, payload: { action: "OUTRA_ACAO" } }, ctx);
assert.equal(confirmation.confirmation.is_test, false);
assert.equal(confirmation.confirmation.action === confirmation.confirmation.pending.confirmAction, false);
assert.ok(ctx.flowStores.default.get("alarm_arrival_pending_confirmation"));
confirmation = call(f.confirmationRead, { arrival_now: 100003, payload: { action: msg.confirm_action, context: { user_id: "synthetic_user" } } }, ctx);
let disarm = call(f.disarmBuild, confirmation, ctx);
assert.equal(disarm.alarm_disarm_automatic, true);
assert.equal(disarm.alarm_disarm_reason, "chegada_confirmada_resident_primary_approach");
assert.equal(ctx.flowStores.default.get("alarm_arrival_pending_confirmation"), null);

const testCtx = contexts();
call(f.policyStore, call(f.policyValidate, { payload: defaults }, testCtx), testCtx);
msg = { ...call(f.policyLoad, { arrival_now: 200000, payload: { ...validPayload, test_mode: true, test_case: "manual" }, _location_test: true }, testCtx) };
msg.arrival_source = "resident_primary";
msg.arrival_stage = "approach";
msg = call(f.testRead, msg, testCtx);
msg = call(f.testBuild, msg, testCtx);
assert.match(msg.confirm_action, /^ALARME_TESTE_CONFIRMAR_/);
msg = call(f.simulate, msg, testCtx);
confirmation = call(f.confirmationRead, { ...msg, arrival_now: 200001 }, testCtx);
assert.equal(confirmation.confirmation.test_token_matches, true);
confirmation.alarm_arrival_test_result = "confirmado";
msg = call(f.testFinish, confirmation, testCtx);
assert.equal(msg.alarm_arrival_test, true);
call(f.dryRun, msg, testCtx);
assert.equal(testCtx.flowStores.default.get("alarm_arrival_last_dry_run_v1").dispatched, false);
assert.equal(testCtx.flowStores.default.get("alarm_arrival_pending_confirmation"), undefined, "TESTE não contamina produção");

assert.ok(byId.get("397c6032b3dad342")?.links.includes("6481cb991b3732f5"));
assert.ok(byId.get("2aa1b0c2907d4017")?.links.includes("6481cb991b3732f5"));
assert.deepEqual(byId.get("alarm_arrival_disarm_command_in")?.wires, [["alarm_set_arrival_disarm"]]);
for (const [id, recipient] of [["3b95712a74512929", "resident_primary"], ["370622ddaaf3fcab", "resident_secondary"]]) {
  assert.equal(byId.get(id)?.type, "change");
  const contract = byId.get(id).rules.map((rule) => String(rule.to ?? "")).join("\n");
  assert.match(contract, new RegExp(`"recipients":\\["${recipient}"\\]`));
  assert.match(contract, /confirm_action/);
  assert.match(contract, /cancel_action/);
  assert.deepEqual(byId.get(`${id}__hub_call`)?.links, ["notification_hub_mobile_in"]);
}
for (const node of tabNodes.filter((entry) => entry.type === "function")) assert.ok(node.func.length < 2000, `JavaScript residual grande: ${node.id}`);
console.log("Alarm arrival visual flow: contracts, bounds, pending, tokens, confirmation and dry-run passed.");
