#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const requestScript = path.join(scriptsDir, "request-host-git-backup.sh");
const processScript = path.join(scriptsDir, "process-git-backup-request.sh");
const installScript = path.join(scriptsDir, "install-git-backup-nodered-bridge.sh");
const backupScript = path.join(scriptsDir, "git-backup.sh");

function waitForFile(file, timeoutMs = 3000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      if (fs.existsSync(file)) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - started >= timeoutMs) {
        clearInterval(timer);
        reject(new Error(`timed out waiting for ${file}`));
      }
    }, 20);
  });
}

function completed(child) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

test("automated backups use the repository commit convention", () => {
  const source = fs.readFileSync(backupScript, "utf8");
  assert.match(source, /commit_message="chore: create automated smart home backup"/);
  assert.doesNotMatch(source, /Automated smart home backup/);
});

test("GitHub backups use authenticated SSH on port 443 with strict host verification", () => {
  const source = fs.readFileSync(backupScript, "utf8");
  assert.match(source, /Hostname=ssh\.github\.com/);
  assert.match(source, /HostKeyAlias=github\.com/);
  assert.match(source, /Port=443/);
  assert.match(source, /StrictHostKeyChecking=yes/);
  assert.doesNotMatch(source, /StrictHostKeyChecking=accept-new/);
});

test("Node-RED request is executed once by the host bridge", async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "git-backup-request-test-"));
  const triggerDir = path.join(fixture, "trigger");
  const calls = path.join(fixture, "calls");
  const backup = path.join(fixture, "backup.sh");
  fs.mkdirSync(triggerDir);
  fs.writeFileSync(backup, `#!/bin/sh\nprintf 'called\\n' >> "${calls}"\n`);
  fs.chmodSync(backup, 0o755);
  const env = {
    ...process.env,
    GIT_BACKUP_TRIGGER_DIR: triggerDir,
    GIT_BACKUP_SCRIPT: backup,
    GIT_BACKUP_REQUEST_TIMEOUT_SECONDS: "5",
  };

  const requester = spawn(requestScript, [], { env, stdio: ["ignore", "pipe", "pipe"] });
  const requestDone = completed(requester);
  await waitForFile(path.join(triggerDir, "requested"));
  const processed = spawnSync(processScript, [], { encoding: "utf8", env });
  assert.equal(processed.status, 0, processed.stderr);
  const result = await requestDone;
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /git-backup status=success/);
  assert.match(result.stdout, /reason=none/);
  assert.equal(fs.readFileSync(calls, "utf8"), "called\n");
  assert.equal(spawnSync(processScript, [], { encoding: "utf8", env }).status, 0);
  assert.equal(fs.readFileSync(calls, "utf8"), "called\n");
  fs.rmSync(fixture, { recursive: true, force: true });
});

test("host bridge does not leak its worker lock into backup validation", () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "git-backup-lock-scope-test-"));
  const triggerDir = path.join(fixture, "trigger");
  const backup = path.join(fixture, "backup.sh");
  const observed = path.join(fixture, "observed-lock");
  fs.mkdirSync(triggerDir);
  fs.writeFileSync(path.join(triggerDir, "requested"), "20260818T003000Z-41\n");
  fs.writeFileSync(
    backup,
    `#!/bin/sh\nprintf '%s\\n' "\${RESOURCE_SAFE_LOCK_FILE-unset}" > "${observed}"\n`,
  );
  fs.chmodSync(backup, 0o755);

  const result = spawnSync(processScript, [], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_BACKUP_TRIGGER_DIR: triggerDir,
      GIT_BACKUP_SCRIPT: backup,
      RESOURCE_SAFE_LOCK_FILE: path.join(fixture, "worker.lock"),
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(observed, "utf8"), "unset\n");
  assert.match(fs.readFileSync(path.join(triggerDir, "result"), "utf8"), /status=success/);
  fs.rmSync(fixture, { recursive: true, force: true });
});

test("host bridge publishes a failed result without retaining the request", () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "git-backup-failure-test-"));
  const triggerDir = path.join(fixture, "trigger");
  const backup = path.join(fixture, "backup.sh");
  fs.mkdirSync(triggerDir);
  fs.writeFileSync(path.join(triggerDir, "requested"), "20260818T003000Z-42\n");
  fs.writeFileSync(backup, "#!/bin/sh\nprintf 'git-backup-reason=network_unavailable\\n'\nexit 23\n");
  fs.chmodSync(backup, 0o755);
  const result = spawnSync(processScript, [], {
    encoding: "utf8",
    env: { ...process.env, GIT_BACKUP_TRIGGER_DIR: triggerDir, GIT_BACKUP_SCRIPT: backup },
  });
  assert.equal(result.status, 1);
  assert.match(fs.readFileSync(path.join(triggerDir, "result"), "utf8"), /status=failed/);
  assert.match(fs.readFileSync(path.join(triggerDir, "result"), "utf8"), /exit_code=23/);
  assert.match(fs.readFileSync(path.join(triggerDir, "result"), "utf8"), /reason=network_unavailable/);
  assert.equal(fs.existsSync(path.join(triggerDir, "processing")), false);
  fs.rmSync(fixture, { recursive: true, force: true });
});

test("host bridge retains a temporarily deferred backup for retry", () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "git-backup-deferred-test-"));
  const triggerDir = path.join(fixture, "trigger");
  const backup = path.join(fixture, "backup.sh");
  const attempts = path.join(fixture, "attempts");
  fs.mkdirSync(triggerDir);
  fs.writeFileSync(path.join(triggerDir, "requested"), "20260818T003000Z-43\n");
  fs.writeFileSync(
    backup,
    `#!/bin/sh\ncount=$(cat "${attempts}" 2>/dev/null || echo 0)\ncount=$((count + 1))\nprintf '%s\\n' "$count" > "${attempts}"\n[ "$count" -gt 1 ] || { printf 'git-backup-reason=validation_busy\\n'; exit 75; }\n`,
  );
  fs.chmodSync(backup, 0o755);
  const env = {
    ...process.env,
    GIT_BACKUP_TRIGGER_DIR: triggerDir,
    GIT_BACKUP_SCRIPT: backup,
  };
  const deferred = spawnSync(processScript, [], { encoding: "utf8", env });
  assert.equal(deferred.status, 75);
  assert.equal(fs.existsSync(path.join(triggerDir, "processing")), true);
  assert.match(fs.readFileSync(path.join(triggerDir, "result"), "utf8"), /status=deferred/);
  assert.match(fs.readFileSync(path.join(triggerDir, "result"), "utf8"), /reason=validation_busy/);

  const completed = spawnSync(processScript, [], { encoding: "utf8", env });
  assert.equal(completed.status, 0, completed.stderr);
  assert.match(fs.readFileSync(path.join(triggerDir, "result"), "utf8"), /status=success/);
  assert.equal(fs.existsSync(path.join(triggerDir, "processing")), false);
  fs.rmSync(fixture, { recursive: true, force: true });
});

test("Node-RED observes a deferred request without reporting failure", async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "git-backup-deferred-request-test-"));
  const triggerDir = path.join(fixture, "trigger");
  const backup = path.join(fixture, "backup.sh");
  fs.mkdirSync(triggerDir);
  fs.writeFileSync(backup, "#!/bin/sh\nprintf 'git-backup-reason=validation_busy\\n'\nexit 75\n");
  fs.chmodSync(backup, 0o755);
  const env = {
    ...process.env,
    GIT_BACKUP_TRIGGER_DIR: triggerDir,
    GIT_BACKUP_SCRIPT: backup,
    GIT_BACKUP_REQUEST_TIMEOUT_SECONDS: "5",
  };

  const requester = spawn(requestScript, [], { env, stdio: ["ignore", "pipe", "pipe"] });
  const requestDone = completed(requester);
  await waitForFile(path.join(triggerDir, "requested"));
  const processed = spawnSync(processScript, [], { encoding: "utf8", env });
  assert.equal(processed.status, 75);
  const result = await requestDone;
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /git-backup status=deferred/);
  assert.match(result.stdout, /reason=validation_busy/);
  assert.equal(fs.existsSync(path.join(triggerDir, "processing")), true);
  fs.rmSync(fixture, { recursive: true, force: true });
});

test("backup retries an existing local commit after validation contention", () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "git-backup-push-retry-test-"));
  const repo = path.join(fixture, "repo");
  const remote = path.join(fixture, "remote.git");
  fs.mkdirSync(repo);
  fs.mkdirSync(path.join(repo, "scripts"));
  fs.mkdirSync(path.join(repo, ".githooks"));
  fs.copyFileSync(backupScript, path.join(repo, "scripts", "git-backup.sh"));
  fs.chmodSync(path.join(repo, "scripts", "git-backup.sh"), 0o755);
  fs.writeFileSync(path.join(repo, "scripts", "security-scan.sh"), "#!/bin/sh\nexit 0\n");
  fs.chmodSync(path.join(repo, "scripts", "security-scan.sh"), 0o755);
  assert.equal(spawnSync("git", ["init", "--bare", "-q", remote]).status, 0);
  assert.equal(spawnSync("git", ["init", "-q", repo]).status, 0);
  const git = (...args) => spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  assert.equal(git("config", "user.name", "Backup Test").status, 0);
  assert.equal(git("config", "user.email", "backup@example.invalid").status, 0);
  assert.equal(git("remote", "add", "origin", remote).status, 0);
  fs.writeFileSync(
    path.join(repo, ".gitignore"),
    ".git-backup.log\n.git-backup.lock\n.push-hook-attempted\n",
  );
  fs.writeFileSync(path.join(repo, "state.txt"), "initial\n");
  assert.equal(git("add", ".").status, 0);
  assert.equal(git("commit", "-m", "test: create backup retry fixture").status, 0);
  assert.equal(git("branch", "-M", "main").status, 0);
  assert.equal(git("push", "-u", "origin", "main").status, 0);

  const hook = path.join(repo, ".githooks", "pre-push");
  fs.writeFileSync(
    hook,
    "#!/bin/sh\nif [ ! -f .push-hook-attempted ]; then\n" +
      "  touch .push-hook-attempted\n" +
      "  echo 'resource-safe: another broad validation is already running' >&2\n" +
      "  exit 75\nfi\n",
  );
  fs.chmodSync(hook, 0o755);
  assert.equal(git("config", "core.hooksPath", ".githooks").status, 0);
  fs.writeFileSync(path.join(repo, "state.txt"), "changed\n");

  const first = spawnSync("bash", ["scripts/git-backup.sh"], { cwd: repo, encoding: "utf8" });
  assert.equal(first.status, 75, first.stderr);
  assert.match(first.stdout, /git-backup-reason=validation_busy/);
  assert.equal(git("rev-list", "--count", "origin/main..HEAD").stdout.trim(), "1");
  const second = spawnSync("bash", ["scripts/git-backup.sh"], { cwd: repo, encoding: "utf8" });
  assert.equal(second.status, 0, second.stderr);
  assert.equal(git("rev-list", "--count", "origin/main..HEAD").stdout.trim(), "0");
  assert.match(fs.readFileSync(path.join(repo, ".git-backup.log"), "utf8"), /backup deferred/);

  fs.writeFileSync(
    hook,
    "#!/bin/sh\necho 'ssh: connect to host github.com port 443: Connection timed out' >&2\nexit 1\n",
  );
  fs.chmodSync(hook, 0o755);
  fs.writeFileSync(path.join(repo, "state.txt"), "changed again\n");
  const failed = spawnSync("bash", ["scripts/git-backup.sh"], { cwd: repo, encoding: "utf8" });
  assert.equal(failed.status, 1, failed.stderr);
  assert.match(failed.stdout, /git-backup-reason=network_unavailable/);
  assert.match(fs.readFileSync(path.join(repo, ".git-backup.log"), "utf8"),
    /reason=network_unavailable/);

  fs.writeFileSync(
    hook,
    "#!/bin/sh\necho 'Node-RED canvas validation failed:' >&2\necho '- backup_git: left margin below 64px' >&2\nexit 1\n",
  );
  fs.chmodSync(hook, 0o755);
  const layoutFailed = spawnSync("bash", ["scripts/git-backup.sh"], { cwd: repo, encoding: "utf8" });
  assert.equal(layoutFailed.status, 1, layoutFailed.stderr);
  assert.match(layoutFailed.stdout, /git-backup-reason=validation_node_red_layout/);
  assert.equal(git("rev-list", "--count", "origin/main..HEAD").stdout.trim(), "1");

  assert.equal(git("reset", "--hard", "origin/main").status, 0);
  fs.writeFileSync(
    hook,
    "#!/bin/sh\necho 'Node-RED canvas validation failed:' >&2\necho '- backup_git: left margin below 64px' >&2\nexit 1\n",
  );
  fs.chmodSync(hook, 0o755);
  fs.writeFileSync(path.join(repo, "state.txt"), "layout invalid\n");
  const freshLayoutFailure = spawnSync("bash", ["scripts/git-backup.sh"], { cwd: repo, encoding: "utf8" });
  assert.equal(freshLayoutFailure.status, 1, freshLayoutFailure.stderr);
  assert.match(freshLayoutFailure.stdout, /git-backup-reason=validation_node_red_layout/);
  assert.equal(git("rev-list", "--count", "origin/main..HEAD").stdout.trim(), "0");
  assert.equal(git("status", "--short", "state.txt").stdout, " M state.txt\n");
  assert.match(fs.readFileSync(path.join(repo, ".git-backup.log"), "utf8"),
    /restored worktree after validation rejected the new commit/);

  assert.equal(git("reset", "--hard", "origin/main").status, 0);
  fs.writeFileSync(
    hook,
    "#!/bin/sh\necho '> flows:validate-layout' >&2\n" +
      "echo 'generator stability test failed' >&2\n" +
      "echo 'make: *** [validate-node-red] Error 1' >&2\nexit 1\n",
  );
  fs.chmodSync(hook, 0o755);
  fs.writeFileSync(path.join(repo, "state.txt"), "generator invalid\n");
  const generatorFailure = spawnSync("bash", ["scripts/git-backup.sh"], { cwd: repo, encoding: "utf8" });
  assert.equal(generatorFailure.status, 1, generatorFailure.stderr);
  assert.match(generatorFailure.stdout, /git-backup-reason=validation_failed/);
  assert.equal(git("rev-list", "--count", "origin/main..HEAD").stdout.trim(), "0");
  assert.equal(git("status", "--short", "state.txt").stdout, " M state.txt\n");
  fs.rmSync(fixture, { recursive: true, force: true });
});

test("cron installer replaces the direct schedule with one managed bridge", () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "git-backup-cron-test-"));
  const bin = path.join(fixture, "bin");
  const state = path.join(fixture, "crontab");
  fs.mkdirSync(bin);
  fs.writeFileSync(state, "# Smart home Git backup - created by Codex\n30 3 * * * /repo/scripts/git-backup.sh\n15 4 * * * keep-this-job\n");
  fs.writeFileSync(path.join(bin, "crontab"), `#!/bin/sh\nif [ "\${1:-}" = "-l" ]; then cat "$FAKE_CRONTAB_STATE"; else cp "$1" "$FAKE_CRONTAB_STATE"; fi\n`);
  fs.chmodSync(path.join(bin, "crontab"), 0o755);
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    FAKE_CRONTAB_STATE: state,
    GIT_BACKUP_TRIGGER_DIR: path.join(fixture, "trigger"),
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = spawnSync(installScript, [], { encoding: "utf8", env });
    assert.equal(result.status, 0, result.stderr);
  }
  const installed = fs.readFileSync(state, "utf8");
  assert.equal((installed.match(/BEGIN Smart home Node-RED Git backup bridge/g) ?? []).length, 1);
  assert.doesNotMatch(installed, /30 3 \* \* \* .*git-backup\.sh/);
  assert.match(installed, /15 4 \* \* \* keep-this-job/);
  assert.match(installed, /process-git-backup-request\.sh/);
  fs.rmSync(fixture, { recursive: true, force: true });
});
