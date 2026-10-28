import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runDailyCycleCommand } from "./offsite-backup.mjs";

for (const code of ["EACCES", "EPERM", "OTHER", "MQTT_METADATA_BACKUP_UNCONFIRMED", "MQTT_METADATA_BACKUP_RESCUED"]) {
  test(`daily failure ${code} reports a safe reason without false verification claims`, async () => {
    let calls = 0;
    let output = "";
    const status = await runDailyCycleCommand({
      cycle: async () => {
        calls++;
        throw Object.assign(new Error("private fixture pathname must not leave error boundary"), { code });
      },
      write: text => { output += text; },
    });
    assert.equal(calls, 1);
    assert.equal(status, 1);
    const reason = code === "OTHER" ? "unknown_failure" : code === "MQTT_METADATA_BACKUP_UNCONFIRMED"
      ? "metadata_coordination_unconfirmed" : code === "MQTT_METADATA_BACKUP_RESCUED"
        ? "house_restored_metadata_disabled" : "authentication_or_access";
    assert.equal(output, `reason=${reason}\n`);
    assert.doesNotMatch(output, /private|capture_verified|remote_verified|protected|components/);
  });
}

test("daily success preserves the canonical receipt fields", async () => {
  let output = "";
  const status = await runDailyCycleCommand({
    cycle: async () => ({ ready: true, components: 13, capture_verified: true,
      remote_verified: true, protected: true, reason: "completed", retention_mode: "observe_only", mqtt_coordination: "verified" }),
    write: text => { output += text; },
  });
  assert.equal(status, 0);
  assert.match(output, /^components=13 capture_verified=true remote_verified=true protected=true reason=completed /);
  assert.match(output, /retention_pruned=0 retention_mode=observe_only mqtt_coordination=verified\n$/);
});

test("inactive daily policy preserves deferred exit 75", async () => {
  let output = "";
  const status = await runDailyCycleCommand({
    cycle: async () => ({ ready: false, components: 0, capture_verified: false,
      remote_verified: false, protected: false, reason: "daily-offsite-backup-not-active" }),
    write: text => { output += text; },
  });
  assert.equal(status, 75);
  assert.match(output, /reason=daily-offsite-backup-not-active/);
});

test("permission reason survives the real shell stage and worker without repeating the synthetic cycle", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "offsite-command-synthetic-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const trigger = path.join(root, "trigger");
  fs.mkdirSync(trigger);
  const fixture = path.join(root, "cycle.mjs");
  const starts = path.join(root, "starts");
  fs.writeFileSync(fixture, `import fs from 'node:fs';
import { runDailyCycleCommand } from ${JSON.stringify(new URL("./offsite-backup.mjs", import.meta.url).href)};
process.exitCode = await runDailyCycleCommand({ cycle: async () => {
  fs.appendFileSync(${JSON.stringify(starts)}, 'started\\n');
  throw Object.assign(new Error('private fixture pathname must not leave error boundary'), { code: 'EACCES' });
} });\n`);
  fs.writeFileSync(path.join(trigger, "offsite-backup-requested"), "synthetic-operation\n");
  const worker = fileURLToPath(new URL("./process-update-stage-request.sh", import.meta.url));
  const options = { encoding: "utf8", timeout: 5000, env: {
    PATH: "/usr/bin:/bin", LC_ALL: "C", DAILY_UPDATE_TRIGGER_DIR: trigger,
    HOST_UPDATE_STAGE_SCRIPT: fileURLToPath(new URL("./run-daily-host-update.sh", import.meta.url)),
    DAILY_UPDATE_NODE_BIN: process.execPath, OFFSITE_BACKUP_SCRIPT: fixture,
  } };
  const result = spawnSync("/bin/sh", [worker, "offsite-backup"], options);
  assert.equal(result.status, 1, result.stderr);
  const receiptFile = path.join(trigger, "offsite-backup-result");
  const receipt = fs.readFileSync(receiptFile, "utf8");
  assert.match(receipt, /status=failed /);
  assert.match(receipt, /exit_code=1 /);
  assert.match(receipt, /reason=authentication_or_access/);
  assert.doesNotMatch(receipt + result.stdout + result.stderr, /private fixture/);
  assert(!fs.existsSync(path.join(trigger, "offsite-backup-requested")));
  assert(!fs.existsSync(path.join(trigger, "offsite-backup-processing")));
  assert.equal(spawnSync("/bin/sh", [worker, "offsite-backup"], options).status, 0);
  assert.equal(fs.readFileSync(starts, "utf8"), "started\n");
  assert.equal(fs.readFileSync(receiptFile, "utf8"), receipt);
});
