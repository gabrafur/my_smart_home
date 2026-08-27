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
    ".githooks/pre-push",
    "scripts/commit-message-check.mjs",
    "scripts/install-git-hooks.sh",
  ]) {
    fs.copyFileSync(path.join(repositoryRoot, file), path.join(root, file));
  }
  fs.chmodSync(path.join(root, ".githooks/commit-msg"), 0o755);
  fs.chmodSync(path.join(root, ".githooks/pre-push"), 0o755);
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

test("Git invokes pre-push and blocks a failing canonical validation", (t) => {
  const root = fixture(t);
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), "git-hooks-remote-"));
  t.after(() => fs.rmSync(remote, { recursive: true, force: true }));
  assert.equal(run("git", ["init", "--bare", "-q"], remote).status, 0);
  assert.equal(run("./scripts/install-git-hooks.sh", [], root).status, 0);
  assert.equal(run("git", ["config", "user.name", "Hook Test"], root).status, 0);
  assert.equal(run("git", ["config", "user.email", "hook-test@example.invalid"], root).status, 0);
  assert.equal(run("git", ["remote", "add", "origin", remote], root).status, 0);

  fs.writeFileSync(path.join(root, ".gitignore"), "/pre-push-ran\n");
  fs.writeFileSync(path.join(root, "Makefile"), "validate-public:\n\t@printf passed > pre-push-ran\n");
  assert.equal(run("git", ["add", "."], root).status, 0);
  assert.equal(run("git", ["commit", "-m", "test: exercise pre-push validation"], root).status, 0);
  assert.equal(run("git", ["branch", "-M", "main"], root).status, 0);
  const accepted = run("git", ["push", "origin", "main"], root);
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.equal(fs.readFileSync(path.join(root, "pre-push-ran"), "utf8"), "passed");
  const acceptedHead = run("git", ["rev-parse", "HEAD"], root).stdout.trim();

  fs.writeFileSync(
    path.join(root, "Makefile"),
    "validate-public:\n\t@echo synthetic-public-validation-failure >&2\n\t@exit 1\n",
  );
  assert.equal(run("git", ["add", "Makefile"], root).status, 0);
  assert.equal(run("git", ["commit", "-m", "test: reject failed pre-push validation"], root).status, 0);
  const rejected = run("git", ["push", "origin", "main"], root);
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /synthetic-public-validation-failure/);
  const remoteHead = run("git", ["rev-parse", "refs/heads/main"], remote).stdout.trim();
  assert.equal(remoteHead, acceptedHead);
});

test("installer preserves an existing custom hooks path", (t) => {
  const root = fixture(t);
  assert.equal(run("git", ["config", "--local", "core.hooksPath", "custom-hooks"], root).status, 0);
  const result = run("./scripts/install-git-hooks.sh", [], root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /refusing to replace core\.hooksPath=custom-hooks/);
  assert.match(result.stderr, /commit-msg and \.githooks\/pre-push/);
  const configured = run("git", ["config", "--local", "--get", "core.hooksPath"], root);
  assert.equal(configured.stdout.trim(), "custom-hooks");
});
