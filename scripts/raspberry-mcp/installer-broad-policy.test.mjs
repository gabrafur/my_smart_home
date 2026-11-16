import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Runs the synthetic Python suite so the canonical validation covers it.
test("installer broad client policy derivation passes its synthetic suite", () => {
  const cwd = fileURLToPath(new URL("./installer-broad-policy/", import.meta.url));
  const result = spawnSync("python3", ["-B", "-m", "unittest", "test_derive"], { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Ran 2 tests/);
});
