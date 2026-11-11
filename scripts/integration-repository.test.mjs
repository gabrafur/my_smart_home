import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { readRepositoryRecord, snapshotRepository, restoreRepository } from "./integration-repository.mjs";

const repository = "alandtse/alexa_media_player";

test("Marketplace scoped storage, stale identity, foreign updates and atomic failures", () => {
  const result = spawnSync("python3", ["-B", "-m", "unittest", "discover", "-s", "scripts", "-p", "integration_repository_test.py"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Ran 8 tests/);
});

test("repository adapter refuses unknown inputs and snapshots only the selected record", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "repository-snapshot-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const command = (binary, args, options) => {
    assert.equal(binary, "docker");assert.deepEqual(args.slice(0, 4), ["exec", "-i", "homeassistant", "python"]);
    const request = JSON.parse(options.input);assert.equal(request.repository, repository);
    return JSON.stringify({ source: "marketplace.repositories", record: { full_name: repository } });
  };
  assert.throws(() => readRepositoryRecord("other/repository", command), /not_reviewed/);
  const before = snapshotRepository(repository, directory, command);
  assert.equal(before.record.full_name, repository);
  assert.equal(fs.statSync(path.join(directory, "repository-before.json")).mode & 0o777, 0o600);
});

test("rollback requires stopped HA and a bounded helper with no network or capabilities", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "repository-restore-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, "repository-before.json"), "{}");
  assert.throws(() => restoreRepository(repository, directory, "v5.20.0", () => "true"), /stopped_homeassistant/);
  const command = (binary, args, options) => {
    assert.equal(binary, "docker");
    if (args[0] === "inspect") return args[2].includes("Running") ? "false" : `sha256:${"a".repeat(64)}`;
    assert.equal(args[0], "run");
    assert.ok(args.includes("--cap-drop=ALL"));assert.ok(args.includes("no-new-privileges"));
    assert.equal(args[args.indexOf("--network") + 1], "none");
    assert.ok(args.includes("--memory"));assert.ok(args.includes("--pids-limit"));
    assert.equal(JSON.parse(options.input).mode, "restore");
    return '{"state":"own_repository_restored","other_records_preserved":true}';
  };
  assert.equal(restoreRepository(repository, directory, "v5.20.0", command, directory).state, "own_repository_restored");
});
