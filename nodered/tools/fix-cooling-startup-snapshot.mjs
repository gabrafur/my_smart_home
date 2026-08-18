#!/usr/bin/env node

import fs from "node:fs";

const flowUrl = new URL("../flows.json", import.meta.url);
const flows = JSON.parse(fs.readFileSync(flowUrl, "utf8"));
const node = flows.find((entry) => entry.id === "566d191a914b687b");
if (!node || node.type !== "function") {
  throw new Error("Cooling startup classifier not found");
}

const oldBlock = `if (typeof msg.stored_snapshot === "string" && msg.stored_snapshot.trim()) {
    try {
        const parsed = JSON.parse(msg.stored_snapshot);
        if (parsed && typeof parsed.state === "string") pendingSnapshot = parsed;
    } catch (error) {
        node.warn("Snapshot pendente inválido no startup: " + error.message);
    }
}`;

const fixedBlock = `if (typeof msg.stored_snapshot === "string") {
    const rawSnapshot = msg.stored_snapshot.trim();
    const transientStates = new Set(["", "unknown", "unavailable", "none", "null"]);
    if (!transientStates.has(rawSnapshot.toLowerCase())) {
        try {
            const parsed = JSON.parse(rawSnapshot);
            if (parsed && typeof parsed.state === "string") pendingSnapshot = parsed;
            else node.warn("Snapshot pendente inválido no startup: contrato ausente");
        } catch (error) {
            node.warn("Snapshot pendente inválido no startup: " + error.message);
        }
    }
}`;

if (node.func.includes(oldBlock)) node.func = node.func.replace(oldBlock, fixedBlock);
else if (!node.func.includes("const transientStates = new Set")) {
  throw new Error("Cooling startup classifier changed unexpectedly");
}

fs.writeFileSync(flowUrl, `${JSON.stringify(flows, null, 4)}\n`);
console.log("Cooling startup snapshot handling fixed.");
