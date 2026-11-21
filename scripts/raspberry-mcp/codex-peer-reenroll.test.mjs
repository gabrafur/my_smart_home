import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const cwd = fileURLToPath(new URL("./codex-peer-reenroll/", import.meta.url));

// Runs the synthetic re-enrollment suite so canonical validation covers it.
test("Codex peer re-enrollment trusts only registry-verified binaries", () => {
  const result = spawnSync("python3", ["-B", "-m", "unittest", "test_reenroll"], { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Ran 17 tests/);
});
