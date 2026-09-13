#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { normalizeAudit } from "../nodered/tools/scan-repository-dependency-audit.mjs";
import { selectSameMajorTarget, validatePackageName } from "./update-repository-dependency.mjs";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const requestScript = path.join(scriptsDir, "request-host-repository-dependency-update.sh");
const readScript = path.join(scriptsDir, "read-host-repository-dependency-update-result.sh");
const processScript = path.join(scriptsDir, "process-repository-dependency-update-request.sh");
const updateScript = path.join(scriptsDir, "update-repository-dependency.mjs");

test("audit adapter exposes only sanitized candidates and managed surfaces", () => {
  const report = normalizeAudit({ vulnerabilities: {
    joi: { name: "joi", severity: "low", fixAvailable: true, via: [{ title: "private advisory text" }] },
    direct: { name: "direct", severity: "high", fixAvailable: { name: "direct" }, via: [] },
    nested: { name: "nested", severity: "moderate", fixAvailable: false, via: ["direct"] },
  } }, {
    overrides: { joi: "17.13.4" }, dependencies: { direct: "1.0.0" },
  }, { packages: {
    "node_modules/joi": { version: "17.13.4" },
    "node_modules/direct": { version: "1.0.0" },
    "node_modules/nested": { version: "2.0.0" },
  } });
  assert.deepEqual(report.candidates.map((item) => [item.package, item.managed_surface]), [
    ["direct", "dependency"], ["joi", "override"], ["nested", "transitive"],
  ]);
  assert.equal(report.candidates.find((item) => item.package === "joi").advisory_count, 1);
  assert.doesNotMatch(JSON.stringify(report), /private advisory text/);
});

test("package validation and target selection remain exact and same-major", () => {
  assert.equal(validatePackageName("joi"), "joi");
  assert.throws(() => validatePackageName("@scope/pkg"), /package_name_invalid/);
  assert.equal(selectSameMajorTarget("17.13.4", ["17.13.4", "18.0.0", "17.13.6", "17.14.0-beta.1"]), "17.13.6");
});

test("Node-RED bridge coalesces requests and publishes a sanitized success", () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "repository-dependency-bridge-"));
  const triggerDir = path.join(fixture, "trigger");
  const fakeUpdate = path.join(fixture, "update.mjs");
  const fakeSafe = path.join(fixture, "safe.sh");
  fs.mkdirSync(triggerDir);
  fs.writeFileSync(fakeUpdate, 'console.log("repository-dependency-update status=success package=joi from=17.13.4 to=17.13.6");\n');
  fs.writeFileSync(fakeSafe, "#!/bin/sh\nexec \"$@\"\n");
  fs.chmodSync(fakeSafe, 0o755);
  const env = {
    ...process.env,
    DAILY_UPDATE_TRIGGER_DIR: triggerDir,
    REPOSITORY_DEPENDENCY_RESOURCE_SAFE_SCRIPT: fakeSafe,
    REPOSITORY_DEPENDENCY_UPDATE_SCRIPT: fakeUpdate,
    REPOSITORY_DEPENDENCY_NODE_BIN: process.execPath,
  };
  const request = spawnSync(requestScript, ["joi"], { encoding: "utf8", env });
  assert.equal(request.status, 0, request.stderr);
  assert.match(request.stdout, /status=accepted/);
  assert.match(spawnSync(requestScript, ["joi"], { encoding: "utf8", env }).stdout, /status=coalesced/);
  assert.match(spawnSync(requestScript, ["other"], { encoding: "utf8", env }).stdout, /status=deferred/);
  const processed = spawnSync(processScript, [], { encoding: "utf8", env });
  assert.equal(processed.status, 0, processed.stderr);
  const result = spawnSync(readScript, [], { encoding: "utf8", env });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /package=joi status=success/);
  assert.match(result.stdout, /from=17.13.4 to=17.13.6/);
  assert.ok(!fs.existsSync(path.join(triggerDir, "repository-dependency-processing")));
  fs.rmSync(fixture, { recursive: true, force: true });
});

test("updater dry-run finds the newest stable version in the current major", () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "repository-dependency-update-"));
  const nodeRedDir = path.join(fixture, "nodered");
  const fakeNpm = path.join(fixture, "npm");
  fs.mkdirSync(nodeRedDir);
  fs.writeFileSync(path.join(nodeRedDir, "package.json"), JSON.stringify({ overrides: { joi: "17.13.4" } }));
  fs.writeFileSync(path.join(nodeRedDir, "package-lock.json"), JSON.stringify({ packages: { "node_modules/joi": { version: "17.13.4" } } }));
  fs.writeFileSync(fakeNpm, `#!/bin/sh
if [ "$1" = audit ]; then
  echo '{"vulnerabilities":{"joi":{"name":"joi","severity":"low","fixAvailable":true}}}'
elif [ "$1" = view ]; then
  echo '["17.13.4","17.13.6","18.0.0","17.14.0-beta.1"]'
else
  exit 64
fi
`);
  fs.chmodSync(fakeNpm, 0o755);
  const result = spawnSync(process.execPath, [updateScript, "--package", "joi", "--dry-run"], {
    encoding: "utf8",
    env: { ...process.env, REPOSITORY_DEPENDENCY_REPO_ROOT: fixture, REPOSITORY_DEPENDENCY_NPM_BIN: fakeNpm },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /status=eligible package=joi from=17.13.4 to=17.13.6/);
  fs.rmSync(fixture, { recursive: true, force: true });
});

test("runtime installation uses the host-owned bind mount before isolated restart", () => {
  const source = fs.readFileSync(updateScript, "utf8");
  assert.match(source, /run\(npmBin, \["ci"/);
  assert.doesNotMatch(source, /\["exec", "-w", "\/data", "nodered", "npm", "ci"/);
  assert.match(source, /\["compose", "restart", "nodered"\]/);
});
