#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";

const flows = JSON.parse(fs.readFileSync(new URL("../flows.json", import.meta.url), "utf8"));
const byId = new Map(flows.map((node) => [node.id, node]));
const prepare = byId.get("resident_notifications_prepare");
assert(prepare, "função de avisos de aproximação ausente");

function memoryFlow(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    get: (key) => values.get(key),
    set: (key, value) => values.set(key, value),
    values,
  };
}

function runNode(id, msg, flow = memoryFlow(), global = memoryFlow()) {
  const execute = new Function(
    "msg", "node", "context", "flow", "global", "env", "setTimeout", "clearTimeout",
    byId.get(id).func,
  );
  return execute(msg, { warn() {}, error() {}, status() {} }, {}, flow, global, {}, setTimeout, clearTimeout);
}

function run(msg, flow = memoryFlow(), global = memoryFlow()) {
  return runNode(prepare.id, msg, flow, global);
}

function privateBindingsGlobal(extra = {}) {
  return memoryFlow({
    publicBindings: {
      roles: {
        resident_primary: { source_alias: "example_primary" },
        resident_secondary: { source_alias: "example_secondary" },
      },
    },
    ...extra,
  });
}

const NOW = Date.parse("2026-08-29T03:00:00.000Z");
const originalNow = Date.now;
Date.now = () => NOW;

function event(source, previous = "not_home", current = "chegando", offset = 0) {
  const prefix = source === "resident_primary" ? "resident_primary" : "resident_secondary";
  return {
    payload: {
      event: "location_update",
      source,
      trigger_entity: source === "resident_primary"
        ? "device_tracker.mobile_primary_source_1"
        : "device_tracker.mobile_secondary_source_1",
      trigger_state: current,
      trigger_prev_state: previous,
      observed_at: new Date(NOW + offset).toISOString(),
      resident_primary_source_1: prefix === "resident_primary" ? current : "not_home",
      resident_primary_source_2: "not_home",
      resident_secondary_source_1: prefix === "resident_secondary" ? current : "not_home",
      resident_secondary_source_2: "not_home",
    },
  };
}

const passed = [];
function scenario(name, callback) {
  callback();
  passed.push(name);
}

scenario("01 fluxo é independente de contexto, veículo e iluminação", () => {
  const tab = byId.get("resident_notifications_tab");
  assert.equal(tab.label, "notificacoes_chegadas_residentes");
  assert.doesNotMatch(prepare.func, /vehicle_primary|sun\.|below_horizon|hour|contexto_chegadas/);
  assert.deepEqual(prepare.wires, [
    ["resident_notifications_notify_primary"],
    ["resident_notifications_notify_secondary"],
    ["resident_notifications_notify_primary"],
    ["resident_notifications_notify_secondary"],
  ]);
});

scenario("02 resident_secondary avisa resident_primary também de madrugada", () => {
  const output = run(
    event("resident_secondary"),
    memoryFlow(),
    privateBindingsGlobal(),
  );
  assert(output[0]);
  assert.equal(output[1], null);
  assert.equal(output[0].payload.recipient, "resident_primary");
  assert.equal(output[0].payload.message, "Example Secondary está chegando.");
});

scenario("03 resident_primary avisa resident_secondary", () => {
  const output = run(
    event("resident_primary"),
    memoryFlow(),
    privateBindingsGlobal(),
  );
  assert.equal(output[0], null);
  assert(output[1]);
  assert.equal(output[1].payload.recipient, "resident_secondary");
  assert.equal(output[1].payload.message, "Example Primary está chegando.");
});

scenario("04 saída de casa não é confundida com chegada", () => {
  assert.equal(run(event("resident_primary", "home", "chegando")), null);
});

scenario("05 um novo ciclo fora de casa rearma o aviso", () => {
  const flow = memoryFlow();
  assert(run(event("resident_secondary"), flow)?.[0]);
  assert.equal(run(event("resident_secondary", "chegando", "not_home", 1_000), flow), null);
  assert(run(event("resident_secondary", "not_home", "chegando", 2_000), flow)?.[0]);
});

scenario("06 dedupe sobrevive a restart do Node-RED", () => {
  const firstFlow = memoryFlow();
  const input = event("resident_primary");
  assert(run(structuredClone(input), firstFlow)?.[1]);
  const persisted = structuredClone(firstFlow.get("resident_approach_notification_recovery_v1"));
  const restartedFlow = memoryFlow({ resident_approach_notification_recovery_v1: persisted });
  assert.equal(run(structuredClone(input), restartedFlow), null);
});

scenario("07 evento antigo não produz notificação tardia", () => {
  assert.equal(run(event("resident_secondary", "not_home", "chegando", -16 * 60_000)), null);
});

scenario("08 bindings públicos apontam para o destinatário correto", () => {
  const primary = byId.get("resident_notifications_notify_primary");
  const secondary = byId.get("resident_notifications_notify_secondary");
  assert.match(primary.data, /"role":"mobile_primary"/);
  assert.match(primary.data, /"action":"notify_actionable"/);
  assert.match(primary.data, /TESTE/);
  assert.match(secondary.data, /"role":"mobile_secondary"/);
  assert.match(secondary.data, /"action":"notify_actionable"/);
  assert.match(secondary.data, /TESTE/);
  assert.deepEqual(primary.wires, [["resident_notifications_delivery_ack"]]);
  assert.deepEqual(secondary.wires, [["resident_notifications_delivery_ack"]]);
});

scenario("09 teste de localização percorre validação e confirma o push", () => {
  const cycleOut = byId.get("bc2afbce89f5a9d5");
  const cycleIn = byId.get("resident_notifications_test_cycle_in");
  const adapter = byId.get("resident_notifications_test_adapter");
  const deliveryAck = byId.get("resident_notifications_delivery_ack");
  assert(cycleOut.links.includes(cycleIn.id));
  assert(cycleIn.links.includes(cycleOut.id));
  assert.equal(deliveryAck.outputs, 0);
  assert.equal((deliveryAck.wires ?? []).flat().length, 0);

  const global = privateBindingsGlobal({
    security_location_test_state_v1: {
      version: 1,
      resident_primary: "not_home",
      resident_secondary: "chegando",
      observed_at: NOW,
      transitions: {
        people: {
          domain: "people",
          source: "resident_secondary",
          state: "chegando",
          prev: "not_home",
          test_case: "resident_secondary_approach",
          at: NOW,
        },
      },
    },
  });
  const flow = memoryFlow();
  const adapted = runNode(adapter.id, {
    _location_test: true,
    _location_test_case: "resident_secondary_approach",
    payload: { kind: "refresh_tick", test_mode: true },
  }, flow, global);
  assert.equal(adapted.payload.trigger_prev_state, "not_home");
  assert.equal(adapted.payload.trigger_state, "chegando");

  const output = runNode(prepare.id, adapted, flow, global);
  assert.equal(output[0], null);
  assert.equal(output[1], null);
  assert.equal(output[2].payload.recipient, "resident_primary");
  assert.equal(
    output[2].payload.message,
    "[TESTE] Example Secondary está chegando.",
  );
  assert.equal(output[2].payload.simulated, false);
  assert.equal(output[2].payload.dispatched, false);

  assert.equal(runNode(deliveryAck.id, output[2], flow, global), null);
  const result = flow.get("resident_notifications_last_test_delivery_v1__test");
  assert.equal(result.recipient, "resident_primary");
  assert.equal(result.simulated, false);
  assert.equal(result.dispatched, true);
});

scenario("10 botões manuais também passam pelo adaptador seguro", () => {
  for (const id of [
    "resident_notifications_test_primary",
    "resident_notifications_test_secondary",
  ]) {
    assert.deepEqual(byId.get(id).wires, [["resident_notifications_test_adapter"]]);
  }
});

scenario("11 alias privado inválido falha fechado para o papel lógico", () => {
  const global = memoryFlow({
    publicBindings: {
      roles: {
        resident_secondary: { source_alias: "<script>" },
      },
    },
  });
  const output = run(event("resident_secondary"), memoryFlow(), global);
  assert.equal(output[0].payload.message, "resident_secondary está chegando.");
});

Date.now = originalNow;
console.log(`resident approach notifications: ${passed.length} cenários OK`);
for (const name of passed) console.log(name);
