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
  dryRun: source("global-flow-observer-dry-run.js"),
};
const flowNodeIds = {
  ingest: "global_observer_ingest",
  evaluate: "global_observer_evaluate",
  guard: "global_observer_dispatch_guard",
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
assert.equal(confirmed[0].length, 1);
assert.match(confirmed[0][0].alert.title, /Home Assistant/);
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
assert.ok(simulated[1]);
const delivery = execute(code.guard, {
  _global_observer_test: true,
  _observer_delivery_test: true,
  payload: {},
}, store);
assert.ok(delivery[0]);
assert.equal(delivery[1], null);
assert.match(delivery[0].alert.title, /TESTE/);
assert.equal(delivery[0].payload.notification_delivery_under_test, true);

const dryRunStore = memory();
execute(code.dryRun, simulated[1], dryRunStore);
assert.equal(dryRunStore.values.get("global_flow_observer_last_dry_run_v1").dispatched, false);

console.log("Global flow observer: topology and incident lifecycle scenarios passed.");
