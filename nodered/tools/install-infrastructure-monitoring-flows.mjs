#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { refreshNotificationWireRoutes } from "./install-notification-hubs.mjs";
import { reconcileGeneratedFlows } from "./reconcile-generated-flows.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.resolve(process.argv[2] ?? path.resolve(here, "..", "flows.json"));
const outputPath = path.resolve(process.argv[3] ?? sourcePath);
const flows = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
const originalFlows = structuredClone(flows);
const broker = flows.find((node) => node.id === "721c47f31046b8bc");
if (!broker) throw new Error("Configuração MQTT esperada não foi encontrada.");
Object.assign(broker, {
  birthTopic: "nodered/status", birthQos: "1", birthRetain: "true", birthPayload: "online",
  closeTopic: "nodered/status", closeQos: "1", closeRetain: "true", closePayload: "offline",
  willTopic: "nodered/status", willQos: "1", willRetain: "true", willPayload: "offline",
});
fs.writeFileSync(outputPath, `${JSON.stringify(flows, null, 4)}\n`);

for (const script of [
  "install-infrastructure-notifier-subflow.mjs",
  "install-internet-monitor-flow.mjs",
  "install-zigbee-monitor-flow.mjs",
  "install-tuya-monitor-flow.mjs",
  "install-global-flow-observer.mjs",
]) {
  execFileSync(process.execPath, [path.join(here, script), outputPath, outputPath], {
    stdio: "inherit",
    env: { ...process.env, NODE_RED_NOTIFICATION_ROUTE_WIRES: "0" },
  });
}
const routedFlows = refreshNotificationWireRoutes(JSON.parse(fs.readFileSync(outputPath, "utf8")));
// Updating infrastructure must not reset the user's lighting, notification hubs
// or manual routes in other canvases as a side effect of shared generators.
const tabs = new Set(["monitoramento_internet_tab", "monitoramento_zigbee_tab", "monitoramento_tuya_tab"]);
const owned = (node) => tabs.has(node.id) || tabs.has(node.z) || node.id === broker.id;
const reconciled = reconcileGeneratedFlows(originalFlows, routedFlows, { isOwned: owned, shouldUpdate: owned });
fs.writeFileSync(outputPath, `${JSON.stringify(reconciled, null, 4)}\n`);
console.log(`Canonical infrastructure flows installed in ${outputPath}`);
