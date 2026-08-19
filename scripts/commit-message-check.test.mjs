import assert from "node:assert/strict";
import test from "node:test";

import { validateCommitSubject } from "./commit-message-check.mjs";

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
  assert.notDeepEqual(validateCommitSubject("fix: Make Codex card deterministic"), []);
  assert.notDeepEqual(validateCommitSubject("fix: make Codex card deterministic."), []);
  assert.notDeepEqual(validateCommitSubject(`fix: ${"a".repeat(70)}`), []);
});
