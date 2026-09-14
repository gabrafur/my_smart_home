#!/usr/bin/env node

import assert from "node:assert/strict";
import test from "node:test";
import { compareLayoutOnly, renderComparison } from "./validate-layout-only.mjs";

const baseline = [
  { id: "tab", type: "tab", label: "example", disabled: false },
  { id: "group", type: "group", z: "tab", name: "Lane", nodes: ["node"], x: 64, y: 20, w: 400, h: 160 },
  { id: "node", type: "function", z: "tab", g: "group", name: "Work", x: 180, y: 100, wires: [[]], func: "return msg;" },
];

function clone(value) {
  return structuredClone(value);
}

test("accepts only node coordinates and group dimensions", () => {
  const after = clone(baseline);
  after[1].x = 84;
  after[1].y = 40;
  after[1].w = 460;
  after[1].h = 200;
  after[2].x = 240;
  after[2].y = 140;
  const result = compareLayoutOnly(baseline, after);
  assert.deepEqual(result.functionalDifferences, []);
  assert.equal(result.visualChanges.length, 6);
  assert.equal(renderComparison(result).ok, true);
});

test("rejects a functional wire change", () => {
  const after = clone(baseline);
  after[2].wires = [["other"]];
  const result = compareLayoutOnly(baseline, after);
  assert.match(renderComparison(result).text, /Functional change detected/);
  assert.match(result.functionalDifferences.map((item) => item.path).join("\n"), /wires/);
});

test("rejects group membership and nested coordinate changes", () => {
  const before = clone(baseline);
  before[2].data = { x: 1 };
  const after = clone(before);
  after[1].nodes = [];
  after[2].data.x = 2;
  const paths = compareLayoutOnly(before, after).functionalDifferences.map((item) => item.path).join("\n");
  assert.match(paths, /\.nodes/);
  assert.match(paths, /\.data\.x/);
});

test("rejects dimensions on non-group nodes", () => {
  const before = clone(baseline);
  before[2].w = 120;
  const after = clone(before);
  after[2].w = 180;
  assert.match(renderComparison(compareLayoutOnly(before, after)).text, /Functional change detected/);
});

test("rejects coordinates on objects that are not placed in a canvas", () => {
  const before = [{ id: "tab", type: "tab", label: "example", x: 1, y: 2 }];
  const after = clone(before);
  after[0].x = 10;
  assert.match(renderComparison(compareLayoutOnly(before, after)).text, /Functional change detected/);
});

test("rejects property addition, removal, and array reordering", () => {
  const afterWithProperty = clone(baseline);
  afterWithProperty[2].y2 = 100;
  assert.equal(renderComparison(compareLayoutOnly(baseline, afterWithProperty)).ok, false);

  const afterReordered = [baseline[1], baseline[0], baseline[2]];
  assert.equal(renderComparison(compareLayoutOnly(baseline, afterReordered)).ok, false);
});

test("rejects overlapping groups in a changed canvas", () => {
  const before = [
    { id: "tab", type: "tab", label: "example" },
    { id: "left", type: "group", z: "tab", name: "Left", nodes: [], x: 64, y: 20, w: 200, h: 160 },
    { id: "right", type: "group", z: "tab", name: "Right", nodes: [], x: 300, y: 20, w: 200, h: 160 },
  ];
  const after = clone(before);
  after[2].x = 240;
  const result = compareLayoutOnly(before, after);
  assert.deepEqual(result.functionalDifferences, []);
  assert.match(renderComparison(result).text, /groups overlap/);
});

test("rejects a wire crossing a node in a changed canvas", () => {
  const before = [
    { id: "tab", type: "tab", label: "example" },
    { id: "group", type: "group", z: "tab", name: "Lane", nodes: ["source", "obstacle", "target"], x: 64, y: 20, w: 700, h: 260 },
    { id: "source", type: "function", z: "tab", g: "group", name: "Source", x: 160, y: 100, wires: [["target"]], func: "return msg;" },
    { id: "obstacle", type: "function", z: "tab", g: "group", name: "Obstacle", x: 360, y: 210, wires: [[]], func: "return msg;" },
    { id: "target", type: "function", z: "tab", g: "group", name: "Target", x: 600, y: 100, wires: [[]], func: "return msg;" },
  ];
  const after = clone(before);
  after[3].y = 100;
  const result = compareLayoutOnly(before, after);
  assert.deepEqual(result.functionalDifferences, []);
  assert.match(renderComparison(result).text, /wire\(s\) cross node\(s\)/);
});

test("rejects long and right-to-left wires in a changed canvas", () => {
  const before = [
    { id: "tab", type: "tab", label: "example" },
    { id: "source", type: "function", z: "tab", name: "Source", x: 180, y: 100, wires: [["target"]], func: "return msg;" },
    { id: "target", type: "function", z: "tab", name: "Target", x: 420, y: 100, wires: [[]], func: "return msg;" },
  ];
  const longAfter = clone(before);
  longAfter[2].x = 800;
  assert.match(renderComparison(compareLayoutOnly(before, longAfter)).text, /exceed 500px/);

  const reverseAfter = clone(before);
  reverseAfter[1].x = 600;
  assert.match(renderComparison(compareLayoutOnly(before, reverseAfter)).text, /right-to-left/);
});

test("reports possible wire crossings as a render warning", () => {
  const before = [
    { id: "tab", type: "tab", label: "example" },
    { id: "a", type: "function", z: "tab", name: "A", x: 140, y: 80, wires: [["d"]], func: "return msg;" },
    { id: "b", type: "function", z: "tab", name: "B", x: 140, y: 180, wires: [["c"]], func: "return msg;" },
    { id: "c", type: "function", z: "tab", name: "C", x: 420, y: 80, wires: [[]], func: "return msg;" },
    { id: "d", type: "function", z: "tab", name: "D", x: 420, y: 180, wires: [[]], func: "return msg;" },
  ];
  const after = clone(before);
  after[1].x = 150;
  const rendered = renderComparison(compareLayoutOnly(before, after));
  assert.equal(rendered.ok, true);
  assert.match(rendered.text, /WARNING: .*possible wire crossing/);
});

test("rejects a visual backtrack between the real node ports", () => {
  const before = [
    { id: "tab", type: "tab", label: "example" },
    { id: "source", type: "link in", z: "tab", name: "Source", x: 300, y: 100, wires: [["target"]] },
    { id: "target", type: "function", z: "tab", name: "A very wide destination node label", x: 500, y: 200, wires: [[]], func: "return msg;" },
  ];
  const after = clone(before);
  after[2].x = 370;
  const rendered = renderComparison(compareLayoutOnly(before, after));
  assert.equal(rendered.ok, false);
  assert.match(rendered.text, /right-to-left wire/);
});

test("rejects a group isolated by an excessive empty gap", () => {
  const before = [
    { id: "tab", type: "tab", label: "example" },
    { id: "left", type: "group", z: "tab", name: "Left", nodes: [], x: 64, y: 20, w: 200, h: 160 },
    { id: "right", type: "group", z: "tab", name: "Right", nodes: [], x: 300, y: 20, w: 200, h: 160 },
  ];
  const after = clone(before);
  after[2].x = 700;
  const rendered = renderComparison(compareLayoutOnly(before, after));
  assert.equal(rendered.ok, false);
  assert.match(rendered.text, /farther than 160px/);
});

test("rejects separated group chains even when every group has a close neighbor", () => {
  const before = [
    { id: "tab", type: "tab", label: "example" },
    { id: "a", type: "group", z: "tab", name: "A", nodes: [], x: 64, y: 20, w: 200, h: 160 },
    { id: "b", type: "group", z: "tab", name: "B", nodes: [], x: 280, y: 20, w: 200, h: 160 },
    { id: "c", type: "group", z: "tab", name: "C", nodes: [], x: 500, y: 20, w: 200, h: 160 },
    { id: "d", type: "group", z: "tab", name: "D", nodes: [], x: 716, y: 20, w: 200, h: 160 },
  ];
  const after = clone(before);
  after[3].x = 700;
  after[4].x = 916;
  const rendered = renderComparison(compareLayoutOnly(before, after));
  assert.equal(rendered.ok, false);
  assert.doesNotMatch(rendered.text, /farther than 160px/);
  assert.match(rendered.text, /disconnected group cluster/);
});
