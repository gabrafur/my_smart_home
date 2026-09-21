#!/usr/bin/env node

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { restoreGeneratedWireRoutes } from "./install-notification-hubs.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const flowPath = path.resolve(here, "..", "flows.json");
const flows = JSON.parse(fs.readFileSync(flowPath, "utf8"));
const byId = new Map(flows.map((node) => [node.id, node]));
for (const [id, label] of [
  ["monitoramento_internet_tab", "monitoramento_internet"],
  ["monitoramento_zigbee_tab", "monitoramento_zigbee"],
  ["monitoramento_tuya_tab", "monitoramento_tuya"],
]) assert.equal(byId.get(id)?.label, label);
for (const removed of ["internet_evaluate", "zigbee_network_evaluate", "zigbee_component_evaluate", "tuya_device_evaluate"]) {
  assert.equal(byId.has(removed), false, `monólito legado ainda existe: ${removed}`);
}
const broker = byId.get("721c47f31046b8bc");
assert.equal(broker.birthTopic, "nodered/status");
assert.equal(broker.willPayload, "offline");
assert.equal(byId.has("infra_notify_all_mobiles"), false, "subflow monolítico legado ainda existe");
for (const [id, hubInput] of [
  ["internet_notify_down", "notification_hub_mobile_in"],
  ["internet_notify_recovery", "notification_hub_mobile_in"],
  ["zigbee_notify_effect", "notification_hub_mobile_in"],
  ["tuya_notify_effect", "notification_hub_mobile_in"],
]) {
  assert.equal(byId.get(id)?.type, "change", `fanout visual ausente: ${id}`);
  assert.deepEqual(byId.get(`${id}__mobile_call`)?.links, [hubInput]);
  if (id.startsWith("internet_")) {
    assert.deepEqual(byId.get(`${id}__mobile_secondary_call`)?.links, [hubInput]);
  } else {
    assert.equal(byId.has(`${id}__mobile_secondary_call`), false);
  }
  assert.equal(byId.has(`${id}__alexa_call`), false);
  assert.deepEqual(byId.get(`${id}__persistent_call`)?.links, ["notification_hub_persistent_in"]);
}

const temporary = path.join(os.tmpdir(), `node-red-infrastructure-${process.pid}.json`);
const repeated = path.join(os.tmpdir(), `node-red-infrastructure-repeated-${process.pid}.json`);
const generated = spawnSync(process.execPath, [path.join(here, "install-infrastructure-monitoring-flows.mjs"), flowPath, temporary], {
  encoding: "utf8",
});
if (generated.status !== 0) throw new Error(generated.stderr || generated.stdout || "gerador canônico falhou");
const regenerated = spawnSync(process.execPath, [path.join(here, "install-infrastructure-monitoring-flows.mjs"), temporary, repeated], {
  encoding: "utf8",
});
if (regenerated.status !== 0) throw new Error(regenerated.stderr || regenerated.stdout || "segunda execução do gerador canônico falhou");
const digest = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const semanticProjection = (file) => restoreGeneratedWireRoutes(JSON.parse(fs.readFileSync(file, "utf8")))
  .map((node) => {
    const projected = structuredClone(node);
    for (const field of ["x", "y", "w", "h", "notification_hub_layout_version", "notification_hub_anchor_y", "notification_hub_wire_route"]) {
      delete projected[field];
    }
    if (Array.isArray(projected.nodes)) projected.nodes.sort();
    if (Array.isArray(projected.scope)) projected.scope.sort();
    return projected;
  })
  .sort((left, right) => left.id.localeCompare(right.id));
assert.deepEqual(semanticProjection(temporary), semanticProjection(flowPath), "gerador canônico alterou o comportamento do fluxo persistido");
assert.equal(digest(temporary), digest(repeated), "gerador canônico de infraestrutura não converge em uma execução");
fs.unlinkSync(temporary);
fs.unlinkSync(repeated);

console.log("Canonical infrastructure generator and notifier tests passed.");
