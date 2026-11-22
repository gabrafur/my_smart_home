import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const cwd = fileURLToPath(new URL("./host-identity/", import.meta.url));

// Runs the synthetic host_operator rendering and migration suite so canonical validation covers it.
test("host identity migration renders roles and pins its sources", () => {
  const result = spawnSync("python3", ["-B", "-m", "unittest", "test_migrate"], { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Ran 9 tests/);
});
