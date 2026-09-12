#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.resolve(process.argv[2] ?? path.resolve(here, "..", "flows.json"));
const outputPath = path.resolve(process.argv[3] ?? sourcePath);
const flows = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
const MIN_LEFT_MARGIN = 64;

let shifted = 0;

for (const canvas of flows.filter((node) =>
  node.type === "tab" || node.type === "subflow"
)) {
  const items = flows.filter(
    (node) => node.z === canvas.id && Number.isFinite(node.x),
  );
  if (items.length === 0) continue;

  const groups = items.filter((node) => node.type === "group");
  const anchors = groups.length > 0 ? groups : items;
  const currentMargin = Math.min(...anchors.map((node) => node.x));
  const delta = Math.max(0, MIN_LEFT_MARGIN - currentMargin);
  if (delta === 0) continue;

  for (const node of items) node.x += delta;
  shifted += 1;
}

fs.writeFileSync(outputPath, `${JSON.stringify(flows, null, 4)}\n`);
console.log(`Margem esquerda de ${MIN_LEFT_MARGIN}px aplicada: ${shifted} canvas(es) deslocado(s).`);
