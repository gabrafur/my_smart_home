#!/usr/bin/env node

// Compatibilidade para comandos antigos: o subflow monolítico foi substituído
// pelos três hubs canônicos. Este wrapper nunca recria efeitos diretos.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { installNotificationHubs } from "./install-notification-hubs.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.resolve(process.argv[2] ?? path.resolve(here, "..", "flows.json"));
const outputPath = path.resolve(process.argv[3] ?? sourcePath);
const flows = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
fs.writeFileSync(outputPath, `${JSON.stringify(installNotificationHubs(flows), null, 4)}\n`);
console.log(`Canonical notification hubs installed in ${outputPath}`);
