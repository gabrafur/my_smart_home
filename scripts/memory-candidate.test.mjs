import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { applyCandidate } from "./memory-candidate.mjs";
import { records } from "./memory-evidence.mjs";
import { checkPublicMemory } from "./public-memory-check.mjs";

import { fixture, target, source } from "./test-support/memory-fixture.mjs";

test("candidate validates before writing, persists, deduplicates and is read by a new process", (t) => {
  const f = fixture(t);
  const before = f.read();
  assert.deepEqual(applyCandidate(f.root, f.candidate(), f), { changed: true, applied: false });
  assert.equal(f.read(), before);
  assert.deepEqual(applyCandidate(f.root, f.candidate(), { ...f, apply: true }), { changed: true, applied: true });
  const persisted = f.read();
  assert.equal(records(persisted).filter((r) => r.metadata.id === "synthetic-adapter").length, 1);
  assert.deepEqual(applyCandidate(f.root, { ...f.candidate(), last_verified: "2026-09-22" }, { ...f, apply: true }), { changed: false, applied: false });
  assert.equal(f.read(), persisted);
  const observed = execFileSync(process.execPath, ["--input-type=module", "-e", "import fs from 'node:fs';process.stdout.write(fs.readFileSync(process.argv[1],'utf8'))", path.join(f.root, target)], { encoding: "utf8" });
  assert.match(observed, /synthetic adapter is blue/);
});

test("changed code invalidates evidence and a verified replacement updates the same record", (t) => {
  const f = fixture(t);
  applyCandidate(f.root, f.candidate(), { ...f, apply: true });
  fs.writeFileSync(path.join(f.root, source), 'export const adapter = "green";\n');
  const audit = checkPublicMemory({ repoRoot: f.root, trackedFiles: f.trackedFiles });
  assert.ok(audit.errors.some((e) => e.includes("evidence_changed")));
  applyCandidate(f.root, { ...f.candidate(), body: "The synthetic adapter is green." }, { ...f, apply: true });
  assert.doesNotMatch(f.read(), /synthetic adapter is blue/);
  assert.equal(records(f.read()).filter((r) => r.metadata.id === "synthetic-adapter").length, 1);
});

test("privacy, poisoning and obsolete evidence are rejected without persistence", (t) => {
  const f = fixture(t);
  const original = f.read();
  for (const change of [
    { body: "password=" + "synthetic-secret-value" },
    { body: "sk-" + "A".repeat(36) },
    { kind: "HYPOTHESIS" },
    { evidence: [{ file: source, sha256: "0".repeat(64) }] },
    { evidence: [{ file: ".agent-history/turns.jsonl", sha256: "0".repeat(64) }] },
    { file: "../outside.md" },
    { body: "<!-- nested record -->" },
  ]) {
    assert.throws(() => applyCandidate(f.root, { ...f.candidate(), ...change }, { ...f, apply: true }));
    assert.equal(f.read(), original);
  }
});

test("accidentally tracked private state is never accepted as evidence", (t) => {
  const f = fixture(t);
  f.trackedFiles.push(".local-state/private.json");
  const original = f.read();
  assert.throws(() => applyCandidate(f.root, {
    ...f.candidate(), evidence: [{ file: ".local-state/private.json", sha256: "0".repeat(64) }],
  }, { ...f, apply: true }), /private runtime|tracked public source/);
  assert.equal(f.read(), original);
});

test("stale candidate and concurrent writer preserve existing work", (t) => {
  const f = fixture(t);
  const old = f.candidate();
  fs.appendFileSync(path.join(f.root, target), "\nUser work.\n");
  assert.throws(() => applyCandidate(f.root, old, { ...f, apply: true }), /memory changed/);
  const current = f.read();
  fs.writeFileSync(path.join(f.root, target + ".memory-lock"), "busy");
  assert.throws(() => applyCandidate(f.root, f.candidate(), { ...f, apply: true }), /EEXIST/);
  assert.equal(f.read(), current);
});

test("duplicate ids and symlink evidence fail closed", (t) => {
  const f = fixture(t);
  applyCandidate(f.root, f.candidate(), { ...f, apply: true });
  const record = records(f.read()).find((r) => r.metadata.id === "synthetic-adapter");
  fs.appendFileSync(path.join(f.root, target), `\n${record.raw}\n`);
  assert.ok(checkPublicMemory({ repoRoot: f.root, trackedFiles: f.trackedFiles }).errors.some((e) => /duplicate memory id/.test(e)));
  fs.writeFileSync(path.join(f.root, target), f.read().slice(0, -record.raw.length - 2));
  fs.renameSync(path.join(f.root, source), path.join(f.root, source + ".real"));
  fs.symlinkSync(path.join(f.root, source + ".real"), path.join(f.root, source));
  assert.throws(() => applyCandidate(f.root, f.candidate(), { ...f, apply: true }), /symlink rejected/);
});
