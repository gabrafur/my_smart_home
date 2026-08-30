#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const flows = JSON.parse(fs.readFileSync(path.resolve(here, "..", "flows.json"), "utf8"));
const node = (id) => {
  const found = flows.find((entry) => entry.id === id);
  assert.ok(found, `missing node ${id}`);
  return found;
};

assert.equal(node("git_backup_tab").label, "backup_git");
assert.equal(node("git_backup_schedule").crontab, "30 00 * * *");
assert.deepEqual(node("git_backup_schedule").wires, [["git_backup_request"]]);
assert.deepEqual(node("git_backup_manual").wires, [["git_backup_request"]]);
assert.equal(node("git_backup_request").command, "/opt/request-host-git-backup.sh");
assert.equal(node("git_backup_request").timer, "240");
assert.ok(!JSON.stringify(node("git_backup_request")).includes("docker.sock"));
assert.ok(!JSON.stringify(node("git_backup_request")).includes("/mnt/data/docker"));
assert.ok(!JSON.stringify(node("git_backup_request")).includes(".ssh"));
assert.ok(!JSON.stringify(node("git_backup_request")).includes("/data/.git-backup-trigger"));
assert.deepEqual(node("git_backup_result").wires, [
  ["git_backup_notify_primary"],
  ["git_backup_dry_run_terminal"],
]);
assert.match(node("git_backup_notify_primary").data, /"role":"mobile_primary"/);
assert.deepEqual(node("git_backup_test_success").wires, [["git_backup_test_result_out"]]);
assert.deepEqual(node("git_backup_test_failure").wires, [["git_backup_test_result_out"]]);
assert.deepEqual(node("git_backup_test_result_out").links, ["git_backup_test_result_in"]);
assert.deepEqual(node("git_backup_test_result_in").wires, [["git_backup_result"]]);
assert.ok(!JSON.stringify(node("git_backup_test_success")).includes("git_backup_request"));
assert.ok(!JSON.stringify(node("git_backup_test_failure")).includes("git_backup_request"));
assert.match(node("git_backup_dry_run_terminal").func, /external_call_sent: false/);
assert.match(node("git_backup_dry_run_terminal").func, /notification_sent: false/);

const values = new Map();
const flow = {
  get(key) { return values.get(key); },
  set(key, value) { values.set(key, value); },
};
const runResult = new Function("msg", "node", "flow", node("git_backup_result").func);
const testFailure = runResult(
  {
    _git_backup_test: true,
    payload: "git-backup status=failed request_id=test finished_at=synthetic",
  },
  { warn() {}, log() {}, status() {} },
  flow,
);
assert.equal(testFailure[0], null);
assert.equal(testFailure[1].payload.test_mode, true);
assert.equal(testFailure[1].payload.status, "failed");

const productionFailure = runResult(
  { payload: "git-backup status=failed request_id=prod finished_at=synthetic" },
  { warn() {}, log() {}, status() {} },
  flow,
);
assert.match(productionFailure[0].alert.title, /Falha no backup Git/);

const packageYaml = fs.readFileSync(path.resolve(here, "..", "..", "homeassistant", "packages", "weekly_documentation_review.yaml"), "utf8");
const dashboard = fs.readFileSync(path.resolve(here, "..", "..", "homeassistant", "dashboards", "raspberry_pi_health.yaml"), "utf8");
assert.match(packageYaml, /unique_id: weekly_documentation_review\b/);
assert.match(packageYaml, /unique_id: weekly_documentation_review_running\b/);
assert.match(dashboard, /entity: sensor\.revisao_semanal_da_documentacao\b/);
assert.match(dashboard, /entity: binary_sensor\.revisao_documental_em_execucao\b/);

console.log("Git backup flow and weekly documentation dashboard contracts are valid");
