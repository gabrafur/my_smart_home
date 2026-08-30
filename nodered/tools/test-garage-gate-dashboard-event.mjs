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
    { status() {}, warn() {}, error() {}, log() {} },
    {},
    flow,
    global,
  );
}

const dashboard = byId.get("gar_dashboard_request_in");
assert.equal(dashboard?.type, "server-events");
assert.equal(dashboard?.eventType, "portao_garagem_pulso_solicitado");
assert.deepEqual(dashboard?.wires, [["gar_portao_normalizar_click"]]);

const normalizer = byId.get("gar_portao_normalizar_click");
assert.match(normalizer?.func ?? "", /const cooldownMs = 1000;/);
assert.equal(normalizer?.outputs, 2);
assert.deepEqual(normalizer?.wires, [
  ["gar_relay_pulse_on", "gar_log_pulse_started"],
  ["gar_relay_pulse_off", "gar_notify_relay_on"],
]);

const originalNow = Date.now;
try {
  const now = 2_000_000;
  Date.now = () => now;

  const state = memory();
  const accepted = execute("gar_portao_normalizar_click", {
    payload: {
      event_type: "portao_garagem_pulso_solicitado",
      event: { action: "single", origem: "botao_dashboard" },
    },
  }, state);
  assert(accepted?.[0], "envelope real de server-events deve sair pelo ramo de pulso");
  assert.equal(accepted[0].payload.origem, "botao_dashboard", "envelope real de server-events deve ser aceito");
  assert.equal(state.get("portao_garagem_last_pulse_ms"), now, "cooldown deve ser armado antes do ON");
  assert.equal(execute("gar_portao_normalizar_click", { payload: { event: { action: "probe" } } }, memory()), null, "probe nunca deve alcançar o relé");

  const insideCooldown = memory({
    portao_garagem_last_click_ms: now - 900,
    portao_garagem_last_pulse_ms: now - 999,
  });
  assert.equal(execute("gar_portao_normalizar_click", { payload: "single", topic: "test" }, insideCooldown), null, "999 ms ainda deve bloquear o pulso");

  const atBoundary = memory({
    portao_garagem_last_click_ms: now - 900,
    portao_garagem_last_pulse_ms: now - 1000,
  });
  assert.ok(execute("gar_portao_normalizar_click", { payload: "single", topic: "test" }, atBoundary), "1.000 ms deve liberar o pulso");

  const relayOn = memory({
    portao_garagem_relay_state: "ON",
    portao_garagem_last_click_ms: now - 2000,
    portao_garagem_last_pulse_ms: now - 2000,
  });
  const refused = execute("gar_portao_normalizar_click", { payload: { action: "single", origem: "teste" } }, relayOn);
  assert.equal(refused[0], null, "relé já ligado nunca deve receber outro ON");
  assert.equal(refused[1].payload.origem, "teste", "recusa deve seguir para OFF e alerta");

  const observed = memory();
  const observerBindings = memory({
    publicBindings: { roles: { garage_gate: { topics: { state: "test/garage_gate/state" } } } },
  });
  execute("gar_pulse_watch_stamp", { topic: "test/garage_gate/state", payload: { state: "ON" } }, observed, observerBindings);
  assert.equal(observed.get("portao_garagem_relay_state"), "ON");
  assert.equal(observed.get("portao_garagem_last_pulse_ms"), now);

  const coalesced = memory({ portao_garagem_last_pulse_ms: now - 300 });
  execute("gar_pulse_watch_stamp", { topic: "test/garage_gate/state", payload: { state: "ON" } }, coalesced, observerBindings);
  assert.equal(coalesced.get("portao_garagem_last_pulse_ms"), now - 300, "retorno MQTT não deve alongar o cooldown");
} finally {
  Date.now = originalNow;
}

assert.equal(byId.get("gar_relay_safety_delay")?.timeout, "700");
for (const id of [
  "45296e246a57590d", "gar_portao_action_topic_in", "gar_dashboard_request_in",
  "gar_portao_normalizar_click", "gar_relay_pulse_on", "gar_relay_safety_delay",
  "gar_relay_pulse_off", "gar_relay_mqtt_out", "gar_log_pulse_started",
  "gar_notify_relay_on", "gar_pulse_watch_note", "gar_pulse_watch_set_in",
  "gar_pulse_watch_state_in", "gar_pulse_watch_stamp",
]) {
  assert.ok(byId.get(id)?.g, `nó da garagem fora de grupo: ${id}`);
}

console.log("Evento do dashboard do portão passou no replay offline de envelope, cooldown e segurança.");
