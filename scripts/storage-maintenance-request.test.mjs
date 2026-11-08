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

test("health request is coalesced and processed as metadata only", () => {
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
    STORAGE_MAINTENANCE_PROCESSOR_LOCK: path.join(fixture, "processor.lock"),
  };

  const request = spawnSync(requestScript, [], { encoding: "utf8", env });
  assert.equal(request.status, 0, request.stderr);
  assert.ok(fs.existsSync(path.join(triggerDir, "manual-trigger")));

  const processed = spawnSync(processScript, [], { encoding: "utf8", env });
  assert.equal(processed.status, 0, processed.stderr);
  assert.equal(fs.readFileSync(calls, "utf8").trim(), "--apply --category report");
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
    env: { ...process.env, STORAGE_MAINTENANCE_TRIGGER_DIR: triggerDir, STORAGE_MAINTENANCE_SCRIPT: maintenance, STORAGE_MAINTENANCE_PROCESSOR_LOCK: path.join(fixture,"processor.lock") },
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

function cacheFixture(exit = 0) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "storage-cache-request-"));
  const trigger = path.join(root, "trigger"); fs.mkdirSync(trigger);
  const calls = path.join(root, "calls");
  const helper = path.join(root, "cache.py");
  fs.writeFileSync(helper, `import sys\nwith open(${JSON.stringify(calls)}, 'a') as f: f.write('cache:'+','.join(sys.argv[1:])+'\\n')\nsys.exit(${exit})\n`);
  const report = path.join(root, "report.sh");
  fs.writeFileSync(report, `#!/bin/sh\nprintf 'report:%s\\n' "$*" >> '${calls}'\n`); fs.chmodSync(report, 0o755);
  return { root, trigger, calls, env: { ...process.env, STORAGE_MAINTENANCE_TRIGGER_DIR: trigger, STORAGE_MAINTENANCE_SCRIPT: report, STORAGE_BUILD_CACHE_HELPER: helper, STORAGE_MAINTENANCE_PROCESSOR_LOCK: path.join(root,"processor.lock") } };
}

test("only the explicit scheduled request queues cache; arguments cannot select commands", () => {
  const x=cacheFixture();
  try {
    assert.equal(spawnSync(requestScript,["--daily-build-cache"],{env:x.env}).status,0);
    assert.ok(fs.existsSync(path.join(x.trigger,"build-cache-trigger")));
    assert.ok(!fs.existsSync(path.join(x.trigger,"manual-trigger")));
    assert.equal(spawnSync(requestScript,["--daily-build-cache"],{env:x.env}).status,0);
    assert.equal(spawnSync(requestScript,["--daily-build-cache","extra"],{env:x.env}).status,64);
    assert.equal(spawnSync(requestScript,["--other"],{env:x.env}).status,64);
    assert.equal(spawnSync(processScript,[],{env:x.env}).status,0);
    assert.equal(fs.readFileSync(x.calls,"utf8"),"cache:--daily\n");
    assert.equal(spawnSync(processScript,[],{env:x.env}).status,0);
    assert.equal(fs.readFileSync(x.calls,"utf8"),"cache:--daily\n");
  } finally {fs.rmSync(x.root,{recursive:true,force:true});}
});

test("uncertain cache result keeps processing receipt and never requeues or blocks metadata", () => {
  const x=cacheFixture(1);
  try {
    assert.equal(spawnSync(requestScript,["--daily-build-cache"],{env:x.env}).status,0);
    assert.equal(spawnSync(requestScript,[],{env:x.env}).status,0);
    assert.equal(spawnSync(processScript,[],{env:x.env}).status,1);
    assert.ok(fs.existsSync(path.join(x.trigger,"build-cache-processing")));
    assert.ok(!fs.existsSync(path.join(x.trigger,"build-cache-trigger")));
    assert.equal(spawnSync(requestScript,["--daily-build-cache"],{env:x.env}).status,75);
    assert.equal(spawnSync(requestScript,[],{env:x.env}).status,0);
    assert.equal(spawnSync(processScript,[],{env:x.env}).status,75);
    const lines=fs.readFileSync(x.calls,"utf8").trim().split("\n");
    assert.equal(lines.filter(l=>l.startsWith("cache:")).length,1);
    assert.equal(lines.filter(l=>l==="report:--apply --category report").length,2);
  } finally {fs.rmSync(x.root,{recursive:true,force:true});}
});

test("known pre-dispatch contention retains the same request and later succeeds", () => {
  const x = cacheFixture(75);
  try {
    assert.equal(spawnSync(requestScript, ["--daily-build-cache"], {env:x.env}).status, 0);
    assert.equal(spawnSync(processScript, [], {env:x.env}).status, 75);
    assert.ok(fs.existsSync(path.join(x.trigger, "build-cache-trigger")));
    assert.ok(!fs.existsSync(path.join(x.trigger, "build-cache-processing")));
    fs.writeFileSync(x.env.STORAGE_BUILD_CACHE_HELPER, "import sys\nsys.exit(0)\n");
    assert.equal(spawnSync(processScript, [], {env:x.env}).status, 0);
    assert.ok(!fs.existsSync(path.join(x.trigger, "build-cache-trigger")));
  } finally { fs.rmSync(x.root, {recursive:true, force:true}); }
});

test("request refuses a symlink instead of following it", () => {
  const x=cacheFixture();
  try {
    const target=path.join(x.root,"protected");fs.writeFileSync(target,"preserved");
    fs.symlinkSync(target,path.join(x.trigger,"build-cache-trigger"));
    assert.equal(spawnSync(requestScript,["--daily-build-cache"],{env:x.env}).status,73);
    assert.equal(fs.readFileSync(target,"utf8"),"preserved");
    assert.equal(spawnSync(processScript,[],{env:x.env}).status,0);
    assert.ok(!fs.existsSync(x.calls));
  } finally {fs.rmSync(x.root,{recursive:true,force:true});}
});

test("transport lock prevents concurrent helper dispatch", () => {
  const x=cacheFixture();
  try {
    assert.equal(spawnSync(requestScript,["--daily-build-cache"],{env:x.env}).status,0);
    const locked=spawnSync("flock",[path.join(x.root,"processor.lock"),processScript],{env:x.env});
    assert.equal(locked.status,0);
    assert.ok(!fs.existsSync(x.calls));
    assert.ok(fs.existsSync(path.join(x.trigger,"build-cache-trigger")));
    assert.equal(spawnSync(processScript,[],{env:x.env}).status,0);
    assert.equal(fs.readFileSync(x.calls,"utf8"),"cache:--daily\n");
  } finally {fs.rmSync(x.root,{recursive:true,force:true});}
});
