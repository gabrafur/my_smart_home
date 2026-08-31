#!/usr/bin/env node

import assert from "node:assert/strict";
import test from "node:test";

import {
  isAllowedMergePath,
  normalizeTarget,
  startupStatusPatch,
} from "./kia-uvo-codex-merge.mjs";

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
  assert.equal(interrupted.target, "v3.12.0");
});
