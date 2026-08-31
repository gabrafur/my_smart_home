#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const flows = JSON.parse(fs.readFileSync(path.join(repoRoot, "nodered", "flows.json"), "utf8"));
const byId = new Map(flows.map((item) => [item.id, item]));
const node = (id) => {
  const found = byId.get(id);
  assert.ok(found, `missing node ${id}`);
  return found;
};

assert.equal(node("weekly_docs_review_tab").label, "revisao_documental_semanal");
assert.equal(node("weekly_docs_review_schedule").crontab, "00 03 * * 1");
assert.deepEqual(node("weekly_docs_review_schedule").wires, [["weekly_docs_review_schedule_out"]]);
assert.deepEqual(node("weekly_docs_review_schedule_out").links, ["weekly_docs_review_schedule_in"]);
assert.deepEqual(node("weekly_docs_review_schedule_in").links, ["weekly_docs_review_schedule_out"]);
assert.deepEqual(node("weekly_docs_review_manual").entities.entity, ["input_button.weekly_documentation_review_run"]);
assert.equal(node("weekly_docs_review_request").command, "/opt/request-weekly-docs-review.sh");
assert.equal(node("weekly_docs_review_request").addpay, "payload");
assert.equal(node("weekly_docs_review_request").timer, "15");
assert.ok(!JSON.stringify(node("weekly_docs_review_request")).includes("docker.sock"));
assert.ok(!JSON.stringify(node("weekly_docs_review_request")).includes("/mnt/data/docker"));
assert.ok(!JSON.stringify(node("weekly_docs_review_request")).includes(".ssh"));
assert.deepEqual(node("weekly_docs_review_test_request_out").links, ["weekly_docs_review_test_request_in"]);
assert.deepEqual(node("weekly_docs_review_test_request_in").links, ["weekly_docs_review_test_request_out"]);
assert.deepEqual(node("weekly_docs_review_dry_run_out").links, ["weekly_docs_review_dry_run_in"]);
assert.deepEqual(node("weekly_docs_review_dry_run_in").links, ["weekly_docs_review_dry_run_out", "weekly_docs_review_error_dry_run_out"]);
assert.ok(!JSON.stringify(node("weekly_docs_review_test_scheduled")).includes("weekly_docs_review_request"));
assert.ok(!JSON.stringify(node("weekly_docs_review_test_manual")).includes("weekly_docs_review_request"));
assert.match(node("weekly_docs_review_dry_run_terminal").func, /external_call_sent: false/);
assert.match(node("weekly_docs_review_dry_run_terminal").func, /worker_started: false/);

const memory = new Map();
const flow = {
  get(key) { return memory.get(key); },
  set(key, value) { memory.set(key, value); },
};
const runtimeNode = { error() {}, log() {}, status() {}, warn() {} };
const prepare = new Function("msg", "node", "flow", node("weekly_docs_review_prepare").func);
const scheduled = prepare({ _weekly_docs_source: "scheduled" }, runtimeNode, flow);
assert.equal(scheduled[0].payload, "scheduled");
assert.equal(scheduled[1], null);
const manualTest = prepare({ _weekly_docs_source: "manual", _weekly_docs_test: true }, runtimeNode, flow);
assert.equal(manualTest[0], null);
assert.equal(manualTest[1].payload, "manual");
assert.equal(manualTest[1]._weekly_docs_test, true);
assert.equal(prepare({ _weekly_docs_source: "invalid" }, runtimeNode, flow), null);

const handleError = new Function("msg", "node", "flow", node("weekly_docs_review_error").func);
const simulatedFailure = handleError(
  { payload: "synthetic bridge unavailable", _weekly_docs_test: true, _weekly_docs_source: "manual" },
  runtimeNode,
  flow,
);
assert.equal(simulatedFailure.payload.status, "failed");
const dryRun = new Function("msg", "node", "flow", node("weekly_docs_review_dry_run_terminal").func);
assert.equal(dryRun(simulatedFailure, runtimeNode, flow), null);
assert.deepEqual(memory.get("weekly_docs_review_last_dry_run_v1"), {
  version: 1,
  simulated: true,
  dispatched: false,
  external_call_sent: false,
  worker_started: false,
  source: "manual",
  status: "failed",
  completed_at: memory.get("weekly_docs_review_last_dry_run_v1").completed_at,
});

const compose = fs.readFileSync(path.join(repoRoot, "docker-compose.yml"), "utf8");
assert.match(compose, /\.\/\.local-state\/docs-review-trigger:\/run\/docs-review-trigger/);
assert.match(compose, /\.\/scripts\/request-weekly-docs-review\.sh:\/opt\/request-weekly-docs-review\.sh:ro/);
assert.match(compose, /WEEKLY_DOCS_REVIEW_SCHEDULE_OWNER=node-red/);
const packageYaml = fs.readFileSync(path.join(repoRoot, "homeassistant", "packages", "weekly_documentation_review.yaml"), "utf8");
assert.match(packageYaml, /weekly_documentation_review_run:/);
assert.doesNotMatch(packageYaml, /solicitar_revisao_documental_manual/);
const dashboard = fs.readFileSync(path.join(repoRoot, "homeassistant", "dashboards", "raspberry_pi_health.yaml"), "utf8");
assert.match(dashboard, /perform_action: input_button\.press/);
assert.match(dashboard, /entity_id: input_button\.weekly_documentation_review_run/);
const dockerfile = fs.readFileSync(path.join(repoRoot, "ia-bridge", "Dockerfile"), "utf8");
assert.match(dockerfile, /docker-ce-cli docker-compose-plugin git make openssh-client python3/);
const entrypoint = fs.readFileSync(path.join(repoRoot, "scripts", "weekly-docs-review-entrypoint.sh"), "utf8");
assert.match(entrypoint, /install -d -m 2770[^\n]*"\$trigger_dir"/);

const triggerFixture = fs.mkdtempSync(path.join(os.tmpdir(), "weekly-docs-trigger-test-"));
const requestScript = path.join(repoRoot, "scripts", "request-weekly-docs-review.sh");
const env = { ...process.env, WEEKLY_DOCS_REVIEW_TRIGGER_DIR: triggerFixture };
const firstRequest = spawnSync(requestScript, ["scheduled"], { encoding: "utf8", env });
assert.equal(firstRequest.status, 0, firstRequest.stderr);
assert.match(firstRequest.stdout, /requested: source=scheduled/);
assert.equal(fs.readFileSync(path.join(triggerFixture, "manual-trigger"), "utf8"), "scheduled\n");
assert.equal(fs.statSync(path.join(triggerFixture, "manual-trigger")).mode & 0o777, 0o660);
const coalescedRequest = spawnSync(requestScript, ["manual"], { encoding: "utf8", env });
assert.equal(coalescedRequest.status, 0, coalescedRequest.stderr);
assert.match(coalescedRequest.stdout, /already pending: source=manual/);
assert.equal(fs.readFileSync(path.join(triggerFixture, "manual-trigger"), "utf8"), "scheduled\n");
const invalidRequest = spawnSync(requestScript, ["invalid"], { encoding: "utf8", env });
assert.equal(invalidRequest.status, 64);
fs.rmSync(triggerFixture, { recursive: true, force: true });

console.log("Weekly documentation review Node-RED flow contracts are valid");
