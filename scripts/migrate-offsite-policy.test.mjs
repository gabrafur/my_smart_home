import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { migrateOffsitePolicy } from "./migrate-offsite-policy.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "offsite-policy-migration-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "restore"));
  const source = path.join(root, "restore/offsite-backup-policy.json");
  const destination = path.join(root, ".local-secrets/offsite-backup-policy.json");
  const bytes = Buffer.from('{"schema_version":1,"active":true,"receipt":"synthetic"}\n');
  fs.writeFileSync(source, bytes);
  return { root, source, destination, bytes };
}

test("migration copies exact bytes privately before removal and is idempotent", (t) => {
  const { root, source, destination, bytes } = fixture(t);
  assert.equal(migrateOffsitePolicy(root), "copied-and-verified");
  assert.deepEqual(fs.readFileSync(destination), bytes);
  assert.equal(fs.statSync(destination).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(destination)).mode & 0o777, 0o700);
  assert.equal(migrateOffsitePolicy(root), "already-migrated");
  assert.deepEqual(fs.readFileSync(source), bytes);
  fs.rmSync(source);
  assert.equal(migrateOffsitePolicy(root), "already-migrated");
});

test("migration preserves a different private policy and never replaces it", (t) => {
  const { root, destination } = fixture(t);
  fs.mkdirSync(path.dirname(destination), { mode: 0o700 });
  fs.writeFileSync(destination, '{"active":false}\n', { mode: 0o600 });
  const before = fs.readFileSync(destination);
  assert.throws(() => migrateOffsitePolicy(root), /already differs/);
  assert.deepEqual(fs.readFileSync(destination), before);
});

test("migration fails closed without a source or when paths are unsafe", (t) => {
  const { root, source, destination } = fixture(t);
  fs.rmSync(source);
  assert.throws(() => migrateOffsitePolicy(root), /both missing/);
  fs.writeFileSync(source, '{"active":true}\n');
  fs.mkdirSync(path.dirname(destination), { mode: 0o700 });
  fs.symlinkSync(source, destination);
  assert.throws(() => migrateOffsitePolicy(root), /regular mode-0600 file/);
  fs.rmSync(destination);
  fs.chmodSync(path.dirname(destination), 0o755);
  assert.throws(() => migrateOffsitePolicy(root), /mode-0700 directory/);
});

test("migration does not mistake a disabled bootstrap example for an active policy", (t) => {
  const { root, source, destination } = fixture(t);
  fs.mkdirSync(path.dirname(destination), { mode: 0o700 });
  fs.writeFileSync(destination, '{"active":false}\n', { mode: 0o600 });
  fs.rmSync(source);
  assert.throws(() => migrateOffsitePolicy(root), /not activated/);
});

test("documented pre-publish migration is repeatable and preserves a divergent private file", {
  skip: process.platform === "win32",
}, (t) => {
  const { root, destination, bytes } = fixture(t);
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const commands = ["docs/RESTORE_CONTRACT.md", "docs/RESTORE_CONTRACT.en.md"].map((file) => {
    const text = fs.readFileSync(path.join(projectRoot, file), "utf8").replace(/\r\n/g, "\n");
    const match = text.match(/```bash\n(set -eu\n[\s\S]*?cmp restore\/offsite-backup-policy\.json \.local-secrets\/offsite-backup-policy\.json)\n```/);
    assert(match, `${file} must contain the guarded migration procedure`);
    return match[1];
  });
  assert.equal(commands[0], commands[1]);
  const run = () => spawnSync("bash", ["-c", commands[0]], { cwd: root, encoding: "utf8" });
  assert.equal(run().status, 0);
  assert.equal(run().status, 0);
  assert.deepEqual(fs.readFileSync(destination), bytes);
  fs.writeFileSync(destination, '{"active":false}\n', { mode: 0o600 });
  assert.notEqual(run().status, 0);
  assert.equal(fs.readFileSync(destination, "utf8"), '{"active":false}\n');
});
