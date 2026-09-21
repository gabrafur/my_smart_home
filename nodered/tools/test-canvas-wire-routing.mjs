import assert from "node:assert/strict";
import { routeCanvasWires, restoreGeneratedWireRoutes } from "./install-notification-hubs.mjs";

const original = [
  { id: "canvas", type: "tab", label: "fixture" },
  { id: "group", type: "group", z: "canvas", x: 64, y: 40, w: 1600, h: 600,
    nodes: ["source", "target", "manual-out", "manual-in", "terminal"] },
  { id: "source", type: "function", z: "canvas", g: "group", name: "Source", func: "return msg;", x: 250, y: 160, wires: [["target", "manual-out"]] },
  { id: "target", type: "function", z: "canvas", g: "group", name: "Target", func: "return msg;", x: 1100, y: 160, wires: [[]] },
  { id: "manual-out", type: "link out", z: "canvas", g: "group", name: "User route", x: 1100, y: 400, mode: "link", links: ["manual-in"], wires: [] },
  { id: "manual-in", type: "link in", z: "canvas", g: "group", name: "User destination", x: 250, y: 400, links: ["manual-out"], wires: [["terminal"]] },
  { id: "terminal", type: "function", z: "canvas", g: "group", name: "Terminal", func: "return null;", x: 550, y: 400, wires: [] },
];
const result = routeCanvasWires(structuredClone(original), ["canvas"]);
assert.equal(new Set(result.map((n) => n.id)).size, result.length);
for (const previous of original.filter((n) => n.type !== "group")) {
  const next = result.find((n) => n.id === previous.id);
  assert.equal(next.x, previous.x, "preserve user positions");
  assert.equal(next.y, previous.y);
  assert.equal(next.func, previous.func);
}
assert.deepEqual(result.find((n) => n.id === "manual-out"), original.find((n) => n.id === "manual-out"));
assert.deepEqual(restoreGeneratedWireRoutes(structuredClone(result)), original,
  "bridges preserve functional targets, fanout and existing manual links");
assert.deepEqual(routeCanvasWires(structuredClone(result), ["canvas"]), result,
  "repeated layout application must converge");

// Reproduce scoped regeneration: the original source is restored while its
// generated pair remains, and an intermediate generator cleared its input.
const partial = structuredClone(result);
partial.find((n) => n.id === "source").wires = structuredClone(original.find((n) => n.id === "source").wires);
for (const n of partial.filter((n) => n.id.startsWith("notification_hub_wire_in_"))) n.wires = [[]];
const repaired = routeCanvasWires(partial, ["canvas"]);
assert.equal(repaired.length, result.length, "never duplicate generated IDs");
assert.equal(new Set(repaired.map((n) => n.id)).size, repaired.length);
assert.deepEqual(restoreGeneratedWireRoutes(structuredClone(repaired)), original);
console.log("Canvas wire routing: manual layout, fanout, convergence and partial regeneration passed.");
