#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import ELK from "elkjs/lib/elk.bundled.js";
import { auditFlows } from "./audit-flow-layout.mjs";
import {
  assertLayoutOnlyChange,
  semanticDigest,
  visualChanges,
} from "./flow-layout-contract.mjs";
import { connectedComponents, semanticEdges } from "./flow-layout-graph.mjs";
import { nodeDimensions, validateFlowLayout } from "./flow-layout-validator.mjs";
import { ELK_LAYERED_OPTIONS, FLOW_LAYOUT_POLICY, snapToGrid } from "./flow-layout-policy.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_FLOWS = path.resolve(here, "..", "flows.json");
const DEFAULT_OVERRIDES = path.resolve(here, "flow-layout-overrides.json");
const ROOT_TYPES = new Set(["tab", "subflow"]);
const elk = new ELK();

function clone(value) {
  return structuredClone(value);
}

function label(node) {
  return node.label || node.name || node.id;
}

function ownerId(node) {
  return node.g || "__ungrouped__";
}

function nodeOrder(nodes) {
  return [...nodes].sort((left, right) =>
    left.y - right.y || left.x - right.x || left.id.localeCompare(right.id));
}

function buildPorts(node, outgoingEdges) {
  const outputs = Math.max(
    Array.isArray(node.wires) ? node.wires.length : 0,
    outgoingEdges.length > 0 ? 1 : 0,
  );
  const ports = [{
    id: `${node.id}::in`,
    width: 0,
    height: 0,
    layoutOptions: { "elk.port.side": "WEST", "elk.port.index": "0" },
  }];
  for (let index = 0; index < outputs; index += 1) {
    ports.push({
      id: `${node.id}::out::${index}`,
      width: 0,
      height: 0,
      layoutOptions: { "elk.port.side": "EAST", "elk.port.index": String(index) },
    });
  }
  return ports;
}

async function layoutNodeSet(nodes, edges, padding) {
  if (nodes.length === 0) {
    return { width: FLOW_LAYOUT_POLICY.minimumGroupWidth, height: padding.top + padding.bottom, positions: new Map() };
  }
  const orderedNodes = nodeOrder(nodes);
  const ids = new Set(orderedNodes.map((node) => node.id));
  const localEdges = edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target));
  const outgoing = new Map(orderedNodes.map((node) => [node.id, []]));
  for (const edge of localEdges) outgoing.get(edge.source).push(edge);
  const graph = {
    id: "container",
    layoutOptions: ELK_LAYERED_OPTIONS,
    children: orderedNodes.map((node) => {
      const size = nodeDimensions(node);
      return {
        id: node.id,
        width: size.width,
        height: size.height,
        ports: buildPorts(node, outgoing.get(node.id)),
        layoutOptions: { "elk.portConstraints": "FIXED_ORDER" },
      };
    }),
    edges: localEdges.map((edge, index) => ({
      id: `edge-${index}-${edge.source}-${edge.target}`,
      sources: [`${edge.source}::out::${Math.max(0, edge.output ?? 0)}`],
      targets: [`${edge.target}::in`],
    })),
  };
  const result = await elk.layout(graph);
  const positions = new Map();
  for (const child of result.children ?? []) {
    positions.set(child.id, {
      x: snapToGrid(padding.left + child.x + child.width / 2),
      y: snapToGrid(padding.top + child.y + child.height / 2),
    });
  }
  const labelWidth = Math.max(0, ...nodes.map((node) => String(node.name ?? "").length * 7 + 32));
  return {
    width: snapToGrid(Math.max(
      FLOW_LAYOUT_POLICY.minimumGroupWidth,
      labelWidth,
      padding.left + (result.width ?? 0) + padding.right,
    )),
    height: snapToGrid(padding.top + (result.height ?? 0) + padding.bottom),
    positions,
  };
}

async function layoutCanvas(flows, root) {
  const canvasNodes = flows.filter((node) =>
    node.z === root.id && node.type !== "group" && Number.isFinite(node.x) && Number.isFinite(node.y));
  const groups = flows.filter((node) =>
    node.z === root.id && node.type === "group" && Number.isFinite(node.x) && Number.isFinite(node.y));
  if (groups.some((group) => group.g)) {
    return { root, frozen: "nested groups are preserved until Node-RED exposes an unambiguous compound contract" };
  }
  const edges = semanticEdges(flows, root.id);
  const byOwner = new Map();
  for (const group of groups) byOwner.set(group.id, []);
  byOwner.set("__ungrouped__", []);
  for (const node of canvasNodes) {
    const owner = ownerId(node);
    if (!byOwner.has(owner)) byOwner.set(owner, []);
    byOwner.get(owner).push(node);
  }

  const units = [];
  for (const group of groups) {
    const inner = await layoutNodeSet(byOwner.get(group.id) ?? [], edges, FLOW_LAYOUT_POLICY.groupPadding);
    inner.width = Math.max(inner.width, snapToGrid(String(group.name ?? "").length * 7 + 32));
    units.push({ id: group.id, group, nodes: byOwner.get(group.id) ?? [], ...inner });
  }
  if ((byOwner.get("__ungrouped__") ?? []).length > 0) {
    const zeroPadding = { top: 0, right: 0, bottom: 0, left: 0 };
    const inner = await layoutNodeSet(byOwner.get("__ungrouped__"), edges, zeroPadding);
    units.push({ id: "__ungrouped__", group: null, nodes: byOwner.get("__ungrouped__"), ...inner });
  }
  if (units.length === 0) return { root, frozen: null, components: 0, geometry: new Map() };

  const unitByNode = new Map();
  for (const unit of units) for (const node of unit.nodes) unitByNode.set(node.id, unit.id);
  const seenUnitEdges = new Set();
  const unitEdges = [];
  for (const edge of edges) {
    const source = unitByNode.get(edge.source);
    const target = unitByNode.get(edge.target);
    if (!source || !target || source === target) continue;
    const key = `${source}\u0000${target}`;
    if (seenUnitEdges.has(key)) continue;
    seenUnitEdges.add(key);
    unitEdges.push({ source, target });
  }
  const componentCount = connectedComponents(units.map((unit) => unit.id), unitEdges).length;
  const unitGraph = {
    id: `canvas-${root.id}`,
    layoutOptions: {
      ...ELK_LAYERED_OPTIONS,
      "elk.spacing.nodeNode": String(FLOW_LAYOUT_POLICY.groupSpacing),
      "elk.spacing.componentComponent": String(FLOW_LAYOUT_POLICY.groupSpacing),
    },
    children: units.map((unit) => ({ id: unit.id, width: unit.width, height: unit.height })),
    edges: unitEdges.map((edge, index) => ({
      id: `unit-edge-${index}`,
      sources: [edge.source],
      targets: [edge.target],
    })),
  };
  const placed = await elk.layout(unitGraph);
  const placedUnits = new Map((placed.children ?? []).map((unit) => [unit.id, unit]));
  const geometry = new Map();
  for (const unit of units) {
    const position = placedUnits.get(unit.id);
    const unitX = Math.max(
      FLOW_LAYOUT_POLICY.leftMargin,
      snapToGrid(FLOW_LAYOUT_POLICY.leftMargin + (position?.x ?? 0)),
    );
    const unitY = snapToGrid(FLOW_LAYOUT_POLICY.topMargin + (position?.y ?? 0));
    if (unit.group) {
      geometry.set(unit.group.id, { x: unitX, y: unitY, w: unit.width, h: unit.height });
    }
    for (const node of unit.nodes) {
      const local = unit.positions.get(node.id);
      geometry.set(node.id, { x: unitX + local.x, y: unitY + local.y });
    }
  }
  return { root, frozen: null, components: componentCount, geometry };
}

function boundsForNodes(nodes, positions = null) {
  const bounds = nodes.map((node) => {
    const size = nodeDimensions(node);
    const position = positions?.get(node.id) ?? node;
    return {
      left: position.x - size.width / 2,
      right: position.x + size.width / 2,
      top: position.y - size.height / 2,
      bottom: position.y + size.height / 2,
    };
  });
  return {
    left: Math.min(...bounds.map((item) => item.left)),
    right: Math.max(...bounds.map((item) => item.right)),
    top: Math.min(...bounds.map((item) => item.top)),
    bottom: Math.max(...bounds.map((item) => item.bottom)),
  };
}

function containedByGroup(bounds, group) {
  return bounds.left >= group.x + FLOW_LAYOUT_POLICY.groupPadding.left &&
    bounds.right <= group.x + group.w - FLOW_LAYOUT_POLICY.groupPadding.right &&
    bounds.top >= group.y + FLOW_LAYOUT_POLICY.groupPadding.top &&
    bounds.bottom <= group.y + group.h - FLOW_LAYOUT_POLICY.groupPadding.bottom;
}

async function layoutCanvasStable(flows, root) {
  const canvasNodes = flows.filter((node) =>
    node.z === root.id && node.type !== "group" && Number.isFinite(node.x) && Number.isFinite(node.y));
  const groups = flows.filter((node) =>
    node.z === root.id && node.type === "group" && Number.isFinite(node.x) && Number.isFinite(node.y));
  if (groups.some((group) => group.g)) {
    return { root, frozen: "nested groups are preserved until Node-RED exposes an unambiguous compound contract" };
  }
  const edges = semanticEdges(flows, root.id);
  const nodesById = new Map(canvasNodes.map((node) => [node.id, node]));
  const groupById = new Map(groups.map((group) => [group.id, group]));
  const owners = new Map();
  for (const node of canvasNodes) {
    const owner = ownerId(node);
    if (!owners.has(owner)) owners.set(owner, []);
    owners.get(owner).push(node);
  }
  const geometry = new Map();
  let componentCount = 0;
  for (const [owner, nodes] of owners) {
    const ids = new Set(nodes.map((node) => node.id));
    const localEdges = edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target));
    const components = connectedComponents(nodes.map((node) => node.id), localEdges);
    componentCount += components.length;
    for (const componentIds of components) {
      if (componentIds.length < 2 || !localEdges.some((edge) => componentIds.includes(edge.source) && componentIds.includes(edge.target))) continue;
      const componentNodes = componentIds.map((id) => nodesById.get(id));
      const originalBounds = boundsForNodes(componentNodes);
      const laidOut = await layoutNodeSet(componentNodes, localEdges, { top: 0, right: 0, bottom: 0, left: 0 });
      const proposedBounds = boundsForNodes(componentNodes, laidOut.positions);
      const deltaX = (originalBounds.left + originalBounds.right - proposedBounds.left - proposedBounds.right) / 2;
      const deltaY = (originalBounds.top + originalBounds.bottom - proposedBounds.top - proposedBounds.bottom) / 2;
      const positions = new Map(componentNodes.map((node) => {
        const position = laidOut.positions.get(node.id);
        return [node.id, { x: snapToGrid(position.x + deltaX), y: snapToGrid(position.y + deltaY) }];
      }));
      const finalBounds = boundsForNodes(componentNodes, positions);
      const group = groupById.get(owner);
      if (group && !containedByGroup(finalBounds, group)) continue;
      for (const [id, position] of positions) geometry.set(id, position);
    }
  }
  return { root, frozen: null, components: componentCount, geometry };
}

function applyGeometry(flows, geometry) {
  const byId = new Map(flows.map((node) => [node.id, node]));
  for (const [id, values] of geometry) {
    const node = byId.get(id);
    if (!node) throw new Error(`layout returned unknown object ${id}`);
    for (const [field, value] of Object.entries(values)) node[field] = value;
  }
}

function qualityRegressions(before, after) {
  const issues = [];
  const neverWorse = [
    ["overlaps", "node overlaps"],
    ["groupOverlaps", "group overlaps"],
    ["wireNodeIntersections", "wire-node intersections"],
    ["longWires", "wires over 500px"],
    ["reverseWires", "right-to-left wires"],
    ["branchOrderInversions", "output-order inversions"],
    ["isolatedGroups", "isolated groups"],
    ["separatedGroupClusters", "separated group chains"],
    ["componentIntersections", "component-hull intersections"],
    ["crossings", "estimated edge crossings"],
    ["closePairs", "node pairs closer than 20px"],
  ];
  for (const [field, description] of neverWorse) {
    if ((after[field] ?? 0) > (before[field] ?? 0)) {
      issues.push(`${description} ${before[field] ?? 0} -> ${after[field] ?? 0}`);
    }
  }
  if (after.groupHullArea > before.groupHullArea * 1.15 + 50000) {
    issues.push(`group envelope area ${before.groupHullArea} -> ${after.groupHullArea}`);
  }
  return issues;
}

function qualityGain(before, after) {
  const weights = {
    overlaps: 3000,
    groupOverlaps: 3000,
    wireNodeIntersections: 1200,
    longWires: 700,
    reverseWires: 700,
    branchOrderInversions: 500,
    isolatedGroups: 400,
    separatedGroupClusters: 400,
    componentIntersections: 100,
    crossings: 50,
    closePairs: 2,
  };
  let gain = 0;
  for (const [field, weight] of Object.entries(weights)) {
    gain += ((before[field] ?? 0) - (after[field] ?? 0)) * weight;
  }
  const beforeArea = Math.max(1, before.width * before.height);
  const afterArea = after.width * after.height;
  if (afterArea < beforeArea * 0.95) gain += Math.round((beforeArea - afterArea) / beforeArea * 100);
  return gain;
}

function metricSummary(metric) {
  return {
    width: metric.width,
    height: metric.height,
    overlaps: metric.overlaps,
    groupOverlaps: metric.groupOverlaps,
    wireNodeIntersections: metric.wireNodeIntersections,
    longWires: metric.longWires,
    reverseWires: metric.reverseWires,
    crossings: metric.crossings,
    closePairs: metric.closePairs,
    minimumSpacing: metric.minimumNodeSpacing,
    averageSpacing: metric.averageNodeSpacing,
    componentIntersections: metric.componentIntersections,
    groupGap: metric.maxGroupNearestGap,
  };
}

export async function layoutFlows(inputFlows, options = {}) {
  const before = clone(inputFlows);
  const candidate = clone(inputFlows);
  const roots = candidate.filter((node) => ROOT_TYPES.has(node.type));
  const selected = new Set(options.canvases ?? []);
  const selectedRoots = roots.filter((root) =>
    selected.size === 0 || selected.has(root.id) || selected.has(label(root)));
  const layouts = [];
  const stableLayouts = [];
  for (const root of selectedRoots) {
    layouts.push(await layoutCanvas(candidate, root));
    stableLayouts.push(await layoutCanvasStable(candidate, root));
  }
  for (const layout of layouts) if (!layout.frozen) applyGeometry(candidate, layout.geometry);

  const stableCandidate = clone(inputFlows);
  for (const layout of stableLayouts) if (!layout.frozen) applyGeometry(stableCandidate, layout.geometry);

  const beforeAudits = new Map(auditFlows(before).map((audit) => [audit.id, audit]));
  const candidateAudits = new Map(auditFlows(candidate).map((audit) => [audit.id, audit]));
  const stableAudits = new Map(auditFlows(stableCandidate).map((audit) => [audit.id, audit]));
  const accepted = clone(before);
  const report = [];
  for (let index = 0; index < layouts.length; index += 1) {
    const layout = layouts[index];
    const stableLayout = stableLayouts[index];
    const beforeAudit = beforeAudits.get(layout.root.id);
    const proposals = [
      { strategy: "hierarchical", layout, flows: candidate, audit: candidateAudits.get(layout.root.id) },
      { strategy: "stable-components", layout: stableLayout, flows: stableCandidate, audit: stableAudits.get(layout.root.id) },
    ].map((proposal) => {
      const regressions = proposal.layout.frozen || !beforeAudit || !proposal.audit
        ? [proposal.layout.frozen || "canvas has no measurable geometry"]
        : qualityRegressions(beforeAudit, proposal.audit);
      regressions.push(...validateFlowLayout(proposal.flows)
        .filter((issue) => issue.startsWith(`${label(layout.root)}:`)));
      return { ...proposal, regressions, gain: beforeAudit && proposal.audit ? qualityGain(beforeAudit, proposal.audit) : 0 };
    });
    const viable = proposals
      .filter((proposal) => options.allowRegressions === true || proposal.regressions.length === 0)
      .filter((proposal) => options.allowRegressions === true || proposal.gain > 0)
      .sort((left, right) => right.gain - left.gain || left.strategy.localeCompare(right.strategy));
    const chosen = viable[0];
    const frozen = !chosen;
    if (chosen?.layout.geometry) applyGeometry(accepted, chosen.layout.geometry);
    const fallbackReasons = proposals
      .flatMap((proposal) => proposal.regressions.map((reason) => `${proposal.strategy}: ${reason}`));
    if (fallbackReasons.length === 0 && frozen) fallbackReasons.push("no proposal produced a measurable quality gain");
    report.push({
      id: layout.root.id,
      name: label(layout.root),
      components: chosen?.layout.components ?? stableLayout.components ?? layout.components ?? 0,
      frozen,
      strategy: chosen?.strategy ?? "baseline",
      reasons: frozen ? fallbackReasons : [],
      before: beforeAudit ? metricSummary(beforeAudit) : null,
      proposed: chosen?.audit ? metricSummary(chosen.audit) : null,
    });
  }

  const contract = assertLayoutOnlyChange(before, accepted);
  const changes = visualChanges(before, accepted);
  for (const item of report) {
    const canvasChanges = changes.filter((change) => change.canvas === item.id);
    item.changedObjects = new Set(canvasChanges.map((change) => change.id)).size;
    item.changedFields = canvasChanges.length;
  }
  const acceptedAudits = new Map(auditFlows(accepted).map((audit) => [audit.id, audit]));
  for (const item of report) {
    const metric = acceptedAudits.get(item.id);
    item.after = metric ? metricSummary(metric) : null;
  }
  return { flows: accepted, report, changes, semanticHash: contract.semanticHash };
}

export function buildApprovedGeometryOverrides(flows, current = null, changedIds = null) {
  const overrides = current && current.version === 1 && current.canvases
    ? clone(current)
    : {
      version: 1,
      description: "Geometria canônica aprovada pelo layout ELK hierárquico; lógica, ordem e ligações permanecem nas fontes funcionais.",
      canvases: {},
    };
  for (const root of flows.filter((node) => ROOT_TYPES.has(node.type))) {
    const positioned = flows.filter((node) =>
      node.z === root.id && Number.isFinite(node.x) && Number.isFinite(node.y));
    const directlyChanged = changedIds ? positioned.filter((node) => changedIds.has(node.id)) : positioned;
    if (changedIds && directlyChanged.length === 0) continue;
    const selected = positioned;
    const managedGroups = positioned.filter((node) =>
      node.type === "group" && node.notification_hub_layout_version === 1);
    const managedGroupIds = new Set(managedGroups.map((node) => node.id));
    const canvas = overrides.canvases[root.id] ?? {
      label: label(root),
      compact_groups: false,
      nodes: {},
    };
    if (changedIds) canvas.geometry_final = true;
    canvas.nodes ??= {};
    for (const node of selected) {
      const geometry = node.type === "group"
        ? { x: node.x, y: node.y, w: node.w, h: node.h }
        : { x: node.x, y: node.y };
      canvas.nodes[node.id] = geometry;
      if (canvas.node_positions?.[node.id]) {
        canvas.node_positions[node.id] = { x: node.x, y: node.y };
      }
      if (canvas.group_positions?.[node.id]) {
        canvas.group_positions[node.id] = { x: node.x, y: node.y };
      }
    }
    if (managedGroups.length > 0) {
      canvas.managed_group_overrides = [...new Set([
        ...(canvas.managed_group_overrides ?? []),
        ...managedGroupIds,
      ])];
      canvas.managed_node_overrides = [...new Set([
        ...(canvas.managed_node_overrides ?? []),
        ...selected
          .filter((node) => managedGroupIds.has(node.g) || node.id.startsWith(`global_observer_coverage__${root.id}__`))
          .map((node) => node.id),
      ])];
    }
    overrides.canvases[root.id] = canvas;
  }
  return overrides;
}

function atomicWrite(target, content) {
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(temporary, content);
    fs.renameSync(temporary, target);
    return "atomic";
  } catch (error) {
    if (error?.code !== "EACCES") throw error;
    try {
      fs.rmSync(temporary, { force: true });
    } catch {}
    fs.writeFileSync(target, content);
    return "rollback-protected";
  }
}

function parseArgs(argv) {
  const options = { dryRun: false, check: false, flows: DEFAULT_FLOWS, output: null, overrides: DEFAULT_OVERRIDES, canvases: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--check") options.check = true;
    else if (arg === "--allow-regressions") options.allowRegressions = true;
    else if (arg === "--flows") options.flows = path.resolve(argv[++index]);
    else if (arg === "--output") options.output = path.resolve(argv[++index]);
    else if (arg === "--overrides") options.overrides = path.resolve(argv[++index]);
    else if (arg === "--tabs") options.canvases.push(...argv[++index].split(",").filter(Boolean));
    else throw new Error(`unknown argument: ${arg}`);
  }
  options.output ??= options.flows;
  return options;
}

function renderReport(result, inputHash) {
  const lines = [
    `Semantic SHA-256: ${result.semanticHash}`,
    `Input file SHA-256: ${inputHash}`,
    "Canvas | components | objects/fields | overlap n/g | wire-node | >500 | reverse | crossings | spacing min/avg | component hulls | size before -> after | status",
  ];
  for (const item of result.report) {
    const before = item.before ?? {};
    const after = item.after ?? {};
    const status = item.frozen ? `frozen: ${item.reasons.join("; ")}` : `accepted (${item.strategy})`;
    lines.push(
      `${item.name} | ${item.components} | ${item.changedObjects}/${item.changedFields} | ` +
      `${before.overlaps ?? 0}/${before.groupOverlaps ?? 0} -> ${after.overlaps ?? 0}/${after.groupOverlaps ?? 0} | ` +
      `${before.wireNodeIntersections ?? 0} -> ${after.wireNodeIntersections ?? 0} | ` +
      `${before.longWires ?? 0} -> ${after.longWires ?? 0} | ${before.reverseWires ?? 0} -> ${after.reverseWires ?? 0} | ` +
      `${before.crossings ?? 0} -> ${after.crossings ?? 0} | ` +
      `${before.minimumSpacing ?? 0}/${before.averageSpacing ?? 0} -> ${after.minimumSpacing ?? 0}/${after.averageSpacing ?? 0} | ` +
      `${before.componentIntersections ?? 0} -> ${after.componentIntersections ?? 0} | ${before.width ?? 0}x${before.height ?? 0} -> ` +
      `${after.width ?? 0}x${after.height ?? 0} | ${status}`,
    );
  }
  lines.push(`Changed: ${new Set(result.changes.map((change) => change.id)).size} object(s), ${result.changes.length} visual field(s).`);
  return lines.join("\n");
}

async function main(argv) {
  const options = parseArgs(argv);
  const raw = fs.readFileSync(options.flows, "utf8");
  const flows = JSON.parse(raw);
  if (!Array.isArray(flows)) throw new Error("flows file must contain a top-level array");
  const result = await layoutFlows(flows, options);
  const second = await layoutFlows(result.flows, options);
  if (JSON.stringify(result.flows) !== JSON.stringify(second.flows)) {
    throw new Error("layout is not idempotent: the second pass changed the candidate");
  }
  const inputHash = await import("node:crypto").then(({ default: crypto }) =>
    crypto.createHash("sha256").update(raw).digest("hex"));
  console.log(renderReport(result, inputHash));
  if (options.check) {
    if (result.changes.length > 0) throw new Error("approved layout is stale; run npm run layout");
    return;
  }
  if (options.dryRun) return;
  const currentOverrides = fs.existsSync(options.overrides)
    ? JSON.parse(fs.readFileSync(options.overrides, "utf8"))
    : null;
  const changedIds = new Set(result.changes.map((change) => change.id));
  const overrides = buildApprovedGeometryOverrides(result.flows, currentOverrides, changedIds);
  const originalFlows = fs.existsSync(options.output) ? fs.readFileSync(options.output, "utf8") : null;
  const originalOverrides = fs.existsSync(options.overrides) ? fs.readFileSync(options.overrides, "utf8") : null;
  try {
    const flowsMode = atomicWrite(options.output, `${JSON.stringify(result.flows, null, 4)}${os.EOL}`);
    const overridesMode = atomicWrite(options.overrides, `${JSON.stringify(overrides, null, 2)}${os.EOL}`);
    console.log(`Write mode: flows=${flowsMode}, overrides=${overridesMode}.`);
  } catch (error) {
    if (originalFlows !== null) fs.writeFileSync(options.output, originalFlows);
    else fs.rmSync(options.output, { force: true });
    if (originalOverrides !== null) fs.writeFileSync(options.overrides, originalOverrides);
    else fs.rmSync(options.overrides, { force: true });
    throw new Error(`write failed; original files restored: ${error.message}`, { cause: error });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`FAIL: ${error.stack || error.message}`);
    process.exitCode = 1;
  });
}
