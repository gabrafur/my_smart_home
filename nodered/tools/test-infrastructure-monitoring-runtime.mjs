#!/usr/bin/env node

import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
for (const test of [
  "test-internet-monitor-flow.mjs",
  "test-zigbee-monitor-flow.mjs",
  "test-tuya-monitor-flow.mjs",
]) {
  const result = spawnSync(process.execPath, [path.join(here, test)], {
    cwd: path.dirname(here), stdio: "inherit",
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
console.log("Infrastructure restart, recovery and dry-run replays passed.");
