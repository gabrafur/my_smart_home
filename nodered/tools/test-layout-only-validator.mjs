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
