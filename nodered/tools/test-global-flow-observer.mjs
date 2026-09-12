#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const functionDir = path.join(here, "functions");
const flows = JSON.parse(
  fs.readFileSync(path.resolve(here, "..", "flows.json"), "utf8"),
);
const byId = new Map(flows.map((node) => [node.id, node]));
const source = (name) => fs.readFileSync(path.join(functionDir, name), "utf8");
const code = {
  policyValidate: source("global-flow-observer-policy-validate.js"),
  policyStore: source("global-flow-observer-policy-store.js"),
  policyReject: source("global-flow-observer-policy-reject.js"),
  normalize: source("global-flow-observer-normalize.js"),
  stateSave: source("global-flow-observer-state-save.js"),
  errorMutate: source("global-flow-observer-error-mutate.js"),
  errorAlert: source("global-flow-observer-error-alert.js"),
  statusUnmonitored: source("global-flow-observer-status-unmonitored.js"),
  statusFailure: source("global-flow-observer-status-failure.js"),
  statusRecovery: source("global-flow-observer-status-recovery.js"),
  evaluateExpand: source("global-flow-observer-evaluate-expand.js"),
  evaluateClear: source("global-flow-observer-evaluate-clear.js"),
  evaluateConfirm: source("global-flow-observer-evaluate-confirm.js"),
  evaluateAlert: source("global-flow-observer-evaluate-alert.js"),
  guard: source("global-flow-observer-dispatch-guard.js"),
  internalFailure: source("global-flow-observer-internal-failure.js"),
  dryRun: source("global-flow-observer-dry-run.js"),
};
const flowNodeIds = {
  policyValidate: "global_observer_policy_validate",
  policyStore: "global_observer_policy_store",
  policyReject: "global_observer_policy_reject",
  normalize: "global_observer_ingest",
  stateSave: "global_observer_error_accepted_save",
  errorMutate: "global_observer_error_mutate",
  errorAlert: "global_observer_error_alert",
  statusUnmonitored: "global_observer_status_unmonitored",
  statusFailure: "global_observer_status_failure",
  statusRecovery: "global_observer_status_recovery",
  evaluateExpand: "global_observer_evaluate",
  evaluateClear: "global_observer_evaluate_clear_uncorroborated",
  evaluateConfirm: "global_observer_evaluate_confirm",
  evaluateAlert: "global_observer_evaluate_alert",
  guard: "global_observer_dispatch_guard",
  internalFailure: "global_observer_internal_failure",
  dryRun: "global_observer_dry_run_terminal",
};
for (const [name, body] of Object.entries(code)) {
  new Function("msg", "node", "flow", body);
  assert.equal(byId.get(flowNodeIds[name])?.func, body.trimEnd());
}

function memory() {
  const values = new Map();
  return {
    get(key) { return values.get(key); },
    set(key, value) { values.set(key, value); },
    values,
  };
}

function execute(body, msg, flow) {
  return vm.runInNewContext(`(function () {\n${body}\n})()`, {
    msg,
    flow,
    structuredClone,
    node: { status() {}, log() {}, warn() {}, error() {} },
    Date,
    Math,
    Number,
    String,
    Object,
    Array,
    Map,
    Set,
  });
}

const DEFAULT_POLICY = {
  version: 1,
  owner: "node_red",
  complete: true,
  connection_recovery_grace_seconds: 90,
  status_confirm_seconds: 60,
  reminder_hours: 6,
  error_retention_days: 7,
  ha_corroboration_sources: 2,
};
function ensurePolicy(flow) {
  if (!flow.get("global_observer_policy_v1")) {
    flow.set("global_observer_policy_v1", structuredClone(DEFAULT_POLICY));
  }
}
function runIngest(msg, flow) {
  ensurePolicy(flow);
  const normalized = execute(code.normalize, msg, flow);
  if (!normalized) return null;
  const data = normalized._observer_event;
  if (data.kind === "error") {
    if (data.accepted_wake_pending || data.connection_suppressed) {
      execute(code.stateSave, normalized, flow);
      return null;
    }
    const mutated = execute(code.errorMutate, normalized, flow);
    return mutated?._observer_event?.notification_due
      ? execute(code.errorAlert, mutated, flow)
      : null;
  }
  if (data.kind === "status") {
    if (!data.monitored) execute(code.statusUnmonitored, normalized, flow);
    else if (data.failing) execute(code.statusFailure, normalized, flow);
    else execute(code.statusRecovery, normalized, flow);
    return null;
  }
  execute(code.stateSave, normalized, flow);
  return null;
}
function runEvaluate(msg, flow) {
  ensurePolicy(flow);
  const expanded = execute(code.evaluateExpand, msg, flow);
  const alerts = [];
  for (const candidate of expanded?.[0] ?? []) {
    const data = candidate._observer_evaluation;
    if (!data.corroborated || !data.duration_met) {
      execute(code.evaluateClear, candidate, flow);
      continue;
    }
    const confirmed = execute(code.evaluateConfirm, candidate, flow);
    if (confirmed?._observer_evaluation?.notification_due) {
      alerts.push(execute(code.evaluateAlert, confirmed, flow));
    }
  }
  return [alerts.length ? alerts : null];
}

{
  const policyStore = memory();
  const atMinimum = execute(code.policyValidate, {
    topic: "status_confirm_seconds", payload: 10,
  }, policyStore);
  assert.ok(atMinimum[0], "limite inferior exato deve ser aceito");
  execute(code.policyStore, atMinimum[0], policyStore);
  const atMaximum = execute(code.policyValidate, {
    topic: "status_confirm_seconds", payload: 600,
  }, policyStore);
  assert.ok(atMaximum[0], "limite superior exato deve ser aceito");
  execute(code.policyStore, atMaximum[0], policyStore);
  const invalid = execute(code.policyValidate, {
    topic: "status_confirm_seconds", payload: 9,
  }, policyStore);
  assert.equal(invalid[0], null);
  assert.equal(invalid[1].observer_policy_rejection.preserved, true);
  execute(code.policyReject, invalid[1], policyStore);
  assert.equal(
    policyStore.get("global_observer_policy_v1").status_confirm_seconds,
    600,
    "valor inválido não pode substituir a última política válida",
  );
  const nonInteger = execute(code.policyValidate, {
    topic: "reminder_hours", payload: 1.5,
  }, policyStore);
  assert.equal(nonInteger[0], null, "valor não inteiro deve ser rejeitado");
}

const store = memory();
const baseError = () => ({
  _global_observer_test: true,
  observer_now: 100_000,
  _global_observer: { flow_id: "flow_test", flow_label: "Fluxo teste" },
  error: {
    message: "synthetic timeout",
    source: { id: "node_test", type: "function", name: "Nó teste" },
  },
});
const firstError = runIngest(baseError(), store);
assert.match(firstError.alert.title, /TESTE/);
assert.match(firstError.alert.message, /Fluxo teste/);
assert.equal(runIngest(baseError(), store), null, "erro repetido deve ser deduplicado");
const tailored = runIngest({
  ...baseError(),
  observer_now: 150_000,
  error: {
    message: "RTX indisponível: listener_absent",
    source: { id: "rtx_health", type: "function", name: "Monitor RTX" },
  },
  observer_alert: { title: "RTX indisponível", message: "Recuperação manual obrigatória." },
}, store);
assert.equal(tailored.alert.title, "TESTE — RTX indisponível");
assert.equal(tailored.alert.message, "Recuperação manual obrigatória.");
const reminder = baseError();
reminder.observer_now += 6 * 60 * 60 * 1000;
assert.ok(runIngest(reminder, store), "erro persistente deve lembrar após 6 h");

const acceptedWakeStore = memory();
assert.equal(runIngest({
  _global_observer_test: true,
  observer_now: 175_000,
  _global_observer: {
    flow_id: "c22d8b12055e87f7",
    flow_label: "contexto_vehicle_primary",
  },
  error: {
    message:
      "HomeAssistantError: Bluelink wake accepted but fresh data is pending; " +
      "bounded cached rechecks remain scheduled",
    source: {
      id: "8907830bb7f6c40c",
      type: "api-call-service",
      name: "Forçar refresh do vehicle_primary",
    },
  },
}, acceptedWakeStore), null);
assert.equal(
  Object.keys(
    acceptedWakeStore.values.get("global_flow_observer_v1__test").errors,
  ).length,
  0,
  "wake aceito e ainda pendente não deve abrir incidente global",
);

const statusFailure = {
  _global_observer_test: true,
  observer_now: 200_000,
  _global_observer: { flow_id: "flow_test", flow_label: "Fluxo teste" },
  status: {
    fill: "red",
    text: "disconnected",
    source: { id: "ha_test", type: "api-call-service", name: "HA teste" },
  },
};
const domainStatus = structuredClone(statusFailure);
domainStatus.status = {
  ...domainStatus.status,
  source: { id: "domain_test", type: "function", name: "Monitor de domínio" },
};
assert.equal(runIngest(domainStatus, store), null);
assert.equal(
  store.values.get("global_flow_observer_v1__test").status_sources["flow_test:domain_test"],
  undefined,
  "status visual de função não deve duplicar o alerta do monitor de domínio",
);

const falsePositiveStore = memory();
for (const status of [
  {
    fill: "red",
    text: "true",
    source: {
      id: "cpu_threshold",
      type: "server-state-changed",
      name: "CPU acima do limite",
    },
  },
  {
    fill: "red",
    text: "Vehicle refresh failed: APIError",
    source: {
      id: "refresh_service",
      type: "api-call-service",
      name: "Atualizar veículo",
    },
  },
]) {
  assert.equal(runIngest({
    _global_observer_test: true,
    observer_now: 200_000,
    _global_observer: { flow_id: "flow_test", flow_label: "Fluxo teste" },
    status,
  }, falsePositiveStore), null);
}
assert.deepEqual(
  Object.keys(
    falsePositiveStore.values.get("global_flow_observer_v1__test").status_sources,
  ),
  [],
  "status vermelho de domínio ou erro de serviço não é queda do Home Assistant",
);

const reconnectStore = memory();
const reconnectFailure = structuredClone(statusFailure);
reconnectFailure.observer_now = 400_000;
runIngest(reconnectFailure, reconnectStore);
const reconnectRecovered = structuredClone(reconnectFailure);
reconnectRecovered.observer_now = 410_000;
reconnectRecovered.status = {
  ...reconnectRecovered.status,
  fill: "green",
  text: "connected",
};
runIngest(reconnectRecovered, reconnectStore);
const startupReadError = {
  ...baseError(),
  observer_now: 420_000,
  error: {
    message: "entity unavailable during startup",
    source: {
      id: "startup_read",
      type: "api-current-state",
      name: "Leitura de startup",
    },
  },
};
assert.equal(
  runIngest(startupReadError, reconnectStore),
  null,
  "erros de nós HA durante reconexão não devem gerar rajada",
);
const unrelatedError = baseError();
unrelatedError.observer_now = 420_000;
assert.ok(
  runIngest(unrelatedError, reconnectStore),
  "erro de função não relacionado deve continuar alertando",
);
const postGraceError = structuredClone(startupReadError);
postGraceError.observer_now = 501_001;
assert.ok(
  runIngest(postGraceError, reconnectStore),
  "erro HA após a carência de reconexão deve voltar a alertar",
);

const legacyStore = memory();
legacyStore.set("global_flow_observer_v1__test", {
  version: 1,
  errors: { preserved: { last_seen_at: 1 } },
  status_sources: { stale: { incident_key: "connection:home_assistant" } },
  status_incidents: { stale: { kind: "home_assistant" } },
});
runEvaluate({
  _global_observer_test: true,
  observer_now: 200_000,
}, legacyStore);
const migrated = legacyStore.values.get("global_flow_observer_v1__test");
assert.equal(migrated.version, 2);
assert.deepEqual(Object.keys(migrated.status_sources), []);
assert.deepEqual(Object.keys(migrated.status_incidents), []);
assert.ok(migrated.errors.preserved, "migração deve preservar dedupe de erros");

assert.equal(runIngest(statusFailure, store), null);
const tooSoon = runEvaluate({
  _global_observer_test: true,
  observer_now: 259_000,
}, store);
assert.equal(tooSoon[0], null);
const confirmed = runEvaluate({
  _global_observer_test: true,
  observer_now: 261_000,
}, store);
assert.equal(
  confirmed[0],
  null,
  "um único nó HA não deve declarar queda da conexão compartilhada",
);
const corroboratedStatus = structuredClone(statusFailure);
corroboratedStatus.observer_now = 200_000;
corroboratedStatus._global_observer = {
  flow_id: "flow_test_2",
  flow_label: "Fluxo teste 2",
};
corroboratedStatus.status.source = {
  id: "ha_test_2",
  type: "server-state-changed",
  name: "HA teste 2",
};
runIngest(corroboratedStatus, store);
const corroborated = runEvaluate({
  _global_observer_test: true,
  observer_now: 261_000,
}, store);
assert.equal(corroborated[0].length, 1);
assert.match(corroborated[0][0].alert.title, /Home Assistant/);
const duplicate = runEvaluate({
  _global_observer_test: true,
  observer_now: 262_000,
}, store);
assert.equal(duplicate[0], null);

const recovered = structuredClone(statusFailure);
recovered.observer_now = 263_000;
recovered.status = { ...recovered.status, fill: "green", text: "connected" };
runIngest(recovered, store);
runEvaluate({ _global_observer_test: true, observer_now: 264_000 }, store);
const newFailure = structuredClone(statusFailure);
newFailure.observer_now = 300_000;
runIngest(newFailure, store);
const newIncident = runEvaluate({
  _global_observer_test: true,
  observer_now: 361_000,
}, store);
assert.equal(newIncident[0].length, 1, "recuperação deve liberar o próximo incidente");

const simulated = execute(code.guard, {
  _global_observer_test: true,
  payload: { test_mode: true },
  alert: { title: "TESTE", message: "simulado" },
}, store);
assert.equal(simulated[0], null);
assert.equal(simulated[1], null);
assert.ok(simulated[2]);
const delivery = execute(code.guard, {
  _global_observer_test: true,
  _observer_delivery_test: true,
  payload: {},
}, store);
assert.ok(delivery[0]);
assert.equal(delivery[1], null);
assert.equal(delivery[2], null);
assert.match(delivery[0].alert.title, /TESTE/);
assert.equal(delivery[0].payload.notification_delivery_under_test, true);

const production = execute(code.guard, {
  payload: {
    observer_kind: "node_error",
    flow_id: "flow_test",
    source_id: "node:test",
  },
  alert: { title: "Falha", message: "Falha de produção" },
}, store);
assert.ok(production[0], "produção deve seguir para o push");
assert.ok(production[1], "produção deve seguir para a notificação persistente");
assert.equal(production[2], null);
assert.equal(
  production[1]._observer_persistent_notification_id,
  "nodered_observabilidade_global_node_error_flow_test_node_test",
);

const internalFailureStore = memory();
ensurePolicy(internalFailureStore);
const internalFailureMessage = {
  error: {
    message: "synthetic internal failure",
    source: {
      id: "global_observer_ingest",
      type: "function",
      name: "Classificar erro ou status",
    },
  },
};
const internalFailure = execute(
  code.internalFailure,
  structuredClone(internalFailureMessage),
  internalFailureStore,
);
assert.ok(internalFailure[0], "falha interna deve seguir para o push");
assert.ok(internalFailure[1], "falha interna deve seguir para o alerta persistente");
assert.match(internalFailure[0].alert.title, /monitor global/);
assert.equal(
  execute(
    code.internalFailure,
    structuredClone(internalFailureMessage),
    internalFailureStore,
  )[0],
  null,
  "falha interna repetida deve ser deduplicada",
);

const dryRunStore = memory();
execute(code.dryRun, simulated[2], dryRunStore);
assert.equal(dryRunStore.values.get("global_flow_observer_last_dry_run_v1").dispatched, false);

console.log("Global flow observer: topology and incident lifecycle scenarios passed.");
