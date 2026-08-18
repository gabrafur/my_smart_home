#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const defaultTarget = "/data/.config.runtime.json";

export function removeGeneratedFallback(target, explicitSecret) {
  if (!explicitSecret || !fs.existsSync(target)) return false;
  const document = JSON.parse(fs.readFileSync(target, "utf8"));
  if (!Object.hasOwn(document, "_credentialSecret")) return false;
  delete document._credentialSecret;
  fs.writeFileSync(target, `${JSON.stringify(document, null, 4)}\n`);
  return true;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const target = process.argv[2] ? path.resolve(process.argv[2]) : defaultTarget;
  const changed = removeGeneratedFallback(target, process.env.NODE_RED_CREDENTIAL_SECRET);
  console.log(changed
    ? "Removed generated Node-RED credential fallback."
    : "Node-RED credential fallback already clean.");
}
