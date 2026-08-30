#!/usr/bin/env node

import assert from "node:assert/strict";
import test from "node:test";
import { validateFlowLayout } from "./flow-layout-validator.mjs";

const tab = { id: "tab", type: "tab", label: "test_flow" };
const group = { id: "group", type: "group", z: "tab", x: 64, y: 0, w: 300, h: 200 };

test("accepts separated nodes contained by a group", () => {
  const flows = [
    tab,
    group,
    { id: "one", type: "function", z: "tab", g: "group", name: "One", x: 144, y: 80 },
    { id: "two", type: "function", z: "tab", g: "group", name: "Two", x: 284, y: 80 },
  ];
  assert.deepEqual(validateFlowLayout(flows), []);
});

test("rejects overlapping nodes", () => {
  const flows = [tab,
    { id: "one", type: "function", z: "tab", name: "First node", x: 100, y: 100 },
    { id: "two", type: "function", z: "tab", name: "Second node", x: 120, y: 100 },
  ];
  assert.match(validateFlowLayout(flows).join("\n"), /nodes overlap: one \/ two/);
});

test("rejects overlapping groups", () => {
  const flows = [tab, group,
    { id: "other", type: "group", z: "tab", x: 290, y: 20, w: 200, h: 100 },
  ];
  assert.match(validateFlowLayout(flows).join("\n"), /groups overlap: group \/ other/);
});

test("rejects a grouped node outside its canvas group", () => {
  const flows = [tab, group,
    { id: "outside", type: "function", z: "tab", g: "group", name: "Outside", x: 354, y: 100 },
  ];
  assert.match(validateFlowLayout(flows).join("\n"), /node outside group bounds: outside \/ group/);
});

test("ignores configuration nodes without canvas coordinates", () => {
  assert.deepEqual(validateFlowLayout([tab, { id: "config", type: "server", name: "HA" }]), []);
});

test("rejects canvases without the standard left margin", () => {
  const flows = [
    tab,
    { id: "too-close", type: "group", z: "tab", x: 63, y: 0, w: 300, h: 200 },
  ];
  assert.match(validateFlowLayout(flows).join("\n"), /left margin below 64px/);
});
