#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const functionDir = path.join(here, "functions");
const source = (name) => fs.readFileSync(path.join(functionDir, name), "utf8");
const flowsPath = path.resolve(here, "..", "flows.json");
const flows = JSON.parse(fs.readFileSync(flowsPath, "utf8"));
const byId = new Map(flows.map((node) => [node.id, node]));
const code = {
  evaluate: source("local-ai-rtx-health-evaluate.js"),
  policy: source("local-ai-rtx-policy-validate.js"),
  cooldown: source("local-ai-rtx-cooldown-read.js"),
  state: source("local-ai-rtx-state-update.js"),
  alert: source("local-ai-rtx-alert-build.js"),
  guard: source("local-ai-rtx-side-effect-guard.js"),
  request: source("local-ai-rtx-recovery-request.js"),
  response: source("local-ai-rtx-recovery-response.js"),
  dry: source("local-ai-rtx-dry-run.js"),
};

function memory() {
  const values = new Map();
  return {
    get: (key) => values.get(key),
    set: (key, value) => values.set(key, value),
    values,
  };
}
function execute(body, msg, flow, environment = {}) {
  const events = { errors: [], warnings: [], statuses: [] };
  const result = vm.runInNewContext(`(function () {\n${body}\n})()`, {
    msg,
    flow,
    env: { get: (key) => environment[key] },
    node: {
      status(value) { events.statuses.push(value); },
      log() {},
      warn(value) { events.warnings.push(value); },
      error(value) { events.errors.push(value); },
    },
    Date,
    Math,
    Number,
    String,
    Object,
    Array,
    JSON,
  });
  return { result, events };
}
const health = (available, now, explicitRecovery = false) => ({
  test_mode: true,
  _rtx_test: true,
  explicit_recovery: explicitRecovery,
  rtx_now: now,
  payload: {
    local_ai: {
      available,
      state: available ? "LOCAL_AI_AVAILABLE" : "LOCAL_AI_UNAVAILABLE",
      preflight: {
        state: available ? "LOCAL_AI_AVAILABLE" : "LOCAL_AI_UNAVAILABLE",
        reason: available ? null : "listener_absent",
      },
    },
  },
});

// O adaptador JavaScript só normaliza o protocolo; switches visuais decidem a rota.
const store = memory();
const available = execute(code.evaluate, health(true, 100000), store).result;
assert.equal(available.rtx_status.available, true);
assert.equal(available.rtx_status.reason, "available");
assert.equal(available.explicit_recovery, false);
const unavailable = execute(code.evaluate, health(false, 200000, true), store).result;
assert.equal(unavailable.rtx_status.available, false);
assert.equal(unavailable.rtx_status.reason, "listener_absent");
assert.equal(unavailable.explicit_recovery, true);
const unknown = execute(code.evaluate, { test_mode: true, rtx_now: 300000, payload: "invalid-json" }, store).result;
assert.equal(unknown.rtx_status.available, false);
assert.equal(unknown.rtx_status.state, "LOCAL_AI_UNKNOWN");
assert.equal(unknown.rtx_status.reason, "unknown");

// Limites exatos são aceitos; inválidos e não inteiros preservam o último valor válido.
for (const [cooldownValue, confirmationValue] of [[10, 60], [600, 600]]) {
  const current = memory();
  execute(code.policy, { topic: "recovery_cooldown_seconds", payload: cooldownValue }, current);
  assert.equal(current.get("local_ai_rtx_policy_v1").complete, false);
  execute(code.policy, { topic: "unavailable_confirmation_seconds", payload: confirmationValue }, current);
  assert.equal(current.get("local_ai_rtx_policy_v1").recovery_cooldown_seconds, cooldownValue);
  assert.equal(current.get("local_ai_rtx_policy_v1").unavailable_confirmation_seconds, confirmationValue);
  assert.equal(current.get("local_ai_rtx_policy_v1").complete, true);
  for (const invalid of [9, 601, 10.5, "not-a-number"]) {
    const rejected = execute(code.policy, { topic: "recovery_cooldown_seconds", payload: invalid }, current);
    assert.equal(rejected.result, null);
    assert.equal(rejected.events.errors.length, 1);
    assert.equal(current.get("local_ai_rtx_policy_v1").recovery_cooldown_seconds, cooldownValue);
  }
  for (const invalid of [59, 601, 60.5, "not-a-number"]) {
    const rejected = execute(code.policy, { topic: "unavailable_confirmation_seconds", payload: invalid }, current);
    assert.equal(rejected.result, null);
    assert.equal(rejected.events.errors.length, 1);
    assert.equal(current.get("local_ai_rtx_policy_v1").unavailable_confirmation_seconds, confirmationValue);
  }
}

// O cálculo lê estado, mas deixa a decisão visível no switch nativo.
store.set("local_ai_rtx_recovery_v1__test", { last_attempt_at: 100000 });
const cooldown = execute(code.cooldown, {
  test_mode: true,
  policy: { recovery_cooldown_seconds: 60 },
  rtx_status: { reason: "listener_absent" },
}, store).result;
assert.equal(cooldown.rtx_cooldown_until, 160000);
assert.equal(cooldown.rtx_status.last_attempt_at, 100000);
const missingPolicy = execute(code.cooldown, { test_mode: true, policy: {}, rtx_status: {} }, store);
assert.equal(missingPolicy.result, null);
assert.equal(missingPolicy.events.errors.length, 1);

// Estado sintético e de produção permanecem isolados, inclusive timestamps de tentativa.
const requested = execute(code.state, {
  test_mode: true,
  rtx_now: 200000,
  rtx_transition: "recovery_requested",
  rtx_status: { available: false, reason: "listener_absent" },
}, store).result;
assert.equal(requested.payload.requested, true);
assert.equal(store.get("local_ai_rtx_recovery_v1__test").last_attempt_at, 200000);
assert.equal(store.get("local_ai_rtx_recovery_v1"), undefined);
const productionState = execute(code.state, {
  test_mode: false,
  rtx_transition: "unavailable",
  rtx_status: { available: false, reason: "listener_absent" },
}, store).result;
assert.equal(productionState.payload.last_result, "unavailable");
assert.equal(store.get("local_ai_rtx_recovery_v1").last_result, "unavailable");

const incident = execute(code.alert, productionState, store).result;
assert.equal(incident._global_observer_test, false);
assert.equal(incident.error, undefined, "estado de domínio não pode fingir node_error");
assert.equal(incident.payload.observer_kind, "domain_alert");
assert.equal(incident.payload.incident_key, "local_ai_rtx_unavailable");
assert.match(incident.alert.message, /recuperacao_rtx/);

// O gate final é a única fronteira que pode alcançar o HTTP autenticado.
const guardedTest = execute(code.guard, requested, store).result;
assert.equal(guardedTest[0], null);
assert.equal(guardedTest[1].payload.dispatched, false);
const dry = execute(code.dry, guardedTest[1], store);
assert.equal(dry.result, null);
assert.deepEqual(JSON.parse(JSON.stringify(store.get("local_ai_rtx_last_dry_run_v1"))), {
  simulated: true,
  dispatched: false,
  side_effect: "mcp_recovery",
  reason: "listener_absent",
});
assert.equal(dry.events.warnings.length, 1);
assert.match(dry.events.warnings[0], /LOCAL_AI_RTX_DRY_RUN/);
const guardedProduction = execute(code.guard, { test_mode: false, payload: { requested: true } }, store).result;
assert.equal(guardedProduction[0].payload.requested, true);
assert.equal(guardedProduction[1], null);

const productionRequest = execute(code.request, { payload: {} }, store, { BRIDGE_TOKEN: "synthetic-token" }).result;
assert.equal(productionRequest.method, "POST");
assert.equal(productionRequest.url, "http://ai-bridge:8099/local-ai/recover");
assert.match(productionRequest.headers.Authorization, /^Bearer /);
assert.ok(!byId.get("local_ai_rtx_prepare_recovery").func.includes("synthetic-token"));

const recovered = execute(code.response, {
  test_mode: true,
  _rtx_test: true,
  payload: { status: "ok", local_ai: { available: true, state: "LOCAL_AI_AVAILABLE", reason: "endpoint_recovered", recovery_attempted: true, recovery_succeeded: true, recovery_attempts: 1 } },
}, store).result;
assert.equal(recovered.payload.available, true);
assert.equal(recovered.payload.last_result, "recovered");
assert.equal(recovered.payload.recovery_attempts, 1);
const failed = execute(code.response, {
  test_mode: true,
  _rtx_test: true,
  payload: { status: "ok", local_ai: { available: false, state: "LOCAL_AI_UNAVAILABLE", reason: "portproxy_add_failed", recovery_attempted: true, recovery_succeeded: false, recovery_attempts: 2 } },
}, store).result;
assert.equal(failed.payload.available, false);
assert.equal(failed.payload.reason, "portproxy_add_failed");
assert.equal(failed.payload.recovery_attempts, 2);

for (const [id, file] of [
  ["local_ai_rtx_health_evaluate", "local-ai-rtx-health-evaluate.js"],
  ["local_ai_rtx_policy_validate", "local-ai-rtx-policy-validate.js"],
  ["local_ai_rtx_cooldown_read", "local-ai-rtx-cooldown-read.js"],
  ["local_ai_rtx_state_update", "local-ai-rtx-state-update.js"],
  ["local_ai_rtx_alert_build", "local-ai-rtx-alert-build.js"],
  ["local_ai_rtx_side_effect_guard", "local-ai-rtx-side-effect-guard.js"],
  ["local_ai_rtx_prepare_recovery", "local-ai-rtx-recovery-request.js"],
  ["local_ai_rtx_recovery_response", "local-ai-rtx-recovery-response.js"],
  ["local_ai_rtx_dry_run_terminal", "local-ai-rtx-dry-run.js"],
]) assert.equal(byId.get(id)?.func, source(file).trimEnd(), `${id} deve vir da fonte geradora`);

assert.equal(byId.get("local_ai_rtx_recovery_http")?.type, "http request");
assert.equal(byId.get("local_ai_rtx_health_evaluate")?.outputs, 1);
assert.equal(byId.get("local_ai_rtx_available_switch")?.type, "switch");
assert.equal(byId.get("local_ai_rtx_explicit_switch")?.type, "switch");
assert.equal(byId.get("local_ai_rtx_test_mode_switch")?.type, "switch");
assert.equal(byId.get("local_ai_rtx_cooldown_switch")?.type, "switch");
assert.equal(byId.get("local_ai_rtx_transition_switch")?.type, "switch");
assert.equal(byId.has("local_ai_rtx_previous_available_switch"), false);
assert.deepEqual(byId.get("local_ai_rtx_transition_switch")?.wires, [
  ["local_ai_rtx_available_mode_switch"],
  ["local_ai_rtx_unavailable_mode_switch"],
  ["local_ai_rtx_recovery_out"],
  ["local_ai_rtx_status_transition_out"],
]);
assert.equal(byId.get("local_ai_rtx_available_mode_switch")?.type, "switch");
assert.equal(byId.get("local_ai_rtx_unavailable_mode_switch")?.type, "switch");
assert.equal(byId.get("local_ai_rtx_prod_host_state_switch")?.type, "switch");
assert.equal(byId.get("local_ai_rtx_test_host_state_switch")?.type, "switch");
assert.equal(byId.get("local_ai_rtx_host_state_source")?.type, "api-current-state");
assert.equal(byId.get("local_ai_rtx_host_state_source")?.entity_id, "sensor.codex_rtx_host_reachability_raw");
assert.equal(byId.get("local_ai_rtx_alert_rbe")?.type, "rbe");
assert.equal(byId.get("local_ai_rtx_alert_rbe")?.property, "rtx_alert_condition");
assert.equal(byId.get("local_ai_rtx_alert_rbe")?.septopics, true);
assert.equal(byId.get("local_ai_rtx_alert_confirm")?.type, "trigger");
assert.equal(byId.get("local_ai_rtx_alert_confirm")?.duration, "90");
assert.equal(byId.get("local_ai_rtx_alert_confirm")?.overrideDelay, true);
assert.equal(byId.get("local_ai_rtx_alert_confirm")?.bytopic, "topic");
assert.deepEqual(byId.get("local_ai_rtx_alert_dedupe_reset_out")?.links?.sort(), [
  "local_ai_rtx_alert_confirmation_reset_in",
  "local_ai_rtx_alert_dedupe_reset_in",
]);
assert.deepEqual(byId.get("local_ai_rtx_alert_confirmation_reset_in")?.wires, [["local_ai_rtx_alert_confirm"]]);
assert.equal(byId.get("local_ai_rtx_alert_delay_valid")?.type, "switch");
assert.equal(
  byId.get("local_ai_rtx_alert_test_delay")?.rules?.some(
    (rule) => rule.t === "set" && rule.p === "delay" && rule.to === "3000" && rule.tot === "num",
  ),
  true,
);
assert.deepEqual(byId.get("local_ai_rtx_prepare_prod_alert_reset")?.wires, [[
  "local_ai_rtx_alert_dedupe_reset_out",
  "local_ai_rtx_status_gate_out",
  "local_ai_rtx_alert_close_available_out",
]]);
assert.deepEqual(byId.get("local_ai_rtx_prepare_test_alert_reset")?.wires, [[
  "local_ai_rtx_alert_dedupe_reset_out",
  "local_ai_rtx_status_gate_out",
]]);
assert.equal(
  byId.get("local_ai_rtx_prepare_prod_alert")?.wires?.[0]?.includes("local_ai_rtx_alert_close_unavailable_out"),
  true,
);
assert.deepEqual(byId.get("local_ai_rtx_alert_close_state_in")?.links?.sort(), [
  "local_ai_rtx_alert_close_available_out",
  "local_ai_rtx_alert_close_unavailable_out",
]);
assert.equal(byId.get("local_ai_rtx_alert_close_rbe")?.type, "rbe");
assert.equal(byId.get("local_ai_rtx_alert_close_rbe")?.property, "rtx_status.available");
assert.equal(byId.get("local_ai_rtx_alert_recovered_switch")?.type, "switch");
assert.deepEqual(byId.get("local_ai_rtx_alert_recovered_switch")?.wires, [
  ["local_ai_rtx_alert_dismiss"],
  [],
]);
assert.equal(byId.get("local_ai_rtx_alert_dismiss")?.type, "change");
const dismissContract = byId.get("local_ai_rtx_alert_dismiss").rules.map((rule) => String(rule.to ?? "")).join("\n");
assert.match(dismissContract, /"operation":"dismiss"/);
assert.match(dismissContract, /"delivery":"queued"/);
assert.match(dismissContract, /nodered_observabilidade_global_domain_alert_local_ai_rtx_unavailable/);
assert.deepEqual(byId.get("local_ai_rtx_alert_dismiss__hub_call")?.links, ["notification_hub_persistent_in"]);
assert.deepEqual(byId.get("local_ai_rtx_prod_host_state_switch")?.wires, [
  ["local_ai_rtx_prepare_prod_alert"],
  ["local_ai_rtx_prod_alert_reset_request_out"],
  ["local_ai_rtx_status_gate_out"],
]);
assert.deepEqual(byId.get("local_ai_rtx_test_host_state_switch")?.wires, [
  ["local_ai_rtx_prepare_test_alert"],
  ["local_ai_rtx_test_alert_reset_request_out"],
  ["local_ai_rtx_status_gate_out"],
]);
for (const [id, state] of [
  ["local_ai_rtx_test_host_off", "offline"],
  ["local_ai_rtx_test_host_on", "online"],
]) {
  assert.equal(
    byId.get(id)?.props.some((prop) => prop.p === "rtx_host_state" && prop.v === state),
    true,
  );
  assert.equal(
    byId.get(id)?.props.some((prop) => prop.p === "explicit_recovery" && prop.v === "false"),
    true,
  );
}
assert.deepEqual(byId.get("local_ai_rtx_alert_out")?.links, ["global_observer_alert_to_dispatch_in"]);
assert.equal(byId.get("local_ai_rtx_tick")?.repeat, "60");
assert.equal(byId.get("local_ai_rtx_policy_cooldown")?.payload, "60");
assert.equal(byId.get("local_ai_rtx_policy_cooldown")?.topic, "recovery_cooldown_seconds");
assert.equal(byId.get("local_ai_rtx_policy_confirmation")?.payload, "90");
assert.equal(byId.get("local_ai_rtx_policy_confirmation")?.topic, "unavailable_confirmation_seconds");
assert.equal(
  byId.get("local_ai_rtx_manual_recovery")?.props.some(
    (prop) => prop.p === "explicit_recovery" && prop.v === "true",
  ),
  true,
);
assert.deepEqual(byId.get("local_ai_rtx_side_effect_guard")?.wires, [
  ["local_ai_rtx_prepare_recovery"],
  ["local_ai_rtx_dry_out"],
]);
assert.equal(byId.get("local_ai_rtx_recovery_tab")?.label, "recuperacao_rtx");
assert.equal(byId.get("local_ai_rtx_dry_run_terminal")?.type, "function");

console.log("Local AI RTX recovery: visual decisions, policy limits, state isolation, MCP guard and dry-run passed.");
