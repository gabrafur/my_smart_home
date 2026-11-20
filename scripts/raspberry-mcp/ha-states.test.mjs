import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const cwd = fileURLToPath(new URL("./ha-states/", import.meta.url));

// Runs the synthetic broker suite and the route test so canonical validation covers them.
test("read-only Home Assistant state broker passes its synthetic suite", () => {
  const result = spawnSync("python3", ["-B", "-m", "unittest", "test_broker"], { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Ran 10 tests/);
});

test("read-only state route refuses unregistered entities", () => {
  const result = spawnSync(process.execPath, ["states-route.test.mjs"], { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});
