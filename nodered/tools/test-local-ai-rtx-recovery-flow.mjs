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
  evaluate: source("local-ai-rtx-health-evaluate.js"),
  guard: source("local-ai-rtx-side-effect-guard.js"),
  request: source("local-ai-rtx-recovery-request.js"),
  response: source("local-ai-rtx-recovery-response.js"),
  dry: source("local-ai-rtx-dry-run.js"),
};

function memory() {
  const values = new Map();
  return { get: (key) => values.get(key), set: (key, value) => values.set(key, value), values };
}
function execute(body, msg, flow, environment = {}) {
  return vm.runInNewContext(`(function () {\n${body}\n})()`, {
    msg, flow, env: { get: (key) => environment[key] },
    node: { status() {}, log() {}, warn() {}, error() {} },
    Date, Math, Number, String, Object, Array, JSON,
  });
}
const health = (available, now) => ({
  test_mode: true, _rtx_test: true, rtx_now: now,
  payload: { local_ai: { available, state: available ? "LOCAL_AI_AVAILABLE" : "LOCAL_AI_UNAVAILABLE", preflight: { state: available ? "LOCAL_AI_AVAILABLE" : "LOCAL_AI_UNAVAILABLE", reason: available ? null : "listener_absent" } } },
});

const store = memory();
const available = execute(code.evaluate, health(true, 100000), store);
assert.equal(available[0].payload.available, true);
assert.equal(available[1], null);

const unavailable = execute(code.evaluate, health(false, 200000), store);
assert.equal(unavailable[1], null);
const explicitUnavailable = execute(code.evaluate, {
  ...health(false, 200000),
  explicit_recovery: true,
}, store);
assert.equal(explicitUnavailable[1].payload.requested, true);
assert.equal(explicitUnavailable[1].payload.reason, "listener_absent");
const guarded = execute(code.guard, explicitUnavailable[1], store);
assert.equal(guarded[0], null);
assert.equal(guarded[1].payload.dispatched, false);
const dry = execute(code.dry, guarded[1], store);
assert.deepEqual(JSON.parse(JSON.stringify(dry.payload)), {
  simulated: true, dispatched: false, side_effect: "mcp_recovery", reason: "listener_absent",
});

const productionRequest = execute(code.request, { payload: {} }, store, { BRIDGE_TOKEN: "synthetic-token" });
assert.equal(productionRequest.method, "POST");
assert.equal(productionRequest.url, "http://ai-bridge:8099/local-ai/recover");
assert.match(productionRequest.headers.Authorization, /^Bearer /);
assert.ok(!byId.get("local_ai_rtx_prepare_recovery").func.includes("synthetic-token"));

const recovered = execute(code.response, {
  test_mode: true, _rtx_test: true,
  payload: { status: "ok", local_ai: { available: true, state: "LOCAL_AI_AVAILABLE", reason: "endpoint_recovered", recovery_attempted: true, recovery_succeeded: true, recovery_attempts: 1 } },
}, store);
assert.equal(recovered.payload.available, true);
assert.equal(recovered.payload.last_result, "recovered");
assert.equal(recovered.payload.recovery_attempts, 1);

const failed = execute(code.response, {
  test_mode: true, _rtx_test: true,
  payload: { status: "ok", local_ai: { available: false, state: "LOCAL_AI_UNAVAILABLE", reason: "portproxy_add_failed", recovery_attempted: true, recovery_succeeded: false, recovery_attempts: 2 } },
}, store);
assert.equal(failed.payload.available, false);
assert.equal(failed.payload.reason, "portproxy_add_failed");
assert.equal(failed.payload.recovery_attempts, 2);

for (const [id, file] of [
  ["local_ai_rtx_health_evaluate", "local-ai-rtx-health-evaluate.js"],
  ["local_ai_rtx_side_effect_guard", "local-ai-rtx-side-effect-guard.js"],
  ["local_ai_rtx_prepare_recovery", "local-ai-rtx-recovery-request.js"],
  ["local_ai_rtx_recovery_response", "local-ai-rtx-recovery-response.js"],
  ["local_ai_rtx_dry_run_terminal", "local-ai-rtx-dry-run.js"],
]) assert.equal(byId.get(id)?.func, source(file).trimEnd(), `${id} deve vir da fonte geradora`);

assert.equal(byId.get("local_ai_rtx_recovery_http")?.type, "http request");
assert.equal(byId.get("local_ai_rtx_tick")?.repeat, "60");
assert.equal(
  byId.get("local_ai_rtx_manual_recovery")?.props.some(
    (prop) => prop.p === "explicit_recovery" && prop.v === "true",
  ),
  true,
);
assert.equal(byId.get("local_ai_rtx_recovery_tab")?.label, "recuperacao_rtx");
assert.equal(byId.get("local_ai_rtx_dry_run_terminal")?.type, "function");
console.log("Local AI RTX recovery: availability, failure reasons, MCP guard and dry-run passed.");
