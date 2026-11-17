import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("codex account status route and classifier pass their suite", () => {
  const cwd = fileURLToPath(new URL("./codex-account-status/", import.meta.url));
  const result = spawnSync(process.execPath, ["account-route.test.mjs"], { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /12 checks passed/);
});
