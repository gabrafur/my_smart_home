#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const inputPath = path.resolve(process.argv[2] ?? path.resolve(here, "..", "flows.json"));
const outputPath = path.resolve(process.argv[3] ?? inputPath);
const functionsDir = path.join(here, "functions");
const flows = JSON.parse(fs.readFileSync(inputPath, "utf8"));
const byId = new Map(flows.map((node) => [node.id, node]));

for (const [id, filename] of [
  ["vehicle_visual_normalize", "vehicle-lifecycle-normalize.js"],
  ["vehicle_visual_state_finalize", "vehicle-lifecycle-state-finalize.js"],
  ["vehicle_visual_evidence_read", "vehicle-lifecycle-evidence-read.js"],
]) {
  const node = byId.get(id);
  if (!node || node.type !== "function") {
    throw new Error(`Nó function obrigatório ausente: ${id}`);
  }
  node.func = fs.readFileSync(path.join(functionsDir, filename), "utf8").trimEnd();
}

fs.writeFileSync(outputPath, `${JSON.stringify(flows, null, 4)}\n`);
console.log(`Funções do lifecycle do vehicle_primary sincronizadas em ${outputPath}`);
