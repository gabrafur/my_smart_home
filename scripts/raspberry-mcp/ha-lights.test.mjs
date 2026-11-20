import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const cwd = fileURLToPath(new URL("./ha-lights/", import.meta.url));

// Runs the synthetic broker suite and the route test so canonical validation covers them.
test("household lighting broker passes its synthetic suite", () => {
  const result = spawnSync("python3", ["-B", "-m", "unittest", "test_broker"], { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Ran 16 tests/);
});

test("household lighting route refuses unregistered targets", () => {
  const result = spawnSync(process.execPath, ["lights-route.test.mjs"], { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});
