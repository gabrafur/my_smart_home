#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(process.env.REPOSITORY_DEPENDENCY_REPO_ROOT ?? path.join(here, ".."));
const nodeRedDir = path.join(repoRoot, "nodered");
const packagePath = path.join(nodeRedDir, "package.json");
const lockPath = path.join(nodeRedDir, "package-lock.json");
const npmBin = process.env.REPOSITORY_DEPENDENCY_NPM_BIN ?? "npm";
const dockerBin = process.env.REPOSITORY_DEPENDENCY_DOCKER_BIN ?? "docker";

export function validatePackageName(value) {
  const name = String(value ?? "");
  if (!/^[a-z0-9][a-z0-9._-]{0,79}$/.test(name)) throw new Error("package_name_invalid");
  return name;
}

export function selectSameMajorTarget(currentVersion, versions) {
  const match = String(currentVersion ?? "").match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) throw new Error("current_version_not_exact_semver");
  const major = Number(match[1]);
  const parsed = versions
    .map((version) => {
      const parts = String(version).match(/^(\d+)\.(\d+)\.(\d+)$/);
      return parts ? { version: String(version), parts: parts.slice(1).map(Number) } : null;
    })
    .filter((entry) => entry && entry.parts[0] === major)
    .sort((left, right) => {
      for (let index = 0; index < 3; index += 1) {
        if (left.parts[index] !== right.parts[index]) return right.parts[index] - left.parts[index];
      }
      return 0;
    });
  if (!parsed.length) throw new Error("same_major_target_unavailable");
  return parsed[0].version;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    env: { ...process.env, ...(options.env ?? {}) },
  });
  if (result.error || (options.allowedStatuses ?? [0]).includes(result.status ?? -1) === false) {
    throw new Error(options.failure ?? "command_failed");
  }
  return result.stdout.trim();
}

function audit() {
  const output = run(npmBin, ["audit", "--json", "--omit=dev"], {
    cwd: nodeRedDir,
    allowedStatuses: [0, 1],
    failure: "npm_audit_unavailable",
  });
  const parsed = JSON.parse(output);
  if (!parsed || typeof parsed.vulnerabilities !== "object") throw new Error("npm_audit_contract_invalid");
  return parsed;
}

function waitForNodeRed() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const status = spawnSync(dockerBin, ["inspect", "-f", "{{.State.Health.Status}}", "nodered"], { encoding: "utf8" });
    if (status.status === 0 && status.stdout.trim() === "healthy") return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000);
  }
  throw new Error("nodered_health_timeout");
}

function installRuntime() {
  // The bind-mounted node_modules directory is maintained by the host account.
  // Installing there as the container's UID can fail after repository checks
  // legitimately recreate .bin entries with host ownership.
  run(npmBin, ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], {
    cwd: nodeRedDir,
    failure: "nodered_npm_ci_failed",
  });
  run(dockerBin, ["exec", "-w", "/data", "nodered", "npm", "run", "flows:validate"], {
    failure: "nodered_dependency_validation_failed",
  });
  run(dockerBin, ["compose", "restart", "nodered"], { failure: "nodered_restart_failed" });
  waitForNodeRed();
}

function runtimeVersion(packageName) {
  return run(dockerBin, [
    "exec", "-w", "/data", "nodered", "node", "-p",
    `require('./node_modules/${packageName}/package.json').version`,
  ], { failure: "runtime_version_unavailable" });
}

export function updateDependency({ packageName, dryRun = false }) {
  const name = validatePackageName(packageName);
  const packageBefore = fs.readFileSync(packagePath, "utf8");
  const lockBefore = fs.readFileSync(lockPath, "utf8");
  const packageJson = JSON.parse(packageBefore);
  const currentVersion = packageJson.overrides?.[name];
  if (typeof currentVersion !== "string") throw new Error("package_not_managed_by_override");
  if (!/^(\d+)\.(\d+)\.(\d+)$/.test(currentVersion)) throw new Error("override_not_exact_semver");

  const vulnerability = audit().vulnerabilities[name];
  if (!vulnerability) {
    return { status: "current", package: name, from: currentVersion, to: currentVersion };
  }
  if (!(vulnerability.fixAvailable === true || typeof vulnerability.fixAvailable === "object")) {
    throw new Error("audited_fix_unavailable");
  }
  const versionsRaw = run(npmBin, ["view", `${name}@${currentVersion.split(".")[0]}`, "version", "--json"], {
    cwd: nodeRedDir,
    failure: "npm_versions_unavailable",
  });
  const versionsValue = JSON.parse(versionsRaw);
  const versions = Array.isArray(versionsValue) ? versionsValue : [versionsValue];
  const targetVersion = selectSameMajorTarget(currentVersion, versions);
  if (targetVersion === currentVersion) throw new Error("same_major_fix_not_found");
  if (dryRun) return { status: "eligible", package: name, from: currentVersion, to: targetVersion };

  const gitState = run("git", ["status", "--porcelain"], { failure: "git_status_failed" });
  if (gitState) throw new Error("repository_not_clean");
  let runtimeTouched = false;
  try {
    packageJson.overrides[name] = targetVersion;
    fs.writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 4)}\n`);
    run(npmBin, ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"], {
      cwd: nodeRedDir,
      failure: "package_lock_update_failed",
    });
    if (audit().vulnerabilities[name]) throw new Error("target_still_vulnerable");
    runtimeTouched = true;
    installRuntime();
    const installedVersion = runtimeVersion(name);
    if (installedVersion !== targetVersion) throw new Error("runtime_version_mismatch");
    return { status: "success", package: name, from: currentVersion, to: targetVersion };
  } catch (error) {
    fs.writeFileSync(packagePath, packageBefore);
    fs.writeFileSync(lockPath, lockBefore);
    if (runtimeTouched) {
      try { installRuntime(); } catch { /* Preserve the original failure. */ }
    }
    throw error;
  }
}

function parseArgs(argv) {
  let packageName = null;
  let dryRun = false;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--package") packageName = argv[++index];
    else if (argv[index] === "--dry-run") dryRun = true;
    else throw new Error("argument_invalid");
  }
  return { packageName, dryRun };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = updateDependency(parseArgs(process.argv.slice(2)));
    console.log(`repository-dependency-update status=${result.status} package=${result.package} from=${result.from} to=${result.to}`);
  } catch (error) {
    console.error(`repository-dependency-update status=failed reason=${String(error?.message ?? "unknown").replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 80)}`);
    process.exitCode = String(error?.message) === "repository_not_clean" ? 75 : 1;
  }
}
