#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";

const flows = JSON.parse(fs.readFileSync(new URL("../flows.json", import.meta.url), "utf8"));
const byId = new Map(flows.map((node) => [node.id, node]));
const TAB = "host_memory_guardian_tab";

function getFunction(id) {
  const flowNode = byId.get(id);
  assert.equal(flowNode?.type, "function", `Function node ausente: ${id}`);
  return new Function("msg", "flow", "node", "global", flowNode.func);
}

function context() {
  const stores = { default: new Map(), persistent: new Map(), memoryOnly: new Map() };
  return {
    stores,
    get(key, store = "default") { return stores[store].get(key); },
    set(key, value, store = "default") { stores[store].set(key, structuredClone(value)); },
  };
}

function nodeMock() {
  return {
    statuses: [],
    warnings: [],
    errors: [],
    status(value) { this.statuses.push(value); },
    warn(value) { this.warnings.push(String(value)); },
    error(value) { this.errors.push(String(value)); },
  };
}

assert.equal(byId.get(TAB)?.label, "guardiao_memoria_host");
const tabNodes = flows.filter((node) => node.z === TAB);
assert.ok(tabNodes.length >= 60, "tab deve expor parâmetros, decisões, efeitos e testes");
assert.equal(byId.get("host_memory_guardian_tick").repeat, "60");
assert.equal(byId.get("host_memory_guardian_tick").onceDelay, "75");
assert.equal(byId.get("host_memory_guardian_result_tick").repeat, "30");
assert.equal(byId.get("host_memory_guardian_result_tick").onceDelay, "90");
assert.equal(byId.get("host_memory_guardian_request_host").timer, "15");
assert.equal(byId.get("host_memory_guardian_read_result").timer, "15");
assert.equal(byId.get("host_memory_guardian_request_host").command, "/opt/request-host-memory-guardian.sh");
assert.equal(byId.get("host_memory_guardian_read_result").command, "/opt/read-host-memory-guardian-result.sh");
assert.match(byId.get("host_memory_guardian_architecture").info, /allowlist fechada/i);
assert.match(byId.get("host_memory_guardian_architecture").info, /nunca recebe \/proc, sudo, CAP_KILL/);

for (const [id, type] of [
  ["host_memory_guardian_request_contract", "switch"],
  ["host_memory_guardian_side_effect_guard", "switch"],
  ["host_memory_guardian_result_presence", "switch"],
  ["host_memory_guardian_result_protocol", "switch"],
  ["host_memory_guardian_result_freshness_switch", "switch"],
  ["host_memory_guardian_duplicate_switch", "switch"],
  ["host_memory_guardian_status_switch", "switch"],
  ["host_memory_guardian_effect_mode", "switch"],
  ["host_memory_guardian_effect_switch", "switch"],
  ["host_memory_guardian_result_complete_switch", "switch"],
  ["host_memory_guardian_request_complete_switch", "switch"],
]) assert.equal(byId.get(id)?.type, type, `decisão visual ausente: ${id}`);

const prepare = getFunction("host_memory_guardian_prepare_request");
const normalize = getFunction("host_memory_guardian_parse_result");
const freshness = getFunction("host_memory_guardian_result_freshness");
const dedupe = getFunction("host_memory_guardian_result_state");
const audit = getFunction("host_memory_guardian_effect_log");
const dryRun = getFunction("host_memory_guardian_dry_run_terminal");
const normalizeCompletion = getFunction("host_memory_guardian_result_complete");
const flow = context();
const mock = nodeMock();

let message = prepare({ _host_memory_guardian_test: true, payload: {} }, flow, mock, {});
assert.equal(message.payload.event, "host_memory_guardian_requested");
assert.equal(message.payload.test_mode, true);
assert.equal(normalizeCompletion({ payload: { code: 0 } }, flow, mock, {}).guardian_exit_code, 0);
assert.equal(normalizeCompletion({ payload: "" }, flow, mock, {}).guardian_exit_code, -1);

message = normalize({
  payload: `host-memory-guardian status=healthy available_mib=4096 available_percent=50.0 candidate_pid=none candidate_mib=0 terminated=0 temp_removed=0 temp_reclaimed_mib=0 cleanup_errors=0 request_id=fresh checked_at=${new Date().toISOString()}`,
}, flow, mock, {});
message.guardian_max_age_seconds = 180;
message = freshness(message, flow, mock, {});
assert.equal(message.guardian_result_fresh, true);

message = normalize({
  payload: "host-memory-guardian status=healthy available_mib=4096 available_percent=50.0 candidate_pid=none candidate_mib=0 terminated=0 temp_removed=0 temp_reclaimed_mib=0 cleanup_errors=0 request_id=stale checked_at=2020-01-01T00:00:00Z",
}, flow, mock, {});
message.guardian_max_age_seconds = 180;
message = freshness(message, flow, mock, {});
assert.equal(message.guardian_result_fresh, false);

const terminated = {
  _host_memory_guardian_test: true,
  payload: {
    status: "terminated",
    request_id: "test-terminated",
    checked_at: "2026-01-01T00:02:00Z",
    available_mib: 1200,
    available_percent: 14.6,
    candidate_pid: "synthetic",
    candidate_mib: 640,
    terminated: 4,
    test_mode: true,
  },
};
message = normalize(structuredClone(terminated), flow, mock, {});
assert.equal(message.guardian_result_present, true);
assert.equal(message.guardian_protocol_valid, true);
assert.equal(message.guardian_status, "terminated");
message = dedupe(message, flow, mock, {});
assert.equal(message.guardian_duplicate, false);
assert.equal(message.payload.simulated, true);
assert.equal(message.payload.dispatched, false);
dryRun(message, flow, mock, {});
assert.equal(flow.get("host_memory_guardian_last_dry_run_v1").signal_sent, false);

message = dedupe(normalize(structuredClone(terminated), flow, mock, {}), flow, mock, {});
assert.equal(message.guardian_duplicate, true, "assinatura sintética repetida deve ser identificada");

const productionFlow = context();
const productionNode = nodeMock();
message = normalize({
  payload: "host-memory-guardian status=terminated available_mib=1800 available_percent=22.0 candidate_pid=123 candidate_mib=700 terminated=5 request_id=req-1 checked_at=2026-08-31T21:00:00Z",
}, productionFlow, productionNode, {});
assert.equal(message.guardian_protocol_valid, true);
message = dedupe(message, productionFlow, productionNode, {});
assert.equal(message.guardian_duplicate, false);
assert.equal(productionFlow.get("host_memory_guardian_last_result_v1", "persistent").terminated, 5);
assert.equal(audit(message, productionFlow, productionNode, {}), null);
assert.equal(productionNode.warnings.length, 1);
assert.match(productionNode.warnings[0], /HOST_MEMORY_GUARDIAN_TERMINATED/);

message = normalize({
  payload: "host-memory-guardian status=reclaimed available_mib=4096 available_percent=50.0 candidate_pid=none candidate_mib=0 terminated=0 temp_removed=12 temp_reclaimed_mib=512 cleanup_errors=0 request_id=req-2 checked_at=2026-08-31T21:01:00Z",
}, productionFlow, productionNode, {});
assert.equal(message.payload.temp_removed, 12);
assert.equal(message.payload.temp_reclaimed_mib, 512);
assert.equal(message.payload.dispatched, true);
assert.equal(audit(message, productionFlow, productionNode, {}), null);
assert.match(productionNode.warnings.at(-1), /HOST_MEMORY_GUARDIAN_RECLAIMED/);

message = normalize({
  payload: "host-memory-guardian status=terminated available_mib=1800 available_percent=22.0 candidate_pid=123 candidate_mib=700 terminated=5 request_id=req-1 checked_at=2026-08-31T21:00:00Z",
}, productionFlow, productionNode, {});
message = dedupe(message, productionFlow, productionNode, {});
assert.equal(message.guardian_duplicate, true, "resultado persistente repetido deve ser identificado");

message = normalize({ payload: "host-memory-guardian status=unknown_policy" }, productionFlow, productionNode, {});
assert.equal(message.guardian_result_present, true);
assert.equal(message.guardian_protocol_valid, false);
message = normalize({ payload: "" }, productionFlow, productionNode, {});
assert.equal(message.guardian_result_present, false);

const terminal = byId.get("host_memory_guardian_dry_run_terminal");
assert.deepEqual((terminal.wires ?? []).flat(), []);
assert.match(terminal.func, /simulated:\s*true/);
assert.match(terminal.func, /dispatched:\s*false/);
assert.deepEqual(byId.get("host_memory_guardian_side_effect_guard").wires[0], ["host_memory_guardian_request_dry_out"]);
assert.deepEqual(byId.get("host_memory_guardian_side_effect_guard").wires[1], ["host_memory_guardian_request_host_out"]);

for (const id of [
  "host_memory_guardian_test_group",
  "host_memory_guardian_test_instructions",
  "host_memory_guardian_test_reset",
  "host_memory_guardian_test_request",
  "host_memory_guardian_test_healthy",
  "host_memory_guardian_test_reclaimed",
  "host_memory_guardian_test_candidate",
  "host_memory_guardian_test_terminated",
  "host_memory_guardian_test_duplicate",
  "host_memory_guardian_test_failed",
  "host_memory_guardian_test_stale",
]) assert.ok(byId.has(id), `evidência manual ausente: ${id}`);

// The error must retain its diagnosis through the actual central alert formatter.
const effectError = getFunction("host_memory_guardian_effect_error");
const formatAlert = getFunction("global_observer_error_alert");
for (const [status, reason, event, description] of [
  ["failed", "memory-guardian_status=failed_reason=temporary_process_scan_unavailable", "host_memory_guardian_failed", /listar os processos do host/],
  ["failed", "worker_unavailable", "host_memory_guardian_failed", /worker de memória falhou/],
  ["failed", "stale_result", "host_memory_guardian_result_stale", /resultado do worker venceu/],
  ["cleanup_partial", "none", "host_memory_guardian_cleanup_partial", /limpeza de temporários/],
  ["invalid", "none", "host_memory_guardian_result_unrecognized", /fora do contrato/],
]) {
  let caught;
  const errorNode = { status() {}, error(error, msg) { caught = structuredClone(msg); caught.error = { message: error }; } };
  effectError({ payload: { status, reason, request_id: "synthetic" } }, context(), errorNode, {});
  assert.match(caught.error.message, new RegExp(event));
  caught._observer_event = { test_mode: true, flow_id: TAB, source_id: "host_memory_guardian_effect_error", policy: { reminder_hours: 6 } };
  const notification = formatAlert(caught, context(), nodeMock(), {});
  assert.match(notification.alert.title, /^TESTE/);
  assert.match(notification.alert.message, description);
  assert.ok(notification.alert.message.includes(reason));
  assert.ok(notification.alert.message.includes(event));
  assert.equal(notification.payload.test_mode, true);
}

const maxFunctionLength = Math.max(...tabNodes.filter((node) => node.type === "function").map((node) => node.func.length));
assert.ok(maxFunctionLength < 2000, `JavaScript residual deve ser pequeno; maior função: ${maxFunctionLength}`);

console.log("Host memory guardian flow tests passed.");
