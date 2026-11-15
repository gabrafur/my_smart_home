import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));

// Isolated repository with a bare remote. The pre-push hook stands in for the
// canonical validation: it rejects a push whose docs/guide.md says BROKEN,
// which is what unfinished interactive work looks like to the real one.
function fixture({ scope = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "git-backup-scope-test-"));
  const repo = path.join(root, "repo");
  const remote = path.join(root, "remote.git");
  for (const dir of ["scripts", "docs", "nodered", ".codex/memories"]) fs.mkdirSync(path.join(repo, dir), { recursive: true });
  fs.copyFileSync(path.join(scriptsDir, "git-backup.sh"), path.join(repo, "scripts", "git-backup.sh"));
  if (scope) fs.copyFileSync(path.join(scriptsDir, "git-backup-scope.conf"), path.join(repo, "scripts", "git-backup-scope.conf"));
  fs.writeFileSync(path.join(repo, "scripts", "security-scan.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const write = (name, body) => fs.writeFileSync(path.join(repo, name), body);
  const git = (...args) => spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  assert.equal(spawnSync("git", ["init", "--bare", "-q", remote]).status, 0);
  assert.equal(spawnSync("git", ["init", "-q", repo]).status, 0);
  git("config", "user.name", "Backup Test");
  git("config", "user.email", "backup@example.invalid");
  git("remote", "add", "origin", remote);
  write(".gitignore", ".git-backup.log\n.git-backup.lock\n");
  write("nodered/flows.json", "[]\n");
  write("docs/guide.md", "stable\n");
  write("docs/old-name.md", "to be renamed\n");
  write(".codex/memories/topic.md", "record\n");
  write("scripts/alexa-media-upstream.json", "{\"version\":1}\n");
  write("README.md", "readme\n");
  git("add", ".");
  assert.equal(git("commit", "-m", "test: create scope fixture").status, 0);
  git("branch", "-M", "main");
  assert.equal(git("push", "-u", "origin", "main").status, 0);
  fs.writeFileSync(path.join(repo, ".git", "hooks", "pre-push"),
    "#!/bin/sh\nif git show HEAD:docs/guide.md | grep -q BROKEN; then echo 'pre-push: canonical validation rejected the commit' >&2; exit 1; fi\n", { mode: 0o755 });
  return { repo, git, write,
    read: (name) => fs.readFileSync(path.join(repo, name), "utf8"),
    backup: () => spawnSync("bash", ["scripts/git-backup.sh"], { cwd: repo, encoding: "utf8" }),
    log: () => fs.readFileSync(path.join(repo, ".git-backup.log"), "utf8"),
    committed: () => git("show", "--name-only", "--pretty=format:", "HEAD").stdout.trim().split("\n").filter(Boolean).sort(),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function unfinishedWork(f) {
  f.write("docs/guide.md", "BROKEN half-written\n");
  f.write("scripts/wip.mjs", "// not ready\n");
  f.write(".codex/memories/topic.md", "record being revised\n");
  f.write("README.md", "readme draft\n");
  f.git("mv", "docs/old-name.md", "docs/new-name.md");
}

test("runtime state is published while unfinished interactive work stays with its author", () => {
  const f = fixture();
  try {
    unfinishedWork(f);
    f.write("nodered/flows.json", "[{\"id\":\"n1\"}]\n");
    f.write("scripts/alexa-media-upstream.json", "{\"version\":2}\n");
    const result = f.backup();
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.deepEqual(f.committed(), ["nodered/flows.json", "scripts/alexa-media-upstream.json"]);
    assert.equal(f.git("rev-list", "--count", "origin/main..HEAD").stdout.trim(), "0", "published");
    // Nothing of the interactive work was lost, staged or published.
    assert.equal(f.read("docs/guide.md"), "BROKEN half-written\n");
    assert.equal(f.read("scripts/wip.mjs"), "// not ready\n");
    assert.equal(f.read("docs/new-name.md"), "to be renamed\n");
    assert.equal(f.git("show", "HEAD:docs/guide.md").stdout, "stable\n");
    assert.equal(f.git("show", "HEAD:docs/old-name.md").stdout, "to be renamed\n", "rename is not half-published");
    assert.equal(f.git("diff", "--cached", "--name-only").stdout, "", "index left clean");
    const status = f.git("status", "--porcelain").stdout;
    for (const expected of [" M docs/guide.md", " M .codex/memories/topic.md", " M README.md", "?? scripts/wip.mjs", "?? docs/new-name.md", " D docs/old-name.md"]) {
      assert.ok(status.split("\n").includes(expected), `${expected} missing from:\n${status}`);
    }
    assert.match(f.log(), /backup left 6 development path\(s\) to their author reason=development_paths_deferred/);
    assert.match(f.log(), /deferred=docs\/guide\.md/);
    assert.match(f.log(), /backup finished: pushed/);
  } finally { f.cleanup(); }
});

test("only interactive changes means a successful backup with nothing to publish", () => {
  const f = fixture();
  try {
    unfinishedWork(f);
    const head = f.git("rev-parse", "HEAD").stdout;
    const result = f.backup();
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(f.git("rev-parse", "HEAD").stdout, head);
    assert.match(f.log(), /backup finished: no changes/);
    assert.doesNotMatch(result.stdout, /git-backup-reason=/);
  } finally { f.cleanup(); }
});

test("without a scope file the previous whole-tree behaviour is kept", () => {
  const f = fixture({ scope: false });
  try {
    f.write("docs/guide.md", "finished\n");
    f.write("nodered/flows.json", "[1]\n");
    assert.equal(f.backup().status, 0);
    assert.deepEqual(f.committed(), ["docs/guide.md", "nodered/flows.json"]);
  } finally { f.cleanup(); }
});

test("a validation failure in runtime state is still a failure and restores the tree", () => {
  const f = fixture({ scope: false });
  try {
    f.write("docs/guide.md", "BROKEN\n");
    const head = f.git("rev-parse", "HEAD").stdout;
    const result = f.backup();
    assert.equal(result.status, 1);
    assert.match(result.stdout, /git-backup-reason=validation_failed/);
    assert.equal(f.git("rev-parse", "HEAD").stdout, head);
    assert.equal(f.read("docs/guide.md"), "BROKEN\n");
  } finally { f.cleanup(); }
});

test("an invalid scope rule stops the backup before anything is committed", () => {
  for (const rule of ["defer ../outside", "defer /etc", "defer :(glob)**", "publish docs/", "defer docs/ extra", "defer do*cs"]) {
    const f = fixture();
    try {
      fs.appendFileSync(path.join(f.repo, "scripts", "git-backup-scope.conf"), `${rule}\n`);
      f.git("commit", "-qam", "test: change scope");
      f.git("push", "-q");
      f.write("nodered/flows.json", "[2]\n");
      const head = f.git("rev-parse", "HEAD").stdout;
      const result = f.backup();
      assert.equal(result.status, 1, rule);
      assert.match(result.stdout, /git-backup-reason=backup_scope_invalid/, rule);
      assert.equal(f.git("rev-parse", "HEAD").stdout, head, rule);
      assert.equal(f.git("diff", "--cached", "--name-only").stdout, "", rule);
      assert.equal(f.read("nodered/flows.json"), "[2]\n", rule);
    } finally { f.cleanup(); }
  }
});

test("the versioned scope only defers known author paths and keeps worker-written files", () => {
  const rules = fs.readFileSync(path.join(scriptsDir, "git-backup-scope.conf"), "utf8").split("\n")
    .filter((line) => line && !line.startsWith("#")).map((line) => line.split(" "));
  assert.ok(rules.every((rule) => rule.length === 2 && ["defer", "keep"].includes(rule[0])));
  const deferred = rules.filter(([kind]) => kind === "defer").map(([, value]) => value);
  for (const runtime of ["homeassistant/", "nodered/", "zigbee2mqtt/", "appdaemon/", "mosquitto/", "docker-compose.yml"]) {
    assert.ok(!deferred.some((value) => runtime.startsWith(value) || value.startsWith(runtime)), `${runtime} must stay in the backup`);
  }
  for (const [, value] of rules.filter(([kind]) => kind === "keep")) {
    assert.ok(deferred.some((prefix) => value.startsWith(prefix)), `${value} is only meaningful inside a deferred prefix`);
    assert.ok(fs.existsSync(path.join(scriptsDir, "..", value)), `${value} exists`);
  }
});
