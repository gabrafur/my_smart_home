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
const selectedCanvases = new Set(
  String(process.env.FLOW_LAYOUT_CANVASES ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);
const applyBaseNodes = process.env.FLOW_LAYOUT_APPLY_BASE_NODES !== "0";
const applyNodePositions = process.env.FLOW_LAYOUT_APPLY_NODE_POSITIONS !== "0";
const applyGroupPositions = process.env.FLOW_LAYOUT_APPLY_GROUP_POSITIONS !== "0";
const compactGroups = process.env.FLOW_LAYOUT_COMPACT_GROUPS !== "0";
const selectedGroupIds = new Set(
  String(process.env.FLOW_LAYOUT_GROUP_IDS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);
const isGeneratedNotificationRoute = (id) => /^notification_hub_wire_(?:out|in)_[a-f0-9]{12}$/.test(id);

if (overrides.version !== 1 || typeof overrides.canvases !== "object") {
  throw new Error("flow-layout-overrides.json inválido");
}

const byId = new Map(flows.map((node) => [node.id, node]));
let overridden = 0;
for (const [canvasId, canvas] of Object.entries(overrides.canvases)) {
  if (selectedCanvases.size > 0 && !selectedCanvases.has(canvasId) && !selectedCanvases.has(canvas.label)) continue;
  const tab = byId.get(canvasId);
  if (!tab || !["tab", "subflow"].includes(tab.type)) {
    throw new Error(`Canvas do override ausente: ${canvasId}`);
  }
  const managedGroups = new Set(flows
    .filter((node) => node.z === canvasId && node.type === "group" && node.notification_hub_layout_version === 1)
    .map((node) => node.id));
  const canvasHasManagedNotifications = managedGroups.size > 0;
  const finalGeometry = canvas.geometry_final === true;
  const managedGroupOverrides = new Set(canvas.managed_group_overrides ?? []);
  const managedNodeOverrides = new Set(canvas.managed_node_overrides ?? []);
  for (const [nodeId, geometry] of Object.entries(canvas.apply_nodes === false || !applyBaseNodes ? {} : (canvas.nodes ?? {}))) {
    const node = byId.get(nodeId);
    if (!node && isGeneratedNotificationRoute(nodeId)) continue;
    if (!node || node.z !== canvasId) throw new Error(`Nó do override ausente: ${nodeId}`);
    if (!finalGeometry && (
      (managedGroups.has(node.id) && !managedGroupOverrides.has(node.id)) ||
      (managedGroups.has(node.g) && !managedGroupOverrides.has(node.g) && !managedNodeOverrides.has(node.id)) ||
      (canvasHasManagedNotifications && node.id.startsWith(`global_observer_coverage__${canvasId}__`) && !managedNodeOverrides.has(node.id))
    )) continue;
    for (const field of ["x", "y", "w", "h"]) {
      if (geometry[field] !== undefined) {
        if (!Number.isFinite(geometry[field])) throw new Error(`Geometria inválida: ${nodeId}.${field}`);
        node[field] = geometry[field];
      }
    }
    overridden += 1;
  }

  for (const [groupId, target] of Object.entries(applyGroupPositions ? (canvas.group_positions ?? {}) : {})) {
    if (selectedGroupIds.size > 0 && !selectedGroupIds.has(groupId)) continue;
    const group = byId.get(groupId);
    if (!group || group.z !== canvasId || group.type !== "group") {
      throw new Error(`Group do posicionamento ausente: ${groupId}`);
    }
    if (!Number.isFinite(target.x) || !Number.isFinite(target.y) ||
        (target.w !== undefined && !Number.isFinite(target.w)) ||
        (target.h !== undefined && !Number.isFinite(target.h))) {
      throw new Error(`Posicionamento de group inválido: ${groupId}`);
    }
    const deltaX = target.x - group.x;
    const deltaY = target.y - group.y;
    const widthChanged = target.w !== undefined && target.w !== group.w;
    const heightChanged = target.h !== undefined && target.h !== group.h;
    if (deltaX === 0 && deltaY === 0 && !widthChanged && !heightChanged) continue;
    group.x = target.x;
    group.y = target.y;
    if (target.w !== undefined) group.w = target.w;
    if (target.h !== undefined) group.h = target.h;
    for (const child of flows.filter((node) => node.z === canvasId && node.g === groupId && Number.isFinite(node.x) && Number.isFinite(node.y))) {
      child.x += deltaX;
      child.y += deltaY;
    }
    overridden += 1;
  }

  for (const [nodeId, target] of Object.entries(finalGeometry || !applyNodePositions ? {} : (canvas.node_positions ?? {}))) {
    const node = byId.get(nodeId);
    if (!node && isGeneratedNotificationRoute(nodeId)) continue;
    if (!node || node.z !== canvasId || node.type === "group") {
      throw new Error(`Nó do posicionamento final ausente: ${nodeId}`);
    }
    if (!Number.isFinite(target.x) || !Number.isFinite(target.y)) {
      throw new Error(`Posicionamento final de nó inválido: ${nodeId}`);
    }
    node.x = target.x;
    node.y = target.y;
    overridden += 1;
  }

  if (!compactGroups || finalGeometry) continue;
  for (const group of flows.filter((node) => node.z === canvasId && node.type === "group")) {
    // Explicit positions and dimensions are approved geometry. Recomputing
    // them here creates drift and can undo the override on every regeneration.
    if (Object.hasOwn(canvas.group_positions ?? {}, group.id)) continue;
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
    const compact = compactGroups && canvas.compact_groups === true;
    const contentLeft = Math.min(...bounds.map((item) => item.left - 20));
    const contentTop = Math.min(...bounds.map((item) => item.top - 36));
    const contentRight = Math.max(...bounds.map((item) => item.right + 20));
    const contentBottom = Math.max(...bounds.map((item) => item.bottom + 20));
    const labelWidth = String(group.name ?? "").length * 7 + 32;
    const notificationManaged = group.notification_hub_layout_version === 1;
    const left = compact
      ? notificationManaged
        ? Math.max(MIN_LEFT_MARGIN, group.x, contentLeft)
        : contentLeft
      : Math.min(group.x, contentLeft);
    const top = compact ? contentTop : Math.min(group.y, contentTop);
    const right = compact
      ? Math.max(contentRight, left + labelWidth)
      : Math.max(group.x + group.w, contentRight);
    const bottom = compact ? contentBottom : Math.max(group.y + group.h, contentBottom);
    const roundedLeft = Math.round(left);
    const roundedTop = Math.round(top);
    group.x = roundedLeft;
    group.y = roundedTop;
    group.w = Math.round(right - roundedLeft);
    group.h = Math.round(bottom - roundedTop);
  }
}

let shifted = 0;

for (const canvas of flows.filter((node) =>
  node.type === "tab" || node.type === "subflow"
)) {
  if (selectedCanvases.size > 0 && !selectedCanvases.has(canvas.id) && !selectedCanvases.has(canvas.label || canvas.name)) continue;
  if (selectedGroupIds.size > 0) continue;
  const items = flows.filter(
    (node) => node.z === canvas.id && Number.isFinite(node.x),
  );
  if (items.length === 0) continue;

  const groups = items.filter((node) => node.type === "group");
  const anchors = groups.length > 0 ? groups : items;
  const currentMargin = Math.min(...anchors.map((node) => node.x));
  const delta = Math.max(0, MIN_LEFT_MARGIN - currentMargin);
  if (delta === 0) continue;

  const notificationManagedGroups = new Set(groups
    .filter((group) => group.notification_hub_layout_version === 1)
    .map((group) => group.id));
  for (const node of items) {
    if (notificationManagedGroups.has(node.id) || notificationManagedGroups.has(node.g)) continue;
    node.x += delta;
  }
  shifted += 1;
}

fs.writeFileSync(outputPath, `${JSON.stringify(flows, null, 4)}\n`);
console.log(`Layout visual preservado em ${overridden} nó(s); margem esquerda de ${MIN_LEFT_MARGIN}px aplicada: ${shifted} canvas(es) deslocado(s).`);
