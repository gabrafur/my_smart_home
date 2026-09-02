#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const scriptsDir = path.dirname(new URL(import.meta.url).pathname);
const requestScript = path.join(scriptsDir, "request-host-memory-guardian.sh");
const readScript = path.join(scriptsDir, "read-host-memory-guardian-result.sh");
const processScript = path.join(scriptsDir, "process-host-memory-guardian-request.sh");
const installScript = path.join(scriptsDir, "install-host-memory-guardian-bridge.sh");

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "host-memory-guardian-request-"));
  const trigger = path.join(root, "trigger");
  fs.mkdirSync(trigger);
  return { root, trigger };
}

test("request bridge accepts one request and coalesces overlap", () => {
  const { root, trigger } = fixture();
  const env = { ...process.env, HOST_MEMORY_GUARDIAN_TRIGGER_DIR: trigger };
  const first = spawnSync(requestScript, [], { encoding: "utf8", env });
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /status=accepted/);
  assert.ok(fs.existsSync(path.join(trigger, "requested")));

  const second = spawnSync(requestScript, [], { encoding: "utf8", env });
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /status=coalesced/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("host worker publishes only the guardian's sanitized result", () => {
  const { root, trigger } = fixture();
  const guardian = path.join(root, "guardian.mjs");
  fs.writeFileSync(
    guardian,
    "console.log('memory-guardian status=healthy available_mib=4096 available_percent=50.0 candidate_pid=none candidate_mib=0 terminated=0');\n",
  );
  fs.writeFileSync(path.join(trigger, "requested"), "request-1\n");
  const env = {
    ...process.env,
    HOST_MEMORY_GUARDIAN_TRIGGER_DIR: trigger,
    HOST_MEMORY_GUARDIAN_SCRIPT: guardian,
    HOST_MEMORY_GUARDIAN_STATE_FILE: path.join(trigger, "state.json"),
  };
  const processed = spawnSync(processScript, [], { encoding: "utf8", env });
  assert.equal(processed.status, 0, processed.stderr);
  assert.ok(!fs.existsSync(path.join(trigger, "processing")));
  const result = fs.readFileSync(path.join(trigger, "result"), "utf8");
  assert.match(result, /^host-memory-guardian status=healthy /);
  assert.match(result, /request_id=request-1/);

  const read = spawnSync(readScript, [], { encoding: "utf8", env });
  assert.equal(read.status, 0, read.stderr);
  assert.equal(read.stdout, result);
  fs.rmSync(root, { recursive: true, force: true });
});

test("host worker reports failure without retaining a processing marker", () => {
  const { root, trigger } = fixture();
  const guardian = path.join(root, "guardian.mjs");
  fs.writeFileSync(guardian, "console.error('unsafe failure detail'); process.exit(1);\n");
  fs.writeFileSync(path.join(trigger, "requested"), "request-2\n");
  const env = {
    ...process.env,
    HOST_MEMORY_GUARDIAN_TRIGGER_DIR: trigger,
    HOST_MEMORY_GUARDIAN_SCRIPT: guardian,
  };
  const processed = spawnSync(processScript, [], { encoding: "utf8", env });
  assert.equal(processed.status, 1);
  assert.ok(!fs.existsSync(path.join(trigger, "processing")));
  assert.match(fs.readFileSync(path.join(trigger, "result"), "utf8"), /status=failed/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("host worker rejects a non-absolute Node.js runtime", () => {
  const { root, trigger } = fixture();
  const guardian = path.join(root, "guardian.mjs");
  fs.writeFileSync(guardian, "console.log('memory-guardian status=healthy');\n");
  fs.writeFileSync(path.join(trigger, "requested"), "request-3\n");
  const env = {
    ...process.env,
    HOST_MEMORY_GUARDIAN_TRIGGER_DIR: trigger,
    HOST_MEMORY_GUARDIAN_SCRIPT: guardian,
    HOST_MEMORY_GUARDIAN_NODE_BIN: "node",
  };

  const processed = spawnSync(processScript, [], { encoding: "utf8", env });
  assert.equal(processed.status, 69);
  assert.match(processed.stderr, /runtime is unavailable/);
  assert.ok(fs.existsSync(path.join(trigger, "requested")));
  fs.rmSync(root, { recursive: true, force: true });
});

test("cron installer is idempotent and keeps the worker unprivileged", () => {
  const { root, trigger } = fixture();
  const bin = path.join(root, "bin");
  const crontabState = path.join(root, "crontab");
  fs.mkdirSync(bin);
  fs.writeFileSync(crontabState, "15 3 * * * /existing/job\n");
  fs.writeFileSync(
    path.join(bin, "crontab"),
    "#!/bin/sh\nif [ \"${1:-}\" = \"-l\" ]; then cat \"$FAKE_CRONTAB_STATE\"; else cp \"$1\" \"$FAKE_CRONTAB_STATE\"; fi\n",
  );
  fs.chmodSync(path.join(bin, "crontab"), 0o755);
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    FAKE_CRONTAB_STATE: crontabState,
    HOST_MEMORY_GUARDIAN_TRIGGER_DIR: trigger,
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const installed = spawnSync(installScript, [], { encoding: "utf8", env });
    assert.equal(installed.status, 0, installed.stderr);
  }
  const contents = fs.readFileSync(crontabState, "utf8");
  assert.equal((contents.match(/BEGIN Smart home Node-RED host memory guardian/g) ?? []).length, 1);
  assert.match(contents, /process-host-memory-guardian-request\.sh/);
  assert.match(contents, /flock -n/);
  assert.doesNotMatch(contents, /sudo|root/);
  fs.rmSync(root, { recursive: true, force: true });
});
