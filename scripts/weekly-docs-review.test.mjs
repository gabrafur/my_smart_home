import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const schedulerSource = fs.readFileSync(new URL("./weekly-docs-review.mjs", import.meta.url), "utf8");

function command(cwd, executable, args, env = {}) {
  return spawnSync(executable, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

function git(cwd, args) {
  const result = command(cwd, "git", args);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function write(target, content, mode = 0o644) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, { mode });
}

function fixture({ branch = "main" } = {}) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "weekly-review-test-"));
  const repo = path.join(temporaryRoot, "repo");
  const remote = path.join(temporaryRoot, "remote.git");
  const control = path.join(temporaryRoot, "control");
  const bin = path.join(temporaryRoot, "bin");
  fs.mkdirSync(repo);
  git(repo, ["init", "-q", "-b", branch]);
  git(repo, ["config", "user.name", "Synthetic Scheduler Fixture"]);
  git(repo, ["config", "user.email", "scheduler@example.invalid"]);
  write(path.join(repo, "README.md"), "# Synthetic fixture\n");
  write(path.join(repo, "docs", "base.md"), "# Base\n");
  write(path.join(repo, "scripts", "runtime.js"), "export const safe = true;\n");
  write(path.join(repo, "scripts", "weekly-docs-review.mjs"), schedulerSource);
  write(path.join(repo, "scripts", "weekly-docs-review.prompt.md"), "Português do Brasil\n");
  write(path.join(repo, "Makefile"), "validate-public:\n\t@true\nvalidate-staged:\n\t@true\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-qm", "synthetic baseline"]);
  const baseline = git(repo, ["rev-parse", "HEAD"]);
  git(temporaryRoot, ["init", "-q", "--bare", remote]);
  git(repo, ["remote", "add", "origin", remote]);
  git(repo, ["push", "-qu", "origin", branch]);

  if (branch === "main") {
    git(temporaryRoot, ["clone", "-q", remote, control]);
    git(control, ["checkout", "-q", "-b", "main", "origin/main"]);
    git(control, ["config", "user.name", "Synthetic Remote Fixture"]);
    git(control, ["config", "user.email", "remote@example.invalid"]);
  }

  write(path.join(bin, "flock"), [
    "#!/bin/sh",
    "shift 2",
    "exec \"$@\"",
    "",
  ].join("\n"), 0o755);
  write(path.join(bin, "codex"), [
    "#!/bin/sh",
    "set -eu",
    "[ -z \"${SCHEDULER_ARGS_PATH:-}\" ] || printf '%s\\n' \"$@\" > \"$SCHEDULER_ARGS_PATH\"",
    "case \"${SCHEDULER_SCENARIO:-no_changes}\" in",
    "  allowed) printf '%s\\n' '# Reviewed' > docs/review.md ;;",
    "  validation_failure|privacy_failure|security_failure) printf '%s\\n' '# Reviewed' > docs/review.md ;;",
    "  forbidden) printf '%s\\n' 'export const changed = true;' >> scripts/runtime.js ;;",
    "  mixed) printf '%s\\n' '# Reviewed' > docs/review.md; printf '%s\\n' 'export const changed = true;' >> scripts/runtime.js ;;",
    "  remote_advanced)",
    "    env -u GIT_CONFIG_COUNT -u GIT_CONFIG_KEY_0 -u GIT_CONFIG_VALUE_0 git -C \"$SCHEDULER_CONTROL\" commit --allow-empty -qm 'synthetic remote advance'",
    "    env -u GIT_CONFIG_COUNT -u GIT_CONFIG_KEY_0 -u GIT_CONFIG_VALUE_0 git -C \"$SCHEDULER_CONTROL\" push -q \"$SCHEDULER_REMOTE\" HEAD:main",
    "    printf '%s\\n' '# Reviewed' > docs/review.md",
    "    ;;",
    "esac",
    "exit 0",
    "",
  ].join("\n"), 0o755);
  write(path.join(bin, "make"), [
    "#!/bin/sh",
    "target=${1:-}",
    "case \"${SCHEDULER_SCENARIO:-}\" in",
    "  validation_failure) [ \"$target\" = validate-public ] && echo synthetic-validation-failure >&2 && exit 1 ;;",
    "  privacy_failure) [ \"$target\" = validate-staged ] && echo synthetic-privacy-failure >&2 && exit 1 ;;",
    "  security_failure) [ \"$target\" = validate-staged ] && echo synthetic-security-failure >&2 && exit 1 ;;",
    "esac",
    "exit 0",
    "",
  ].join("\n"), 0o755);

  function run(scenario) {
    const argsPath = path.join(temporaryRoot, "codex-args.txt");
    return command(repo, process.execPath, ["scripts/weekly-docs-review.mjs", "--run-now"], {
      PATH: `${bin}:${process.env.PATH}`,
      SCHEDULER_SCENARIO: scenario,
      SCHEDULER_ARGS_PATH: argsPath,
      SCHEDULER_CONTROL: control,
      SCHEDULER_REMOTE: remote,
      WEEKLY_DOCS_REVIEW_STATUS_PATH: path.join(temporaryRoot, "status.json"),
    });
  }

  function remoteCount() {
    return Number(git(temporaryRoot, ["--git-dir", remote, "rev-list", "--count", branch]));
  }

  return {
    argsPath: path.join(temporaryRoot, "codex-args.txt"),
    baseline,
    branch,
    remote,
    remoteCount,
    repo,
    run,
    temporaryRoot,
  };
}

test("uses automatic approval without a conflicting sandbox option", () => {
  const item = fixture();
  const result = item.run("no_changes");
  assert.equal(result.status, 0, result.stderr);
  const args = fs.readFileSync(item.argsPath, "utf8").trim().split("\n");
  assert.equal(args.filter((arg) => arg === "--approve-for-me").length, 1);
  assert.equal(args.includes("--sandbox"), false);
});

test("allows a documentation-only diff, validates it and publishes one commit", () => {
  const item = fixture();
  const before = item.remoteCount();
  const result = item.run("allowed");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(item.remoteCount(), before + 1);
  assert.equal(git(item.repo, ["log", "-1", "--format=%s"]), "docs: weekly public-repository review");
});

for (const scenario of ["forbidden", "mixed"]) {
  test(`rejects ${scenario} diffs without publishing`, () => {
    const item = fixture();
    const before = item.remoteCount();
    const result = item.run(scenario);
    assert.equal(result.status, 1);
    assert.match(`${result.stdout}\n${result.stderr}`, /unapproved_paths/);
    assert.equal(item.remoteCount(), before);
    assert.equal(git(item.repo, ["rev-parse", "HEAD"]), item.baseline);
  });
}

test("rejects an unexpected branch before running the agent", () => {
  const item = fixture({ branch: "feature" });
  const result = item.run("allowed");
  assert.equal(result.status, 1);
  assert.match(result.stdout, /expected branch main/);
  assert.equal(item.remoteCount(), 1);
});

test("rejects delivery when the remote advances during review", () => {
  const item = fixture();
  const result = item.run("remote_advanced");
  assert.equal(result.status, 1);
  assert.match(`${result.stdout}\n${result.stderr}`, /remote_advanced/);
  assert.equal(git(item.repo, ["rev-parse", "HEAD"]), item.baseline);
  assert.equal(git(path.dirname(item.remote), ["--git-dir", item.remote, "log", "-1", "--format=%s", "main"]), "synthetic remote advance");
});

for (const [scenario, marker] of [
  ["validation_failure", "synthetic-validation-failure"],
  ["privacy_failure", "synthetic-privacy-failure"],
  ["security_failure", "synthetic-security-failure"],
]) {
  test(`does not publish after ${scenario}`, () => {
    const item = fixture();
    const before = item.remoteCount();
    const result = item.run(scenario);
    assert.equal(result.status, 1);
    assert.match(`${result.stdout}\n${result.stderr}`, new RegExp(marker));
    assert.equal(item.remoteCount(), before);
    assert.equal(git(item.repo, ["rev-parse", "HEAD"]), item.baseline);
  });
}

test("an agent code change is rejected by the executable allowlist", () => {
  const item = fixture();
  const result = item.run("forbidden");
  assert.equal(result.status, 1);
  assert.match(result.stdout, /unapproved_paths/);
  assert.equal(git(item.repo, ["rev-parse", "HEAD"]), item.baseline);
});

test("a no-change review creates no commit", () => {
  const item = fixture();
  const before = item.remoteCount();
  const result = item.run("no_changes");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /completed with no changes/);
  assert.equal(item.remoteCount(), before);
  assert.equal(git(item.repo, ["rev-parse", "HEAD"]), item.baseline);
});
