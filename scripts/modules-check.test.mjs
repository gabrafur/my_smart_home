import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { validateModules } from "./modules-check.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "..");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "modules-check-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "modules"), { recursive: true });
  fs.copyFileSync(path.join(repositoryRoot, "docker-compose.yml"), path.join(root, "docker-compose.yml"));
  fs.copyFileSync(path.join(repositoryRoot, "compose.modules.yml"), path.join(root, "compose.modules.yml"));
  const manifest = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "modules/features.json"), "utf8"));
  for (const module of manifest.modules) module.configuration = [];
  fs.writeFileSync(path.join(root, "modules/features.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return { root, manifest };
}

test("the public module graph and Compose profile overlay are coherent", (t) => {
  const { root } = fixture(t);
  assert.deepEqual(validateModules(root), {
    valid: true,
    errors: [],
    modules: 13,
    core_services: 3,
  });
});

test("an unknown module dependency fails closed", (t) => {
  const { root, manifest } = fixture(t);
  manifest.modules.find((module) => module.name === "vehicle").depends_on.push("unknown-module");
  fs.writeFileSync(path.join(root, "modules/features.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  const result = validateModules(root);
  assert.equal(result.valid, false);
  assert.ok(result.errors.includes("unknown module dependency unknown-module"));
});
