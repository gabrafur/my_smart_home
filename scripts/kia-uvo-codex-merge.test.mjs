#!/usr/bin/env node

import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyAgentFailure,
  isAllowedMergePath,
  normalizeTarget,
  refreshCodexAuth,
  startupStatusPatch,
} from "./kia-uvo-codex-merge.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("normalizes and validates Kia UVO merge targets", () => {
  assert.equal(normalizeTarget("3.11.0"), "v3.11.0");
  assert.equal(normalizeTarget("v3.11.0"), "v3.11.0");
  assert.throws(() => normalizeTarget("main"), /invalid target/);
  assert.throws(() => normalizeTarget("v3.11.0;touch-x"), /invalid target/);
});

test("limits Codex merge output to the Kia component and upstream metadata", () => {
  assert.equal(isAllowedMergePath("homeassistant/custom_components/kia_uvo/manifest.json"), true);
  assert.equal(isAllowedMergePath("scripts/kia-uvo-upstream.json"), true);
  assert.equal(isAllowedMergePath("docker-compose.yml"), false);
  assert.equal(isAllowedMergePath("bindings/private/example"), false);
});

test("preserves terminal status across worker restarts", () => {
  assert.equal(startupStatusPatch({ state: "success", target: "v3.11.0" }), null);
  assert.equal(startupStatusPatch({ state: "failed", target: "v3.11.0" }), null);
  assert.equal(startupStatusPatch({ state: "waiting" }).state, "waiting");
  const interrupted = startupStatusPatch({ state: "running", target: "v3.12.0" });
  assert.equal(interrupted.state, "failed");
  assert.equal(interrupted.reason, "worker_restarted");
  assert.equal(interrupted.reason_code, "worker_restarted");
  assert.equal(interrupted.failure_stage, "worker_runtime");
  assert.equal(interrupted.target, "v3.12.0");
});

test("refreshes the protected Codex auth copy atomically", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kia-auth-refresh-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source.json");
  const destinationRoot = path.join(root, "runtime");
  const destination = path.join(destinationRoot, "auth.json");
  fs.mkdirSync(destinationRoot, { mode: 0o700 });
  fs.writeFileSync(source, '{"token":"fresh-fixture"}\n', { mode: 0o600 });
  fs.writeFileSync(destination, '{"token":"stale-fixture"}\n', { mode: 0o600 });
  refreshCodexAuth(source, destination);
  assert.equal(fs.readFileSync(destination, "utf8"), '{"token":"fresh-fixture"}\n');
  assert.equal(fs.statSync(destination).mode & 0o777, 0o600);
  assert.equal(fs.readdirSync(destinationRoot).length, 1);
});

test("classifies only closed Codex failure categories", () => {
  assert.deepEqual(classifyAgentFailure("401 Unauthorized token_expired private detail"), {
    reason_code: "codex_authentication_failed", failure_stage: "codex_authentication",
  });
  assert.deepEqual(classifyAgentFailure("unrecognized private failure"), {
    reason_code: "codex_execution_failed", failure_stage: "codex_execution",
  });
});
