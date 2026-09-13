import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import vm from "node:vm";

const flowsPath = new URL("../flows.json", import.meta.url);
const flows = JSON.parse(fs.readFileSync(flowsPath, "utf8"));
const byId = new Map(flows.map((item) => [item.id, item]));
const TAB = "alarm_house_tab";
const alarmPackage = fs.readFileSync(
  new URL("../../homeassistant/packages/moni_mobile_alarm.yaml", import.meta.url),
  "utf8",
);

function node(id) {
  const result = byId.get(id);
  assert.ok(result, `missing node: ${id}`);
  return result;
}

function store(initial = {}) {
  return new Map(Object.entries(initial));
}

function runFunction(id, msg, values = store()) {
  const statuses = [];
  const warnings = [];
  const errors = [];
  const context = {
    msg,
    node: {
      status: (value) => statuses.push(value),
      warn: (value) => warnings.push(value),
      error: (value) => errors.push(value),
    },
    flow: {
      get: (key) => values.get(key),
      set: (key, value) => values.set(key, value),
    },
    global: { get: () => undefined, set: () => undefined },
    Date, Math, Number, String, Object, JSON,
  };
  const result = vm.runInNewContext(`(function () { ${node(id).func}\n})()`, context);
  return { result, values, statuses, warnings, errors };
}

assert.equal(node(TAB).label, "alarme_casa");
assert.match(node(TAB).info, /Fonte canônica visual/);
assert.equal(new Set(flows.map((item) => item.id)).size, flows.length);

for (const id of [
  "alarm_group_policy", "alarm_group_inputs", "alarm_group_retry",
  "alarm_group_effects", "alarm_group_tests", "alarm_policy_retry_seconds",
  "alarm_policy_notify_every", "alarm_policy_max_attempts", "alarm_policy_validate",
  "alarm_intent_action_switch", "alarm_retry_allowed_switch",
  "alarm_retry_still_desired_switch", "alarm_retry_notify_switch",
  "alarm_arm_final_gate", "alarm_disarm_final_gate", "alarm_notification_final_gate",
  "alarm_test_reset", "alarm_test_arm", "alarm_test_failure_arm",
  "alarm_test_disarm", "alarm_test_dry_run_terminal",
]) {
  assert.equal(node(id).z, TAB, `${id} ficou fora da aba canônica`);
  assert.ok(node(id).name, `${id} precisa de nome visual`);
}

for (const [id, topic, payload] of [
  ["alarm_policy_retry_seconds", "retry_seconds", "10"],
  ["alarm_policy_notify_every", "notify_every_attempts", "5"],
  ["alarm_policy_max_attempts", "max_attempts", "0"],
]) {
  assert.equal(node(id).topic, topic);
  assert.equal(node(id).payload, payload);
  assert.equal(node(id).once, true);
  assert.deepEqual(node(id).wires, [["alarm_policy_validate"]]);
}

const policyStore = store();
for (const [topic, payload] of [
  ["retry_seconds", 10], ["notify_every_attempts", 5], ["max_attempts", 0],
]) {
  const applied = runFunction("alarm_policy_validate", { topic, payload }, policyStore);
  assert.equal(applied.result, null);
  assert.equal(applied.errors.length, 0);
}
assert.deepEqual(
  JSON.parse(JSON.stringify(policyStore.get("alarm_house_policy_v1"))),
  {
    version: 1, owner: "node_red", retry_seconds: 10,
    notify_every_attempts: 5, max_attempts: 0, complete: true,
    updated_at: policyStore.get("alarm_house_policy_v1").updated_at,
  },
);
const lastValid = structuredClone(policyStore.get("alarm_house_policy_v1"));
for (const [topic, payload] of [
  ["retry_seconds", 0], ["retry_seconds", 301],
  ["notify_every_attempts", 0], ["notify_every_attempts", 101],
  ["max_attempts", -1], ["max_attempts", 1001], ["max_attempts", 1.5],
  ["unknown", 10],
]) {
  const rejected = runFunction("alarm_policy_validate", { topic, payload }, policyStore);
  assert.equal(rejected.result, null);
  assert.equal(rejected.errors.length, 1);
  assert.equal(
    JSON.stringify(policyStore.get("alarm_house_policy_v1")),
    JSON.stringify(lastValid),
  );
}
for (const [topic, payload] of [
  ["retry_seconds", 1], ["retry_seconds", 300],
  ["notify_every_attempts", 1], ["notify_every_attempts", 100],
  ["max_attempts", 0], ["max_attempts", 1000],
]) {
  const boundary = runFunction("alarm_policy_validate", { topic, payload }, policyStore);
  assert.equal(boundary.errors.length, 0, `${topic}=${payload} deveria ser aceito`);
}

const defaultPolicy = {
  version: 1, owner: "node_red", complete: true,
  retry_seconds: 10, notify_every_attempts: 5, max_attempts: 0,
};
for (const [retryCount, expectedAttempt, notifyNow] of [
  [0, 1, true], [1, 2, false], [4, 5, true], [9, 10, true],
]) {
  const evaluated = runFunction("alarm_retry_evaluate", {
    policy: defaultPolicy, retry_count: retryCount,
    alarm_request: { action: "arm" }, test_mode: true,
  });
  assert.equal(evaluated.result.retry.attempt, expectedAttempt);
  assert.equal(evaluated.result.retry.retry_allowed, true);
  assert.equal(evaluated.result.retry.notify_now, notifyNow);
  assert.equal(evaluated.result.retry.delay_ms, 10_000);
}
const limited = runFunction("alarm_retry_evaluate", {
  policy: { ...defaultPolicy, max_attempts: 1 }, retry_count: 0,
  alarm_request: { action: "disarm" },
});
assert.equal(limited.result.retry.retry_allowed, false);
assert.equal(limited.result.retry.notify_now, true);
assert.match(limited.result.notify_text, /Limite de 1 tentativas atingido/);
const noPolicy = runFunction("alarm_retry_evaluate", { alarm_request: { action: "arm" } });
assert.equal(noPolicy.result, null);
assert.equal(noPolicy.errors.length, 1);

const isolated = store({ alarm_desired: "disarm" });
const testIntent = runFunction("alarm_record_intent", {
  alarm_request: { action: "arm", source: "manual_test" }, test_mode: true,
}, isolated);
assert.equal(testIntent.result.retry_count, 0);
assert.equal(isolated.get("alarm_desired"), "disarm", "TESTE não pode alterar o estado legado de produção");
assert.equal(isolated.get("alarm_house_state_v1"), undefined);
assert.equal(isolated.get("alarm_house_test_state_v1").desired, "arm");
const productionIntent = runFunction("alarm_record_intent", {
  alarm_request: { action: "disarm", source: "arrival_policy" }, test_mode: false,
}, isolated);
assert.equal(productionIntent.result.alarm_request.action, "disarm");
assert.equal(isolated.get("alarm_desired"), "disarm");
assert.equal(isolated.get("alarm_house_state_v1").desired, "disarm");

const desired = runFunction("alarm_retry_read_desired", {
  alarm_request: { action: "arm" }, test_mode: true, retry: {},
}, isolated);
assert.equal(desired.result.retry.still_desired, true);
const stale = runFunction("alarm_retry_read_desired", {
  alarm_request: { action: "arm" }, test_mode: false, retry: {},
}, isolated);
assert.equal(stale.result.retry.still_desired, false);

const dryRun = runFunction("alarm_test_dry_run_terminal", {
  test_mode: true, alarm_request: { action: "arm" },
  dry_run_boundary: "security_panel_service", retry: { attempt: 2 },
});
assert.equal(dryRun.result, null);
assert.equal(dryRun.warnings.length, 1);
assert.match(dryRun.warnings[0], /"simulated":true/);
assert.match(dryRun.warnings[0], /"dispatched":false/);

assert.equal(node("moni_mobile_arm_event").eventType, "node_red_moni_mobile_arm");
assert.match(alarmPackage, /moni_mobile_armar_via_carplay:[\s\S]*event: node_red_moni_mobile_arm/);
assert.match(alarmPackage, /source: script\.moni_mobile_armar_via_carplay[\s\S]*action: arm/);
assert.doesNotMatch(alarmPackage, /moni_mobile_armar_via_carplay:[\s\S]*alarm_control_panel\.alarm_arm_away/);
assert.deepEqual(node("alarm_arrival_disarm_command_in").wires, [["alarm_set_arrival_disarm"]]);
assert.deepEqual(node("alarm_arm_final_gate").wires[1], ["alarm_security_dry_run_out"]);
assert.deepEqual(node("alarm_disarm_final_gate").wires[1], ["alarm_security_dry_run_out"]);
assert.deepEqual(node("alarm_notification_final_gate").wires[1], ["alarm_notification_dry_run_out"]);
assert.deepEqual(node("alarm_test_dry_run_in").links.sort(), [
  "alarm_notification_dry_run_out", "alarm_security_dry_run_out",
].sort());
assert.equal(node("alarm_test_dry_run_terminal").outputs, 0);
assert.equal((node("alarm_test_dry_run_terminal").wires ?? []).flat().length, 0);

for (const [id, action] of [
  ["70eb073f8191e69e", "arm_away"], ["8261c7cfb6756ca8", "disarm"],
]) {
  const effect = node(id);
  assert.equal(effect.action, "public_bindings.call");
  assert.equal(effect.queue, "none");
  const data = JSON.parse(effect.data);
  assert.equal(data.role, "security_panel");
  assert.equal(data.action, action);
  assert.deepEqual(data.data, {});
}
assert.equal(node("alarm_notify_alexa").type, "change");
assert.match(node("alarm_notify_alexa").rules.map((rule) => String(rule.to ?? "")).join("\n"), /"targets":\["voice_assistant_primary"\]/);
assert.deepEqual(node("alarm_notify_alexa__hub_call").links, ["notification_hub_alexa_in"]);
assert.equal(node("moni_mobile_update_after_arm").action, "homeassistant.update_entity");

for (const removed of legacyIdsForTest()) assert.equal(byId.has(removed), false, `${removed} deveria ter sido removido`);
for (const item of flows.filter((candidate) => candidate.type === "function")) {
  new Function("msg", "node", "context", "flow", "global", "env", "setTimeout", "clearTimeout", item.func);
}
for (const item of flows.filter((candidate) => candidate.z)) {
  for (const targetId of (item.wires || []).flat()) {
    const target = node(targetId);
    assert.equal(target.z, item.z, `wire direto entre abas: ${item.id} -> ${targetId}`);
  }
}
for (const item of flows.filter((candidate) => candidate.z === TAB && candidate.type === "function")) {
  assert.ok(item.func.length < 3_500, `${item.id} ainda encapsula lógica extensa (${item.func.length})`);
}

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "alarm-flow-idempotence-"));
const firstOut = path.join(tempDir, "first.json");
const secondOut = path.join(tempDir, "second.json");
for (const output of [firstOut, secondOut]) {
  const run = spawnSync(process.execPath, [new URL("./install-alarm-house-flow.mjs", import.meta.url).pathname, output], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr || run.stdout);
}
const digest = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
assert.equal(digest(firstOut), digest(secondOut), "gerador visual precisa ser idempotente");
fs.rmSync(tempDir, { recursive: true, force: true });

function legacyIdsForTest() {
  return [
    "arm_alarm_retry_decision", "arm_alarm_retry_delay",
    "disarm_alarm_retry_decision", "disarm_alarm_retry_delay",
    "alarm_guard_arm", "alarm_guard_disarm", "4043829dac0a9fee", "0543222ad4ed094d",
  ];
}

console.log("Alarm-house visual canonical flow tests passed.");
