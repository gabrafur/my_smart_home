import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { stopReview, completeReview } from "./memory-review.mjs";
import { applyCandidate } from "./memory-candidate.mjs";
import { fixture, target, source } from "./test-support/memory-fixture.mjs";

const event = { hook_event_name: "Stop", session_id: "synthetic-session", turn_id: "synthetic-turn", stop_hook_active: false };
const tokenOf = (result) => result.reason.match(/[a-f0-9]{64}:[a-f0-9]{64}/)[0];

test("review and candidate discover tracked files through Git without an injected manifest", (t) => {
  const f = fixture(t);
  const git = (args, input) => execFileSync("git", args, {
    cwd: f.root, encoding: "utf8", input, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
  git(["init", "--quiet"]);
  const emptyBlob = git(["hash-object", "-w", "--stdin"], "").trim();
  git(["update-index", "--index-info"], f.trackedFiles.map((file) => `100644 ${emptyBlob}\t${file}\n`).join(""));
  const result = stopReview(f.root, event);
  applyCandidate(f.root, f.candidate(), { apply: true });
  assert.equal(completeReview(f.root, tokenOf(result), "updated").status, "reviewed");
  assert.deepEqual(stopReview(f.root, event), {});
});

test("missing checkpoint continues task; persisted useful memory permits completion", (t) => {
  const f = fixture(t);
  const result = stopReview(f.root, event, f);
  assert.equal(result.decision, "block");
  assert.throws(() => completeReview(f.root, tokenOf(result), "updated", f), /persisted memory change/);
  applyCandidate(f.root, f.candidate(), { ...f, apply: true });
  assert.equal(completeReview(f.root, tokenOf(result), "updated", f).status, "reviewed");
  assert.deepEqual(stopReview(f.root, { ...event, turn_id: "continuation", stop_hook_active: true }, f), {});
});

test("ordinary conversations can record no durable discovery without creating a note", (t) => {
  const f = fixture(t);
  const before = f.read();
  const result = stopReview(f.root, event, f);
  completeReview(f.root, tokenOf(result), "no_durable_discovery", f);
  assert.equal(f.read(), before);
  assert.deepEqual(stopReview(f.root, event, f), {});
  assert.equal(stopReview(f.root, { ...event, turn_id: "new-user-turn" }, f).decision, "block");
});

test("checkpoint does not ingest prompts, assistant messages, transcripts or identities", (t) => {
  const f = fixture(t);
  stopReview(f.root, { ...event, prompt: "PRIVATE_PROMPT", last_assistant_message: "PRIVATE_ANSWER", transcript_path: "/not-readable/private-log", extra: "PRIVATE_EXTRA" }, f);
  const directory = path.join(f.root, ".local-state/memory-review");
  const content = fs.readdirSync(directory).map((file) => fs.readFileSync(path.join(directory, file), "utf8")).join("");
  assert.doesNotMatch(content, /PRIVATE_|synthetic-session|synthetic-turn|transcript|prompt|private-log/);
  assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
});

test("two failed continuations produce explicit failure instead of an infinite loop", (t) => {
  const f = fixture(t);
  assert.equal(stopReview(f.root, event, f).decision, "block");
  const next = { ...event, stop_hook_active: true, turn_id: "continuation" };
  assert.equal(stopReview(f.root, next, f).decision, "block");
  const failed = stopReview(f.root, next, f);
  assert.equal(failed.continue, false);
  assert.match(failed.systemMessage, /MEMORY_REVIEW_FAILED/);
});

test("stale receipt and changes after review cannot authorize completion", (t) => {
  const f = fixture(t);
  const result = stopReview(f.root, event, f);
  completeReview(f.root, tokenOf(result), "already_current", f);
  fs.appendFileSync(path.join(f.root, target), "\nConcurrent public note.\n");
  assert.equal(stopReview(f.root, event, f).decision, "block");
  stopReview(f.root, { ...event, turn_id: "new-user-turn" }, f);
  assert.throws(() => completeReview(f.root, tokenOf(result), "already_current", f), /stale/);
});

test("evidence drift and unverified outcome never report a clean review", (t) => {
  const f = fixture(t);
  applyCandidate(f.root, f.candidate(), { ...f, apply: true });
  const result = stopReview(f.root, event, f);
  fs.appendFileSync(path.join(f.root, source), "// changed\n");
  assert.throws(() => completeReview(f.root, tokenOf(result), "already_current", f), /validation failed/);
  fs.writeFileSync(path.join(f.root, source), 'export const adapter = "blue";\n');
  completeReview(f.root, tokenOf(result), "unverified", f);
  assert.equal(stopReview(f.root, event, f).continue, false);
});

test("missing hook identity fails explicitly and unrelated events do nothing", (t) => {
  const f = fixture(t);
  assert.equal(stopReview(f.root, { hook_event_name: "Stop" }, f).continue, false);
  assert.deepEqual(stopReview(f.root, { hook_event_name: "PostToolUse" }, f), {});
});

test("versioned Stop hook uses canonical checkpoint with bounded timeout", () => {
  const hooks = JSON.parse(fs.readFileSync(new URL("../.codex/hooks.json", import.meta.url)));
  assert.equal(hooks.hooks.Stop.length, 1);
  assert.match(hooks.hooks.Stop[0].hooks[0].command, /scripts\/memory-review\.mjs.*hook/);
  assert.ok(hooks.hooks.Stop[0].hooks[0].timeout <= 15);
  assert.equal(hooks.hooks.PostToolUse.length, 1);
});
