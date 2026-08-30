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
  const node = byId.get(id);
  assert(node && node.type === "function", `function node ausente: ${id}`);
  return new Function("msg", "node", "context", "flow", "global", node.func)(
    msg,
    { status() {}, warn() {}, error() {} },
    {},
    flow,
    global,
  );
}

const state = memory();
assert.equal(execute("gar_portao_normalizar_click", { payload: "double", topic: "test" }, state), null);
const accepted = execute("gar_portao_normalizar_click", { payload: { action: "single" }, topic: "test" }, state);
assert(accepted?.[0], "pedido single deve sair pelo ramo de pulso");
assert.equal(accepted[0].payload.action, "single");
assert.equal(execute("gar_portao_normalizar_click", { payload: "single", topic: "test" }, state), null, "retransmissão deve ser deduplicada");

const bindings = memory({
  publicBindings: { roles: { garage_gate: { topics: { command: "test/garage_gate/set" } } } },
});
const on = execute("gar_relay_pulse_on", {}, memory(), bindings);
const off = execute("gar_relay_pulse_off", {}, memory(), bindings);
assert.equal(on.topic, "test/garage_gate/set");
assert.deepEqual(JSON.parse(on.payload), { state: "ON" });
assert.deepEqual(JSON.parse(off.payload), { state: "OFF" });
assert.equal(execute("gar_relay_pulse_on", {}, memory(), memory()), null, "binding ausente deve falhar fechado");

console.log("Fluxo do portão passou no replay offline de dedupe, cooldown e pulso.");
