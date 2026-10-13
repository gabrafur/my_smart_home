#!/usr/bin/env node

import assert from "node:assert/strict";
import test from "node:test";

import {
  canAcceptAbsorbedDelta,
  changedFilesFromDelta,
  normalizeVersion,
  parseTagRefs,
  repositoryArchiveUrl,
  statusLine,
  validVersion,
  pollRuntime,
  runtimeEvidence,
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
