#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const functionDir = path.join(here, "functions");
const source = (name) => fs.readFileSync(path.join(functionDir, name), "utf8");
const flows = JSON.parse(fs.readFileSync(path.resolve(here, "..", "flows.json"), "utf8"));
const byId = new Map(flows.map((node) => [node.id, node]));
const code = {
  report: source("vpn-monitor-report-ingest.js"),
  internet: source("vpn-monitor-internet-ingest.js"),
  evaluate: source("vpn-monitor-evaluate.js"),
  guard: source("vpn-monitor-side-effect-guard.js"),
  dryRun: source("vpn-monitor-dry-run.js"),
  discovery: source("vpn-monitor-discovery.js"),
};

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
    node: { status() {}, log() {}, warn() {}, error() {} },
    Buffer,
    Date,
    Math,
    Number,
    String,
    Object,
    Array,
    Map,
    Set,
    JSON,
  });
}

const internet = (phase, now) => ({
  _vpn_test: true,
  vpn_now: now,
  payload: phase,
});
const report = (healthy, now, reason = healthy ? "running" : "backend_stopped") => ({
  _vpn_test: true,
  vpn_now: now,
  payload: {
    schema_version: 1,
    checked_at: new Date(now).toISOString(),
    vpns: [{
      role: "vpn_primary",
      kind: "tailscale",
      installed: true,
      healthy,
      reason,
      checked_at: new Date(now).toISOString(),
    }],
  },
});
const evaluate = (store, now) => execute(code.evaluate, {
  _vpn_test: true,
  vpn_now: now,
  payload: { test_mode: true },
}, store);

const store = memory();
execute(code.internet, internet("online", 100_000), store);
execute(code.report, report(false, 100_000), store);
assert.equal(evaluate(store, 100_000)[0], null, "primeira falha não alerta");
assert.equal(evaluate(store, 219_000)[0], null, "menos de 2 minutos não alerta");
const confirmed = evaluate(store, 221_000);
assert.equal(confirmed[0].length, 1);
assert.match(confirmed[0][0].notification.title, /TESTE.*Tailscale.*indisponível/);
assert.match(confirmed[0][0].notification.message, /internet está disponível/i);
assert.equal(evaluate(store, 222_000)[0], null, "incidente aberto é deduplicado");

const guarded = execute(code.guard, confirmed[0][0], store);
assert.equal(guarded[0], null);
assert.equal(guarded[1].payload.dispatched, false);
execute(code.dryRun, guarded[1], store);
assert.equal(store.values.get("vpn_monitor_last_dry_run_v1").notification_sent, false);

execute(code.report, report(true, 230_000), store);
assert.equal(evaluate(store, 230_000)[1], null, "recuperação precisa estabilizar");
const recovered = evaluate(store, 291_000);
assert.equal(recovered[1].length, 1);
assert.match(recovered[1][0].notification.title, /TESTE.*recuperada/);

const internetDownStore = memory();
execute(code.internet, internet("offline", 100_000), internetDownStore);
execute(code.report, report(false, 100_000), internetDownStore);
assert.equal(evaluate(internetDownStore, 400_000)[0], null);
assert.equal(
  internetDownStore.values.get("vpn_monitor_state_v1__test").vpn_primary.phase,
  "suppressed_internet",
  "queda geral da internet suprime alerta de VPN",
);

const staleStore = memory();
execute(code.internet, internet("online", 100_000), staleStore);
execute(code.report, report(true, 100_000), staleStore);
evaluate(staleStore, 400_000);
const staleAlert = evaluate(staleStore, 521_000);
assert.equal(staleAlert[0].length, 1);
assert.match(staleAlert[0][0].notification.message, /deixou de atualizar/);

const discovery = execute(code.discovery, {}, memory());
const discoveryPayloads = new Map(discovery[0].map((entry) => [entry.topic, JSON.parse(entry.payload)]));
assert.equal(
  discoveryPayloads.get("homeassistant/binary_sensor/vpn_primary_connection/config").default_entity_id,
  "binary_sensor.vpn_primary_connection",
);
assert.equal(
  discoveryPayloads.get("homeassistant/sensor/vpn_primary_connection_state/config").default_entity_id,
  "sensor.vpn_primary_connection_state",
);

for (const [id, file] of [
  ["vpn_monitor_report_ingest", "vpn-monitor-report-ingest.js"],
  ["vpn_monitor_internet_ingest", "vpn-monitor-internet-ingest.js"],
  ["vpn_monitor_evaluate", "vpn-monitor-evaluate.js"],
  ["vpn_monitor_down_guard", "vpn-monitor-side-effect-guard.js"],
  ["vpn_monitor_recovery_guard", "vpn-monitor-side-effect-guard.js"],
  ["vpn_monitor_mqtt_guard", "vpn-monitor-side-effect-guard.js"],
  ["vpn_monitor_dry_run_terminal", "vpn-monitor-dry-run.js"],
]) {
  assert.equal(byId.get(id)?.func, source(file).trimEnd(), `${id} deve vir da fonte geradora`);
}
assert.equal(byId.get("monitoramento_vpn_tab")?.label, "monitoramento_vpn");
assert.equal(byId.get("vpn_monitor_notify_down")?.type, "subflow:infra_notify_all_mobiles");
assert.equal(byId.get("vpn_monitor_notify_recovery")?.type, "subflow:infra_notify_all_mobiles");
assert.equal(byId.get("vpn_monitor_state_out")?.retain, "true");
assert.equal(byId.get("vpn_monitor_health_in")?.topic, "nodered/infrastructure/vpn/host-health");
assert.equal(byId.get("vpn_monitor_internet_in")?.topic, "nodered/infrastructure/internet/state");

console.log("VPN monitor: failure, internet suppression, recovery and dry-run scenarios passed.");
