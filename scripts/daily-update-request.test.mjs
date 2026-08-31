#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const requestScript = path.join(scriptsDir, "request-host-daily-update.sh");
const readScript = path.join(scriptsDir, "read-host-daily-update-result.sh");
const processScript = path.join(scriptsDir, "process-daily-update-request.sh");
const runScript = path.join(scriptsDir, "run-daily-host-update.sh");
const dietpiScript = path.join(scriptsDir, "dietpi-daily-upgrade.sh");
const installBridge = path.join(scriptsDir, "install-daily-update-nodered-bridge.sh");
const installHelper = path.join(scriptsDir, "install-dietpi-daily-upgrade-helper.sh");
const requestKiaUpdate = path.join(scriptsDir, "request-host-kia-uvo-update-check.sh");
const readKiaUpdate = path.join(scriptsDir, "read-host-kia-uvo-update-result.sh");
const processKiaUpdate = path.join(scriptsDir, "process-kia-uvo-update-request.sh");

test("Node-RED requests are coalesced and expose the final host result", () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "daily-update-request-test-"));
  const triggerDir = path.join(fixture, "trigger");
  const updater = path.join(fixture, "update.sh");
  const calls = path.join(fixture, "calls");
  fs.mkdirSync(triggerDir);
  fs.writeFileSync(updater, `#!/bin/sh\nprintf 'called\\n' >> "${calls}"\nprintf 'dietpi_exit=0 containers_exit=0\\n' > "$DAILY_UPDATE_DETAIL_FILE"\n`);
  fs.chmodSync(updater, 0o755);
  const env = {
    ...process.env,
    DAILY_UPDATE_TRIGGER_DIR: triggerDir,
    HOST_DAILY_UPDATE_SCRIPT: updater,
  };

  const first = spawnSync(requestScript, [], { encoding: "utf8", env });
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /status=accepted/);
  assert.equal(fs.statSync(path.join(triggerDir, "requested")).mode & 0o060, 0o060);
  const requestId = fs.readFileSync(path.join(triggerDir, "requested"), "utf8").trim();

  const second = spawnSync(requestScript, [], { encoding: "utf8", env });
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, new RegExp(`status=coalesced request_id=${requestId}`));

  const processed = spawnSync(processScript, [], { encoding: "utf8", env });
  assert.equal(processed.status, 0, processed.stderr);
  assert.equal(fs.readFileSync(calls, "utf8"), "called\n");
  const read = spawnSync(readScript, [], { encoding: "utf8", env });
  assert.equal(read.status, 0, read.stderr);
  assert.match(read.stdout, new RegExp(`status=success request_id=${requestId}`));
  assert.equal(fs.statSync(path.join(triggerDir, "result")).mode & 0o060, 0o060);
  assert.match(read.stdout, /dietpi_exit=0 containers_exit=0/);
  assert.equal(spawnSync(processScript, [], { encoding: "utf8", env }).status, 0);
  assert.equal(fs.readFileSync(calls, "utf8"), "called\n");
  fs.rmSync(fixture, { recursive: true, force: true });
});

test("a resource deferral retains the daily update request for retry", () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "daily-update-deferred-test-"));
  const triggerDir = path.join(fixture, "trigger");
  const updater = path.join(fixture, "update.sh");
  const attempts = path.join(fixture, "attempts");
  fs.mkdirSync(triggerDir);
  fs.writeFileSync(path.join(triggerDir, "requested"), "request-75\n");
  fs.writeFileSync(
    updater,
    `#!/bin/sh\ncount=$(cat "${attempts}" 2>/dev/null || echo 0)\ncount=$((count + 1))\nprintf '%s\\n' "$count" > "${attempts}"\n[ "$count" -gt 1 ] || exit 75\n`,
  );
  fs.chmodSync(updater, 0o755);
  const env = { ...process.env, DAILY_UPDATE_TRIGGER_DIR: triggerDir, HOST_DAILY_UPDATE_SCRIPT: updater };

  const deferred = spawnSync(processScript, [], { encoding: "utf8", env });
  assert.equal(deferred.status, 75);
  assert.ok(fs.existsSync(path.join(triggerDir, "requested")));
  assert.match(fs.readFileSync(path.join(triggerDir, "result"), "utf8"), /status=deferred/);

  const retried = spawnSync(processScript, [], { encoding: "utf8", env });
  assert.equal(retried.status, 0, retried.stderr);
  assert.match(fs.readFileSync(path.join(triggerDir, "result"), "utf8"), /status=success/);
  fs.rmSync(fixture, { recursive: true, force: true });
});

test("a failed host update records a terminal result without an infinite retry", () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "daily-update-failure-test-"));
  const triggerDir = path.join(fixture, "trigger");
  const updater = path.join(fixture, "update.sh");
  fs.mkdirSync(triggerDir);
  fs.writeFileSync(path.join(triggerDir, "requested"), "request-failed\n");
  fs.writeFileSync(updater, "#!/bin/sh\nexit 23\n");
  fs.chmodSync(updater, 0o755);
  const result = spawnSync(processScript, [], {
    encoding: "utf8",
    env: { ...process.env, DAILY_UPDATE_TRIGGER_DIR: triggerDir, HOST_DAILY_UPDATE_SCRIPT: updater },
  });
  assert.equal(result.status, 23);
  assert.match(fs.readFileSync(path.join(triggerDir, "result"), "utf8"), /status=failed/);
  assert.match(fs.readFileSync(path.join(triggerDir, "result"), "utf8"), /exit_code=23/);
  assert.ok(!fs.existsSync(path.join(triggerDir, "requested")));
  assert.ok(!fs.existsSync(path.join(triggerDir, "processing")));
  fs.rmSync(fixture, { recursive: true, force: true });
});

test("Node-RED Kia requests run only the safe checker and expose a sanitized result", () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "kia-uvo-update-request-test-"));
  const triggerDir = path.join(fixture, "trigger");
  const fakeNode = path.join(fixture, "node");
  const fakeUpdater = path.join(fixture, "kia-uvo-safe-update.mjs");
  const fakeDetector = path.join(fixture, "docker-auto-update.mjs");
  const calls = path.join(fixture, "calls");
  fs.mkdirSync(triggerDir);
  fs.writeFileSync(fakeUpdater, "fixture\n");
  fs.writeFileSync(fakeDetector, "fixture\n");
  fs.writeFileSync(fakeNode, `#!/bin/sh\nprintf '%s\\n' "$2" >> "${calls}"\nif [ "$2" = "status" ]; then\n  echo 'kia-uvo-update status=conflict installed_version=3.10.1 latest_version=v3.11.0 patch_state=conflict conflicts=1 checked_at=2026-08-31T13:30:04.072Z'\nfi\n`);
  fs.chmodSync(fakeNode, 0o755);
  const env = {
    ...process.env,
    DAILY_UPDATE_TRIGGER_DIR: triggerDir,
    KIA_UVO_UPDATE_NODE_BIN: fakeNode,
    KIA_UVO_UPDATE_SCRIPT: fakeUpdater,
    KIA_UVO_UPDATE_DETECTOR: fakeDetector,
  };

  const request = spawnSync(requestKiaUpdate, [], { encoding: "utf8", env });
  assert.equal(request.status, 0, request.stderr);
  assert.match(request.stdout, /status=accepted/);
  assert.equal(fs.statSync(path.join(triggerDir, "kia-uvo-requested")).mode & 0o060, 0o060);
  const duplicate = spawnSync(requestKiaUpdate, [], { encoding: "utf8", env });
  assert.equal(duplicate.status, 0, duplicate.stderr);
  assert.match(duplicate.stdout, /status=coalesced/);

  const processed = spawnSync(processKiaUpdate, [], { encoding: "utf8", env });
  assert.equal(processed.status, 0, processed.stderr);
  assert.deepEqual(fs.readFileSync(calls, "utf8").trim().split("\n"), ["ha-updates", "status"]);
  const read = spawnSync(readKiaUpdate, [], { encoding: "utf8", env });
  assert.equal(read.status, 0, read.stderr);
  assert.match(read.stdout, /status=conflict/);
  assert.match(read.stdout, /request_id=/);
  assert.equal(fs.statSync(path.join(triggerDir, "kia-uvo-result")).mode & 0o060, 0o060);
  assert.doesNotMatch(read.stdout, /private|message=/);
  fs.rmSync(fixture, { recursive: true, force: true });
});

test("the host cycle runs DietPi before container reconciliation", () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "daily-host-update-order-test-"));
  const calls = path.join(fixture, "calls");
  const sudo = path.join(fixture, "sudo");
  const helper = path.join(fixture, "dietpi-helper");
  const node = path.join(fixture, "node");
  const dockerUpdater = path.join(fixture, "docker-auto-update.mjs");
  const dietpiStatus = path.join(fixture, "dietpi-status");
  const detail = path.join(fixture, "detail");
  fs.writeFileSync(sudo, `#!/bin/sh\n[ "$1" = "-n" ] && shift\n"$@"\n`);
  fs.writeFileSync(helper, `#!/bin/sh\nprintf 'dietpi\\n' >> "${calls}"\n`);
  fs.writeFileSync(node, `#!/bin/sh\nprintf 'containers:%s\\n' "$*" >> "${calls}"\n`);
  fs.writeFileSync(dockerUpdater, "fixture\n");
  for (const file of [sudo, helper, node]) fs.chmodSync(file, 0o755);
  const result = spawnSync(runScript, [], {
    encoding: "utf8",
    env: {
      ...process.env,
      DAILY_UPDATE_SUDO_BIN: sudo,
      DIETPI_UPDATE_HELPER: helper,
      DAILY_UPDATE_NODE_BIN: node,
      DOCKER_UPDATE_SCRIPT: dockerUpdater,
      DIETPI_UPDATE_STATUS_FILE: dietpiStatus,
      DAILY_UPDATE_DETAIL_FILE: detail,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(fs.readFileSync(calls, "utf8").trim().split("\n"), [
    "dietpi",
    `containers:${dockerUpdater} daily`,
  ]);
  assert.equal(fs.readFileSync(detail, "utf8").trim(), "dietpi_exit=0 dietpi_stage=unknown containers_exit=0");
  fs.rmSync(fixture, { recursive: true, force: true });
});

test("dry-run never invokes sudo and keeps the container updater non-mutating", () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "daily-host-update-dry-run-test-"));
  const calls = path.join(fixture, "calls");
  const sudo = path.join(fixture, "sudo");
  const node = path.join(fixture, "node");
  const dockerUpdater = path.join(fixture, "docker-auto-update.mjs");
  fs.writeFileSync(sudo, `#!/bin/sh\nprintf 'sudo\\n' >> "${calls}"\nexit 99\n`);
  fs.writeFileSync(node, `#!/bin/sh\nprintf '%s\\n' "$*" >> "${calls}"\n`);
  fs.writeFileSync(dockerUpdater, "fixture\n");
  fs.chmodSync(sudo, 0o755);
  fs.chmodSync(node, 0o755);
  const result = spawnSync(runScript, ["--dry-run"], {
    encoding: "utf8",
    env: {
      ...process.env,
      DAILY_UPDATE_SUDO_BIN: sudo,
      DAILY_UPDATE_NODE_BIN: node,
      DOCKER_UPDATE_SCRIPT: dockerUpdater,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(calls, "utf8").trim(), `${dockerUpdater} daily --dry-run`);
  assert.match(result.stdout, /dry-run: .* -n .*dietpi/);
  fs.rmSync(fixture, { recursive: true, force: true });
});

test("the DietPi helper uses update then bounded non-removing upgrade", () => {
  const source = fs.readFileSync(dietpiScript, "utf8");
  const updateIndex = source.indexOf("APT::Update::Lock::Timeout=300");
  const upgradeIndex = source.indexOf("--with-new-pkgs");
  const dietpiUpdateIndex = source.indexOf("/boot/dietpi/dietpi-update 1");
  assert.ok(updateIndex > 0);
  assert.ok(upgradeIndex > updateIndex);
  assert.ok(dietpiUpdateIndex > upgradeIndex);
  assert.match(source, /Dpkg::Options::=--force-confold/);
  assert.match(source, /status=failed stage=dietpi-update/);
  assert.match(source, /install_stage.*= "2"/);
  assert.doesNotMatch(source, /dist-upgrade|full-upgrade|autoremove|systemctl\s+reboot|\/sbin\/reboot/);

  const installer = fs.readFileSync(installHelper, "utf8");
  assert.match(installer, /install -o root -g root -m 0755/);
  assert.match(installer, /NOPASSWD: %s/);
  assert.match(installer, /visudo -cf/);
});

test("the cron installer migrates direct update schedules to Node-RED bridges", () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "daily-update-cron-test-"));
  const bin = path.join(fixture, "bin");
  const state = path.join(fixture, "crontab");
  const triggerDir = path.join(fixture, "trigger");
  fs.mkdirSync(bin);
  fs.writeFileSync(
    state,
    "# Smart home Docker auto update - created by Codex\n" +
      "15 4 * * * /usr/bin/node /repo/scripts/docker-auto-update.mjs daily >> /repo/daily.log 2>&1\n" +
      "*/30 * * * * /usr/bin/node /repo/scripts/docker-auto-update.mjs ha-updates >> /repo/ha.log 2>&1\n",
  );
  fs.writeFileSync(path.join(bin, "crontab"), `#!/bin/sh\nif [ "\${1:-}" = "-l" ]; then cat "$FAKE_CRONTAB_STATE"; else cp "$1" "$FAKE_CRONTAB_STATE"; fi\n`);
  fs.chmodSync(path.join(bin, "crontab"), 0o755);
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    FAKE_CRONTAB_STATE: state,
    DAILY_UPDATE_TRIGGER_DIR: triggerDir,
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = spawnSync(installBridge, [], { encoding: "utf8", env });
    assert.equal(result.status, 0, result.stderr);
  }
  assert.equal(fs.statSync(triggerDir).mode & 0o2770, 0o2770);
  const installed = fs.readFileSync(state, "utf8");
  assert.equal((installed.match(/BEGIN Smart home Node-RED daily update bridge/g) ?? []).length, 1);
  assert.doesNotMatch(installed, /docker-auto-update\.mjs daily/);
  assert.doesNotMatch(installed, /docker-auto-update\.mjs ha-updates/);
  assert.match(installed, /process-daily-update-request\.sh/);
  assert.match(installed, /process-kia-uvo-update-request\.sh/);
  assert.match(installed, /nice -n 15 .*ionice -c 3/);
  fs.rmSync(fixture, { recursive: true, force: true });
});
