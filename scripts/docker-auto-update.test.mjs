#!/usr/bin/env node

import assert from "node:assert/strict";
import test from "node:test";

import {
  replaceServiceImage,
  updateIsProtected,
} from "./docker-auto-update.mjs";
import {
  preferFullCommit,
  updateMatchesTarget,
} from "./kia-uvo-safe-update.mjs";

test("replaces an image even when comments precede it", () => {
  const compose = `services:
  first:
    image: example/first@sha256:old
  matter_server:
    # Operational comment that used to break the regex parser.
    # A second comment keeps this fixture representative.
    image: example/matter@sha256:old
    restart: always
  last:
    image: example/last@sha256:old
`;
  const result = replaceServiceImage(compose, "matter_server", "example/matter@sha256:new");
  assert.equal(result.current, "example/matter@sha256:old");
  assert.match(result.compose, /matter_server:[\s\S]*image: example\/matter@sha256:new/);
  assert.match(result.compose, /first:[\s\S]*image: example\/first@sha256:old/);
  assert.match(result.compose, /last:[\s\S]*image: example\/last@sha256:old/);
});

test("does not cross into the next service", () => {
  const compose = `services:
  build_only:
    build: .
  next:
    image: example/next:latest
`;
  assert.throws(
    () => replaceServiceImage(compose, "build_only", "example/build:new"),
    /Could not find image property/,
  );
});

test("routes Hyundai Kia updates to analysis instead of blind install", () => {
  assert.equal(updateIsProtected({
    entity_id: "update.kia_uvo_hyundai_bluelink_update",
    attributes: { friendly_name: "Kia Uvo / Hyundai Bluelink" },
  }), true);
  assert.equal(updateIsProtected({
    entity_id: "update.hacs_update",
    attributes: { friendly_name: "HACS" },
  }), false);
});

test("recognizes an already installed Kia UVO target", () => {
  const entity = {
    attributes: { installed_version: "v3.10.1" },
  };
  const hacs = { version_installed: "v3.10.1" };
  assert.equal(updateMatchesTarget(entity, hacs, "3.10.1"), true);
  assert.equal(updateMatchesTarget(entity, hacs, "v3.10.2"), false);
  assert.equal(
    updateMatchesTarget(entity, { version_installed: "v3.9.0" }, "v3.10.1"),
    false,
  );
});

test("preserves the full upstream commit when HACS reports a prefix", () => {
  const full = "2c602560746318fd001db8fe52347e9398f181ed";
  assert.equal(preferFullCommit(full, "2c60256"), full);
  assert.equal(preferFullCommit("2c60256", full), full);
});
