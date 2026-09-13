#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const functionDir = path.join(here, "functions");
const source = (name) => fs.readFileSync(path.join(functionDir, name), "utf8");
const flows = JSON.parse(fs.readFileSync(path.resolve(here, "..", "flows.json"), "utf8"));
const byId = new Map(flows.map((entry) => [entry.id, entry]));
const node = (id) => {
  const found = byId.get(id);
  assert.ok(found, `missing node ${id}`);
  return found;
};
const logicalWireTargets = (id, output = 0) => (node(id).wires?.[output] ?? []).flatMap((targetId) => {
  const target = node(targetId);
  if (target.type !== "link out" || !target.notification_hub_wire_route) return [targetId];
  return (target.links ?? []).flatMap((linkInId) => node(linkInId).wires?.[0] ?? []);
});
function memory() {
  const stores = { default: new Map(), persistent: new Map() };
  return {
    get(key, store = "default") { return stores[store].get(key); },
    set(key, value, store = "default") { stores[store].set(key, structuredClone(value)); },
    stores,
  };
}
function execute(body, msg, flow) {
  const events = { errors: [], warnings: [], statuses: [] };
  const result = vm.runInNewContext(`(function () {\n${body}\n})()`, {
    msg,
    flow,
    node: {
      error(value) { events.errors.push(value); },
      warn(value) { events.warnings.push(value); },
      log() {},
      status(value) { events.statuses.push(value); },
    },
    Date,
    JSON,
    String,
    Object,
  });
  return { result, events };
}

assert.equal(node("git_backup_tab").label, "backup_git");
assert.equal(node("git_backup_schedule").crontab, "30 00 * * *");
assert.equal(node("git_backup_request_gate").type, "switch");
assert.deepEqual(node("git_backup_request_gate").wires, [
  ["git_backup_request_dry_out"],
  ["git_backup_worker_out"],
]);
assert.deepEqual(node("git_backup_request_dry_out").links, ["git_backup_dry_in"]);
assert.deepEqual(node("git_backup_worker_out").links, ["git_backup_worker_in"]);
assert.equal(node("git_backup_request").command, "/opt/request-host-git-backup.sh");
assert.equal(node("git_backup_request").timer, "240");
assert.ok(!JSON.stringify(node("git_backup_request")).includes("docker.sock"));
assert.ok(!JSON.stringify(node("git_backup_request")).includes("/mnt/data/docker"));
assert.ok(!JSON.stringify(node("git_backup_request")).includes(".ssh"));
assert.deepEqual(node("git_backup_result_out").links, ["git_backup_result_in"]);
assert.equal(node("git_backup_status_switch").type, "switch");
assert.equal(node("git_backup_success_origin").type, "switch");
assert.equal(node("git_backup_success_gate").type, "switch");
assert.equal(node("git_backup_failure_gate").type, "switch");
assert.equal(node("git_backup_deferred_gate").type, "switch");
assert.equal(node("git_backup_invalid_gate").type, "switch");
assert.deepEqual(node("git_backup_success_gate").wires, [
  ["git_backup_dry_out"],
  ["git_backup_mark_daily_success"],
]);
assert.deepEqual(node("git_backup_failure_gate").wires, [
  ["git_backup_dry_out"],
  ["git_backup_notification_out"],
]);
assert.deepEqual(node("git_backup_deferred_gate").wires, [
  ["git_backup_dry_out"],
  ["git_backup_retry_effect_out"],
]);
assert.deepEqual(logicalWireTargets("git_backup_notification_in"), [
  "git_backup_notify_primary",
  "git_backup_notify_persistent",
]);
assert.deepEqual(logicalWireTargets("git_backup_retry_delay"), ["git_backup_retry_out"]);
assert.equal(node("git_backup_retry_delay").timeout, "5");
assert.equal(node("git_backup_retry_delay").timeoutUnits, "minutes");
assert.match(node("git_backup_complete").property, /\$exists\(payload\.code\)/);
assert.deepEqual(node("git_backup_retry_out").links, ["git_backup_retry_in"]);
assert.deepEqual(node("git_backup_daily_update_out").links, ["daily_update_after_backup_in"]);
assert.ok(node("git_backup_mark_daily_success").rules.some((rule) => rule.p === "payload.event" && rule.to === "git_backup_completed"));
assert.match(node("git_backup_notify_primary").rules.map((rule) => String(rule.to ?? "")).join("\n"), /"recipients":\["resident_primary"\]/);
assert.deepEqual(node("git_backup_notify_primary__hub_call").links, ["notification_hub_mobile_in"]);
assert.match(node("git_backup_notify_persistent").rules.map((rule) => String(rule.to ?? "")).join("\n"), /"notification_id":"git_backup_failure"/);
assert.deepEqual(node("git_backup_notify_persistent__hub_call").links, ["notification_hub_persistent_in"]);
assert.deepEqual(node("git_backup_test_request_out").links, ["git_backup_test_request_in"]);
assert.deepEqual(node("git_backup_test_result_out").links, ["git_backup_result_in"]);
assert.ok(!JSON.stringify(node("git_backup_test_request")).includes("git_backup_request"));
assert.ok(!JSON.stringify(node("git_backup_test_success")).includes("git_backup_request"));

const flow = memory();
const normalize = source("git-backup-result-normalize.js");
for (const [status, testMode] of [["success", true], ["failed", true], ["deferred", false]]) {
  const result = execute(normalize, {
    _git_backup_test: testMode,
    payload: `git-backup status=${status} request_id=test finished_at=synthetic`,
  }, flow).result;
  assert.equal(result.git_backup_status, status);
  assert.equal(result.payload.status, status);
  const key = testMode ? "git_backup_last_result_v1__test" : "git_backup_last_result_v1";
  const store = testMode ? "default" : "persistent";
  assert.equal(flow.get(key, store).status, status);
}
const invalid = execute(normalize, { _git_backup_test: true, payload: "unexpected" }, flow).result;
assert.equal(invalid.git_backup_status, "invalid");
const emptyStdout = execute(normalize, { payload: "\n" }, flow);
assert.equal(emptyStdout.result, null);
assert.match(emptyStdout.events.statuses[0].text, /erro tratado separadamente/);
assert.equal(flow.get("git_backup_last_result_v1", "persistent").status, "deferred");

const alert = execute(source("git-backup-alert-build.js"), { payload: { status: "failed" } }, flow).result;
assert.match(alert.alert.title, /Falha no backup Git/);
const bridgeError = execute(source("git-backup-error-build.js"), { payload: "synthetic timeout" }, flow);
assert.equal(bridgeError.events.errors.length, 1);
assert.match(bridgeError.result.alert.message, /worker do host/);
const invalidResult = execute(source("git-backup-invalid-result.js"), invalid, flow);
assert.equal(invalidResult.result, null);
assert.equal(invalidResult.events.warnings[0], "git_backup_result_unrecognized");

const dry = execute(source("git-backup-dry-run.js"), alert, flow);
assert.equal(dry.result, null);
assert.deepEqual(JSON.parse(JSON.stringify(flow.get("git_backup_last_dry_run_v1"))), {
  version: 1,
  simulated: true,
  dispatched: false,
  external_call_sent: false,
  notification_sent: false,
  persistent_notification_sent: false,
  status: "failed",
  completed_at: flow.get("git_backup_last_dry_run_v1").completed_at,
});
assert.match(dry.events.warnings[0], /GIT_BACKUP_DRY_RUN/);

for (const [id, file] of [
  ["git_backup_result", "git-backup-result-normalize.js"],
  ["git_backup_alert_build", "git-backup-alert-build.js"],
  ["git_backup_error", "git-backup-error-build.js"],
  ["git_backup_invalid_result", "git-backup-invalid-result.js"],
  ["git_backup_test_reset_state", "git-backup-reset-test.js"],
  ["git_backup_dry_run_terminal", "git-backup-dry-run.js"],
]) assert.equal(node(id).func, source(file).trimEnd(), `${id} deve vir da fonte canônica`);

const packageYaml = fs.readFileSync(path.join(root, "homeassistant", "packages", "weekly_documentation_review.yaml"), "utf8");
const dashboard = fs.readFileSync(path.join(root, "homeassistant", "dashboards", "raspberry_pi_health.yaml"), "utf8");
assert.match(packageYaml, /unique_id: weekly_documentation_review\b/);
assert.match(packageYaml, /unique_id: weekly_documentation_review_running\b/);
assert.match(dashboard, /entity: sensor\.revisao_semanal_da_documentacao\b/);
assert.match(dashboard, /entity: binary_sensor\.revisao_documental_em_execucao\b/);

console.log("Git backup: visual decisions, isolated effects, retry and complete dry-run passed.");
