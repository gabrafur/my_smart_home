#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const defaultTarget = "/data/flows.json";
const sunsetNodeId = "24743bc9f254d1c1";

export function disableAutomaticExternalLightingRecovery(flows) {
  const sunset = flows.find((node) => node.id === sunsetNodeId);
  if (!sunset || sunset.type !== "server-state-changed") {
    throw new Error(`External-lighting sunset node not found: ${sunsetNodeId}`);
  }
  if (sunset.outputInitially === false) return false;
  sunset.outputInitially = false;
  return true;
}

export function removePrivateServiceData(flows) {
  let changed = false;
  for (const [id, action] of Object.entries({
    "70eb073f8191e69e": "arm_away",
    "8261c7cfb6756ca8": "disarm",
  })) {
    const node = flows.find((candidate) => candidate.id === id);
    const call = JSON.parse(node?.data ?? "null");
    if (call?.role !== "security_panel" || call?.action !== action) {
      throw new Error(`Security-panel binding call not found: ${id}`);
    }
    if (call.data && Object.hasOwn(call.data, "code")) {
      delete call.data.code;
      node.data = JSON.stringify(call);
      changed = true;
    }
  }
  return changed;
}

export function patchFile(target = defaultTarget) {
  const flows = JSON.parse(fs.readFileSync(target, "utf8"));
  const recovered = disableAutomaticExternalLightingRecovery(flows);
  const sanitized = removePrivateServiceData(flows);
  const changed = recovered || sanitized;
  if (changed) fs.writeFileSync(target, `${JSON.stringify(flows, null, 4)}\n`);
  return changed;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const target = process.argv[2] ? path.resolve(process.argv[2]) : defaultTarget;
  const changed = patchFile(target);
  console.log(changed
    ? "Runtime flow safety patches applied."
    : "Runtime flow safety patches already present.");
}
