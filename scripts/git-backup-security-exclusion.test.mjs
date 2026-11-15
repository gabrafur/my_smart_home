import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));

// The fake scanner flags `wip.py` whenever it is staged and flags the tracked
// `state.txt` when it contains the word FLAG, using the canonical report line.
const scanner = `#!/bin/sh
status=0
staged=$(git diff --cached --name-only)
if printf '%s\\n' "$staged" | grep -qx 'wip.py'; then
  echo "  rule=ipv4-privado file=wip.py line=3 category=secret-or-private-data"; status=1
fi
if printf '%s\\n' "$staged" | grep -qx 'state.txt' && grep -q FLAG state.txt; then
  echo "  rule=senha file=state.txt line=1 category=secret-or-private-data"; status=1
fi
if printf '%s\\n' "$staged" | grep -qx 'odd.bin'; then
  echo "  forbidden=odd.bin category=forbidden-file"; status=1
fi
exit $status
`;

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "git-backup-exclusion-test-"));
  const repo = path.join(root, "repo");
  const remote = path.join(root, "remote.git");
  fs.mkdirSync(path.join(repo, "scripts"), { recursive: true });
  fs.copyFileSync(path.join(scriptsDir, "git-backup.sh"), path.join(repo, "scripts", "git-backup.sh"));
  fs.writeFileSync(path.join(repo, "scripts", "security-scan.sh"), scanner, { mode: 0o755 });
  const git = (...args) => spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  assert.equal(spawnSync("git", ["init", "--bare", "-q", remote]).status, 0);
  assert.equal(spawnSync("git", ["init", "-q", repo]).status, 0);
  git("config", "user.name", "Backup Test");
  git("config", "user.email", "backup@example.invalid");
  git("remote", "add", "origin", remote);
  fs.writeFileSync(path.join(repo, ".gitignore"), ".git-backup.log\n.git-backup.lock\n");
  fs.writeFileSync(path.join(repo, "state.txt"), "initial\n");
  git("add", ".");
  assert.equal(git("commit", "-m", "test: create exclusion fixture").status, 0);
  git("branch", "-M", "main");
  assert.equal(git("push", "-u", "origin", "main").status, 0);
  const backup = () => spawnSync("bash", ["scripts/git-backup.sh"], { cwd: repo, encoding: "utf8" });
  const log = () => fs.readFileSync(path.join(repo, ".git-backup.log"), "utf8");
  return { repo, git, backup, log, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("flagged brand-new file is left out and the rest of the backup is published", () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.repo, "wip.py"), "in progress\n");
    fs.writeFileSync(path.join(f.repo, "state.txt"), "changed\n");
    const result = f.backup();
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(f.git("rev-list", "--count", "origin/main..HEAD").stdout.trim(), "0");
    assert.equal(f.git("show", "HEAD:state.txt").stdout, "changed\n");
    assert.notEqual(f.git("cat-file", "-e", "HEAD:wip.py").status, 0, "flagged file never committed");
    assert.equal(fs.readFileSync(path.join(f.repo, "wip.py"), "utf8"), "in progress\n", "work in progress untouched");
    assert.match(f.git("status", "--porcelain").stdout, /^\?\? wip\.py$/m);
    assert.match(f.log(), /backup excluded 1 flagged new file\(s\) from staging reason=security_scan_excluded_new_files/);
    assert.match(f.log(), /rule=ipv4-privado file=wip\.py/);
  } finally { f.cleanup(); }
});

test("finding in an already tracked file still aborts without publishing", () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.repo, "wip.py"), "in progress\n");
    fs.writeFileSync(path.join(f.repo, "state.txt"), "FLAG\n");
    const head = f.git("rev-parse", "HEAD").stdout;
    const result = f.backup();
    assert.equal(result.status, 1);
    assert.match(result.stdout, /git-backup-reason=security_scan_failed/);
    assert.equal(f.git("rev-parse", "HEAD").stdout, head);
    assert.equal(f.git("diff", "--cached", "--name-only").stdout, "", "index restored");
    assert.doesNotMatch(f.log(), /backup excluded/);
  } finally { f.cleanup(); }
});

test("finding in an unknown report format aborts instead of being skipped", () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.repo, "odd.bin"), "x\n");
    fs.writeFileSync(path.join(f.repo, "wip.py"), "in progress\n");
    const result = f.backup();
    assert.equal(result.status, 1);
    assert.match(result.stdout, /git-backup-reason=security_scan_failed/);
  } finally { f.cleanup(); }
});
