import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { bootstrapClone } from "./bootstrap.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function copyFile(root, relative) {
  const destination = path.join(root, relative);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(path.join(repoRoot, relative), destination);
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bootstrap-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const file of [
    ".env.example",
    "homeassistant/secrets.yaml.example",
    "bindings/private-bindings.example.json",
    "zigbee2mqtt/configuration.example.yaml",
    "templates/appdaemon/secrets.yaml.example",
    "modules/features.json",
    "bootstrap/bootstrap-manifest.json",
  ]) copyFile(root, file);
  return root;
}

function hash(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

test("bootstrap creates only selected private templates and safe random values", (t) => {
  const root = fixture(t);
  const result = bootstrapClone(root, { selectedModules: ["core"], checkTools: false });
  assert.equal(result.overwritten, false);
  assert.equal(result.containers_started, false);
  assert.deepEqual(new Set(result.created), new Set([".env", "homeassistant/secrets.yaml", "bindings/private/private-bindings.json"]));
  assert.equal(fs.existsSync(path.join(root, "zigbee2mqtt/configuration.yaml")), false);
  const env = fs.readFileSync(path.join(root, ".env"), "utf8");
  assert.match(env, /^NODE_RED_CREDENTIAL_SECRET=[0-9a-f]{64}$/m);
  assert.match(env, /^CLAUDE_BRIDGE_TOKEN=[0-9a-f]{64}$/m);
  assert.equal(fs.statSync(path.join(root, ".env")).mode & 0o777, 0o600);
  assert.ok(result.gaps.some((gap) => gap.logical_name === "mosquitto_credentials"));
});

test("bootstrap is idempotent and never overwrites existing private files", (t) => {
  const root = fixture(t);
  bootstrapClone(root, { selectedModules: ["core"], checkTools: false });
  const envFile = path.join(root, ".env");
  const before = hash(envFile);
  const second = bootstrapClone(root, { selectedModules: ["core"], checkTools: false });
  assert.equal(hash(envFile), before);
  assert.ok(second.preserved.includes(".env"));
  assert.deepEqual(second.created, []);
});

test("optional module dependencies expand without requiring unrelated modules", (t) => {
  const root = fixture(t);
  const result = bootstrapClone(root, { selectedModules: ["zigbee", "appdaemon"], checkTools: false });
  assert.deepEqual(new Set(result.modules), new Set(["core", "zigbee", "appdaemon"]));
  assert.equal(fs.existsSync(path.join(root, "zigbee2mqtt/configuration.yaml")), true);
  assert.equal(fs.existsSync(path.join(root, ".local-secrets/appdaemon-secrets.yaml")), true);
});

test("unknown modules and destination symlinks fail closed", (t) => {
  const root = fixture(t);
  assert.throws(() => bootstrapClone(root, { selectedModules: ["not-a-module"], checkTools: false }), /unknown module/);
  fs.symlinkSync(path.join(root, ".env.example"), path.join(root, ".env"));
  assert.throws(() => bootstrapClone(root, { selectedModules: ["core"], checkTools: false }), /symlink rejected/);
});

test("a symlinked destination parent cannot redirect bootstrap outside the clone", (t) => {
  const root = fixture(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "bootstrap-outside-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "bindings"), { recursive: true });
  fs.symlinkSync(outside, path.join(root, "bindings/private"));
  assert.throws(() => bootstrapClone(root, { selectedModules: ["core"], checkTools: false }), /symlink rejected/);
  assert.deepEqual(fs.readdirSync(outside), []);
});
