#!/usr/bin/env node

import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  checkCandidateMemory,
  checkCandidatePrivacy,
  canAcceptAbsorbedDelta,
  changedFilesFromDelta,
  normalizeVersion,
  parseTagRefs,
  repositoryArchiveUrl,
  statusLine,
  validVersion,
  pollRuntime,
  runtimeEvidence,
  runCandidateBehaviorTest,
} from "./alexa-media-safe-update.mjs";

const baseline = { entity_ids: ["sensor.example"], active_entity_ids: ["sensor.example"], recorder_rows: 12 };
const activeStates = [{ entity_id: "sensor.example", state: "unknown" }];

test("runtime evidence separates availability from missing entities and history loss", () => {
  assert.deepEqual(runtimeEvidence(activeStates, baseline, baseline), {
    version_ready: true, missing_active: [], missing_registry: [], recorder_before: 12, recorder_after: 12,
  });
  const lost = runtimeEvidence([], baseline, { entity_ids: [], recorder_rows: 0 }, false);
  assert.deepEqual(lost.missing_active, ["sensor.example"]);
  assert.deepEqual(lost.missing_registry, ["sensor.example"]);
  assert.equal(lost.version_ready, false);
});

test("runtime polling preserves diagnostic failures and recovers after startup", async () => {
  let time = 0, calls = 0;
  const evidence = [];
  const result = await pollRuntime({ before: baseline,
    readStates: async () => { if (++calls === 1) throw new Error("connection refused"); return activeStates; },
    readSnapshot: () => baseline, saveEvidence: (e) => evidence.push(e),
    now: () => time, sleep: async (ms) => { time += ms; }, timeoutMs: 20_000,
  });
  assert.equal(evidence[0].reason, "probe_failed");
  assert.equal(evidence[0].error, "connection refused");
  assert.deepEqual(result, { registry_entities: 1, recorder_rows: 12 });
});

for (const [reason, states, snapshot, version] of [
  ["version_not_ready", activeStates, baseline, false],
  ["active_entities_missing", [], baseline, true],
  ["registry_entities_missing", activeStates, { entity_ids: [], recorder_rows: 12 }, true],
  ["recorder_rows_decreased", activeStates, { ...baseline, recorder_rows: 11 }, true],
]) {
  test(`runtime refuses ${reason} and reports the exact failing gate`, async () => {
    let time = 0;
    await assert.rejects(pollRuntime({ before: baseline,
      readStates: async () => states, readSnapshot: () => snapshot, versionReady: () => version,
      now: () => time, sleep: async (ms) => { time += ms; }, timeoutMs: 10_000,
    }), new RegExp(reason));
  });
}

test("Alexa Media versions and annotated tags are normalized exactly", () => {
  assert.equal(normalizeVersion("5.16.1"), "v5.16.1");
  assert.equal(normalizeVersion("v5.16.1"), "v5.16.1");
  assert.equal(validVersion("v5.16.1"), true);
  assert.equal(validVersion("v5.16.1;touch /tmp/no"), false);
  assert.deepEqual(parseTagRefs([
    "41d74d9207be106c1693a7c58ad5d3f2bb005684\trefs/tags/v5.16.1",
    "8fd1ba5e5d514152338da0880a5d34d7768c3c47\trefs/tags/v5.16.1^{}",
  ].join("\n"), "v5.16.1"), {
    version: "v5.16.1",
    commit: "8fd1ba5e5d514152338da0880a5d34d7768c3c47",
    tag_object: "41d74d9207be106c1693a7c58ad5d3f2bb005684",
  });
  assert.equal(repositoryArchiveUrl(
    { repository: "alandtse/alexa_media_player" },
    { commit: "8fd1ba5e5d514152338da0880a5d34d7768c3c47" },
  ), "https://github.com/alandtse/alexa_media_player/archive/8fd1ba5e5d514152338da0880a5d34d7768c3c47.tar.gz");
  assert.throws(() => repositoryArchiveUrl(
    { repository: "alandtse/alexa_media_player" },
    { commit: "v5.16.1" },
  ), /archive commit is invalid/);
});

test("only reviewed Alexa Media deltas may be treated as absorbed upstream", () => {
  const delta = [
    "diff -ruN old/alexa_media/__init__.py local/alexa_media/__init__.py",
    "--- old/alexa_media/__init__.py",
    "+++ local/alexa_media/__init__.py",
  ].join("\n");
  assert.deepEqual(changedFilesFromDelta(delta), ["__init__.py"]);
  const metadata = {
    absorbable_local_delta_files: ["__init__.py"],
    required_markers: [{
      file: "__init__.py",
      text: "if alexa_entity_id and binary_sensor.enabled:\n                entities_to_monitor.add(alexa_entity_id)",
    }],
  };
  assert.equal(canAcceptAbsorbedDelta(metadata, ["__init__.py"], () => true), true);
  assert.equal(canAcceptAbsorbedDelta(metadata, ["const.py"], () => true), false);
  assert.equal(canAcceptAbsorbedDelta(metadata, ["__init__.py"], () => false), false);
});

test("Alexa Media status output excludes private failure details", () => {
  const line = statusLine({
    state: "rollback",
    target: "v5.16.1",
    patch_state: "absorbed",
    checked_at: "2026-09-14T13:00:00.000Z",
    reason: "private token and runtime detail",
  });
  assert.match(line, /status=rollback target=v5\.16\.1 patch_state=absorbed/);
  assert.doesNotMatch(line, /private|token|reason/);
});


test("candidate memory permits version metadata and behavior test refuses a broken Kids contract", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const source = path.join(root, "homeassistant/custom_components/alexa_media");
  const metadata = JSON.parse(fs.readFileSync(path.join(root, "scripts/alexa-media-upstream.json")));
  const next = { ...metadata, base_version: "v99.0.0", base_commit: "a".repeat(40) };
  assert.deepEqual(checkCandidateMemory(source, next).errors, []);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "alexa-memory-test-"));
  try {
    fs.cpSync(source, temporary, { recursive: true, filter: (p) => !p.includes("__pycache__") });
    // Upstream files are no longer memory evidence: a release that changes them without
    // changing the reviewed behavior is admitted...
    fs.appendFileSync(path.join(temporary, "amazon_kids.py"), "\n# synthetic upstream change\n");
    assert.deepEqual(checkCandidateMemory(temporary, next).errors, []);
    runCandidateBehaviorTest(temporary);
    // ...and a release that breaks the shared Kids polling is refused by the behavior test.
    fs.rmSync(path.join(temporary, "amazon_kids.py"));
    assert.throws(() => runCandidateBehaviorTest(temporary), /candidate_amazon_kids_behavior_test_failed/);
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
  const code = fs.readFileSync(new URL("./alexa-media-safe-update.mjs", import.meta.url), "utf8");
  const apply = code.slice(code.indexOf("async function apply(target)"));
  assert.ok(apply.indexOf("checkCandidateMemory(") < apply.indexOf("const token = readHaToken()"));
  assert.match(statusLine({ state: "blocked", reason: "public_memory_invalid" }), /reason=public_memory_invalid/);
});

test("candidate behavior test runs the Kids regression against the staged tree only", () => {
  const calls = [];
  runCandidateBehaviorTest("/staged/alexa_media", { execute: (cmd, args, options) => calls.push({ cmd, args, options }) });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ["-E", "-s", "-m", "unittest", "test_alexa_media_amazon_kids"]);
  assert.equal(calls[0].options.env.ALEXA_MEDIA_COMPONENT_ROOT, "/staged/alexa_media");
  assert.deepEqual(Object.keys(calls[0].options.env).sort(), ["ALEXA_MEDIA_COMPONENT_ROOT", "PATH"]);
  assert.match(calls[0].options.cwd, /homeassistant\/tests$/);
  assert.throws(() => runCandidateBehaviorTest("/staged", { execute: () => { throw new Error("exit 1 with private output"); } }),
    /^Error: candidate_amazon_kids_behavior_test_failed$/);
});

test("candidate privacy gate blocks unaudited images before any runtime change", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "alexa-privacy-"));
  try {
    fs.mkdirSync(path.join(root, "brand"));
    fs.mkdirSync(path.join(root, "__pycache__"));
    fs.writeFileSync(path.join(root, "__init__.py"), "VALUE = 1\n");
    fs.writeFileSync(path.join(root, "__pycache__", "x.png"), "ignored cache");
    assert.deepEqual(checkCandidatePrivacy(root), []);
    fs.writeFileSync(path.join(root, "brand", "new.png"), "\x89PNG unreviewed");
    assert.deepEqual(checkCandidatePrivacy(root), [
      { rule: "image-location", file: "homeassistant/custom_components/alexa_media/brand/new.png" },
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("candidate privacy gate accepts the audited upstream brand icons", () => {
  const installed = new URL("../homeassistant/custom_components/alexa_media/brand/", import.meta.url);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "alexa-privacy-"));
  try {
    fs.mkdirSync(path.join(root, "brand"));
    const names = fs.readdirSync(installed).filter((name) => name.endsWith(".png"));
    assert.equal(names.length, 2);
    for (const name of names) fs.copyFileSync(new URL(name, installed), path.join(root, "brand", name));
    assert.deepEqual(checkCandidatePrivacy(root), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
