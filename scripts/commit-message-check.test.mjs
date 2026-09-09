import assert from "node:assert/strict";
import test from "node:test";

import { isGitHubMergeResult, validateCommitSubject } from "./commit-message-check.mjs";

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
