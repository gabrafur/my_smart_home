#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
const root = new URL("./", import.meta.url);
const source = name => fs.readFileSync(new URL(`functions/rtx-metrics-${name}.js`, root), "utf8");
const store = () => { const map = new Map(); return { get: k => map.get(k), set: (k, v) => map.set(k, v) }; };
const flow = store(), context = store();
const run = (name, msg, memory = flow) => vm.runInNewContext(`(function(){${source(name)}\n})()`, { msg, flow: memory, context, node: { status() {}, warn() {} }, Buffer, Date, Math, Number, String, Object, Array, JSON });
function fixture(scenario) { return run("fixture", { payload: { scenario } }); }
function compute(msg) { for (const step of ["normalize", "health", "periods", "history"]) msg = run(step, msg); return msg; }
const nominal = compute(fixture("nominal"));
assert.equal(nominal.report.metrics.net_today, 900);
assert.equal(nominal.report.metrics.use_rate_today, 25);
assert.equal(nominal.report.metrics.reduction_today, 45);
assert.equal(nominal.report.periods.today.without_gate, 0);
assert.equal(nominal.report.health.label, "Em uso");
assert.equal(nominal.report.metrics.gpu, 70);
const empty = compute(fixture("empty"));
assert.equal(empty.report.metrics.net_today, 0);
assert.equal(empty.report.metrics.use_rate_today, null);
assert.equal(empty.report.metrics.reduction_today, null);
assert.equal(empty.report.metrics.gpu, null, "Idle is unmeasured, not zero GPU");
assert.equal(compute(fixture("offline")).report.health.label, "Computador desligado");
for (const scenario of ["stale", "invalid"]) {
    const result = compute(fixture(scenario));
    assert.equal(result.report.metrics.calls_today, null);
    assert.equal(result.report.metrics.net_today, null);
    assert.equal(result.report.data_status, "unavailable");
}
assert.equal(compute(fixture("nominal")).report.data_status, "current", "Recovery must clear stale classification");
const noHost = fixture("nominal"); noHost.host.state = "unknown";
assert.equal(compute(noHost).report.host, "unknown");
const oldHost = fixture("nominal"); oldHost.host.attributes.collected_at = "2000-01-01T00:00:00Z";
assert.equal(compute(oldHost).report.host, "unknown");
const broken = fixture("nominal"); broken.usage.attributes.local_ai.periods.today.confirmed_useful_context_tokens_avoided = 999;
assert.equal(compute(broken).report.metrics.net_today, null, "Inconsistent accounting cannot claim savings");
const missing = fixture("nominal"); delete missing.usage.attributes.local_ai.periods.today.operational_calls;
assert.equal(compute(missing).report.metrics.use_rate_today, null);
const oldHistory = fixture("nominal"); oldHistory.history.attributes.collected_at = "2000-01-01T00:00:00Z";
assert.equal(compute(oldHistory).report.history_status, "unavailable");

const jobs = fixture("nominal");
const job = { status: "success", primary_context_used: true, quality_accepted: true, quality_validation_tokens_measured: true, gross_useful_context_tokens_avoided: 600, quality_validation_tokens: 50, task: "analyze-tests", model: "synthetic", duration_seconds: 1, processor: "cpu", chat_name: "must not leak" };
jobs.history.attributes.jobs = [job, { ...job, primary_context_used: false }, { ...job, status: "discarded", discard_reason: "insufficient_net_savings" }, { ...job, quality_validation_tokens_measured: false }, { ...job, status: "failed" }];
const history = compute(jobs).report.jobs;
assert.deepEqual(Array.from(history, j => j.net), [550, 0, 0, 0, 0]);
assert.equal(history[0].processor, "cpu", "Local output must not be called RTX inference");
assert.equal(history[2].result, "Descartado: sem ganho líquido");
assert.equal(history[4].result, "Falha técnica");
assert.doesNotMatch(JSON.stringify(history), /must not leak|chat_name/);

const validPolicy = flow.get("rtx_metrics_test_policy");
assert.equal(run("policy", { test_mode: true, payload: { ...validPolicy, history_limit: 1000 } }), null);
assert.equal(flow.get("rtx_metrics_test_policy"), validPolicy);
const prod = fixture("nominal"); prod.test_mode = false;
run("policy", { payload: validPolicy });
const prodPolicy = flow.get("rtx_metrics_policy");
const before = JSON.stringify(prodPolicy);
const messages = run("publish", nominal)[0];
for (const message of messages) {
    assert.equal(message.test_mode, true);
    run("dry-run", message);
    assert.equal(flow.get("rtx_metrics_test_result").dispatched, false);
}
assert.equal(JSON.stringify(flow.get("rtx_metrics_policy")), before, "Tests cannot mutate production policy");

const oversized = compute(fixture("nominal"));
oversized.report.jobs = Array.from({length:30}, () => ({model:"😀".repeat(100),task:"😀".repeat(100),processor:"😀".repeat(100)}));
const bounded = run("publish", oversized)[0].at(-1);
assert.ok(Buffer.byteLength(bounded.payload) <= 12000);
assert.equal(JSON.parse(bounded.payload).history_truncated, true);

const config = messages.map(m => JSON.parse(m.payload)).find(c => c.unique_id === "rtx_metrics_net_today");
assert.equal(config.default_entity_id, "sensor.rtx_contexto_evitado_hoje");
assert.equal(config.state_class, "measurement");
assert.equal(config.unit_of_measurement, "tokens");
assert.equal(config.expire_after, 45);
assert.equal(compute(prod).report.metrics.net_today, 900);
assert.equal(run("normalize", prod, store()), null, "Restart waits for policy; no stale persistent counters");

const flows = JSON.parse(fs.readFileSync(new URL("../flows.json", root), "utf8"));
const byId = new Map(flows.map(n => [n.id, n]));
const gate = byId.get("rtx_metrics_test_gate");
assert.equal(gate.property, "test_mode");
assert.deepEqual(gate.wires, [["rtx_metrics_dry_run"], ["rtx_metrics_mqtt"]]);
for (const type of ["catch", "status"]) assert.ok(flows.some(n => n.z === "rtx_metrics_tab" && n.type === type));
for (const [id, file] of [["normalize", "normalize"], ["health", "health"], ["periods", "periods"], ["jobs", "history"], ["serialize", "publish"], ["fixture", "fixture"], ["dry_run", "dry-run"]]) assert.equal(byId.get(`rtx_metrics_${id}`).func, source(file).trimEnd());
for (const n of flows.filter(n => n.z === "rtx_metrics_tab")) assert.ok(!["exec", "http request", "api-call-service"].includes(n.type), "Metrics may not control/recover devices");
console.log("RTX metrics: formulas, unknown/zero, freshness, history, recovery, isolated dry-run and publication passed");
