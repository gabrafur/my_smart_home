import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { memoryLinks, verifyAgentContext } from "./ai-context-recovery.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-context-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, ".codex/memories/projeto"), { recursive: true });
  fs.mkdirSync(path.join(root, ".codex/memories/restore"), { recursive: true });
  fs.writeFileSync(path.join(root, "AGENTS.md"), "# Synthetic agent rules\n");
  fs.writeFileSync(path.join(root, "MEMORY.md"), "[Restore](.codex/memories/restore/restore-contract.md)\n");
  fs.writeFileSync(path.join(root, ".codex/memories/projeto/indice.md"), "[Restore](../restore/restore-contract.md)\n");
  fs.writeFileSync(path.join(root, ".codex/memories/restore/restore-contract.md"), "# Synthetic restore contract\n");
  const trackedFiles = new Set([
    "AGENTS.md",
    "MEMORY.md",
    ".codex/memories/projeto/indice.md",
    ".codex/memories/restore/restore-contract.md",
  ]);
  const commitFiles = new Map([...trackedFiles].map((file) => [file, fs.readFileSync(path.join(root, file), "utf8")]));
  return { root, trackedFiles, commitFiles };
}

test("memory link extraction is restricted to public thematic memory", () => {
  assert.deepEqual(memoryLinks("[A](.codex/memories/topic/a.md) [B](docs/b.md)"), [".codex/memories/topic/a.md"]);
});

test("context recovery verifies the complete public chain at a commit", (t) => {
  const { root, commitFiles } = fixture(t);
  const result = verifyAgentContext(root, { mode: "commit", commit: "synthetic", commitFiles });
  assert.equal(result.agent_context_ready, true);
  assert.equal(result.private_runtime_read, false);
  assert.equal(result.thematic_memories, 1);
  assert.ok(result.sequence.every((entry) => entry.status === "verified" || entry.status === "operator-prerequisite"));
});

test("untracked thematic memory cannot satisfy worktree recovery", (t) => {
  const { root, trackedFiles } = fixture(t);
  fs.writeFileSync(path.join(root, ".codex/memories/restore/untracked.md"), "# Untracked\n");
  fs.writeFileSync(path.join(root, "MEMORY.md"), "[Missing](.codex/memories/restore/untracked.md)\n");
  fs.writeFileSync(path.join(root, ".codex/memories/projeto/indice.md"), "[Missing](../restore/untracked.md)\n");
  assert.throws(() => verifyAgentContext(root, { mode: "worktree", trackedFiles }), /not tracked/);
});

test("context recovery reads only selected thematic memory", (t) => {
  const { root, trackedFiles } = fixture(t);
  fs.writeFileSync(path.join(root, "MEMORY.md"), "[Restore](.codex/memories/restore/restore-contract.md) [Unrelated](.codex/memories/other/missing.md)\n");
  const result = verifyAgentContext(root, { mode: "worktree", topics: ["restore"], trackedFiles });
  assert.equal(result.thematic_memories, 1);
  assert.deepEqual(result.memory_topics, ["restore"]);
});
