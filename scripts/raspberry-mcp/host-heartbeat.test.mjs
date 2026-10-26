import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("heartbeat failure diagnostics preserve history without network effects", () => {
  const suite = fileURLToPath(new URL("./runtime-source/host-heartbeat/", import.meta.url));
  const result = spawnSync("python3", ["-I", "-S", "-B", "-m", "unittest", "discover", "-s", suite, "-p", "test_*.py"], {
    encoding: "utf8", timeout: 30_000, maxBuffer: 128 * 1024,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Ran 21 tests/);
});
