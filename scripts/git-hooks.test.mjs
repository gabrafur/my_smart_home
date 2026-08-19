import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";

const repositoryRoot = path.resolve(import.meta.dirname, "..");

function run(command, args, cwd) {
  return spawnSync(command, args, { cwd, encoding: "utf8" });
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "git-hooks-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, ".githooks"));
  fs.mkdirSync(path.join(root, "scripts"));
  for (const file of [
    ".githooks/commit-msg",
    "scripts/commit-message-check.mjs",
    "scripts/install-git-hooks.sh",
  ]) {
    fs.copyFileSync(path.join(repositoryRoot, file), path.join(root, file));
  }
  fs.chmodSync(path.join(root, ".githooks/commit-msg"), 0o755);
  fs.chmodSync(path.join(root, "scripts/install-git-hooks.sh"), 0o755);
  assert.equal(run("git", ["init", "-q"], root).status, 0);
  return root;
}

test("installer enables the versioned hooks idempotently", (t) => {
  const root = fixture(t);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = run("./scripts/install-git-hooks.sh", [], root);
    assert.equal(result.status, 0, result.stderr);
  }
  const configured = run("git", ["config", "--local", "--get", "core.hooksPath"], root);
  assert.equal(configured.stdout.trim(), ".githooks");
});

test("Git invokes commit-msg and blocks an invalid manual commit", (t) => {
  const root = fixture(t);
  assert.equal(run("./scripts/install-git-hooks.sh", [], root).status, 0);
  assert.equal(run("git", ["config", "user.name", "Hook Test"], root).status, 0);
  assert.equal(run("git", ["config", "user.email", "hook-test@example.invalid"], root).status, 0);

  const rejected = run("git", ["commit", "--allow-empty", "-m", "fix: corrigir mensagens manuais"], root);
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /Portuguese action word 'corrigir'/);
  assert.notEqual(run("git", ["rev-parse", "--verify", "HEAD"], root).status, 0);

  const accepted = run("git", ["commit", "--allow-empty", "-m", "fix: validate manual commit messages"], root);
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.equal(run("git", ["show", "-s", "--format=%s", "HEAD"], root).stdout.trim(), "fix: validate manual commit messages");
});

test("installer preserves an existing custom hooks path", (t) => {
  const root = fixture(t);
  assert.equal(run("git", ["config", "--local", "core.hooksPath", "custom-hooks"], root).status, 0);
  const result = run("./scripts/install-git-hooks.sh", [], root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /refusing to replace core\.hooksPath=custom-hooks/);
  const configured = run("git", ["config", "--local", "--get", "core.hooksPath"], root);
  assert.equal(configured.stdout.trim(), "custom-hooks");
});
