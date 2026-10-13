#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function installInputButtonRestorationGuards(flows) {
  for (const node of flows) {
    if (node.type !== "server-state-changed" ||
        !node.entities?.entity?.some((id) => id.startsWith("input_button."))) continue;
    // Entity creation/restoration has no previous State. A first real press
    // has an existing State, even when its value is still unknown.
    node.ignorePrevStateNull = true;
    node.ignorePrevStateUnknown = false;
    node.outputInitially = false;
  }
  return flows;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const target = path.resolve(process.argv[2] ?? new URL("../flows.json", import.meta.url).pathname);
  const flows = installInputButtonRestorationGuards(JSON.parse(fs.readFileSync(target, "utf8")));
  fs.writeFileSync(target, `${JSON.stringify(flows, null, 4)}\n`);
  console.log("Manual button restoration guards generated without changing canvas geometry.");
}
