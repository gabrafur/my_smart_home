#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, "modules/features.json"), "utf8"));
const composeText = fs.readFileSync(path.join(repoRoot, "docker-compose.yml"), "utf8");
const servicesStart = composeText.search(/^services:\s*$/m);
const servicesTail = composeText.slice(servicesStart).replace(/^services:\s*\n/, "");
const nextTopLevel = servicesTail.search(/^[a-zA-Z][a-zA-Z0-9_-]*:\s*$/m);
const servicesBlock = nextTopLevel < 0 ? servicesTail : servicesTail.slice(0, nextTopLevel);
const allExpected = [...servicesBlock.matchAll(/^ {2}([a-zA-Z0-9_-]+):\s*$/gm)]
  .map((match) => match[1]).sort();

function services(profiles = false) {
  const args = ["compose", "--env-file", ".env.example", "-f", "docker-compose.yml", "-f", "compose.modules.yml"];
  if (profiles) args.push("--profile", "*");
  args.push("config", "--services");
  const result = spawnSync("docker", args, { cwd: repoRoot, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr.trim() || "docker compose config failed");
  return result.stdout.trim().split(/\r?\n/).filter(Boolean).sort();
}

const core = services();
const full = services(true);
const coreExpected = [...manifest.core].sort();
if (JSON.stringify(core) !== JSON.stringify(coreExpected)) {
  throw new Error(`core Compose matrix drift: expected ${coreExpected.join(", ")}; got ${core.join(", ")}`);
}
if (JSON.stringify(full) !== JSON.stringify(allExpected)) {
  throw new Error(`full Compose matrix drift: expected ${allExpected.join(", ")}; got ${full.join(", ")}`);
}
console.log(`Compose matrix check passed: core=${core.length}, full=${full.length} services.`);
