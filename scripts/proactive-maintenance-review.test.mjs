import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_POLICY_PATH, SOURCES, collectEvidence, createContext, emptyLedger, evaluate, loadPolicy,
  notificationDigest, openRecommendations, readLedger, reconcile, redact, renderNotification,
  rollbackAction, runReview, updateRecommendation, validatePolicy,
} from "./proactive-maintenance-review.mjs";

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "proactive-maintenance-review.mjs");
const policy = () => structuredClone(loadPolicy(DEFAULT_POLICY_PATH));
const HOUR = 3600000;
const NOW = Date.parse("2026-01-10T12:00:00Z");

const source = (id, data, error = null) => ({ id, origin: "fixture", observed_at: new Date(NOW).toISOString(), age_seconds: 0,
  revision: data ? "r".repeat(16) : null, collection_error: error, data });

const healthy = () => [
  source("host.resources", { disk_used_percent: 40, memory_available_kb: 4e6 }),
  source("host.failed_units", { failed_count: 0, families: {} }),
  source("containers.state", { total: 1, containers: [{ name: "core", state: "running", unhealthy: false, restarting: false, exit_code: null }] }),
  source("backup.git_result", { status: "success", reason: null, request_id: "x", finished_at: null, age_hours: 2 }),
  source("backup.git_history", { failures_7d: 0, reasons: {} }),
  source("updates.workers", { workers: { core: { age_hours: 3, last_run_failed: false } } }),
  source("repo.state", { ahead_of_origin_main: 0, modified: 0, untracked: 0, oldest_change_hours: null, sample_paths: [] }),
  source("logs.sizes", { total_bytes: 10, largest: [] }),
  source("executor.peer_binding", { boot_matches: true, peer_process_alive: true, cgroup_matches: true, socket_matches: true }),
  source("workers.stale_markers", { markers: [] }),
];

const replace = (evidence, id, data, error = null) => evidence.map((item) => (item.id === id ? source(id, data, error) : item));

function fixtureRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "proactive-review-"));
  fs.mkdirSync(path.join(root, "state"));
  return { root, stateDir: path.join(root, "state"), cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("versioned policy is valid and rejects unsafe rotation paths", () => {
  const value = policy();
  assert.equal(value.enabled, true);
  for (const bad of ["/etc/passwd", "../outside.cron.log", ".git-backup.log", "nested/.a.cron.log"]) {
    const changed = structuredClone(value);
    changed.auto_actions.catalog.rotate_worker_log.paths = [bad];
    assert.throws(() => validatePolicy(changed), /invalid_policy/);
  }
  assert.ok(!value.auto_actions.catalog.rotate_worker_log.paths.some((item) => /backup|update/.test(item)),
    "evidence logs of backup and update workers stay outside automatic rotation");
});

test("redaction removes credentials, addresses and opaque material", () => {
  const address = [203, 0, 113, 7].join(".");
  // Assembled at runtime so the fixture itself is not a credential-shaped literal.
  const credentialUrl = ["https://user", "pw@host/x"].join(":");
  const text = redact(`api_token=abc123456 Bearer abcdefghijkl user@example.org ${address} ` +
    `url ${credentialUrl} ${"A".repeat(60)}`);
  for (const leaked of ["abc123456", "abcdefghijkl", "user@example.org", address, "user:pw", "A".repeat(60)]) {
    assert.ok(!text.includes(leaked), leaked);
  }
});

test("every registered source has a unique id and a declared origin", () => {
  assert.equal(new Set(SOURCES.map((item) => item.id)).size, SOURCES.length);
  for (const item of SOURCES) assert.ok(item.origin.length > 5 && typeof item.collect === "function");
});

test("collection errors are explicit and never look like healthy data", () => {
  const value = policy();
  const ctx = createContext({ policy: value, repoRoot: "/nonexistent-review-root", now: NOW,
    run: () => ({ status: 1, stdout: "" }), procRoot: "/nonexistent-proc" });
  const evidence = collectEvidence(ctx);
  assert.equal(evidence.length, SOURCES.length);
  for (const item of evidence) {
    assert.ok(item.collection_error, item.id);
    assert.equal(item.data, null);
    assert.equal(item.revision, null);
  }
  const findings = evaluate(evidence, value);
  assert.deepEqual(findings.map((f) => f.key), ["review.collection_gaps"]);
});

test("healthy evidence produces no recommendation", () => {
  assert.deepEqual(evaluate(healthy(), policy()), []);
});

test("each finding carries benefit, priority, risk, action and evidence identity", () => {
  let evidence = replace(healthy(), "backup.git_result", { status: "failed", reason: "security_scan_failed", request_id: "r", finished_at: "x", age_hours: 1 });
  evidence = replace(evidence, "host.resources", { disk_used_percent: 91, memory_available_kb: 100 });
  evidence = replace(evidence, "executor.peer_binding", { boot_matches: false, peer_process_alive: false, cgroup_matches: null, socket_matches: null });
  evidence = replace(evidence, "logs.sizes", { total_bytes: 1, largest: [
    { name: ".vpn-health-publisher.cron.log", bytes: 9e6, regular: true }, { name: ".git-backup.log", bytes: 9e6, regular: true }] });
  const findings = evaluate(evidence, policy());
  assert.deepEqual(findings.map((f) => f.key).sort(), ["backup.git_last_failed", "executor.peer_binding_stale", "host.disk_pressure",
    "host.memory_pressure", "logs.oversized:.git-backup.log", "logs.oversized:.vpn-health-publisher.cron.log"]);
  for (const finding of findings) {
    assert.match(finding.id, /^rec-[a-f0-9]{12}$/);
    assert.ok(["P1", "P2", "P3"].includes(finding.priority));
    assert.ok(finding.benefit && finding.proposed_action && finding.risk);
    assert.ok(finding.evidence.length > 0 && finding.evidence.every((item) => item.revision));
  }
  const byKey = Object.fromEntries(findings.map((f) => [f.key, f]));
  assert.deepEqual(byKey["logs.oversized:.vpn-health-publisher.cron.log"].auto_action, { id: "rotate_worker_log", params: { path: ".vpn-health-publisher.cron.log" } });
  assert.equal(byKey["logs.oversized:.git-backup.log"].auto_action, null, "backup evidence log is recommendation-only");
});

test("a one-shot container that exited cleanly is not degraded", () => {
  const evidence = replace(healthy(), "containers.state", { total: 2, containers: [
    { name: "helper", state: "exited", unhealthy: false, restarting: false, exit_code: 0 },
    { name: "worker", state: "exited", unhealthy: false, restarting: false, exit_code: 1 }] });
  const [finding] = evaluate(evidence, policy());
  assert.equal(finding.key, "containers.degraded");
  assert.match(finding.title, /worker/);
  assert.doesNotMatch(finding.title, /helper/);
});

test("ledger deduplicates, reminds, aggravates and resolves", () => {
  const value = policy();
  const ledger = emptyLedger();
  const warn = replace(healthy(), "host.resources", { disk_used_percent: 82, memory_available_kb: 4e6 });
  const high = replace(healthy(), "host.resources", { disk_used_percent: 88, memory_available_kb: 4e6 });
  assert.deepEqual(reconcile(ledger, evaluate(warn, value), warn, value, NOW).map((a) => a.reason), ["new"]);
  assert.deepEqual(reconcile(ledger, evaluate(warn, value), warn, value, NOW + HOUR), [], "repeat is silent");
  const [record] = Object.values(ledger.recommendations);
  assert.equal(record.occurrences, 2);
  assert.deepEqual(reconcile(ledger, evaluate(high, value), high, value, NOW + 2 * HOUR).map((a) => a.reason), ["aggravated"]);
  assert.equal(record.priority, "P1");
  const later = NOW + 2 * HOUR + value.dedupe.remind_after_hours * HOUR;
  assert.deepEqual(reconcile(ledger, evaluate(high, value), high, value, later).map((a) => a.reason), ["reminder"]);
  assert.deepEqual(reconcile(ledger, [], healthy(), value, later + HOUR).map((a) => a.reason), ["resolved"]);
  assert.equal(record.status, "resolved");
  assert.deepEqual(reconcile(ledger, evaluate(warn, value), warn, value, later + 2 * HOUR).map((a) => a.reason), ["reopened"]);
  assert.deepEqual(ledger.events.map((event) => event.type), ["opened", "aggravated", "reminded", "resolved", "reopened"]);
});

test("a finding hidden by a failed source stays open instead of resolving", () => {
  const value = policy();
  const ledger = emptyLedger();
  const failing = replace(healthy(), "backup.git_result", { status: "failed", reason: "x", age_hours: 1 });
  reconcile(ledger, evaluate(failing, value), failing, value, NOW);
  const blind = replace(healthy(), "backup.git_result", null, "EACCES");
  const announcements = reconcile(ledger, evaluate(blind, value), blind, value, NOW + HOUR);
  const backup = Object.values(ledger.recommendations).find((r) => r.key === "backup.git_last_failed");
  assert.equal(backup.status, "open");
  assert.ok(!announcements.some((a) => a.id === backup.id && a.reason === "resolved"));
});

test("dismissed recommendation stays quiet until it expires or worsens", () => {
  const value = policy();
  const ledger = emptyLedger();
  const warn = replace(healthy(), "host.resources", { disk_used_percent: 82, memory_available_kb: 4e6 });
  reconcile(ledger, evaluate(warn, value), warn, value, NOW);
  const [record] = Object.values(ledger.recommendations);
  record.status = "dismissed";
  record.dismissed_until = new Date(NOW + 10 * HOUR).toISOString();
  assert.deepEqual(reconcile(ledger, evaluate(warn, value), warn, value, NOW + HOUR), []);
  assert.equal(record.status, "dismissed");
  assert.equal(openRecommendations(ledger).length, 0);
  const high = replace(healthy(), "host.resources", { disk_used_percent: 90, memory_available_kb: 4e6 });
  assert.deepEqual(reconcile(ledger, evaluate(high, value), high, value, NOW + 2 * HOUR).map((a) => a.reason), ["aggravated"]);
  assert.equal(record.status, "open");
});

test("notification is bounded, redacted and changes only with the open set", () => {
  const value = policy();
  const ledger = emptyLedger();
  const evidence = replace(healthy(), "backup.git_result", { status: "failed", reason: "token=supersecretvalue", age_hours: 1 });
  reconcile(ledger, evaluate(evidence, value), evidence, value, NOW);
  const before = notificationDigest(ledger);
  const rendered = renderNotification(ledger, value, NOW);
  assert.match(rendered.title, /1 recomendação/);
  assert.match(rendered.message, /Benefício:.*\n.*Risco da ação/);
  assert.ok(!rendered.message.includes("supersecretvalue"));
  reconcile(ledger, evaluate(evidence, value), evidence, value, NOW + HOUR);
  assert.equal(notificationDigest(ledger), before);
});

// The remaining tests drive the full run through injected evidence.
import * as review from "./proactive-maintenance-review.mjs";

function patchedRun(fixture, evidence, now, options = {}) {
  const value = options.policy ?? policy();
  const ctx = createContext({ policy: value, repoRoot: fixture.root, now });
  const sources = evidence.map((item) => ({ id: item.id, origin: item.origin, collect: () => {
    if (item.collection_error) throw new Error(item.collection_error);
    return item.data;
  } }));
  return review.runReview({ policy: value, stateDir: fixture.stateDir, now, ctx: { ...ctx, sources }, ...options });
}

test("run persists the ledger, publishes once and retries a failed publication", async () => {
  const fixture = fixtureRepo();
  try {
    const sent = [];
    let fail = true;
    const send = async (servicePath, body) => { if (fail) throw new Error("home_assistant_api_503"); sent.push({ servicePath, body }); };
    const failing = replace(healthy(), "backup.git_result", { status: "failed", reason: "validation_failed", age_hours: 1 });
    const first = await patchedRun(fixture, failing, NOW, { send });
    assert.equal(first.publication.state, "publication_failed");
    assert.equal(readLedger(fixture.stateDir).notification.pending, true);
    fail = false;
    const second = await patchedRun(fixture, failing, NOW + HOUR, { send });
    assert.equal(second.publication.state, "published");
    assert.equal(second.announcements.length, 0, "no duplicate announcement");
    const third = await patchedRun(fixture, failing, NOW + 2 * HOUR, { send });
    assert.equal(third.publication.state, "unchanged");
    assert.equal(sent.length, 1);
    assert.equal(sent[0].servicePath, "/api/services/persistent_notification/create");
    assert.equal(sent[0].body.notification_id, "proactive_maintenance_review");
    const fourth = await patchedRun(fixture, healthy(), NOW + 3 * HOUR, { send });
    assert.deepEqual(fourth.announcements.map((a) => a.reason), ["resolved"]);
    assert.equal(sent.at(-1).servicePath, "/api/services/persistent_notification/dismiss");
    const ledger = readLedger(fixture.stateDir);
    assert.equal(ledger.revision, 4);
    assert.equal(ledger.runs.length, 4);
    assert.equal(fs.statSync(path.join(fixture.stateDir, "ledger.json")).mode & 0o777, 0o600);
    assert.ok(!fs.existsSync(path.join(fixture.stateDir, "lock")), "lock released after async run");
  } finally { fixture.cleanup(); }
});

test("revocation marker and disabled policy stop the review without effects", async () => {
  const fixture = fixtureRepo();
  try {
    fs.writeFileSync(path.join(fixture.stateDir, "disabled"), "");
    assert.deepEqual(await patchedRun(fixture, healthy(), NOW), { state: "disabled", reason: "revocation_marker_present" });
    fs.unlinkSync(path.join(fixture.stateDir, "disabled"));
    const off = policy();
    off.enabled = false;
    assert.equal((await patchedRun(fixture, healthy(), NOW, { policy: off })).reason, "policy_disabled");
    assert.ok(!fs.existsSync(path.join(fixture.stateDir, "ledger.json")));
  } finally { fixture.cleanup(); }
});

test("a live lock owner makes a concurrent run report busy and a dead owner is reclaimed", async () => {
  const fixture = fixtureRepo();
  try {
    fs.writeFileSync(path.join(fixture.stateDir, "lock"), String(process.pid));
    await assert.rejects(async () => patchedRun(fixture, healthy(), NOW, { publishNotification: false }), /review_busy/);
    const dead = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }).stdout;
    fs.writeFileSync(path.join(fixture.stateDir, "lock"), dead);
    assert.equal((await patchedRun(fixture, healthy(), NOW, { publishNotification: false })).state, "completed");
  } finally { fixture.cleanup(); }
});

test("acknowledgement links a task, is CAS protected and survives the next run", async () => {
  const fixture = fixtureRepo();
  try {
    const failing = replace(healthy(), "backup.git_result", { status: "failed", reason: "validation_failed", age_hours: 1 });
    const first = await patchedRun(fixture, failing, NOW, { publishNotification: false });
    const id = first.open[0].id;
    assert.throws(() => updateRecommendation({ stateDir: fixture.stateDir, policy: policy(), id, status: "acknowledged", expectedRevision: 99 }), /ledger_revision_changed/);
    assert.throws(() => updateRecommendation({ stateDir: fixture.stateDir, policy: policy(), id, status: "acknowledged", taskRef: "bad ref!" }), /task_ref_invalid/);
    const ack = updateRecommendation({ stateDir: fixture.stateDir, policy: policy(), id, status: "acknowledged", taskRef: "task-0123abcd", expectedRevision: 1, now: NOW });
    assert.equal(ack.ledger_revision, 2);
    const second = await patchedRun(fixture, failing, NOW + HOUR, { publishNotification: false });
    assert.deepEqual(second.open.map((r) => [r.status]), [["acknowledged"]]);
    assert.equal(readLedger(fixture.stateDir).recommendations[id].task_ref, "task-0123abcd");
    assert.equal(second.announcements.length, 0);
  } finally { fixture.cleanup(); }
});

test("catalogued log rotation applies within limits, verifies and rolls back", async () => {
  const fixture = fixtureRepo();
  try {
    const value = policy();
    const rotate = value.auto_actions.catalog.rotate_worker_log;
    Object.assign(rotate, { min_bytes: 4096, keep_bytes: 1024, max_per_run: 1 });
    value.thresholds.log_warn_bytes = 4096;
    const names = [".vpn-health-publisher.cron.log", ".codex-remote-health.cron.log"];
    const original = Array.from({ length: 400 }, (_, index) => `line ${index} ${"x".repeat(20)}`).join("\n") + "\n";
    for (const name of names) fs.writeFileSync(path.join(fixture.root, name), original);
    const evidence = () => replace(healthy(), "logs.sizes", { total_bytes: 1, largest: names.map((name) =>
      ({ name, bytes: fs.statSync(path.join(fixture.root, name)).size, regular: true })) });
    const first = await patchedRun(fixture, evidence(), NOW, { policy: value, publishNotification: false });
    assert.deepEqual(first.actions.map((a) => a.state), ["applied_verified", "refused"]);
    assert.equal(first.actions[1].reason, "run_limit");
    const rotated = fs.readFileSync(path.join(fixture.root, names[0]), "utf8");
    assert.ok(rotated.length <= 1024 && original.endsWith(rotated) && rotated.startsWith("line "));
    assert.equal(fs.readFileSync(path.join(fixture.root, names[1]), "utf8"), original);
    fs.appendFileSync(path.join(fixture.root, names[0]), "new line after rotation\n");
    const undone = rollbackAction({ stateDir: fixture.stateDir, policy: value, actionId: first.actions[0].action_id,
      ctx: createContext({ policy: value, repoRoot: fixture.root, now: NOW }) });
    assert.equal(undone.state, "rolled_back");
    assert.equal(fs.readFileSync(path.join(fixture.root, names[0]), "utf8"), `${original}new line after rotation\n`);
    assert.throws(() => rollbackAction({ stateDir: fixture.stateDir, policy: value, actionId: first.actions[0].action_id }), /action_not_reversible/);
  } finally { fixture.cleanup(); }
});

test("rotation refuses symlinks, unknown disk state and paths outside the catalog", async () => {
  const fixture = fixtureRepo();
  try {
    const value = policy();
    Object.assign(value.auto_actions.catalog.rotate_worker_log, { min_bytes: 16, keep_bytes: 8 });
    value.thresholds.log_warn_bytes = 16;
    const name = ".vpn-health-publisher.cron.log";
    fs.writeFileSync(path.join(fixture.root, "real.log"), "x".repeat(64));
    fs.symlinkSync(path.join(fixture.root, "real.log"), path.join(fixture.root, name));
    const logs = { total_bytes: 1, largest: [{ name, bytes: 64, regular: true }] };
    const linked = await patchedRun(fixture, replace(healthy(), "logs.sizes", logs), NOW, { policy: value, publishNotification: false });
    assert.deepEqual(linked.actions.map((a) => [a.state, a.reason]), [["refused", "not_a_plain_file"]]);
    const blind = replace(replace(healthy(), "logs.sizes", logs), "host.resources", null, "EIO");
    const unknown = await patchedRun(fixture, blind, NOW + HOUR, { policy: value, publishNotification: false });
    assert.deepEqual(unknown.actions.map((a) => a.reason), ["disk_state_unknown"]);
    assert.equal(fs.readFileSync(path.join(fixture.root, "real.log"), "utf8"), "x".repeat(64));
  } finally { fixture.cleanup(); }
});

test("CLI lists sources and reports an unknown source as an error", () => {
  const listed = spawnSync(process.execPath, [script, "sources", "--json"], { encoding: "utf8" });
  assert.equal(listed.status, 0);
  assert.equal(JSON.parse(listed.stdout).length, SOURCES.length);
  const unknown = spawnSync(process.execPath, [script, "evidence", "not.registered"], { encoding: "utf8" });
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /source_not_registered/);
});
