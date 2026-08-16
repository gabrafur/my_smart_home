#!/usr/bin/env node

import assert from "node:assert/strict";
import test from "node:test";

import {
  replaceServiceImage,
  updateIsProtected,
} from "./docker-auto-update.mjs";

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
