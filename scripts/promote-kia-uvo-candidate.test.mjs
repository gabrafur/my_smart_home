#!/usr/bin/env node

import assert from "node:assert/strict";
import test from "node:test";

import {
  isAllowedCandidatePath,
  normalizeCandidateStatus,
} from "./promote-kia-uvo-candidate.mjs";

test("accepts only a successful pushed Kia UVO candidate", () => {
  const candidate = normalizeCandidateStatus({
    state: "success",
    target: "v3.11.0",
    branch: "codex/kia-uvo-3.11.0-20260831t154312z",
    commit: "dbdd9f75932bf16d71a8b9d91fc2a6ef8f85e012",
    pushed: true,
  });
  assert.equal(candidate.target, "v3.11.0");
  assert.equal(normalizeCandidateStatus({ state: "running" }), null);
  assert.throws(() => normalizeCandidateStatus({
    state: "success",
    target: "v3.11.0",
    branch: "main",
    commit: "dbdd9f75932bf16d71a8b9d91fc2a6ef8f85e012",
    pushed: true,
  }), /branch/);
});

test("promotion allowlist excludes infrastructure and secrets", () => {
  assert.equal(isAllowedCandidatePath("homeassistant/custom_components/kia_uvo/manifest.json"), true);
  assert.equal(isAllowedCandidatePath("scripts/kia-uvo-upstream.json"), true);
  assert.equal(isAllowedCandidatePath("docker-compose.yml"), false);
  assert.equal(isAllowedCandidatePath(".local-secrets/token"), false);
});
