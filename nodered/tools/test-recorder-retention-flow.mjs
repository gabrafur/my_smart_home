#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const flows = JSON.parse(fs.readFileSync(path.resolve(here, "..", "flows.json"), "utf8"));
const codexPackage = fs.readFileSync(path.resolve(here, "..", "..", "homeassistant", "packages", "codex_usage.yaml"), "utf8");
const node = (id) => {
  const found = flows.find((entry) => entry.id === id);
  assert.ok(found, `missing node ${id}`);
  return found;
};
const memoryFlow = (initial = {}) => {
  const values = new Map(Object.entries(initial));
  return { get: (key) => values.get(key), set: (key, value) => values.set(key, value), values };
};
const runtimeNode = () => ({ statuses: [], errors: [], logs: [], status(value) { this.statuses.push(value); }, error(value) { this.errors.push(value); }, log(value) { this.logs.push(value); } });
const compile = (id) => new Function("msg", "flow", "node", "context", "env", node(id).func);

assert.equal(node("recorder_retention_schedule").crontab, "30 04 * * *");
assert.equal(node("recorder_retention_policy_raw_days").payload, "2");
assert.equal(node("recorder_retention_policy_compact_days").payload, "30");
assert.equal(node("recorder_retention_policy_baseline_hours").payload, "6");
assert.equal(node("recorder_retention_policy_absolute_tolerance").payload, "0.5");
assert.equal(node("recorder_retention_policy_relative_percent").payload, "1");
assert.equal(node("recorder_retention_policy_mad_multiplier").payload, "3");
assert.equal(node("recorder_retention_policy_warmup_days").payload, "2");
assert.equal(node("recorder_retention_purge").action, "recorder.purge_entities");
assert.equal(node("recorder_retention_repack").action, "recorder.purge");
assert.equal(node("recorder_retention_purge").dataType, "jsonata");
assert.equal(node("recorder_retention_rate_limit").rate, "1");
assert.equal(node("recorder_retention_rate_limit").nbRateUnits, "2");
assert.deepEqual(node("recorder_retention_dispatch_guard").wires, [["recorder_retention_rate_limit"], ["recorder_retention_guard_dry_out"]]);
assert.deepEqual(node("recorder_retention_plan").wires, [["recorder_retention_split"], ["recorder_retention_repack_delay"]]);
assert.deepEqual(node("recorder_retention_compact").wires, [["recorder_retention_result_switch"]]);
assert.deepEqual(node("recorder_retention_result_switch").rules.map((rule) => rule.t === "else" ? "else" : rule.v), ["baseline", "change", "outlier", "else"]);
assert.equal(node("recorder_retention_test_output_gate").type, "switch");
assert.deepEqual(node("recorder_retention_test_compact_out").links, ["recorder_retention_test_compact_in"]);
assert.deepEqual(node("recorder_retention_test_compact_in").links, ["recorder_retention_test_compact_out"]);
assert.deepEqual(node("recorder_retention_test_result_out").links, ["recorder_retention_test_result_in"]);
assert.equal(flows.some((entry) => entry.id === "recorder_retention_test_compact"), false, "teste não deve duplicar o cálculo canônico");
assert.ok(node("recorder_retention_changes").entities.entity.includes("sensor.raspberry_pi_cpu_usage"));
assert.ok(node("recorder_retention_changes").entities.entity.includes("sensor.vehicle_primary_refresh_coordinator"));
assert.match(node("recorder_retention_dry_run_terminal").func, /simulated/);
assert.match(node("recorder_retention_dry_run_terminal").func, /dispatched/);
assert.doesNotMatch(node("recorder_retention_repack_evaluate").func, /compactRetentionDays\s*\|\|\s*30/);
assert.doesNotMatch(node("recorder_retention_test_reset_state").func, /rawRetentionDays|compactRetentionDays|madMultiplier/);
for (const entity of [
  "sensor.codex_dados_de_limite",
  "sensor.codex_benchmark_rtx_alto_potencial",
  "sensor.codex_canario_extracao_estruturada",
  "sensor.codex_pivot_rtx_restrito",
  "sensor.codex_atualizacao_do_limite_em",
  "sensor.codex_esgotamento_estimado",
]) assert.match(codexPackage, new RegExp(`- ${entity.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));

const flow = memoryFlow();
const configure = compile("recorder_retention_config");
const compact = compile("recorder_retention_compact");
const plan = compile("recorder_retention_plan");
const guard = compile("recorder_retention_dispatch_guard");
const repackEvaluate = compile("recorder_retention_repack_evaluate");
const finalize = compile("recorder_retention_test_finalize");
for (const [topic, payload] of [
  ["rawRetentionDays", 2],
  ["compactRetentionDays", 30],
  ["baselineIntervalHours", 6],
  ["numericAbsoluteTolerance", 0.5],
  ["numericRelativeTolerancePercent", 1],
  ["madMultiplier", 3],
  ["warmupDays", 2],
]) configure({ topic, payload }, flow, runtimeNode(), {}, {});
const policy = flow.get("recorder_retention_policy_v2");
assert.equal(policy.complete, true);
assert.equal(policy.baselineIntervalMs, 6 * 60 * 60 * 1000);
assert.equal(policy.numericRelativeTolerance, 0.01);
assert.equal(policy.warmupMs, 2 * 24 * 60 * 60 * 1000);
for (const [topic, payload] of [
  ["rawRetentionDays", 0],
  ["compactRetentionDays", 181],
  ["baselineIntervalHours", 25],
  ["numericAbsoluteTolerance", 0],
  ["numericRelativeTolerancePercent", 10.1],
  ["madMultiplier", 0.9],
  ["warmupDays", 15],
]) {
  const before = JSON.stringify(flow.get("recorder_retention_policy_v2"));
  const errors = runtimeNode();
  configure({ topic, payload }, flow, errors, {}, {});
  assert.equal(errors.errors.length, 1, `${topic}=${payload} deveria ser rejeitado`);
  assert.equal(JSON.stringify(flow.get("recorder_retention_policy_v2")), before);
}
const NOW = 1_800_000_000_000;
const event = (value, offset = 0) => ({
  test_mode: true,
  testNow: NOW + offset,
  payload: { entity_id: "sensor.raspberry_pi_cpu_usage", state: String(value) },
});
const baseline = compact(event(40), flow, runtimeNode(), {}, {});
assert.equal(baseline.payload.kind, "baseline");
const near = compact(event(40.2, 60_000), flow, runtimeNode(), {}, {});
assert.equal(near.payload.retained, false);
assert.equal(near.payload.reason, "near_subsequent");
const outlier = compact(event(87, 120_000), flow, runtimeNode(), {}, {});
assert.equal(outlier.payload.kind, "outlier");
assert.deepEqual(finalize(outlier, flow, runtimeNode(), {}, {}).payload, {
  simulated: true,
  dispatched: false,
  action: "recorder-compaction",
  entity_id: "sensor.raspberry_pi_cpu_usage",
  retained: true,
  kind: "outlier",
});
const history = flow.get("recorder_retention_compact_history_v1");
assert.equal(history["sensor.raspberry_pi_cpu_usage"].length, 2, "baseline e outlier são preservados; valor próximo não");

const purgeTargets = JSON.parse(node("recorder_retention_plan_targets").rules[0].to);
flow.set("recorder_retention_started_at_v1", NOW);
const cold = plan({ testNow: NOW, purgeTargets }, flow, runtimeNode(), {}, {});
assert.deepEqual(cold[0].payload.map((entry) => entry.key), ["codex_diagnostics"]);
const warm = plan({ testNow: NOW + 2 * 24 * 60 * 60 * 1000, purgeTargets }, flow, runtimeNode(), {}, {});
assert.equal(warm[0].payload.length, 6);
assert.equal(warm[0].payload.find((entry) => entry.key === "raspberry_pi_health").keep_days, 2);
const testDispatch = guard({ test_mode: true, payload: warm[0].payload[0] }, flow, runtimeNode(), {}, {});
assert.equal(testDispatch[0], null);
assert.deepEqual(testDispatch[1].payload, { simulated: true, dispatched: false, action: "recorder.purge_entities", target: "codex_diagnostics", keep_days: 0 });
const productionDispatch = guard({ payload: warm[0].payload[1] }, flow, runtimeNode(), {}, {});
assert.equal(productionDispatch[0].payload.keep_days, 2);
assert.ok(Array.isArray(productionDispatch[0].payload.entity_id));
const repackDryRun = repackEvaluate({ test_mode: true, payload: "ready", recorderRetention: { targetKeys: ["codex_diagnostics"], compactRetentionDays: 30 }, data: { attributes: { pending_targets: [] } } }, flow, runtimeNode(), {}, {});
assert.deepEqual(repackDryRun[2].payload, { simulated: true, dispatched: false, action: "recorder.purge", repack: true, ready: true });
const repackWait = repackEvaluate({ payload: "pending", recorderRetention: { targetKeys: ["codex_diagnostics"] }, data: { attributes: { pending_targets: ["codex_diagnostics"] } } }, flow, runtimeNode(), {}, {});
assert.ok(repackWait[1], "repack aguarda enquanto a fila do alvo ainda tiver linhas");

console.log("Recorder retention flow policy valid.");
