#!/usr/bin/env node

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

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
const notifier = byId.get("infra_notify_all_mobiles");
assert.equal(notifier?.type, "subflow");
for (const id of ["infra_notify_persistent", "infra_notify_mobile", "infra_notify_mobile_secondary", "infra_notify_echo", "infra_notify_dismiss"]) {
  assert.equal(byId.get(id)?.type, "api-call-service", `efeito compartilhado ausente: ${id}`);
}
assert.equal(byId.get("infra_notify_route")?.func.length < 600, true);

const temporary = path.join(os.tmpdir(), `node-red-infrastructure-${process.pid}.json`);
const generated = spawnSync(process.execPath, [path.join(here, "install-infrastructure-monitoring-flows.mjs"), flowPath, temporary], {
  encoding: "utf8",
});
if (generated.status !== 0) throw new Error(generated.stderr || generated.stdout || "gerador canônico falhou");
const digest = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
assert.equal(digest(temporary), digest(flowPath), "gerador canônico de infraestrutura não é idempotente");
fs.unlinkSync(temporary);

console.log("Canonical infrastructure generator and notifier tests passed.");
