import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const cwd = fileURLToPath(new URL("./notice-provenance/", import.meta.url));

// Runs the Python suites so the canonical validation covers them.
test("notice provenance derivation and reader projection pass", () => {
  for (const [module, count] of [["test_derive", 2], ["test_provenance", 1]]) {
    const result = spawnSync("python3", ["-B", "-m", "unittest", module], { cwd, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, new RegExp(`Ran ${count} tests?`));
  }
});

test("collector boundary provenance keeps revisions and refuses forged labels", () => {
  const result = spawnSync(process.execPath, ["--test", "test_provenance.cjs"], { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
