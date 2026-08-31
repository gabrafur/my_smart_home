#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";

const flows = JSON.parse(fs.readFileSync(new URL("../flows.json", import.meta.url), "utf8"));
const byId = new Map(flows.map((node) => [node.id, node]));
const TAB = "host_memory_guardian_tab";

function getFunction(id) {
  const node = byId.get(id);
  assert.equal(node?.type, "function", `Function node ausente: ${id}`);
  return new Function("msg", "flow", "node", "global", node.func);
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
assert.ok(tabNodes.length >= 25, "tab deve conter produção, resultado e testes");
assert.equal(byId.get("host_memory_guardian_tick").repeat, "60");
assert.equal(byId.get("host_memory_guardian_result_tick").repeat, "30");
assert.equal(byId.get("host_memory_guardian_request_host").command, "/opt/request-host-memory-guardian.sh");
assert.equal(byId.get("host_memory_guardian_read_result").command, "/opt/read-host-memory-guardian-result.sh");
assert.match(byId.get("host_memory_guardian_architecture").info, /Allowlist fechada/);
assert.match(byId.get("host_memory_guardian_architecture").name, /nunca recebe \/proc, sudo, CAP_KILL/);

const prepare = getFunction("host_memory_guardian_prepare_request");
const guard = getFunction("host_memory_guardian_side_effect_guard");
const dryRun = getFunction("host_memory_guardian_dry_run_terminal");
const parseResult = getFunction("host_memory_guardian_parse_result");
const flow = context();
const mock = nodeMock();

let message = prepare({ _host_memory_guardian_test: true, payload: {} }, flow, mock, {});
assert.equal(message.payload.test_mode, true);
let routed = guard(message, flow, mock, {});
assert.equal(routed[0], null);
assert.ok(routed[1]);
assert.equal(dryRun(routed[1], flow, mock, {}), null);
assert.equal(flow.get("host_memory_guardian_last_dry_run_v1").dispatched, false);
assert.equal(flow.get("host_memory_guardian_last_dry_run_v1").signal_sent, false);

message = prepare({ payload: {} }, flow, mock, {});
routed = guard(message, flow, mock, {});
assert.ok(routed[0]);
assert.equal(routed[1], null);

const synthetic = {
  _host_memory_guardian_test: true,
  payload: {
    status: "terminated",
    available_mib: 1200,
    available_percent: 14.6,
    candidate_pid: "synthetic",
    candidate_mib: 640,
    terminated: 4,
    test_mode: true,
  },
};
routed = parseResult(synthetic, flow, mock, {});
assert.equal(routed[0], null);
assert.equal(routed[1].payload.simulated, true);
assert.equal(routed[1].payload.dispatched, false);
dryRun(routed[1], flow, mock, {});
assert.equal(flow.get("host_memory_guardian_last_dry_run_v1").candidate_mib, 640);

const productionFlow = context();
const productionNode = nodeMock();
routed = parseResult({
  payload: "host-memory-guardian status=terminated available_mib=1800 available_percent=22.0 candidate_pid=123 candidate_mib=700 terminated=5 request_id=req-1 checked_at=2026-08-31T21:00:00Z",
}, productionFlow, productionNode, {});
assert.deepEqual(routed, [null, null]);
assert.equal(productionNode.warnings.length, 1);
assert.match(productionNode.warnings[0], /HOST_MEMORY_GUARDIAN_TERMINATED/);
assert.equal(productionFlow.get("host_memory_guardian_last_result_v1", "persistent").terminated, 5);

const duplicate = parseResult({
  payload: "host-memory-guardian status=terminated available_mib=1800 available_percent=22.0 candidate_pid=123 candidate_mib=700 terminated=5 request_id=req-1 checked_at=2026-08-31T21:00:00Z",
}, productionFlow, productionNode, {});
assert.equal(duplicate, null, "resultado persistente repetido deve ser deduplicado");

const terminal = byId.get("host_memory_guardian_dry_run_terminal");
assert.deepEqual(terminal.wires, []);
assert.match(terminal.func, /simulated:\s*true/);
assert.match(terminal.func, /dispatched:\s*false/);

for (const id of [
  "host_memory_guardian_test_group",
  "host_memory_guardian_test_instructions",
  "host_memory_guardian_test_reset",
  "host_memory_guardian_test_request",
  "host_memory_guardian_test_healthy",
  "host_memory_guardian_test_candidate",
  "host_memory_guardian_test_terminated",
  "host_memory_guardian_test_failed",
]) {
  assert.ok(byId.has(id), `evidência manual ausente: ${id}`);
}

const requestGuard = byId.get("host_memory_guardian_side_effect_guard");
assert.deepEqual(requestGuard.wires[1], ["host_memory_guardian_request_test_out"]);
assert.equal(byId.get("host_memory_guardian_request_test_out").links[0], "host_memory_guardian_dry_in");
assert.ok(byId.get("host_memory_guardian_dry_in").links.includes("host_memory_guardian_result_test_out"));

console.log("Host memory guardian flow tests passed.");
