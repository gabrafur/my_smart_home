import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const normalize = fs.readFileSync(new URL("functions/git-backup-result-normalize.js", import.meta.url), "utf8");
const project = fs.readFileSync(new URL("functions/git-backup-health-project.js", import.meta.url), "utf8");
const values = new Map();
const flow = {
  get: (key, store) => values.get(`${store ?? "default"}:${key}`),
  set: (key, value, store) => values.set(`${store ?? "default"}:${key}`, JSON.parse(JSON.stringify(value))),
};
const run = (body, msg) => vm.runInNewContext(`(function(){${body}\n})()`, { msg, flow, node: { status() {} }, Date, JSON, String });
const cycle = (status, topic, day = "24", extra = {}) => run(normalize, {
  topic, payload: `git-backup status=${status} reason=completed request_id=202610${day}T040000Z-123 finished_at=2026-10-${day}T04:00:05Z`, ...extra,
});
const snapshot = () => JSON.parse(run(project, {}).payload);

cycle("failed", "scheduled");
cycle("success", "scheduled", "25");
assert.equal(snapshot().last_scheduled_cycle.status, "success");
assert.equal(snapshot().failure_history[0].status, "failed");
cycle("success", "manual", "25");
assert.equal(snapshot().last_result.origin, "manual");
assert.equal(snapshot().last_scheduled_cycle.origin, "scheduled");
cycle("failed", "scheduled", "26");
assert.equal(snapshot().last_scheduled_cycle.status, "failed");
assert.equal(snapshot().failure_history.length, 2);
cycle("failed", "scheduled", "26");
assert.equal(snapshot().failure_history.length, 2, "same result is deduplicated");
cycle("success", "unexpected", "27");
assert.equal(snapshot().last_result.origin, "unknown");
assert.equal(snapshot().last_scheduled_cycle.request_id, "20261026T040000Z-123");

const before = JSON.stringify([...values].filter(([key]) => key.startsWith("persistent:")));
cycle("success", "scheduled", "28", { _git_backup_test: true });
assert.equal(run(project, { _git_backup_test: true }), null);
assert.equal(JSON.stringify([...values].filter(([key]) => key.startsWith("persistent:"))), before);
assert.equal(run(normalize, { payload: "" }), null);
run(normalize, { topic: "scheduled", payload: "status=success finished_at=not-a-date" });
assert.equal(snapshot().last_scheduled_cycle.request_id, "20261026T040000Z-123", "missing request ID cannot replace scheduled metadata");
assert.equal(snapshot().last_result.request_id, null);
flow.set("git_backup_failure_history_v1", [{ status: "failed", reason: "completed", extra_field: "PRIVATE-SYNTHETIC" }, null], "persistent");
cycle("success", "manual");
assert.ok(!JSON.stringify(snapshot()).includes("PRIVATE-SYNTHETIC"));
for (let day = 1; day <= 20; day++) cycle("failed", "manual", String(day).padStart(2, "0"));
assert.equal(snapshot().failure_history.length, 16);
assert.equal(snapshot().offsite_success_inferred, false);
assert.equal(snapshot().restoration_inferred, false);
console.log("Git backup provenance: scheduled/manual separation, retained failures, dedupe, bounds, sanitization and dry-run isolation passed.");
