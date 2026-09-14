#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  findActiveHostUpdateStage,
  isAllowedCandidatePath,
  normalizeCandidateStatus,
  shouldResumeCandidateCleanup,
} from "./promote-kia-uvo-candidate.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const promotionScript = path.join(scriptDir, "promote-kia-uvo-candidate.mjs");
const mergeEntrypoint = path.join(scriptDir, "kia-uvo-codex-merge-entrypoint.sh");

test("Kia publication uses GitHub SSH 443 with strict host verification", () => {
  for (const file of [promotionScript, mergeEntrypoint]) {
    const source = fs.readFileSync(file, "utf8");
    assert.match(source, /Hostname=ssh\.github\.com/);
    assert.match(source, /HostKeyAlias=github\.com/);
    assert.match(source, /Port=443/);
    assert.match(source, /StrictHostKeyChecking=yes/);
  }
});

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

test("Kia promotion defers while another host update stage is active", () => {
  const triggerDir = fs.mkdtempSync(path.join(os.tmpdir(), "kia-promotion-stage-test-"));
  assert.equal(findActiveHostUpdateStage(triggerDir), null);
  fs.writeFileSync(path.join(triggerDir, "containers-processing"), "request\n");
  assert.equal(findActiveHostUpdateStage(triggerDir), "containers");
  fs.rmSync(triggerDir, { recursive: true, force: true });
});

test("only resumes candidate cleanup after main has been published", () => {
  const candidate = normalizeCandidateStatus({
    state: "success",
    target: "v3.11.0",
    branch: "codex/kia-uvo-3.11.0-20260831t154312z",
    commit: "dbdd9f75932bf16d71a8b9d91fc2a6ef8f85e012",
    pushed: true,
  });
  assert.equal(shouldResumeCandidateCleanup({
    state: "main_published",
    source_commit: candidate.commit,
  }, candidate), true);
  assert.equal(shouldResumeCandidateCleanup({
    state: "runtime_applied",
    source_commit: candidate.commit,
  }, candidate), false);
  assert.equal(shouldResumeCandidateCleanup({
    state: "main_published",
    source_commit: "f".repeat(40),
  }, candidate), false);
});
