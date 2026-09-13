#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..");
const packagePath = path.join(projectRoot, "package.json");
const lockPath = path.join(projectRoot, "package-lock.json");

export function normalizeAudit(audit, packageJson, packageLock) {
  if (!audit || typeof audit.vulnerabilities !== "object") {
    throw new Error("npm_audit_contract_invalid");
  }
  const overrides = packageJson.overrides ?? {};
  const dependencies = packageJson.dependencies ?? {};
  const lockPackages = packageLock.packages ?? {};
  const candidates = Object.values(audit.vulnerabilities)
    .filter((entry) => entry && typeof entry.name === "string")
    .map((entry) => {
      const name = entry.name;
      const override = typeof overrides[name] === "string" ? overrides[name] : null;
      const direct = typeof dependencies[name] === "string" ? dependencies[name] : null;
      const currentVersion = lockPackages[`node_modules/${name}`]?.version ?? null;
      const managedSurface = override ? "override" : direct ? "dependency" : "transitive";
      return {
        version: 1,
        package: name,
        severity: String(entry.severity ?? "unknown"),
        current_version: currentVersion,
        declared_version: override ?? direct,
        managed_surface: managedSurface,
        fix_available: entry.fixAvailable === true || typeof entry.fixAvailable === "object",
        advisory_count: Array.isArray(entry.via)
          ? entry.via.filter((item) => item && typeof item === "object").length
          : 0,
        signature: [name, currentVersion, entry.severity, entry.fixAvailable === false ? "blocked" : "fix"].join(":"),
      };
    })
    .sort((left, right) => left.package.localeCompare(right.package));
  return {
    version: 1,
    status: "ok",
    source: "npm_audit",
    candidates,
    candidate_count: candidates.length,
    scanned_at: new Date().toISOString(),
  };
}

export function scan() {
  const result = spawnSync("npm", ["audit", "--json", "--omit=dev"], {
    cwd: projectRoot,
    encoding: "utf8",
    maxBuffer: 5 * 1024 * 1024,
  });
  if (result.error || ![0, 1].includes(result.status ?? -1)) {
    throw new Error("npm_audit_unavailable");
  }
  const audit = JSON.parse(result.stdout);
  const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  const packageLock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  return normalizeAudit(audit, packageJson, packageLock);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify(scan()));
  } catch (error) {
    console.log(JSON.stringify({
      version: 1,
      status: "unavailable",
      source: "npm_audit",
      candidates: [],
      error: String(error?.message ?? "scan_failed").slice(0, 120),
      scanned_at: new Date().toISOString(),
    }));
  }
}
