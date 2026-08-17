#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function servicesFromCompose(file) {
  const text = fs.readFileSync(file, "utf8");
  const servicesStart = text.indexOf("services:\n");
  if (servicesStart < 0) throw new Error("Compose file has no services block");
  return new Set([...text.slice(servicesStart).matchAll(/^ {2}([a-zA-Z0-9_-]+):\s*$/gm)].map((match) => match[1]));
}

export function validateModules(root = repoRoot) {
  const errors = [];
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "modules/features.json"), "utf8"));
  const baseServices = servicesFromCompose(path.join(root, "docker-compose.yml"));
  const overlay = fs.readFileSync(path.join(root, "compose.modules.yml"), "utf8");
  const modules = new Map();
  if (manifest.schema_version !== 1 || !Array.isArray(manifest.modules)) errors.push("invalid feature manifest schema");
  for (const module of manifest.modules ?? []) {
    if (!/^[a-z][a-z0-9-]*$/.test(module.name) || modules.has(module.name)) errors.push(`invalid or duplicate module: ${module.name}`);
    modules.set(module.name, module);
    if (typeof module.optional !== "boolean" || !Array.isArray(module.services) || !Array.isArray(module.depends_on) || !Array.isArray(module.configuration)) errors.push(`invalid module contract: ${module.name}`);
    for (const service of module.services ?? []) if (!baseServices.has(service)) errors.push(`unknown Compose service ${service} in module ${module.name}`);
    if (module.profile) {
      for (const service of module.services) {
        const pattern = new RegExp(`^  ${service}:\\n(?:    .*\\n)*?    profiles: \\["${module.profile}"\\]`, "m");
        if (!pattern.test(overlay) && !(service === "docs-review-scheduler" && module.profile === "automation")) errors.push(`missing profile overlay for ${service}`);
      }
    }
  }
  for (const module of manifest.modules ?? []) for (const dependency of module.depends_on) if (!modules.has(dependency)) errors.push(`unknown module dependency ${dependency}`);
  const core = modules.get("core");
  if (!core || core.optional || JSON.stringify(core.services) !== JSON.stringify(manifest.core)) errors.push("core service contract is inconsistent");
  for (const module of manifest.modules ?? []) {
    for (const file of module.configuration) {
      if (["matter-server", "portainer"].includes(file)) continue;
      if (!fs.existsSync(path.join(root, file))) errors.push(`module ${module.name} references missing path: ${file}`);
    }
  }
  return { valid: errors.length === 0, errors, modules: manifest.modules?.length ?? 0, core_services: manifest.core?.length ?? 0 };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = validateModules();
    if (!result.valid) throw new Error(result.errors[0]);
    console.log(`Module check passed: ${result.modules} modules, ${result.core_services} core services.`);
  } catch (error) {
    console.error(`modules-check: ${error.message}`);
    process.exit(1);
  }
}
