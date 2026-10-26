import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

for (const [label, directory, pattern] of [
  ["fixed capture and scheduled-window selection", "./acceptance-observer/", "test_*.py"],
  ["sanitized health evidence", "./runtime-source/repair-control/", "test_health_summary.py"],
]) {
  test(`procmon acceptance: ${label}`, () => {
    const result = spawnSync("python3", ["-I", "-S", "-B", "-m", "unittest", "discover",
      "-s", fileURLToPath(new URL(directory, import.meta.url)), "-p", pattern], {
      encoding: "utf8", timeout: 30_000, maxBuffer: 128 * 1024,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /Ran [1-9]\d* tests/);
  });
}
