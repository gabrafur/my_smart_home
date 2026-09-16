#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.resolve(process.argv[2] ?? path.resolve(here, "..", "flows.json"));
const outputPath = path.resolve(process.argv[3] ?? sourcePath);
const sourceEndedWithNewline = fs.readFileSync(sourcePath, "utf8").endsWith("\n");
const scripts = [
  "install-resident-notifications-flow.mjs",
  "install-arrival-context-flow.mjs",
  "install-location-lifecycle-flow.mjs",
  "install-security-light-visual-policy.mjs",
  "install-global-flow-observer.mjs",
  "apply-left-margin.mjs",
];
const layoutCanvases = [
  "resident_notifications_tab",
  "62bb822e033d1623",
  "ea0a6aa0d24ff863",
  "c22d8b12055e87f7",
  "6b7552efb85343f4",
  "global_flow_observer_tab",
  "notification_hub_mobile_tab",
  "notification_hub_alexa_tab",
  "notification_hub_persistent_tab",
].join(",");

if (sourcePath !== outputPath) fs.copyFileSync(sourcePath, outputPath);

for (const script of scripts) {
  const env = script === "apply-left-margin.mjs"
    ? {
        ...process.env,
        FLOW_LAYOUT_CANVASES: layoutCanvases,
        FLOW_LAYOUT_APPLY_BASE_NODES: "0",
        FLOW_LAYOUT_APPLY_GROUP_POSITIONS: "0",
        FLOW_LAYOUT_APPLY_NODE_POSITIONS: "0",
      }
    : process.env;
  const result = spawnSync(process.execPath, [path.join(here, script), outputPath, outputPath], {
    cwd: path.dirname(outputPath),
    env,
    stdio: "inherit",
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

// Node-RED may serialize flows.json without a terminal newline. Preserve the
// input byte convention so a no-op regeneration remains a true no-op.
if (!sourceEndedWithNewline) {
  const generated = fs.readFileSync(outputPath, "utf8");
  if (generated.endsWith("\n")) fs.writeFileSync(outputPath, generated.slice(0, -1));
}
