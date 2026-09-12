#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { nodeDimensions } from "./flow-layout-validator.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.resolve(process.argv[2] ?? path.resolve(here, "..", "flows.json"));
const outputPath = path.resolve(process.argv[3] ?? sourcePath);
const flows = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
const MIN_LEFT_MARGIN = 64;
const overridesPath = path.join(here, "flow-layout-overrides.json");
const overrides = fs.existsSync(overridesPath)
  ? JSON.parse(fs.readFileSync(overridesPath, "utf8"))
  : { version: 1, canvases: {} };

if (overrides.version !== 1 || typeof overrides.canvases !== "object") {
  throw new Error("flow-layout-overrides.json inválido");
}

const byId = new Map(flows.map((node) => [node.id, node]));
let overridden = 0;
for (const [canvasId, canvas] of Object.entries(overrides.canvases)) {
  const tab = byId.get(canvasId);
  if (!tab || !["tab", "subflow"].includes(tab.type)) {
    throw new Error(`Canvas do override ausente: ${canvasId}`);
  }
  for (const [nodeId, geometry] of Object.entries(canvas.nodes ?? {})) {
    const node = byId.get(nodeId);
    if (!node || node.z !== canvasId) throw new Error(`Nó do override ausente: ${nodeId}`);
    for (const field of ["x", "y", "w", "h"]) {
      if (geometry[field] !== undefined) {
        if (!Number.isFinite(geometry[field])) throw new Error(`Geometria inválida: ${nodeId}.${field}`);
        node[field] = geometry[field];
      }
    }
    overridden += 1;
  }

  for (const group of flows.filter((node) => node.z === canvasId && node.type === "group")) {
    const children = flows.filter((node) =>
      node.z === canvasId && node.g === group.id && Number.isFinite(node.x) && Number.isFinite(node.y)
    );
    if (children.length === 0) continue;
    const bounds = children.map((node) => {
      const size = nodeDimensions(node);
      return {
        left: node.x - size.width / 2,
        right: node.x + size.width / 2,
        top: node.y - size.height / 2,
        bottom: node.y + size.height / 2,
      };
    });
    const compact = canvas.compact_groups === true;
    const contentLeft = Math.min(...bounds.map((item) => item.left - 20));
    const contentTop = Math.min(...bounds.map((item) => item.top - 36));
    const contentRight = Math.max(...bounds.map((item) => item.right + 20));
    const contentBottom = Math.max(...bounds.map((item) => item.bottom + 20));
    const labelWidth = String(group.name ?? "").length * 7 + 32;
    const left = compact ? contentLeft : Math.min(group.x, contentLeft);
    const top = compact ? contentTop : Math.min(group.y, contentTop);
    const right = compact
      ? Math.max(contentRight, left + labelWidth)
      : Math.max(group.x + group.w, contentRight);
    const bottom = compact ? contentBottom : Math.max(group.y + group.h, contentBottom);
    group.x = Math.round(left);
    group.y = Math.round(top);
    group.w = Math.round(right - left);
    group.h = Math.round(bottom - top);
  }
}

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
console.log(`Layout visual preservado em ${overridden} nó(s); margem esquerda de ${MIN_LEFT_MARGIN}px aplicada: ${shifted} canvas(es) deslocado(s).`);
