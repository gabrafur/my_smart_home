#!/usr/bin/env node

import fs from "node:fs";

const flowUrl = new URL("../flows.json", import.meta.url);
const flows = JSON.parse(fs.readFileSync(flowUrl, "utf8"));
const actionableIds = new Set([
  "ext_send_recovery_mobile",
  "3b95712a74512929",
  "370622ddaaf3fcab",
]);

let changed = 0;
for (const node of flows) {
  if (!actionableIds.has(node.id)) continue;
  if (node.action !== "public_bindings.call" || typeof node.data !== "string") {
    throw new Error(`Binding acionável inválido: ${node.id}`);
  }
  if (!/"data"\s*:\s*\{/.test(node.data)) {
    throw new Error(`Payload móvel ausente: ${node.id}`);
  }
  const updated = node.data.replace(
    /"action":"(?:notify_[23]|notify_actionable)"/,
    '"action":"notify_actionable"',
  );
  if (!updated.includes('"action":"notify_actionable"')) {
    throw new Error(`Ação lógica ausente: ${node.id}`);
  }
  if (updated !== node.data) changed += 1;
  node.data = updated;
  node.queue = "all";
}

for (const id of actionableIds) {
  if (!flows.some((node) => node.id === id)) {
    throw new Error(`Nó acionável ausente: ${id}`);
  }
}

fs.writeFileSync(flowUrl, `${JSON.stringify(flows, null, 4)}\n`);
console.log(`Bindings acionáveis corrigidos: ${changed} alteração(ões).`);
