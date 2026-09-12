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

function execute(id, msg, flow = memory(), global = memory()) {
  const candidate = byId.get(id);
  assert(candidate && candidate.type === "function", `function node ausente: ${id}`);
  return new Function("msg", "node", "context", "flow", "global", candidate.func)(
    msg,
    { status() {}, warn() {}, error() {}, log() {} },
    {},
    flow,
    global,
  );
}

const dashboard = byId.get("gar_dashboard_request_in");
assert.equal(dashboard?.type, "server-events");
assert.equal(dashboard?.eventType, "portao_garagem_pulso_solicitado");
assert.deepEqual(dashboard?.wires, [["gar_request_normalize"]]);

const normalized = execute("gar_request_normalize", {
  payload: {
    event_type: "portao_garagem_pulso_solicitado",
    event: { action: "single", origem: "botao_dashboard" },
  },
});
assert.equal(normalized.request.action, "single");
assert.equal(normalized.request.origin, "botao_dashboard");

const policy = {
  version: 1,
  complete: true,
  dedupe_ms: 900,
  cooldown_ms: 1000,
  pulse_ms: 700,
  same_pulse_ms: 500,
};
const originalNow = Date.now;
try {
  const now = 2_000_000;
  Date.now = () => now;
  const production = memory();
  const accepted = execute("gar_request_evaluate", { request: normalized.request, policy }, production);
  assert.equal(accepted.decision.action, "pulse");
  assert.equal(production.get("garage_gate_state_v1").last_pulse_ms, now, "cooldown deve ser armado antes do ON");
  assert.equal(production.get("portao_garagem_last_pulse_ms"), now, "estado legado deve permanecer apto a rollback");

  const migratedLegacy = memory({
    portao_garagem_last_click_ms: now - 900,
    portao_garagem_last_pulse_ms: now - 999,
  });
  const migratedDecision = execute("gar_request_evaluate", { request: normalized.request, policy }, migratedLegacy);
  assert.equal(migratedDecision.decision.reason, "cooldown", "restart deve recuperar os timestamps legados");

  const observed = memory();
  const observerBindings = memory({
    publicBindings: { roles: { garage_gate: { topics: { state: "test/garage_gate/state" } } } },
  });
  const observation = execute("gar_pulse_watch_normalize", {
    topic: "test/garage_gate/state",
    payload: { state: "ON" },
  });
  observation.policy = policy;
  execute("gar_pulse_watch_stamp", observation, observed, observerBindings);
  assert.equal(observed.get("garage_gate_state_v1").relay_state, "ON");
  assert.equal(observed.get("garage_gate_state_v1").last_pulse_ms, now);

  const coalesced = memory({ garage_gate_state_v1: { last_pulse_ms: now - 300 } });
  execute("gar_pulse_watch_stamp", observation, coalesced, observerBindings);
  assert.equal(coalesced.get("garage_gate_state_v1").last_pulse_ms, now - 300, "retorno MQTT não deve alongar o cooldown");
} finally {
  Date.now = originalNow;
}

for (const id of [
  "gar_group_policy", "gar_policy_validate", "gar_group_request",
  "gar_request_normalize", "gar_request_action_switch", "gar_request_evaluate",
  "gar_request_decision_switch", "gar_group_observer", "gar_pulse_watch_normalize",
  "gar_pulse_watch_state_switch", "gar_group_effect", "gar_pulse_test_gate",
  "gar_safe_off_test_gate", "gar_group_tests", "gar_test_dry_run_terminal",
]) {
  assert.ok(byId.get(id), `nó visual obrigatório ausente: ${id}`);
}

for (const candidate of flows.filter((node) => node.z === "29d64664bf8cbde8" && node.type !== "group")) {
  assert.ok(candidate.g, `nó da garagem fora de grupo: ${candidate.id}`);
}

console.log("Evento do dashboard percorre política visual, decisão e gates seguros.");
