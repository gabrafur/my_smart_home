import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import vm from "node:vm";

const flows = JSON.parse(fs.readFileSync(new URL("../flows.json", import.meta.url), "utf8"));
const byId = new Map(flows.map((item) => [item.id, item]));
const packageText = fs.readFileSync(new URL("../../homeassistant/packages/codex_usage.yaml", import.meta.url), "utf8");
const dashboardText = fs.readFileSync(new URL("../../homeassistant/dashboards/chat.yaml", import.meta.url), "utf8");

function node(id) {
  const value = byId.get(id);
  assert.ok(value, `missing node ${id}`);
  return value;
}

function memory(initial = {}) {
  return new Map(Object.entries(initial));
}

function run(id, msg, values = memory()) {
  const errors = [];
  const warnings = [];
  const runtime = {
    msg,
    flow: { get: (key) => values.get(key), set: (key, value) => values.set(key, value) },
    node: { status() {}, log() {}, warn: (value) => warnings.push(value), error: (value) => errors.push(value) },
    Date, Math, Number, String, Object, JSON,
  };
  const result = vm.runInNewContext(`(function () { ${node(id).func}\n})()`, runtime);
  return { result, values, errors, warnings };
}

for (const candidate of flows.filter((item) =>
  item.action === "public_bindings.call" && typeof item.data === "string" &&
  /["']data["']\s*:\s*\{[^}]*["']data["']\s*:/.test(item.data)
)) {
  assert.match(candidate.data, /"action":"notify_actionable"/, `${candidate.name} precisa do binding móvel acionável`);
}

assert.equal(node("codex_alertas_tab").label, "alertas_codex");
assert.match(node("codex_group_policy").name, /PARÂMETROS AJUSTÁVEIS DO CODEX/);
assert.match(node("codex_policy_warning").name, /padrão 70 %/);
assert.match(node("codex_policy_critical").name, /padrão 90 %/);
for (const id of [
  "codex_group_policy", "codex_group_inputs", "codex_group_level",
  "codex_group_decisions", "codex_group_tests", "codex_group_effects",
  "codex_level_data_current", "codex_level_critical", "codex_level_warning",
  "codex_request_type", "codex_alerts_enabled", "codex_entity_route",
  "codex_candidate_available", "codex_delivery_allowed", "codex_level_final_gate",
  "codex_alert_final_gate", "codex_test_dry_run_terminal",
]) {
  assert.equal(node(id).z, "codex_alertas_tab");
  assert.ok(node(id).name);
}

const defaults = [
  ["codex_policy_warning", "warning_usage_percent", "70"],
  ["codex_policy_critical", "critical_usage_percent", "90"],
  ["codex_policy_cache", "minimum_cache_percent", "60"],
  ["codex_policy_credits", "minimum_extra_credits", "10"],
  ["codex_policy_critical_cd", "critical_cooldown_hours", "1"],
  ["codex_policy_standard_cd", "standard_cooldown_hours", "6"],
  ["codex_policy_retry", "retry_seconds", "60"],
];
for (const [id, topic, payload] of defaults) {
  assert.equal(node(id).topic, topic);
  assert.equal(node(id).payload, payload);
  assert.equal(node(id).once, true);
  assert.deepEqual(node(id).wires, [["codex_policy_validate"]]);
}

const policyValues = memory();
for (const [, topic, payload] of defaults) {
  const result = run("codex_policy_validate", { topic, payload: Number(payload) }, policyValues);
  assert.equal(result.errors.length, 0);
}
const validPolicy = JSON.parse(JSON.stringify(policyValues.get("codex_alert_policy_v1")));
assert.equal(validPolicy.complete, true);
assert.equal(validPolicy.warning_usage_percent, 70);
assert.equal(validPolicy.critical_usage_percent, 90);
for (const [topic, payload] of [
  ["warning_usage_percent", 96], ["critical_usage_percent", 19],
  ["minimum_cache_percent", -1], ["minimum_extra_credits", 0],
  ["critical_cooldown_hours", 25], ["standard_cooldown_hours", 49],
  ["retry_seconds", 9], ["retry_seconds", 601], ["retry_seconds", 10.5],
]) {
  const before = JSON.stringify(policyValues.get("codex_alert_policy_v1"));
  const rejected = run("codex_policy_validate", { topic, payload }, policyValues);
  assert.equal(rejected.errors.length, 1);
  assert.equal(JSON.stringify(policyValues.get("codex_alert_policy_v1")), before);
}
const cross = run("codex_policy_validate", { topic: "warning_usage_percent", payload: 95 }, policyValues);
assert.equal(cross.errors.length, 1, "aviso >= crítico deve ser rejeitado");

const seed = {
  "input_boolean.codex_alertas_iphone": "on",
  "input_boolean.codex_resumo_diario_iphone": "on",
  "sensor.codex_dados_de_limite": "atual",
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
const snapshots = memory({ codex_alert_test_state_v1: { values: seed, ready: true, sequence: 0 } });
const accumulated = run("codex_alert_logic", {
  test_mode: true,
  payload: { test_mode: true, entity_id: "sensor.codex_limite_usado", state: "71", previous: "69" },
}, snapshots);
assert.equal(accumulated.result.snapshot.ready, true);
assert.equal(accumulated.result.snapshot.current, "71");
assert.equal(accumulated.result.snapshot.previous, "69");
assert.equal(snapshots.get("codex_alertas_state_v2"), undefined, "TESTE não pode tocar snapshot de produção");

for (const [current, previous, expected] of [
  ["70", "69", "usage_warning"], ["90", "89", "critical"],
  ["69", "70", ""], ["90", "90", ""],
]) {
  const decided = run("codex_usage_decision", {
    snapshot: { current, previous }, policy: validPolicy,
  });
  assert.equal(decided.result.decision.kind, expected, `${previous} -> ${current}`);
}
assert.equal(run("codex_cache_decision", { snapshot: { current: "59", previous: "60" }, policy: validPolicy }).result.decision.kind, "cache_low");
assert.equal(run("codex_cache_decision", { snapshot: { current: "60", previous: "61" }, policy: validPolicy }).result.decision.kind, "");
assert.equal(run("codex_credits_decision", { snapshot: { current: "9", previous: "10" }, policy: validPolicy }).result.decision.kind, "credits_low");
assert.equal(run("codex_credits_decision", { snapshot: { current: "10", previous: "11" }, policy: validPolicy }).result.decision.kind, "");
for (const [current, previous, expected] of [
  ["atenção", "aguenta", "forecast_warning"],
  ["não aguenta", "atenção", "critical"],
  ["aguenta", "não aguenta", "recovery"],
  ["aguenta", "aguenta", ""],
]) assert.equal(run("codex_forecast_decision", { snapshot: { current, previous } }).result.decision.kind, expected);

const deliveryMemory = memory();
const candidate = run("codex_build_alert", {
  test_mode: false, decision: { kind: "usage_warning" },
  snapshot: { values: { ...seed, "sensor.codex_limite_usado": "71" }, sequence: 1 },
  policy: validPolicy,
});
assert.equal(candidate.result.alert.kind, "usage_warning");
const allowed = run("codex_delivery_evaluate", candidate.result, deliveryMemory);
assert.equal(allowed.result.delivery.allowed, true);
assert.equal(deliveryMemory.get("codex_alert_delivery_v1").pending.deliveryAck.id, allowed.result.alert.deliveryAck.id);
const duplicate = run("codex_delivery_evaluate", {
  ...candidate.result,
  alert: { ...candidate.result.alert, deliveryAck: { ...candidate.result.alert.deliveryAck, at: candidate.result.alert.deliveryAck.at + 1000 } },
}, deliveryMemory);
assert.equal(duplicate.result.delivery.allowed, false);
assert.equal(duplicate.result.delivery.reason, "delivery_pending");
run("codex_alert_ack", { alert: allowed.result.alert }, deliveryMemory);
assert.equal(deliveryMemory.get("codex_alert_delivery_v1").sent.usage_warning, allowed.result.alert.deliveryAck.at);
assert.equal(deliveryMemory.get("codex_alert_delivery_v1").pending, null);
const cooldown = run("codex_delivery_evaluate", {
  ...candidate.result,
  alert: { ...candidate.result.alert, deliveryAck: { ...candidate.result.alert.deliveryAck, at: candidate.result.alert.deliveryAck.at + 60_000 } },
}, deliveryMemory);
assert.equal(cooldown.result.delivery.allowed, false);
assert.equal(cooldown.result.delivery.reason, "cooldown_active");

const testDelivery = memory();
const safeCandidate = run("codex_build_alert", {
  test_mode: true, _test_now_ms: 2_000_000_000,
  decision: { kind: "test" }, snapshot: { values: seed, sequence: 1 }, policy: validPolicy,
});
run("codex_delivery_evaluate", safeCandidate.result, testDelivery);
assert.equal(testDelivery.get("codex_alert_delivery_v1"), undefined);
assert.ok(testDelivery.get("codex_alert_delivery_test_v1").pending);
const dry = run("codex_test_dry_run_terminal", { test_mode: true, alert: safeCandidate.result.alert, delivery: { reason: "cooldown_elapsed" } });
assert.equal(dry.result, null);
assert.match(dry.warnings[0], /"simulated":true/);
assert.match(dry.warnings[0], /"dispatched":false/);

assert.deepEqual(node("codex_alert_push").wires, [["codex_alert_ack"]]);
assert.deepEqual(node("codex_alert_persistent").wires, [["codex_alert_ack"]]);
assert.deepEqual(node("codex_alert_catch").scope.sort(), ["codex_alert_persistent", "codex_alert_push"].sort());
assert.equal(node("codex_alert_push").queue, "all");
assert.match(node("codex_alert_push").data, /"role":"mobile_primary"/);
assert.deepEqual(node("codex_level_publish").entityId, ["input_text.codex_nivel_alerta_canonico"]);
assert.deepEqual(node("codex_level_final_gate").wires[1], ["codex_level_dry_run_out"]);
assert.deepEqual(node("codex_alert_final_gate").wires[1], ["codex_alert_dry_run_out"]);
assert.deepEqual(node("codex_test_dry_run_in").links.sort(), ["codex_alert_dry_run_out", "codex_level_dry_run_out"].sort());

assert.match(packageText, /Codex Nivel de Alerta[\s\S]*states\('input_text\.codex_nivel_alerta_canonico'\)/);
const levelBlock = packageText.match(/- name: Codex Nivel de Alerta[\s\S]*?(?=\n\s+- name: Codex Local AI Status)/)?.[0] || "";
assert.doesNotMatch(levelBlock, /codex_alerta_(aviso|critico)_percentual/);
assert.match(levelBlock, /fonte_decisao: node_red/);
assert.match(packageText, /codex_nivel_alerta_canonico:/);
assert.doesNotMatch(dashboardText, /entity: input_number\.codex_alerta_(aviso|critico|saldo)/);

for (const item of flows.filter((candidateNode) => candidateNode.z === "codex_alertas_tab" && candidateNode.type === "function")) {
  assert.ok(item.func.length < 3_500, `${item.id} contém JavaScript excessivo (${item.func.length})`);
  new Function("msg", "node", "flow", "global", item.func);
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-alert-idempotence-"));
const out1 = path.join(temp, "one.json");
const out2 = path.join(temp, "two.json");
for (const output of [out1, out2]) {
  const generated = spawnSync(process.execPath, [new URL("./install-codex-alert-flows.mjs", import.meta.url).pathname, output], { encoding: "utf8" });
  assert.equal(generated.status, 0, generated.stderr || generated.stdout);
}
const sha = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
assert.equal(sha(out1), sha(out2));
fs.rmSync(temp, { recursive: true, force: true });

console.log("Canonical Codex alert and delivery reliability tests passed.");
