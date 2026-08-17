#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url));
// These categories have first-class Make targets so validate-public runs them
// exactly once while every other new public test is discovered automatically.
const standalone = new Set([
  "bootstrap.test.mjs",
  "demo.test.mjs",
  "docker-auto-update.test.mjs",
  "restore-prompt.test.mjs",
  "restore.test.mjs",
]);

function discover(directory) {
  return fs.readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) return discover(target);
      if (entry.isFile() && entry.name.endsWith(".test.mjs") && !standalone.has(entry.name)) return [target];
      return [];
    });
}

const tests = discover(scriptsDirectory);
if (!tests.length) {
  console.error("No public repository Node.js tests discovered.");
  process.exit(1);
}
console.log(`Discovered ${tests.length} public repository Node.js test files.`);
const result = spawnSync(process.execPath, ["--test", ...tests], {
  cwd: path.dirname(scriptsDirectory),
  stdio: "inherit",
});
process.exit(result.status ?? 1);
