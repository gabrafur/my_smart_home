import assert from "node:assert/strict";
import fs from "node:fs";

const flows = JSON.parse(
  fs.readFileSync(new URL("../flows.json", import.meta.url), "utf8"),
);
const byId = new Map(flows.map((node) => [node.id, node]));

function node(id) {
  const value = byId.get(id);
  assert.ok(value, `missing node ${id}`);
  return value;
}

function memoryFlow(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    get: (key) => values.get(key),
    set: (key, value) => values.set(key, value),
    values,
  };
}

function run(id, msg, flow) {
  const runtimeNode = {
    status() {},
    log() {},
    warn() {},
    error() {},
  };
  return new Function("msg", "flow", "node", node(id).func)(msg, flow, runtimeNode);
}

assert.deepEqual(node("codex_alert_push").wires, [["codex_alert_ack"]]);
assert.deepEqual(node("codex_alert_persistent").wires, [["codex_alert_ack"]]);
assert.deepEqual(node("codex_alert_catch").scope.sort(), [
  "codex_alert_persistent",
  "codex_alert_push",
].sort());

const values = {
  "input_boolean.codex_alertas_iphone": "on",
  "input_boolean.codex_resumo_diario_iphone": "on",
  "input_number.codex_alerta_aviso_percentual": "70",
  "input_number.codex_alerta_critico_percentual": "90",
  "input_number.codex_alerta_cache_minimo": "60",
  "input_number.codex_alerta_saldo_creditos": "10",
  "sensor.codex_previsao_ate_o_reset": "aguenta",
  "sensor.codex_limite_usado": "69",
  "sensor.codex_eficiencia_de_cache": "90",
  "sensor.codex_creditos_extras": "100",
  "sensor.codex_uso_projetado_no_reset": "75",
  "sensor.codex_folga_projetada_no_reset": "25",
  "sensor.codex_ritmo_do_limite": "3",
  "sensor.codex_limite_disponivel": "31",
  "sensor.codex_proximo_reset": "2026-08-20T00:00:00Z",
};
const flow = memoryFlow({
  codex_alertas_state_v1: { values, ready: true, sent: {} },
});
const output = run("codex_alert_logic", {
  payload: {
    entity_id: "sensor.codex_limite_usado",
    state: "71",
    previous: "69",
  },
}, flow);
const alert = output[0].alert;
let state = flow.get("codex_alertas_state_v1");
assert.equal(state.sent.usage_warning, undefined, "cooldown must not start before delivery acceptance");
assert.equal(state.pending.deliveryAck.id, alert.deliveryAck.id);

run("codex_alert_ack", { alert }, flow);
state = flow.get("codex_alertas_state_v1");
assert.equal(state.sent.usage_warning, alert.deliveryAck.at);
assert.equal(state.pending, null);

console.log("Notification delivery reliability tests passed.");
