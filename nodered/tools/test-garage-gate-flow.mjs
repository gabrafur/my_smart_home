#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";

const flows = JSON.parse(fs.readFileSync(new URL("../flows.json", import.meta.url), "utf8"));
const byId = new Map(flows.map((node) => [node.id, node]));

function memory(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    get: (key) => values.get(key),
    set: (key, value) => values.set(key, value),
  };
}

function execute(id, msg, flow = memory(), global = memory(), events = {}) {
  const candidate = byId.get(id);
  assert(candidate && candidate.type === "function", `function node ausente: ${id}`);
  return new Function("msg", "node", "context", "flow", "global", candidate.func)(
    msg,
    {
      status(value) { events.status = value; },
      warn(value) { events.warn = value; },
      error(value) { events.error = value; },
      log(value) { events.log = value; },
    },
    {},
    flow,
    global,
  );
}

const policyState = memory();
for (const [topic, payload] of [
  ["dedupe_ms", 900],
  ["cooldown_ms", 1000],
  ["pulse_ms", 700],
  ["same_pulse_ms", 500],
]) {
  execute("gar_policy_validate", { topic, payload }, policyState);
}
const policy = policyState.get("garage_gate_policy_v1");
assert.deepEqual(
  Object.fromEntries(["dedupe_ms", "cooldown_ms", "pulse_ms", "same_pulse_ms"].map((key) => [key, policy[key]])),
  { dedupe_ms: 900, cooldown_ms: 1000, pulse_ms: 700, same_pulse_ms: 500 },
);
assert.equal(policy.complete, true);

const invalidEvents = {};
execute("gar_policy_validate", { topic: "pulse_ms", payload: 1000 }, policyState, memory(), invalidEvents);
assert.match(invalidEvents.error, /Política do portão inválida/);
assert.equal(policyState.get("garage_gate_policy_v1").pulse_ms, 700, "valor inválido não pode substituir a política válida");

const normalized = execute("gar_request_normalize", {
  payload: { event: { action: "single", origem: "botao_dashboard", test_mode: true, _test_now_ms: 2_000_000 } },
});
assert.deepEqual(normalized.request, { action: "single", origin: "botao_dashboard" });
assert.equal(normalized.test_mode, true);
assert.equal(normalized._test_now_ms, 2_000_000);

const testState = memory();
const accepted = execute("gar_request_evaluate", {
  request: normalized.request,
  policy,
  test_mode: true,
  _test_now_ms: 2_000_000,
}, testState);
assert.equal(accepted.decision.action, "pulse");
assert.equal(accepted.decision.reason, "accepted");

const duplicate = execute("gar_request_evaluate", {
  request: normalized.request,
  policy,
  test_mode: true,
  _test_now_ms: 2_000_500,
}, testState);
assert.equal(duplicate.decision.action, "blocked");
assert.equal(duplicate.decision.reason, "duplicate");

const cooldown = execute("gar_request_evaluate", {
  request: normalized.request,
  policy,
  test_mode: true,
  _test_now_ms: 2_000_950,
}, testState);
assert.equal(cooldown.decision.reason, "cooldown");

const boundary = execute("gar_request_evaluate", {
  request: normalized.request,
  policy,
  test_mode: true,
  _test_now_ms: 2_001_000,
}, testState);
assert.equal(boundary.decision.action, "pulse", "1.000 ms deve liberar o pulso");

const relayState = memory({ garage_gate_test_state_v1: { relay_state: "ON" } });
const safeOff = execute("gar_request_evaluate", {
  request: normalized.request,
  policy,
  test_mode: true,
  _test_now_ms: 2_003_000,
}, relayState);
assert.equal(safeOff.decision.action, "safe_off");
assert.equal(safeOff.decision.reason, "relay_already_on");

const bindings = memory({
  publicBindings: { roles: { garage_gate: { topics: { command: "test/garage_gate/set" } } } },
});
const on = execute("gar_relay_pulse_on", {}, memory(), bindings);
const off = execute("gar_relay_pulse_off", {}, memory(), bindings);
assert.equal(on.topic, "test/garage_gate/set");
assert.deepEqual(JSON.parse(on.payload), { state: "ON" });
assert.deepEqual(JSON.parse(off.payload), { state: "OFF" });
assert.equal(execute("gar_relay_pulse_on", {}, memory(), memory()), null, "binding ausente deve falhar fechado");

const dryRunMessage = { test_mode: true, decision: { action: "pulse", reason: "accepted" } };
assert.equal(execute("gar_test_dry_run_terminal", dryRunMessage), null);
assert.deepEqual(dryRunMessage.payload, {
  simulated: true,
  dispatched: false,
  domain: "garage_gate",
  requested_action: "pulse",
  reason: "accepted",
});

assert.deepEqual(byId.get("gar_request_decision_switch")?.wires, [
  ["gar_request_pulse_out"],
  ["gar_request_safe_off_out"],
  ["gar_request_blocked_terminal"],
]);
assert.deepEqual(byId.get("gar_pulse_test_gate")?.wires, [
  ["gar_prepare_pulse_delay"],
  ["gar_effect_dry_run_out"],
]);
assert.deepEqual(byId.get("gar_safe_off_test_gate")?.wires, [
  ["gar_effect_safe_off_adapter_out", "gar_notify_relay_on"],
  ["gar_effect_dry_run_out"],
]);
assert.equal(byId.get("gar_relay_safety_delay")?.pauseType, "delayv");
assert.equal(byId.get("gar_prepare_pulse_delay")?.rules?.[0]?.to, "policy.pulse_ms");

console.log("Fluxo visual do portão: política, limites, decisões e dry-run passaram.");
