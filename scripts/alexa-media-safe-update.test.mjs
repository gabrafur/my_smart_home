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
} from "./alexa-media-safe-update.mjs";

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
    required_markers: [{ file: "__init__.py", text: "getattr" }],
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
