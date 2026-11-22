import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { isGitHubMergeResult, parentCount, validateCommitSubject } from "./commit-message-check.mjs";

test("accepts the repository commit subject convention", () => {
  for (const subject of [
    "fix: make Codex card loading deterministic",
    "feat(nodered): add vehicle door lock action",
    "refactor!: replace the public bindings contract",
  ]) {
    assert.deepEqual(validateCommitSubject(subject), []);
  }
});

test("rejects legacy, uppercase, punctuated, and oversized subjects", () => {
  assert.notDeepEqual(validateCommitSubject("Corrigir iluminação externa"), []);
  assert.notDeepEqual(validateCommitSubject("fix: corrigir mensagens manuais"), []);
  assert.notDeepEqual(validateCommitSubject("fix: Make Codex card deterministic"), []);
  assert.notDeepEqual(validateCommitSubject("fix: make Codex card deterministic."), []);
  assert.notDeepEqual(validateCommitSubject(`fix: ${"a".repeat(70)}`), []);
});

test("recognizes only the GitHub pull request merge result subject", () => {
  assert.equal(
    isGitHubMergeResult("Merge ca3f1872607ad6572bbe73ec367d2d0f277a80cb into 0e7240bb89ab24399260e8f0f2dcfd7b340f55a9"),
    true,
  );
  assert.equal(isGitHubMergeResult("Merge branch 'main'"), false);
});

test("counts parents from the raw commit header only", () => {
  const raw = "tree abc\nparent 1111\nparent 2222\nauthor A <a@example.invalid> 0 +0000\n\nparent 3333 in the body\n";
  assert.equal(parentCount(raw), 2);
  assert.equal(parentCount("tree abc\nauthor A <a@example.invalid> 0 +0000\n\nroot\n"), 0);
});

test("skips a real merge commit even in a depth-1 shallow checkout", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "commit-check-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const run = (cwd, ...args) => {
    const result = spawnSync(args[0], args.slice(1), { cwd, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const origin = path.join(root, "origin");
  fs.mkdirSync(path.join(origin, "scripts"), { recursive: true });
  fs.copyFileSync(new URL("./commit-message-check.mjs", import.meta.url), path.join(origin, "scripts", "commit-message-check.mjs"));
  run(origin, "git", "init", "-q", "-b", "main");
  run(origin, "git", "config", "user.name", "Fixture");
  run(origin, "git", "config", "user.email", "fixture@example.invalid");
  run(origin, "git", "add", ".");
  run(origin, "git", "commit", "-qm", "chore: add checker");
  run(origin, "git", "checkout", "-qb", "topic");
  fs.writeFileSync(path.join(origin, "topic.txt"), "x\n");
  run(origin, "git", "add", ".");
  run(origin, "git", "commit", "-qm", "docs: add topic");
  run(origin, "git", "checkout", "-q", "main");
  run(origin, "git", "merge", "-q", "--no-ff", "topic", "-m", "Merge pull request #1 from owner/topic");
  const shallow = path.join(root, "shallow");
  run(root, "git", "clone", "-q", "--depth", "1", `file://${origin}`, shallow);
  assert.equal(run(shallow, "git", "show", "-s", "--format=%P", "HEAD"), "");
  const result = spawnSync(process.execPath, ["scripts/commit-message-check.mjs", "HEAD"], { cwd: shallow, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});
