#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";

const flows = JSON.parse(fs.readFileSync(new URL("../flows.json", import.meta.url), "utf8"));
const byId = new Map(flows.map((node) => [node.id, node]));

const ids = {
  group: "5df25064f701ecd2",
  coordinator: "3ad83e8d6897b983",
  output: "2ff281276fc1d020",
  engineOn: "vehicle_primary_manual_engine_on_test_v1",
  engineOff: "vehicle_primary_manual_engine_off_test_v1",
};

function memory(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    get: (key) => values.get(key),
    set: (key, value) => values.set(key, value),
    values,
  };
}

function execute(node, msg, flow, global, envValues = {}, nodeOverrides = {}) {
  const run = new Function(
    "msg", "node", "context", "flow", "global", "env", "setTimeout", "clearTimeout",
    node.func,
  );
  return run(
    msg,
    { log() {}, warn() {}, error() {}, status() {}, ...nodeOverrides },
    {},
    flow,
    global,
    { get: (key) => envValues[key] },
    setTimeout,
    clearTimeout,
  );
}

const group = byId.get(ids.group);
const coordinator = byId.get(ids.coordinator);
const normalizer = flows.find((node) => node.name === "Normalizar vehicle_primary e detectar transições");
const gate = flows.find((node) => node.name === "vehicle_primary está em uso?");
const mergeContext = flows.find((node) => node.name === "Atualizar contexto de alto nível");
const prepareArrival = flows.find((node) => node.name === "Montar decisão de acendimento");
const checkInactive = flows.find((node) => node.name === "Refletor disponível para acender?");
const markActive = flows.find((node) => node.name === "Marcar refletor ativo por chegada");
const dryRunTerminal = byId.get("light_full_dry_run_terminal_v1");
assert(
  group && coordinator && normalizer && gate && mergeContext &&
    prepareArrival && checkInactive && markActive && dryRunTerminal,
  "estrutura de teste obrigatória ausente",
);

for (const [id, testCase] of [
  [ids.engineOn, "vehicle_primary_engine_on"],
  [ids.engineOff, "vehicle_primary_engine_off"],
]) {
  const node = byId.get(id);
  assert(node, `controle ausente: ${id}`);
  assert.equal(node.type, "inject");
  assert.equal(node.props[0].v, testCase);
  assert.deepEqual(node.wires, [[ids.coordinator]]);
  assert(group.nodes.includes(id), `${id} fora do grupo manual`);
}

const shared = memory();
const flow = memory();
execute(coordinator, { test_case: "reset" }, flow, shared);
assert.equal(shared.get("security_location_test_state_v1").vehicle_primary_engine, "off");

const onMessage = execute(coordinator, { test_case: "vehicle_primary_engine_on" }, flow, shared);
assert.equal(onMessage.payload.test_mode, true);
assert.equal(onMessage.payload.test_state.vehicle_primary_engine, "on");
assert.deepEqual(shared.get("security_location_test_state_v1").transitions, {});

execute(coordinator, { test_case: "vehicle_primary_away" }, flow, shared);
assert.equal(shared.get("security_location_test_state_v1").vehicle_primary_engine, "on", "localização deve preservar ON");
assert.equal(shared.get("security_location_test_state_v1").vehicle_primary, "not_home");

const normalizedOn = execute(normalizer, {
  _location_test: true,
  _location_test_case: "vehicle_primary_engine_on",
  payload: { event: "context_snapshot", test_mode: true },
}, flow, shared, { HOME_LAT: "0", HOME_LON: "0", GATE_LAT: "0", GATE_LON: "0" });
assert.equal(normalizedOn[0].payload.context.engine_on, true);
assert.equal(normalizedOn[0].payload.context.in_use, true);
assert.equal(normalizedOn[0].payload.test_mode, true);

const offMessage = execute(coordinator, { test_case: "vehicle_primary_engine_off" }, flow, shared);
assert.equal(offMessage.payload.test_state.vehicle_primary_engine, "off");
execute(coordinator, { test_case: "vehicle_primary_approach" }, flow, shared);
assert.equal(shared.get("security_location_test_state_v1").vehicle_primary_engine, "off", "localização deve preservar OFF");

const normalizedOff = execute(normalizer, {
  _location_test: true,
  _location_test_case: "vehicle_primary_engine_off",
  payload: { event: "context_snapshot", test_mode: true },
}, flow, shared, { HOME_LAT: "0", HOME_LON: "0", GATE_LAT: "0", GATE_LON: "0" });
assert.equal(normalizedOff[0].payload.context.engine_on, false);
assert.equal(normalizedOff[0].payload.context.in_use, false);

const gateFlow = memory({
  sun_ready: true,
  sun_below_horizon: true,
  light_reconciled: true,
  security_light_physical_state: "off",
  security_light_physical_observed_at: Date.now(),
  people_context_v1__test: { ready: true, updated_at: Date.now() },
});
assert(execute(gate, {
  payload: {
    vehicle_primary_in_use: true,
    vehicle_primary_engine_on: true,
    vehicle_primary_engine_state_valid: true,
  },
}, gateFlow, shared));
assert.equal(execute(gate, {
  payload: {
    vehicle_primary_in_use: false,
    vehicle_primary_engine_on: false,
    vehicle_primary_engine_state_valid: true,
  },
}, gateFlow, shared), null);

const testStatuses = [];
const testGateApproved = execute(gate, {
  _location_test: true,
  payload: {
    test_mode: true,
    vehicle_primary_in_use: true,
    vehicle_primary_engine_on: true,
    vehicle_primary_engine_state_valid: true,
  },
}, gateFlow, shared, {}, { status: (status) => testStatuses.push(status.text) });
assert(testGateApproved, "gate aprovado deve continuar pelo dry-run");
assert.equal(testGateApproved.payload.dispatched, false);
assert.equal(testStatuses.at(-1), "TESTE: gate aprovado — continuando dry-run");

assert.equal(execute(gate, {
  _location_test: true,
  payload: {
    test_mode: true,
    kind: "arrival",
    source: "resident_primary",
    arrival_stage: "approach",
    event_at: Date.now(),
    vehicle_primary_in_use: false,
    vehicle_primary_engine_on: false,
    vehicle_primary_engine_state_valid: true,
  },
}, gateFlow, shared, {}, { status: (status) => testStatuses.push(status.text) }), null);
assert.equal(testStatuses.at(-1), "TESTE: aguardando motor ON — chegada preservada");
const pendingKey = "security_light_pending_arrival_v1__test";
assert.equal(gateFlow.get(pendingKey).wait_reason, "vehicle_engine_on_after_arrival");

const offUpdatedAt = Date.now() + 1;
const offContext = execute(mergeContext, {
  _location_test: true,
  _location_test_case: "vehicle_primary_engine_off",
  payload: {
    kind: "vehicle_primary_context",
    test_mode: true,
    updated_at: offUpdatedAt,
    context: {
      ready: true,
      lighting_ready: true,
      in_use: false,
      engine_on: false,
      engine_state_valid: true,
      engine_stale: false,
      updated_at: offUpdatedAt,
    },
  },
}, gateFlow, shared);
assert.equal(offContext[2], null, "motor OFF não pode reprocessar a chegada");
assert(gateFlow.get(pendingKey), "chegada deve continuar pendente enquanto o motor está OFF");

const onUpdatedAt = offUpdatedAt + 1;
const onContext = execute(mergeContext, {
  _location_test: true,
  _location_test_case: "vehicle_primary_engine_on",
  payload: {
    kind: "vehicle_primary_context",
    test_mode: true,
    updated_at: onUpdatedAt,
    context: {
      ready: true,
      lighting_ready: true,
      in_use: true,
      engine_on: true,
      engine_state_valid: true,
      engine_stale: false,
      updated_at: onUpdatedAt,
    },
  },
}, gateFlow, shared);
assert(onContext[2], "motor ON deve reprocessar a chegada preservada");
assert.equal(onContext[2].payload.arrival_replayed_after_context_recovery, true);
assert.equal(onContext[2].payload.test_mode, true);
assert.equal(gateFlow.get(pendingKey), null);

const prepared = execute(prepareArrival, onContext[2], gateFlow, shared)[0];
assert(prepared, "replay ON deve atravessar a preparação de acendimento");
assert.equal(prepared.payload.sun_below_horizon, true);

const gated = execute(gate, prepared, gateFlow, shared);
assert(gated, "replay ON deve atravessar o gate em test_mode");
const available = execute(checkInactive, gated, gateFlow, shared)[0];
assert(available, "refletor OFF reconciliado deve chegar ao lifecycle de teste");
const dispatched = execute(markActive, available, gateFlow, shared);
assert.equal(dispatched[0], null, "test_mode nunca pode entrar na saída física");
assert(dispatched[1], "test_mode deve chegar ao terminal dry-run");
assert.equal(gateFlow.get("security_light_lifecycle_v1"), undefined);
assert.equal(gateFlow.get("security_light_lifecycle_v1__test").active_by_arrival, true);
assert.deepEqual(markActive.wires[0], [
  "f863fcd77744a4da",
  "9f047ccb2ce2c3aa",
  "2818bf202b397612",
  "light_notify_on_secondary",
]);
assert.deepEqual(markActive.wires[1], ["light_test_to_terminal_out_v1"]);

execute(dryRunTerminal, dispatched[1], gateFlow, shared);
const finalResult = gateFlow.get("security_light_last_dry_run_v1__test");
assert.equal(finalResult.simulated, true);
assert.equal(finalResult.dispatched, false);
assert.equal(finalResult.actions.length, 4);
assert.equal((dryRunTerminal.wires ?? []).flat().length, 0);

console.log("Testes manuais ON/OFF passaram pelo fluxo completo até o terminal dry-run, sem dispositivos." );
