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
  bypassFunction: "security_light_engine_bypass_function_v1",
  bypassTestOn: "security_light_engine_bypass_test_on_v1",
  bypassTestOff: "security_light_engine_bypass_test_off_v1",
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
const bypassFunction = byId.get(ids.bypassFunction);
const dryRunTerminal = byId.get("light_full_dry_run_terminal_v1");
assert(
  group && coordinator && normalizer && gate && mergeContext &&
    prepareArrival && checkInactive && markActive && bypassFunction && dryRunTerminal,
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

for (const [id, requestedState] of [
  [ids.bypassTestOn, "ON"],
  [ids.bypassTestOff, "OFF"],
]) {
  const node = byId.get(id);
  assert(node, `controle de bypass ausente: ${id}`);
  assert.equal(node.type, "inject");
  assert.equal(JSON.parse(node.payload).requested_state, requestedState);
  assert.deepEqual(node.wires, [[ids.bypassFunction]]);
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
  people_context_v1__test: {
    ready: true,
    updated_at: Date.now(),
    resident_primary: {
      ready: true,
      stale: false,
      state: "chegando",
    },
  },
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

const pendingKey = "security_light_pending_arrival_v1__test";
const arrivalAt = Date.now() - 5 * 60_000;
gateFlow.set("sun_below_horizon", false);
gateFlow.set("vehicle_primary_context_v1__test", {
  ready: true,
  lighting_ready: false,
  in_use: true,
  engine_on: false,
  engine_state_valid: false,
  engine_stale: true,
  updated_at: arrivalAt,
});
const queued = execute(prepareArrival, {
  _location_test: true,
  _location_test_case: "arrival_before_sunset",
  payload: {
    kind: "arrival",
    test_mode: true,
    source: "resident_primary",
    arrival_stage: "approach",
    event_at: arrivalAt,
  },
}, gateFlow, shared);
assert.equal(queued[0], null, "sem motor confiável a chegada deve aguardar");
assert.equal(gateFlow.get(pendingKey).version, 2);
assert.equal(gateFlow.get(pendingKey).retention, "while_approaching");
assert.equal(gateFlow.get(pendingKey).expires_at, null);

gateFlow.set("sun_below_horizon", true);
const sunset = execute(mergeContext, {
  _location_test: true,
  _location_test_case: "arrival_before_sunset",
  payload: {
    kind: "sun_context",
    test_mode: true,
    sun_below_horizon: true,
    updated_at: Date.now(),
  },
}, gateFlow, shared);
assert.equal(sunset[2], null, "bypass desligado ainda deve aguardar motor confiável");
assert(gateFlow.get(pendingKey), "chegada com mais de 2 min deve permanecer em chegando");

const bypassOn = execute(bypassFunction, {
  _location_test: true,
  payload: {
    requested_state: "ON",
    test_mode: true,
    test_case: "engine_bypass_on",
  },
}, gateFlow, shared);
assert.equal(bypassOn[0], null, "teste não deve publicar discovery MQTT");
assert.equal(gateFlow.get("security_light_engine_bypass_enabled__test"), true);

const manualOwnershipFlow = memory({
  security_light_engine_bypass_enabled: true,
});
execute(bypassFunction, {
  payload: JSON.stringify({
    requested_state: "ON",
    source: "provider_backoff",
  }),
}, manualOwnershipFlow, shared);
assert.equal(
  manualOwnershipFlow.get("security_light_engine_bypass_automatic"),
  undefined,
  "um ON manual existente não pode virar propriedade da automação",
);
assert.equal(execute(bypassFunction, {
  payload: JSON.stringify({
    requested_state: "OFF",
    source: "provider_recovered",
  }),
}, manualOwnershipFlow, shared), null);
assert.equal(
  manualOwnershipFlow.get("security_light_engine_bypass_enabled"),
  true,
  "a recuperação da API deve preservar o ON escolhido pelo usuário",
);

const automaticOwnershipFlow = memory({
  security_light_engine_bypass_enabled: false,
});
const automaticOn = execute(bypassFunction, {
  payload: JSON.stringify({
    requested_state: "ON",
    source: "provider_backoff",
  }),
}, automaticOwnershipFlow, shared);
assert(automaticOn[0], "falha da API deve publicar o bypass ON");
assert.equal(automaticOwnershipFlow.get("security_light_engine_bypass_enabled"), true);
assert.equal(automaticOwnershipFlow.get("security_light_engine_bypass_automatic"), true);
const automaticOff = execute(bypassFunction, {
  payload: JSON.stringify({
    requested_state: "OFF",
    source: "provider_recovered",
  }),
}, automaticOwnershipFlow, shared);
assert(automaticOff[0], "recuperação deve publicar OFF quando o ON foi automático");
assert.equal(automaticOwnershipFlow.get("security_light_engine_bypass_enabled"), false);
assert.equal(automaticOwnershipFlow.get("security_light_engine_bypass_automatic"), false);

assert.equal(execute(gate, {
  _location_test: true,
  payload: {
    test_mode: true,
    vehicle_primary_in_use: false,
    vehicle_primary_engine_on: false,
    vehicle_primary_engine_state_valid: true,
    vehicle_primary_engine_stale: false,
    vehicle_primary_lighting_ready: true,
    engine_data_unreliable: false,
  },
}, gateFlow, shared), null, "bypass nunca pode ignorar motor OFF confiável");

const bypassReplay = execute(
  mergeContext,
  bypassOn[1],
  gateFlow,
  shared,
);
assert(bypassReplay[2], "bypass deve reprocessar chegada quando motor está stale");
assert.equal(
  bypassReplay[2].payload.arrival_replayed_after_context_recovery,
  true,
);
assert.equal(bypassReplay[2].payload.test_mode, true);

const prepared = execute(prepareArrival, bypassReplay[2], gateFlow, shared)[0];
assert(prepared, "replay com bypass deve atravessar a preparação de acendimento");
assert.equal(prepared.payload.sun_below_horizon, true);
assert.equal(prepared.payload.engine_bypass_allowed, true);

const gated = execute(gate, prepared, gateFlow, shared);
assert(gated, "replay com bypass deve atravessar o gate em test_mode");
assert.equal(gated.payload.vehicle_primary_gate, "manual_bypass_for_unreliable_engine");
const available = execute(checkInactive, gated, gateFlow, shared)[0];
assert(available, "refletor OFF reconciliado deve chegar ao lifecycle de teste");
const dispatched = execute(markActive, available, gateFlow, shared);
assert.equal(dispatched[0], null, "test_mode nunca pode entrar na saída física");
assert(dispatched[1], "test_mode deve chegar ao terminal dry-run");
assert.equal(gateFlow.get("security_light_lifecycle_v1"), undefined);
assert.equal(gateFlow.get("security_light_lifecycle_v1__test").active_by_arrival, true);
assert.equal(gateFlow.get(pendingKey), null, "intenção só é removida após despacho");
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

const cancelFlow = memory({
  sun_ready: true,
  sun_below_horizon: true,
  people_context_v1__test: {
    ready: true,
    updated_at: Date.now() - 1,
    resident_primary: {
      ready: true,
      stale: false,
      state: "chegando",
    },
  },
  vehicle_primary_context_v1__test: {
    ready: true,
    lighting_ready: false,
    engine_state_valid: false,
    engine_stale: true,
  },
  security_light_pending_arrival_v1__test: {
    version: 2,
    retention: "while_approaching",
    source: "resident_primary",
    queued_at: Date.now() - 5 * 60_000,
    event_at: Date.now() - 5 * 60_000,
    expires_at: null,
    message: {
      _location_test: true,
      payload: {
        kind: "arrival",
        source: "resident_primary",
        arrival_stage: "approach",
        test_mode: true,
      },
    },
  },
});
execute(mergeContext, {
  _location_test: true,
  payload: {
    kind: "people_context",
    test_mode: true,
    updated_at: Date.now(),
    context: {
      ready: true,
      updated_at: Date.now(),
      resident_primary: {
        ready: true,
        stale: false,
        state: "home",
      },
    },
  },
}, cancelFlow, shared);
assert.equal(
  cancelFlow.get("security_light_pending_arrival_v1__test"),
  null,
  "entrada em home deve cancelar a intenção pendente",
);

console.log("Motor, bypass seguro e chegada persistente passaram pelo fluxo completo em dry-run." );
