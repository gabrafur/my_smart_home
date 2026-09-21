#!/usr/bin/env node

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { reconcileGeneratedFlows } from "./reconcile-generated-flows.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const flowsPath = path.resolve(here, "..", "flows.json");
const baselineText = fs.readFileSync(flowsPath, "utf8");
const baseline = JSON.parse(baselineText);
for (const node of baseline) {
  for (const field of ["name", "label"]) {
    assert.doesNotMatch(String(node[field] ?? ""), /\uFFFD/, `${node.id}.${field}: texto corrompido na transferência UTF-8`);
  }
}
const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "nodered-generator-stability-"));
const hash = (text) => crypto.createHash("sha256").update(text).digest("hex");
const byId = (flows) => new Map(flows.map((node) => [node.id, node]));

function run(script, target, env = process.env) {
  const result = spawnSync(process.execPath, [path.join(here, script), target, target], {
    cwd: path.dirname(target), env, encoding: "utf8",
  });
  assert.equal(result.status, 0, `${script} falhou:\n${result.stdout}\n${result.stderr}`);
}

function changedIds(before, after) {
  const beforeById = byId(before);
  const afterById = byId(after);
  return [...new Set([...beforeById.keys(), ...afterById.keys()])]
    .filter((id) => JSON.stringify(beforeById.get(id)) !== JSON.stringify(afterById.get(id)))
    .sort();
}

function assertStableStructure(before, after, label) {
  const beforeById = byId(before);
  const afterById = byId(after);
  const commonBefore = before.filter((node) => afterById.has(node.id)).map((node) => node.id);
  const commonAfter = after.filter((node) => beforeById.has(node.id)).map((node) => node.id);
  assert.deepEqual(commonAfter, commonBefore, `${label}: ordem relativa global mudou`);
  for (const [id, current] of beforeById) {
    const generated = afterById.get(id);
    if (!generated) continue;
    for (const field of ["x", "y", "w", "h"]) {
      assert.equal(generated[field], current[field], `${label}: ${id}.${field} mudou`);
    }
    if (Array.isArray(current.nodes) && Array.isArray(generated.nodes)) {
      const commonCurrent = current.nodes.filter((member) => generated.nodes.includes(member));
      const commonGenerated = generated.nodes.filter((member) => current.nodes.includes(member));
      assert.deepEqual(commonGenerated, commonCurrent, `${label}: ordem de ${id}.nodes mudou`);
    }
  }
}

// Fixture pequena: update por id, preservação de layout/propriedades, escopo e topologia.
const fixture = [
  { id: "tab-managed", type: "tab", label: "managed" },
  { id: "managed-group", type: "group", z: "tab-managed", nodes: ["managed-existing", "unmanaged-child", "managed-removed"], x: 64, y: 40, w: 600, h: 300 },
  { id: "managed-existing", type: "function", z: "tab-managed", g: "managed-group", name: "old", func: "return msg;", custom: "preserve", x: 180, y: 120, wires: [[]] },
  { id: "unmanaged-child", type: "comment", z: "tab-managed", g: "managed-group", name: "untouched", x: 300, y: 120, wires: [] },
  { id: "managed-removed", type: "comment", z: "tab-managed", g: "managed-group", name: "remove", x: 420, y: 120, wires: [] },
  { id: "tab-unrelated", type: "tab", label: "unrelated" },
  { id: "unrelated-node", type: "function", z: "tab-unrelated", name: "byte-equivalent", func: "return msg;", x: 90, y: 90, wires: [[]] },
];
const desiredFixture = [
  { id: "tab-managed", type: "tab", label: "managed" },
  { id: "managed-group", type: "group", z: "tab-managed", nodes: ["managed-existing", "managed-new"], x: 999, y: 999, w: 1, h: 1 },
  { id: "managed-existing", type: "function", z: "tab-managed", g: "managed-group", name: "new", func: "return [msg];", x: 999, y: 999, wires: [[]] },
  { id: "unmanaged-child", type: "comment", z: "tab-managed", g: "managed-group", name: "must-not-change", x: 999, y: 999, wires: [] },
  { id: "tab-unrelated", type: "tab", label: "changed-by-provisional-build" },
  { id: "unrelated-node", type: "function", z: "tab-unrelated", name: "must-not-change", func: "return null;", x: 999, y: 999, wires: [] },
  { id: "managed-new", type: "function", z: "tab-managed", g: "managed-group", name: "new node", func: "return msg;", x: 540, y: 120, wires: [[]] },
];
const ownsFixture = (node) => node.id.startsWith("managed-");
const fixtureResult = reconcileGeneratedFlows(fixture, desiredFixture, {
  isOwned: ownsFixture,
  shouldUpdate: (current) => ownsFixture(current),
});
const fixtureById = byId(fixtureResult);
assert.equal(fixtureResult[2].id, "managed-existing", "nó atualizado deve permanecer no próprio índice");
assert.equal(fixtureById.get("managed-existing").name, "new");
assert.equal(fixtureById.get("managed-existing").custom, "preserve", "propriedade não administrada foi removida");
assert.deepEqual(
  ["x", "y"].map((field) => fixtureById.get("managed-existing")[field]),
  [180, 120],
  "coordenadas aprovadas devem permanecer",
);
assert.deepEqual(
  ["x", "y", "w", "h"].map((field) => fixtureById.get("managed-group")[field]),
  [64, 40, 600, 300],
  "dimensões aprovadas do grupo devem permanecer",
);
assert.deepEqual(fixtureById.get("managed-group").nodes, ["managed-existing", "unmanaged-child", "managed-new"]);
assert.equal(fixtureById.has("managed-removed"), false, "nó obsoleto realmente administrado deve sair");
assert.equal(JSON.stringify(fixtureById.get("unmanaged-child")), JSON.stringify(fixture[3]));
assert.equal(JSON.stringify(fixtureById.get("unrelated-node")), JSON.stringify(fixture[6]));
assert.equal(fixtureResult.at(-1).id, "managed-new", "nó novo deve ser acrescentado ao fim");
const fixtureSecond = reconcileGeneratedFlows(fixtureResult, desiredFixture, {
  isOwned: ownsFixture,
  shouldUpdate: (current) => ownsFixture(current),
});
assert.equal(fixtureSecond.filter((node) => node.id === "managed-new").length, 1);
assert.equal(JSON.stringify(fixtureSecond), JSON.stringify(fixtureResult));

// Cada gerador deve estabilizar após a primeira execução sem ordem/geometria artificial.
for (const [name, script] of [
  ["resident", "install-resident-notifications-flow.mjs"],
  ["arrival", "install-arrival-context-flow.mjs"],
  ["location", "install-location-lifecycle-flow.mjs"],
  ["security", "install-security-light-visual-policy.mjs"],
  ["observer", "install-global-flow-observer.mjs"],
]) {
  const target = path.join(temporaryDirectory, `${name}.json`);
  fs.writeFileSync(target, baselineText);
  run(script, target);
  const firstText = fs.readFileSync(target, "utf8");
  const first = JSON.parse(firstText);
  assertStableStructure(baseline, first, name);
  run(script, target);
  assert.equal(fs.readFileSync(target, "utf8"), firstText, `${name}: segunda execução não foi idempotente`);
}

// A cadeia pública deve ser byte a byte neutra e manter o mesmo hash em duas execuções.
const updateTarget = path.join(temporaryDirectory, "update-location.json");
fs.writeFileSync(updateTarget, baselineText);
run("update-location-flows.mjs", updateTarget);
const firstUpdate = fs.readFileSync(updateTarget, "utf8");
assert.equal(firstUpdate, baselineText, "flows:update-location alterou um fluxo já reconciliado");
run("update-location-flows.mjs", updateTarget);
const secondUpdate = fs.readFileSync(updateTarget, "utf8");
assert.equal(hash(secondUpdate), hash(firstUpdate), "hash mudou na segunda execução de flows:update-location");

// Uma mudança funcional pequena deve tocar somente os quatro nós administrados.
const functionalTarget = path.join(temporaryDirectory, "functional-change.json");
const stale = structuredClone(baseline);
const staleById = byId(stale);
staleById.get("security_visual_arrival_facts").func = "return null;";
staleById.get("security_light_arrival_direction_blocked_v1").func = "return null;";
staleById.get("security_light_arrival_direction_gate_v1").name = "stale";
staleById.get("security_light_arrival_direction_gate_v1").property = "stale";
staleById.get("people_arrival_direction_note_v1").name = "stale";
fs.writeFileSync(
  functionalTarget,
  `${JSON.stringify(stale, null, 4)}${baselineText.endsWith("\n") ? "\n" : ""}`,
);
run("update-location-flows.mjs", functionalTarget);
const functionalResultText = fs.readFileSync(functionalTarget, "utf8");
const functionalResult = JSON.parse(functionalResultText);
assert.deepEqual(changedIds(stale, functionalResult), [
  "people_arrival_direction_note_v1",
  "security_light_arrival_direction_blocked_v1",
  "security_light_arrival_direction_gate_v1",
  "security_visual_arrival_facts",
]);
assert.equal(functionalResultText, baselineText, "reconciliação funcional não retornou ao arquivo aprovado");
assertStableStructure(stale, functionalResult, "functional-change");
run("update-location-flows.mjs", functionalTarget);
assert.equal(fs.readFileSync(functionalTarget, "utf8"), functionalResultText);

fs.rmSync(temporaryDirectory, { recursive: true, force: true });
console.log("Flow generator stability tests passed.");
