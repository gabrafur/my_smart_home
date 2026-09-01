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
  ingest: source("global-flow-observer-ingest.js"),
  evaluate: source("global-flow-observer-evaluate.js"),
  guard: source("global-flow-observer-dispatch-guard.js"),
  internalFailure: source("global-flow-observer-internal-failure.js"),
  dryRun: source("global-flow-observer-dry-run.js"),
};
const flowNodeIds = {
  ingest: "global_observer_ingest",
  evaluate: "global_observer_evaluate",
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
const firstError = execute(code.ingest, baseError(), store);
assert.match(firstError.alert.title, /TESTE/);
assert.match(firstError.alert.message, /Fluxo teste/);
assert.equal(execute(code.ingest, baseError(), store), null, "erro repetido deve ser deduplicado");
const reminder = baseError();
reminder.observer_now += 6 * 60 * 60 * 1000;
assert.ok(execute(code.ingest, reminder, store), "erro persistente deve lembrar após 6 h");

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
assert.equal(execute(code.ingest, domainStatus, store), null);
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
  assert.equal(execute(code.ingest, {
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
execute(code.ingest, reconnectFailure, reconnectStore);
const reconnectRecovered = structuredClone(reconnectFailure);
reconnectRecovered.observer_now = 410_000;
reconnectRecovered.status = {
  ...reconnectRecovered.status,
  fill: "green",
  text: "connected",
};
execute(code.ingest, reconnectRecovered, reconnectStore);
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
  execute(code.ingest, startupReadError, reconnectStore),
  null,
  "erros de nós HA durante reconexão não devem gerar rajada",
);
const unrelatedError = baseError();
unrelatedError.observer_now = 420_000;
assert.ok(
  execute(code.ingest, unrelatedError, reconnectStore),
  "erro de função não relacionado deve continuar alertando",
);
const postGraceError = structuredClone(startupReadError);
postGraceError.observer_now = 501_001;
assert.ok(
  execute(code.ingest, postGraceError, reconnectStore),
  "erro HA após a carência de reconexão deve voltar a alertar",
);

const legacyStore = memory();
legacyStore.set("global_flow_observer_v1__test", {
  version: 1,
  errors: { preserved: { last_seen_at: 1 } },
  status_sources: { stale: { incident_key: "connection:home_assistant" } },
  status_incidents: { stale: { kind: "home_assistant" } },
});
execute(code.evaluate, {
  _global_observer_test: true,
  observer_now: 200_000,
}, legacyStore);
const migrated = legacyStore.values.get("global_flow_observer_v1__test");
assert.equal(migrated.version, 2);
assert.deepEqual(Object.keys(migrated.status_sources), []);
assert.deepEqual(Object.keys(migrated.status_incidents), []);
assert.ok(migrated.errors.preserved, "migração deve preservar dedupe de erros");

assert.equal(execute(code.ingest, statusFailure, store), null);
const tooSoon = execute(code.evaluate, {
  _global_observer_test: true,
  observer_now: 259_000,
}, store);
assert.equal(tooSoon[0], null);
const confirmed = execute(code.evaluate, {
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
execute(code.ingest, corroboratedStatus, store);
const corroborated = execute(code.evaluate, {
  _global_observer_test: true,
  observer_now: 261_000,
}, store);
assert.equal(corroborated[0].length, 1);
assert.match(corroborated[0][0].alert.title, /Home Assistant/);
const duplicate = execute(code.evaluate, {
  _global_observer_test: true,
  observer_now: 262_000,
}, store);
assert.equal(duplicate[0], null);

const recovered = structuredClone(statusFailure);
recovered.observer_now = 263_000;
recovered.status = { ...recovered.status, fill: "green", text: "connected" };
execute(code.ingest, recovered, store);
execute(code.evaluate, { _global_observer_test: true, observer_now: 264_000 }, store);
const newFailure = structuredClone(statusFailure);
newFailure.observer_now = 300_000;
execute(code.ingest, newFailure, store);
const newIncident = execute(code.evaluate, {
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
