#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { formatSyntheticSummary, runSyntheticScenario } from "../demo/engine.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

try {
  const scenario = JSON.parse(fs.readFileSync(path.join(repoRoot, "demo/scenario.json"), "utf8"));
  const result = runSyntheticScenario(scenario);
  console.log(process.argv.includes("--json")
    ? JSON.stringify(result, null, 2)
    : formatSyntheticSummary(result));
} catch (error) {
  console.error(`demo: ${error.message}`);
  process.exit(1);
}
