import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Runs the Python suite against a verbatim fixture of the pre-patch reference closure.
test("client reference continuity derivation passes its suite", () => {
  const cwd = fileURLToPath(new URL("./client-reference-continuity/", import.meta.url));
  const result = spawnSync("python3", ["-B", "-m", "unittest", "test_derive"], { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Ran 4 tests/);
});
