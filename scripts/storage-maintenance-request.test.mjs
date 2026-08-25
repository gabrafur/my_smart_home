#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const requestScript = path.join(scriptsDir, "request-host-storage-maintenance.sh");
const processScript = path.join(scriptsDir, "process-storage-maintenance-request.sh");
const installScript = path.join(scriptsDir, "install-storage-maintenance-cron.sh");

test("manual request is coalesced and processed with bounded Docker cache", () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "storage-request-test-"));
  const triggerDir = path.join(fixture, "trigger");
  const calls = path.join(fixture, "calls");
  const maintenance = path.join(fixture, "maintenance.sh");
  fs.mkdirSync(triggerDir);
  fs.writeFileSync(maintenance, `#!/bin/sh\nprintf '%s\\n' "$*" >> "${calls}"\n`);
  fs.chmodSync(maintenance, 0o755);
  const env = {
    ...process.env,
    STORAGE_MAINTENANCE_TRIGGER_DIR: triggerDir,
    STORAGE_MAINTENANCE_SCRIPT: maintenance,
  };

  const request = spawnSync(requestScript, [], { encoding: "utf8", env });
  assert.equal(request.status, 0, request.stderr);
  assert.ok(fs.existsSync(path.join(triggerDir, "manual-trigger")));

  const processed = spawnSync(processScript, [], { encoding: "utf8", env });
  assert.equal(processed.status, 0, processed.stderr);
  assert.equal(fs.readFileSync(calls, "utf8").trim(), "--apply --min-age 24 --max-build-cache 2GB");
  assert.ok(!fs.existsSync(path.join(triggerDir, "manual-trigger")));
  assert.equal(spawnSync(processScript, [], { encoding: "utf8", env }).status, 0);
  assert.equal(fs.readFileSync(calls, "utf8").trim().split("\n").length, 1);
  fs.rmSync(fixture, { recursive: true, force: true });
});

test("failed maintenance restores the request for retry", () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "storage-request-retry-test-"));
  const triggerDir = path.join(fixture, "trigger");
  const maintenance = path.join(fixture, "maintenance.sh");
  fs.mkdirSync(triggerDir);
  fs.writeFileSync(path.join(triggerDir, "manual-trigger"), "");
  fs.writeFileSync(maintenance, "#!/bin/sh\nexit 1\n");
  fs.chmodSync(maintenance, 0o755);
  const result = spawnSync(processScript, [], {
    encoding: "utf8",
    env: { ...process.env, STORAGE_MAINTENANCE_TRIGGER_DIR: triggerDir, STORAGE_MAINTENANCE_SCRIPT: maintenance },
  });
  assert.equal(result.status, 1);
  assert.ok(fs.existsSync(path.join(triggerDir, "manual-trigger")));
  fs.rmSync(fixture, { recursive: true, force: true });
});

test("cron installer exposes an idempotent managed block", () => {
  const result = spawnSync(installScript, ["--dry-run"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /BEGIN Smart home manual storage maintenance/);
  assert.match(result.stdout, /process-storage-maintenance-request\.sh/);
  assert.match(result.stdout, /run-resource-safe\.sh/);
  assert.doesNotMatch(result.stdout, /23 \*\/6 \* \* \*/);
  assert.doesNotMatch(result.stdout, /storage-maintenance\.sh --apply/);
});
