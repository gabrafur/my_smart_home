#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runSyntheticScenario } from "../demo/engine.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

try {
  const scenario = JSON.parse(fs.readFileSync(path.join(repoRoot, "demo/scenario.json"), "utf8"));
  console.log(JSON.stringify(runSyntheticScenario(scenario), null, 2));
} catch (error) {
  console.error(`demo: ${error.message}`);
  process.exit(1);
}
