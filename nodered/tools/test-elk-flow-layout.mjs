#!/usr/bin/env node

import assert from "node:assert/strict";
import test from "node:test";
import { assertLayoutOnlyChange, semanticDigest } from "./flow-layout-contract.mjs";
import { connectedComponents, semanticEdges } from "./flow-layout-graph.mjs";
import { validateFlowLayout } from "./flow-layout-validator.mjs";
import { buildApprovedGeometryOverrides, layoutFlows } from "./layout-flows-elk.mjs";

function groupedFixture(nodes, options = {}) {
  const rootType = options.rootType ?? "tab";
  const root = rootType === "subflow"
    ? { id: "canvas", type: "subflow", name: "fixture" }
    : { id: "canvas", type: "tab", label: "fixture" };
  const group = {
    id: "group",
    type: "group",
    z: "canvas",
    name: "Pipeline",
    nodes: nodes.map((node) => node.id),
    x: 64,
    y: 20,
    w: 1200,
    h: Math.max(220, nodes.length * 50),
  };
  return [root, group, ...nodes.map((node, index) => ({
    type: "function",
    z: "canvas",
    g: "group",
    name: node.id,
    x: 160 + (index % 4) * 240,
    y: 90 + Math.floor(index / 4) * 70,
    func: "return msg;",
    outputs: node.wires?.length || 1,
    wires: node.wires ?? [[]],
    ...node,
  }))];
}

function byId(flows) {
  return new Map(flows.map((node) => [node.id, node]));
}

test("lays out a chain from left to right without semantic changes", async () => {
  const fixture = groupedFixture([
    { id: "a", type: "inject", wires: [["b"]] },
    { id: "b", wires: [["c"]] },
    { id: "c", type: "debug", wires: [] },
  ]);
  const result = await layoutFlows(fixture);
  const nodes = byId(result.flows);
  assert.ok(nodes.get("a").x < nodes.get("b").x);
  assert.ok(nodes.get("b").x < nodes.get("c").x);
  assert.equal(semanticDigest(result.flows), semanticDigest(fixture));
  assert.deepEqual(validateFlowLayout(result.flows), []);
});

test("handles fan-out, fan-in and switch port order", async () => {
  const fixture = groupedFixture([
    { id: "source", type: "switch", outputs: 3, wires: [["top"], ["middle"], ["bottom"]] },
    { id: "top", wires: [["join"]] },
    { id: "middle", wires: [["join"]] },
    { id: "bottom", wires: [["join"]] },
    { id: "join", type: "join", wires: [] },
  ]);
  const result = await layoutFlows(fixture);
  const nodes = byId(result.flows);
  assert.ok(nodes.get("source").x < nodes.get("join").x);
  assert.ok(nodes.get("top").y <= nodes.get("middle").y);
  assert.ok(nodes.get("middle").y <= nodes.get("bottom").y);
  assert.equal(result.report[0].after.overlaps, 0);
});

test("lays out cycles deterministically", async () => {
  const fixture = groupedFixture([
    { id: "a", wires: [["b"]] },
    { id: "b", wires: [["c"]] },
    { id: "c", wires: [["a"]] },
  ]);
  const first = await layoutFlows(fixture, { allowRegressions: true });
  const second = await layoutFlows(first.flows, { allowRegressions: true });
  assert.deepEqual(second.flows, first.flows);
  assert.equal(first.report[0].components, 1);
});

test("recognizes independent components and semantic link edges", async () => {
  const fixture = groupedFixture([
    { id: "a", wires: [["b"]] },
    { id: "b", wires: [] },
    { id: "link-out", type: "link out", mode: "link", links: ["link-in"], wires: [] },
    { id: "link-in", type: "link in", links: ["link-out"], wires: [["end"]] },
    { id: "end", wires: [] },
    { id: "call", type: "link call", links: ["link-in"], wires: [["after-call"]] },
    { id: "after-call", wires: [] },
  ]);
  const edges = semanticEdges(fixture, "canvas");
  assert.ok(edges.some((edge) => edge.source === "link-out" && edge.target === "link-in" && edge.kind === "link"));
  assert.ok(edges.some((edge) => edge.source === "call" && edge.target === "link-in" && edge.kind === "link-call"));
  const components = connectedComponents(fixture.slice(2).map((node) => node.id), edges);
  assert.equal(components.length, 2);
  const result = await layoutFlows(fixture, { allowRegressions: true });
  assert.equal(result.report[0].components, 1);
});

test("supports subflows, comments, Home Assistant, MQTT and custom nodes", async () => {
  const fixture = groupedFixture([
    { id: "note", type: "comment", info: "visual only", wires: [] },
    { id: "ha", type: "api-current-state", entity_id: "sensor.example", wires: [["mqtt"]] },
    { id: "mqtt", type: "mqtt out", topic: "example/topic", broker: "broker", wires: [] },
    { id: "custom", type: "vendor-unknown", customSetting: { keep: true }, wires: [] },
  ], { rootType: "subflow" });
  const result = await layoutFlows(fixture, { allowRegressions: true });
  assert.equal(byId(result.flows).get("custom").customSetting.keep, true);
  assert.equal(byId(result.flows).get("ha").entity_id, "sensor.example");
  assert.equal(byId(result.flows).get("mqtt").topic, "example/topic");
  assert.deepEqual(result.flows.map((node) => node.id), fixture.map((node) => node.id));
});

test("freezes nested groups instead of guessing their semantics", async () => {
  const fixture = groupedFixture([{ id: "a", wires: [] }]);
  fixture[1].g = "outer";
  const result = await layoutFlows(fixture);
  assert.deepEqual(result.flows, fixture);
  assert.equal(result.report[0].frozen, true);
  assert.match(result.report[0].reasons.join("\n"), /nested groups/);
});

test("removes node collisions and keeps children inside their group", async () => {
  const fixture = groupedFixture([
    { id: "a", x: 180, y: 100, wires: [["b"]] },
    { id: "b", x: 180, y: 100, wires: [["c"]] },
    { id: "c", x: 180, y: 100, wires: [] },
  ]);
  const result = await layoutFlows(fixture, { allowRegressions: true });
  assert.deepEqual(validateFlowLayout(result.flows), []);
  assert.equal(result.report[0].after.overlaps, 0);
});

test("scales to a large deterministic graph", async () => {
  const count = 80;
  const nodes = Array.from({ length: count }, (_, index) => ({
    id: `node-${String(index).padStart(3, "0")}`,
    wires: index + 1 < count ? [[`node-${String(index + 1).padStart(3, "0")}`]] : [],
  }));
  const fixture = groupedFixture(nodes);
  const first = await layoutFlows(fixture, { allowRegressions: true });
  const second = await layoutFlows(first.flows, { allowRegressions: true });
  assert.equal(first.flows.length, count + 2);
  assert.deepEqual(second.flows, first.flows);
  assert.equal(first.report[0].after.overlaps, 0);
});

test("rejects any wire or top-level order change", () => {
  const fixture = groupedFixture([{ id: "a", wires: [] }, { id: "b", wires: [] }]);
  const wireChanged = structuredClone(fixture);
  wireChanged[2].wires = [["b"]];
  assert.throws(() => assertLayoutOnlyChange(fixture, wireChanged), /semantic hash changed/);
  const reordered = [fixture[0], fixture[1], fixture[3], fixture[2]];
  assert.throws(() => assertLayoutOnlyChange(fixture, reordered), /object order/);
});

test("preserves unrelated tabs, group member order and property order byte for byte", async () => {
  const fixture = groupedFixture([{ id: "a", wires: [["b"]] }, { id: "b", wires: [] }]);
  fixture.push(
    { id: "other", type: "tab", label: "unrelated" },
    { id: "other-node", type: "inject", z: "other", name: "Do not touch", x: 140, y: 80, wires: [] },
    { id: "server", type: "server", name: "HA", addon: false },
  );
  const untouchedBefore = fixture.slice(4).map((node) => JSON.stringify(node));
  const memberOrder = [...fixture[1].nodes];
  const result = await layoutFlows(fixture, { canvases: ["fixture"] });
  assert.deepEqual(result.flows[1].nodes, memberOrder);
  assert.deepEqual(result.flows.slice(4).map((node) => JSON.stringify(node)), untouchedBefore);
  assert.deepEqual(result.flows.map((node) => Object.keys(node)), fixture.map((node) => Object.keys(node)));
});

test("exports approved geometry for every positioned object", async () => {
  const fixture = groupedFixture([{ id: "a", wires: [["b"]] }, { id: "b", wires: [] }]);
  const result = await layoutFlows(fixture);
  const overrides = buildApprovedGeometryOverrides(result.flows);
  assert.deepEqual(Object.keys(overrides.canvases.canvas.nodes), ["group", "a", "b"]);
  assert.deepEqual(overrides.canvases.canvas.nodes.a, {
    x: byId(result.flows).get("a").x,
    y: byId(result.flows).get("a").y,
  });
});
