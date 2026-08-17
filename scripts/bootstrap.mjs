#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fail(message) {
  throw new Error(message);
}

function readJson(file, label) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    fail(`${label} is missing or invalid`);
  }
}

function safeRelative(value, label) {
  if (!value || path.isAbsolute(value) || value.includes("\\")) fail(`${label} must be a portable relative path`);
  const normalized = path.posix.normalize(value);
  if (normalized !== value || normalized === "." || normalized === ".." || normalized.startsWith("../")) fail(`${label} escapes the clone root`);
}

function assertNoSymlinkWithin(root, candidate, label) {
  const relative = path.relative(root, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) fail(`${label} escapes the clone root`);
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) fail(`${label} symlink rejected`);
  }
}

function replaceEnvValue(content, key, value) {
  const expression = new RegExp(`^${key}=.*$`, "m");
  if (!expression.test(content)) fail(`bootstrap generator key is missing: ${key}`);
  return content.replace(expression, `${key}=${value}`);
}

function generatedTemplate(content, generators) {
  let result = content;
  for (const key of generators) result = replaceEnvValue(result, key, crypto.randomBytes(32).toString("hex"));
  return result;
}

function toolStatus(command, args = ["--version"]) {
  const result = spawnSync(command, args, { stdio: "ignore" });
  return result.status === 0;
}

function expandModules(selected, modulesByName) {
  const result = new Set();
  const visiting = new Set();
  const visit = (name) => {
    if (result.has(name)) return;
    if (visiting.has(name)) fail(`module dependency cycle at ${name}`);
    const module = modulesByName.get(name);
    if (!module) fail(`unknown module: ${name}`);
    visiting.add(name);
    for (const dependency of module.depends_on) visit(dependency);
    visiting.delete(name);
    result.add(name);
  };
  for (const name of selected) visit(name);
  return result;
}

export function bootstrapClone(root, { selectedModules = ["core"], checkTools = true } = {}) {
  const cloneRoot = path.resolve(root);
  const features = readJson(path.join(cloneRoot, "modules/features.json"), "module manifest");
  const bootstrap = readJson(path.join(cloneRoot, "bootstrap/bootstrap-manifest.json"), "bootstrap manifest");
  if (features.schema_version !== 1 || bootstrap.schema_version !== 1) fail("unsupported bootstrap schema version");
  const modulesByName = new Map(features.modules.map((module) => [module.name, module]));
  const modules = expandModules(selectedModules, modulesByName);
  const created = [];
  const preserved = [];

  for (const entry of bootstrap.templates.filter((candidate) => modules.has(candidate.module))) {
    safeRelative(entry.source, "template source");
    safeRelative(entry.destination, "private destination");
    if (!/^0[0-7]{3}$/.test(entry.mode) || !Array.isArray(entry.generators)) fail("invalid bootstrap template contract");
    const source = path.join(cloneRoot, ...entry.source.split("/"));
    const destination = path.join(cloneRoot, ...entry.destination.split("/"));
    assertNoSymlinkWithin(cloneRoot, source, "public bootstrap template");
    assertNoSymlinkWithin(cloneRoot, destination, "private destination");
    if (!fs.existsSync(source) || !fs.lstatSync(source).isFile()) fail(`public bootstrap template missing: ${entry.source}`);
    if (fs.existsSync(destination)) {
      preserved.push(entry.destination);
      continue;
    }
    const parent = path.dirname(destination);
    if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    const content = generatedTemplate(fs.readFileSync(source, "utf8"), entry.generators);
    fs.writeFileSync(destination, content, { mode: Number.parseInt(entry.mode, 8), flag: "wx" });
    fs.chmodSync(destination, Number.parseInt(entry.mode, 8));
    created.push(entry.destination);
  }

  const gaps = bootstrap.gaps.filter((gap) => modules.has(gap.module));
  const tools = checkTools ? {
    node: toolStatus("node"),
    git: toolStatus("git"),
    docker: toolStatus("docker"),
    docker_compose: toolStatus("docker", ["compose", "version"]),
  } : { skipped: true };
  if (checkTools && (!tools.node || !tools.git)) fail("required bootstrap tools are unavailable");
  return {
    operation: "bootstrap",
    modules: [...modules],
    created,
    preserved,
    gaps,
    tools,
    overwritten: false,
    containers_started: false,
  };
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) fail("unexpected positional argument");
    const key = token.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) fail(`missing value for --${key}`);
    options[key] = value;
    index += 1;
  }
  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const selectedModules = (options.modules ?? "core").split(",").map((value) => value.trim()).filter(Boolean);
    const result = bootstrapClone(options.root ? path.resolve(options.root) : repoRoot, { selectedModules });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(`bootstrap: ${error.message}`);
    process.exit(1);
  }
}
