#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const toolsDirectory = path.dirname(fileURLToPath(import.meta.url));
const excluded = new Set(["test-all.mjs"]);
const tests = fs.readdirSync(toolsDirectory)
  .filter((file) => file.startsWith("test-") && file.endsWith(".mjs") && !excluded.has(file))
  .sort();

if (tests.length === 0) {
  console.error("No public Node-RED tests discovered.");
  process.exit(1);
}

for (const test of tests) {
  console.log(`\n[Node-RED public test] ${test}`);
  const result = spawnSync(process.execPath, [path.join(toolsDirectory, test)], {
    cwd: path.dirname(toolsDirectory),
    stdio: "inherit",
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log(`\nNode-RED public test suite passed (${tests.length} files).`);
