import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Synthetic only: the exported public collector is patched in a temporary
// directory. No Home Assistant, service, policy or spool of the host is used.
const here = path.dirname(fileURLToPath(import.meta.url));
const exported = path.join(here, "runtime-source", "ha-notices");
const candidate = path.join(here, "private-notice-spool");
const sha = (value) => createHash("sha256").update(value).digest("hex");

function python(code, input) {
  const result = spawnSync("python3", ["-B", "-c", code], { cwd: candidate, input, encoding: "buffer" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr.toString() };
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), "private-spool-"));
test.after(() => fs.rmSync(work, { recursive: true, force: true }));
for (const name of fs.readdirSync(exported)) {
  if (name !== "notification_collector.cjs") fs.symlinkSync(path.join(exported, name), path.join(work, name));
}
const built = python(
  "import sys,derive;sys.stdout.buffer.write(derive.patch_collector(sys.stdin.buffer.read()))",
  fs.readFileSync(path.join(exported, "notification_collector.cjs")),
);
assert.equal(built.status, 0, built.stderr);
fs.writeFileSync(path.join(work, "notification_collector.cjs"), built.stdout);
const require = createRequire(path.join(work, "x.cjs"));
const { connect, readSpool, spoolFrames, SPOOL_PREFIX } = require("./notification_collector.cjs");
const { NotificationState } = require("./notification_state.cjs");

const UID = process.getuid();
const entry = (id, message = "corpo", title = "Revisão") =>
  JSON.stringify({ schema_version: 1, notification_id: id, title, message, created_at: "2026-01-01T00:00:00Z" });
function spoolDir() {
  const dir = fs.mkdtempSync(path.join(work, "spool-"));
  fs.chmodSync(dir, 0o750);
  return dir;
}
const put = (dir, id, body = entry(id)) => fs.writeFileSync(path.join(dir, `${id}.json`), body, { mode: 0o640 });

test("derivation moves only the collector pin and refuses a changed baseline", () => {
  const code = `
import json,sys,derive
before=open(sys.argv[1],'rb').read()
after=derive.patch_collector(before)
policy=json.dumps({'enabled':True,'revoked_at':None,'valid_until':None,'source_hashes':{'notification_collector.cjs':derive.sha(before),'other.py':'a'*64}},indent=1).encode()
new=derive.patch_policy(policy,before,after)
a,b=json.loads(policy),json.loads(new)
assert b['source_hashes'].pop('notification_collector.cjs')==derive.sha(after)
a['source_hashes'].pop('notification_collector.cjs'); assert a==b
for bad in (before+b' ', after):
    try: derive.patch_collector(bad); raise SystemExit('accepted changed baseline')
    except ValueError: pass
for bad in (policy.replace(b'true',b'false'), policy.replace(derive.sha(before).encode(), b'b'*64)):
    try: derive.patch_policy(bad,before,after); raise SystemExit('accepted wrong policy')
    except ValueError: pass
print(derive.sha(after))
`;
  const result = spawnSync("python3", ["-B", "-c", code, path.join(exported, "notification_collector.cjs")], { cwd: candidate, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.equal(result.stdout.trim(), sha(built.stdout));
});

test("spool reader accepts only closed producer-owned entries", () => {
  assert.equal(readSpool(path.join(work, "absent"), UID).size, 0);
  const dir = spoolDir();
  put(dir, "eva_private_review");
  fs.writeFileSync(path.join(dir, "notes.txt"), "ignored");
  fs.writeFileSync(path.join(dir, "git_backup_failure.json"), entry("git_backup_failure"));
  const found = readSpool(dir, UID);
  assert.deepEqual([...found.keys()], ["eva_private_review"]);
  assert.deepEqual(found.get("eva_private_review"), {
    notification_id: "eva_private_review", title: "Revisão", message: "corpo", created_at: "2026-01-01T00:00:00.000Z" });
  assert.throws(() => readSpool(dir, UID + 1), /unsafe_spool/);

  const refuse = (mutate, pattern) => {
    const bad = spoolDir();
    mutate(bad);
    assert.throws(() => readSpool(bad, UID), pattern);
  };
  refuse((d) => fs.chmodSync(d, 0o757), /unsafe_spool/);
  refuse((d) => { const target = path.join(work, "outside.json"); fs.writeFileSync(target, entry("eva_private_a")); fs.symlinkSync(target, path.join(d, "eva_private_a.json")); }, /ELOOP|unsafe_spool_entry/);
  refuse((d) => { put(d, "eva_private_a"); fs.linkSync(path.join(d, "eva_private_a.json"), path.join(d, "second-name")); }, /unsafe_spool_entry/);
  refuse((d) => put(d, "eva_private_a", entry("eva_private_a", "x".repeat(6001))), /invalid_spool_entry/);
  refuse((d) => put(d, "eva_private_a", entry("eva_private_b")), /invalid_spool_entry/);
  refuse((d) => put(d, "eva_private_a", JSON.stringify({ ...JSON.parse(entry("eva_private_a")), service: "notify.mobile" })), /invalid_spool_entry/);
  refuse((d) => put(d, "eva_private_a", "{"), /JSON|Unexpected|Expected/);
  refuse((d) => put(d, "eva_private_a", " ".repeat(16385)), /unsafe_spool_entry/);
  refuse((d) => { for (let i = 0; i < 17; i++) put(d, `eva_private_n${i}`); }, /spool_limit/);
});

test("spool difference is expressed as subscription frames", () => {
  const a = { notification_id: "eva_private_a", title: "t", message: "1", created_at: "x" };
  assert.deepEqual(spoolFrames(new Map(), new Map()), []);
  assert.deepEqual(spoolFrames(new Map(), new Map([["eva_private_a", a]])), [{ type: "updated", notifications: { eva_private_a: a } }]);
  assert.deepEqual(spoolFrames(new Map([["eva_private_a", a]]), new Map([["eva_private_a", { ...a }]])), []);
  assert.deepEqual(spoolFrames(new Map([["eva_private_a", a]]), new Map()),
    [{ type: "removed", notifications: { eva_private_a: { notification_id: "eva_private_a" } } }]);
});

class FakeSocket extends EventEmitter {
  constructor() { super(); this.sent = []; FakeSocket.last = this; }
  send(raw) { this.sent.push(JSON.parse(raw)); }
  ping() {}
  terminate() { this.terminated = true; }
}

function session(t, dir, { withSpool = true } = {}) {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const user = "fixture_reader";
  const state = new NotificationState();
  const captured = [];
  const statuses = [];
  let now = 1_800_000_000_000;
  const connection = connect({
    WebSocket: FakeSocket, token: "FIXTURE", expectedUserHash: sha(user), state, publish: () => {},
    clock: () => (now += 10),
    privateCapture: { reconnect() {}, failure() {}, collectionFailure() {}, observe: (event) => captured.push(event) },
    spool: withSpool ? { read: () => readSpool(dir, UID), status: (error, count) => statuses.push([error, count]) } : null,
  });
  const ws = FakeSocket.last;
  const message = (value) => ws.emit("message", JSON.stringify(value));
  message({ type: "auth_required" });
  message({ type: "auth_ok" });
  message({ type: "result", id: 1, success: true, result: { is_owner: false, is_admin: false, id: user } });
  t.after(() => connection.stop());
  return { state, captured, statuses, ws,
    frame: (type, notifications) => message({ type: "event", id: 2, event: { type, notifications } }),
    heartbeat: () => t.mock.timers.tick(5000) };
}
const ha = (id, message = "m") => ({ notification_id: id, title: "t", message, created_at: "2026-01-01T00:00:00+00:00" });
const phases = (state) => state.events.map((event) => `${event.phase}:${event.object_id.slice(0, 8)}`);
const short = (id) => sha(id).slice(0, 8);

test("spool notices join the baseline and later changes become ordinary events", (t) => {
  const dir = spoolDir();
  put(dir, "eva_private_review");
  const s = session(t, dir);
  s.frame("current", { backup_1: ha("backup_1") });
  assert.deepEqual([...s.state.current.keys()].sort(), [sha("backup_1"), sha("eva_private_review")].sort());
  assert.deepEqual(s.state.events, [], "the initial frame is a baseline, not a backlog");
  assert.equal(s.captured[0].type, "current");
  assert.ok(s.captured[0].notifications.eva_private_review, "private capture stores the spool text");

  s.heartbeat();
  assert.deepEqual(s.state.events, [], "an unchanged spool produces nothing");

  put(dir, "eva_private_escalation");
  s.heartbeat();
  assert.deepEqual(phases(s.state), [`added:${short("eva_private_escalation")}`]);
  const event = s.state.events[0];
  assert.equal(event.topic, "ha_notification");
  assert.equal(event.source, "ha_persistent_notification");

  put(dir, "eva_private_review", entry("eva_private_review", "novo corpo", "Revisão 2"));
  s.heartbeat();
  // Sanitized revisions ignore free text; only the private capture sees the new body.
  assert.equal(s.captured.at(-1).notifications.eva_private_review.message, "novo corpo");

  fs.rmSync(path.join(dir, "eva_private_escalation.json"));
  s.heartbeat();
  assert.equal(phases(s.state).at(-1), `removed:${short("eva_private_escalation")}`);
  assert.ok(!s.state.current.has(sha("eva_private_escalation")));
  assert.ok(s.state.current.has(sha("backup_1")), "HA notices are untouched by spool changes");
});

test("a full HA frame never withdraws spool notices and cannot forge the reserved prefix", (t) => {
  const dir = spoolDir();
  put(dir, "eva_private_review");
  const s = session(t, dir);
  s.frame("current", {});
  s.frame("current", { backup_1: ha("backup_1") });
  assert.deepEqual(phases(s.state), [`added:${short("backup_1")}`]);
  assert.ok(s.state.current.has(sha("eva_private_review")));

  s.frame("added", { [`${SPOOL_PREFIX}forged`]: ha(`${SPOOL_PREFIX}forged`) });
  s.frame("removed", { eva_private_review: { notification_id: "eva_private_review" } });
  s.frame("current", { [`${SPOOL_PREFIX}forged`]: ha(`${SPOOL_PREFIX}forged`), backup_1: ha("backup_1") });
  assert.ok(!s.state.current.has(sha(`${SPOOL_PREFIX}forged`)));
  assert.ok(s.state.current.has(sha("eva_private_review")));
  assert.deepEqual(phases(s.state), [`added:${short("backup_1")}`]);
});

test("an unreadable spool keeps delivered notices and reports the gap", (t) => {
  const dir = spoolDir();
  put(dir, "eva_private_review");
  const s = session(t, dir);
  s.frame("current", {});
  fs.chmodSync(dir, 0o757);
  s.heartbeat();
  s.frame("current", {});
  assert.ok(s.state.current.has(sha("eva_private_review")));
  assert.deepEqual(s.state.events, []);
  assert.deepEqual(s.statuses.at(-1), ["private_spool_unreadable", 1]);
  fs.chmodSync(dir, 0o750);
  fs.rmSync(path.join(dir, "eva_private_review.json"));
  s.heartbeat();
  assert.deepEqual(s.statuses.at(-1), [null, 0]);
  assert.deepEqual(phases(s.state), [`removed:${short("eva_private_review")}`]);
});

test("without a spool the collector behaves as before", (t) => {
  const s = session(t, null, { withSpool: false });
  s.frame("current", { [`${SPOOL_PREFIX}x`]: ha(`${SPOOL_PREFIX}x`) });
  s.frame("added", { backup_1: ha("backup_1") });
  s.heartbeat();
  assert.ok(s.state.current.has(sha(`${SPOOL_PREFIX}x`)));
  assert.deepEqual(phases(s.state), [`added:${short("backup_1")}`]);
});
