#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const defaultManifestFile = path.join(repoRoot, "restore/private-state-manifest.yaml");
const manifestSchemaFile = path.join(repoRoot, "restore/schema.json");
const bundleSchemaFile = path.join(repoRoot, "restore/bundle.schema.json");
const APPLY_CONFIRMATION = "RESTORE_PRIVATE_STATE";
const NON_CANARY_CONFIRMATION = "I_UNDERSTAND_NON_CANARY_DESTINATION";

function fail(message) {
  throw new Error(message);
}

function readJson(file, label = "JSON") {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    fail(`${label} is missing or invalid`);
  }
}

function assertRegularFileNoSymlink(file, label) {
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch {
    fail(`${label} is missing`);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) fail(`${label} must be a regular file`);
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function resolveRef(rootSchema, reference) {
  if (!reference.startsWith("#/")) fail("only local schema references are supported");
  return reference.slice(2).split("/").reduce((value, key) => value?.[key.replaceAll("~1", "/").replaceAll("~0", "~")], rootSchema);
}

export function validateJsonSchema(value, schema, rootSchema = schema, pointer = "$") {
  const errors = [];
  const visit = (current, currentSchema, currentPointer) => {
    if (currentSchema.$ref) {
      const resolved = resolveRef(rootSchema, currentSchema.$ref);
      if (!resolved) errors.push(`${currentPointer}: unresolved schema reference`);
      else visit(current, resolved, currentPointer);
      return;
    }
    if (Object.hasOwn(currentSchema, "const") && current !== currentSchema.const) {
      errors.push(`${currentPointer}: unexpected constant value`);
    }
    if (currentSchema.enum && !currentSchema.enum.includes(current)) {
      errors.push(`${currentPointer}: value is outside the allowed enum`);
    }
    const typeMatches = {
      object: current !== null && typeof current === "object" && !Array.isArray(current),
      array: Array.isArray(current),
      string: typeof current === "string",
      integer: Number.isInteger(current),
      number: typeof current === "number" && Number.isFinite(current),
      boolean: typeof current === "boolean",
    };
    if (currentSchema.type && !typeMatches[currentSchema.type]) {
      errors.push(`${currentPointer}: expected ${currentSchema.type}`);
      return;
    }
    if (typeof current === "string") {
      if (currentSchema.minLength !== undefined && current.length < currentSchema.minLength) errors.push(`${currentPointer}: string is too short`);
      if (currentSchema.pattern && !(new RegExp(currentSchema.pattern).test(current))) errors.push(`${currentPointer}: string does not match schema pattern`);
      if (currentSchema.format === "date-time" && Number.isNaN(Date.parse(current))) errors.push(`${currentPointer}: invalid date-time`);
    }
    if (typeof current === "number" && currentSchema.minimum !== undefined && current < currentSchema.minimum) {
      errors.push(`${currentPointer}: number is below minimum`);
    }
    if (Array.isArray(current)) {
      if (currentSchema.minItems !== undefined && current.length < currentSchema.minItems) errors.push(`${currentPointer}: array is too short`);
      if (currentSchema.uniqueItems && new Set(current.map((item) => JSON.stringify(item))).size !== current.length) errors.push(`${currentPointer}: duplicate array item`);
      if (currentSchema.items) current.forEach((item, index) => visit(item, currentSchema.items, `${currentPointer}[${index}]`));
    }
    if (typeMatches.object) {
      for (const key of currentSchema.required ?? []) {
        if (!Object.hasOwn(current, key)) errors.push(`${currentPointer}.${key}: required property is missing`);
      }
      for (const [key, child] of Object.entries(current)) {
        const childSchema = currentSchema.properties?.[key];
        if (childSchema) visit(child, childSchema, `${currentPointer}.${key}`);
        else if (currentSchema.additionalProperties === false) errors.push(`${currentPointer}.${key}: additional property is not allowed`);
        else if (currentSchema.additionalProperties && typeof currentSchema.additionalProperties === "object") {
          visit(child, currentSchema.additionalProperties, `${currentPointer}.${key}`);
        }
      }
    }
  };
  visit(value, schema, pointer);
  return errors;
}

function isExternalKind(item) {
  return item.kind === "external-file" || item.kind === "external-volume";
}

function assertSafeRelative(relativePath, label) {
  if (typeof relativePath !== "string" || !relativePath || path.isAbsolute(relativePath) || relativePath.includes("\\")) {
    fail(`${label} must be a portable relative path`);
  }
  const normalized = path.posix.normalize(relativePath);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../") || normalized !== relativePath) {
    fail(`${label} escapes or changes its declared root`);
  }
}

function assertManifestSemantics(manifest) {
  const names = new Set();
  const destinations = new Set();
  const orders = new Set();
  for (const item of manifest.items) {
    if (names.has(item.logical_name)) fail(`duplicate logical component: ${item.logical_name}`);
    names.add(item.logical_name);
    if (orders.has(item.restore_order)) fail(`duplicate restore order: ${item.restore_order}`);
    orders.add(item.restore_order);
    if ((Number.parseInt(item.permissions, 8) & 0o077) !== 0) fail(`private permissions are too broad for ${item.logical_name}`);
    if (isExternalKind(item)) {
      if (!/^(?:external|docker-volume):\/\/[a-z0-9-]+$/.test(item.source) || item.destination !== item.source) {
        fail(`external component ${item.logical_name} must use one matching logical URI`);
      }
    } else {
      assertSafeRelative(item.source, `${item.logical_name}.source`);
      assertSafeRelative(item.destination, `${item.logical_name}.destination`);
      if (destinations.has(item.destination)) fail(`duplicate destination for ${item.logical_name}`);
      destinations.add(item.destination);
    }
  }
  const orderByName = new Map(manifest.items.map((item) => [item.logical_name, item.restore_order]));
  for (const item of manifest.items) {
    for (const dependency of item.dependencies) {
      if (!orderByName.has(dependency)) fail(`unknown dependency ${dependency} for ${item.logical_name}`);
      if (orderByName.get(dependency) >= item.restore_order) fail(`dependency order is invalid for ${item.logical_name}`);
    }
  }
}

export function loadManifest(file = defaultManifestFile) {
  const manifest = readJson(file, "manifest (JSON-compatible YAML)");
  const schema = readJson(manifestSchemaFile, "manifest schema");
  const errors = validateJsonSchema(manifest, schema);
  if (errors.length) fail(`manifest schema validation failed: ${errors[0]}`);
  assertManifestSemantics(manifest);
  return manifest;
}

function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function portableRelative(root, file) {
  return path.relative(root, file).split(path.sep).join("/");
}

function walkFiles(target, root = target) {
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink()) fail("bundle payload cannot contain symlinks");
  if (stat.isFile()) return [target];
  if (!stat.isDirectory()) fail("bundle payload contains an unsupported filesystem object");
  return fs.readdirSync(target, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => walkFiles(path.join(target, entry.name), root));
}

function directoryBytes(target) {
  return walkFiles(target).reduce((total, file) => total + fs.statSync(file).size, 0);
}

function expectedPayloadPath(logicalName) {
  return `components/${logicalName}/payload`;
}

function canonicalContract(manifest) {
  return new Map(manifest.items.map((item) => [
    item.logical_name,
    Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])),
  ]));
}

function assertCanonicalManifest(bundleManifest, canonicalManifest) {
  const expected = canonicalContract(canonicalManifest);
  const actual = canonicalContract(bundleManifest);
  if (expected.size !== actual.size) fail("bundle manifest does not match the current public contract");
  for (const [name, contract] of expected) {
    if (JSON.stringify(actual.get(name)) !== JSON.stringify(contract)) {
      fail(`bundle manifest contract mismatch for ${name}`);
    }
  }
}

function validateChecksumsDocument(document) {
  if (!document || document.schema_version !== 1 || document.algorithm !== "sha256" || !Array.isArray(document.files)) {
    fail("checksums metadata is invalid");
  }
  const seen = new Set();
  for (const entry of document.files) {
    if (!entry || typeof entry.path !== "string" || !/^[0-9a-f]{64}$/.test(entry.sha256 ?? "") || !Number.isInteger(entry.bytes) || entry.bytes < 0 || !/^0[0-7]{3}$/.test(entry.mode ?? "")) {
      fail("checksum entry is invalid");
    }
    if ((Number.parseInt(entry.mode, 8) & 0o077) !== 0) fail("bundle payload permissions are not private");
    assertSafeRelative(entry.path, "checksum path");
    if (seen.has(entry.path)) fail("duplicate checksum path");
    seen.add(entry.path);
  }
}

function requiredComponents(manifest, enabledModules) {
  const enabled = new Set(enabledModules);
  return new Set(manifest.items
    .filter((item) => item.required || (item.required_when_module_enabled && enabled.has(item.module)))
    .map((item) => item.logical_name));
}

export function verifyBundle(backupDir, { canonicalManifestFile = defaultManifestFile } = {}) {
  const root = path.resolve(backupDir);
  if (!fs.existsSync(root) || fs.lstatSync(root).isSymbolicLink() || !fs.lstatSync(root).isDirectory()) fail("backup directory is missing or unsafe");
  const metadataFile = path.join(root, "bundle.json");
  assertRegularFileNoSymlink(metadataFile, "bundle metadata");
  const metadata = readJson(metadataFile, "bundle metadata");
  const bundleSchema = readJson(bundleSchemaFile, "bundle schema");
  const metadataErrors = validateJsonSchema(metadata, bundleSchema);
  if (metadataErrors.length) fail(`bundle metadata schema validation failed: ${metadataErrors[0]}`);
  if (!metadata.enabled_modules.includes("core")) fail("bundle must declare the core module");
  const features = readJson(path.join(repoRoot, "modules/features.json"), "module feature manifest");
  const knownModules = new Set(features.modules.map((module) => module.name));
  for (const module of metadata.enabled_modules) if (!knownModules.has(module)) fail(`bundle declares unknown module: ${module}`);
  const synthetic = metadata.repository_commit === "synthetic";
  if (synthetic !== (metadata.encryption_method === "none-synthetic")) fail("unencrypted bundles are allowed only for synthetic tests");
  if ((metadata.verification_status === "synthetic-verified") !== synthetic) fail("synthetic verification status is inconsistent");
  const bundleManifestFile = path.join(root, "manifest.yaml");
  assertRegularFileNoSymlink(bundleManifestFile, "bundle manifest");
  const bundleManifest = loadManifest(bundleManifestFile);
  const canonicalManifest = loadManifest(canonicalManifestFile);
  for (const item of bundleManifest.items) if (!knownModules.has(item.module)) fail(`manifest declares unknown module: ${item.module}`);
  if (sha256File(bundleManifestFile) !== metadata.manifest_sha256) fail("bundle manifest checksum mismatch");
  assertCanonicalManifest(bundleManifest, canonicalManifest);
  const checksumsFile = path.join(root, metadata.checksums);
  assertRegularFileNoSymlink(checksumsFile, "checksums metadata");
  const checksums = readJson(checksumsFile, "checksums metadata");
  validateChecksumsDocument(checksums);

  const itemByName = new Map(bundleManifest.items.map((item) => [item.logical_name, item]));
  const componentNames = new Set();
  let totalBytes = 0;
  for (const component of metadata.components) {
    const item = itemByName.get(component.logical_name);
    if (!item || componentNames.has(component.logical_name)) fail("bundle component list is invalid");
    componentNames.add(component.logical_name);
    if (component.payload_path !== expectedPayloadPath(component.logical_name) || component.kind !== item.kind) fail(`bundle component contract mismatch for ${component.logical_name}`);
    const payload = path.join(root, ...component.payload_path.split("/"));
    if (!fs.existsSync(payload)) fail(`bundle payload missing for ${component.logical_name}`);
    const stat = fs.lstatSync(payload);
    if (stat.isSymbolicLink()) fail(`bundle payload symlink rejected for ${component.logical_name}`);
    if (item.kind.includes("file") && !stat.isFile()) fail(`bundle payload kind mismatch for ${component.logical_name}`);
    if (item.kind.includes("volume") || item.kind === "directory") {
      if (!stat.isDirectory()) fail(`bundle payload kind mismatch for ${component.logical_name}`);
    }
    const bytes = stat.isFile() ? stat.size : directoryBytes(payload);
    if (bytes !== component.bytes) fail(`bundle byte count mismatch for ${component.logical_name}`);
    totalBytes += bytes;
  }
  for (const required of requiredComponents(bundleManifest, metadata.enabled_modules)) {
    if (!componentNames.has(required)) fail(`required bundle component missing: ${required}`);
  }

  const expectedFiles = new Map();
  for (const component of metadata.components) {
    const payload = path.join(root, ...component.payload_path.split("/"));
    for (const file of walkFiles(payload)) {
      const relative = portableRelative(root, file);
      expectedFiles.set(relative, file);
    }
  }
  if (expectedFiles.size !== checksums.files.length) fail("checksum file list does not match bundle payloads");
  for (const entry of checksums.files) {
    const file = expectedFiles.get(entry.path);
    if (!file) fail("checksum references an unexpected payload path");
    const stat = fs.statSync(file);
    if (stat.size !== entry.bytes || sha256File(file) !== entry.sha256) fail("bundle payload checksum mismatch");
  }

  const componentRoot = path.join(root, "components");
  const diskEntries = fs.existsSync(componentRoot) ? fs.readdirSync(componentRoot, { withFileTypes: true }) : [];
  if (diskEntries.some((entry) => !entry.isDirectory() || entry.isSymbolicLink())) fail("unexpected object in bundle components directory");
  const diskComponents = diskEntries.map((entry) => entry.name).sort();
  if (JSON.stringify(diskComponents) !== JSON.stringify([...componentNames].sort())) fail("unexpected component directory in bundle");

  return {
    valid: true,
    schema_version: metadata.schema_version,
    components: metadata.components.length,
    required_components: requiredComponents(bundleManifest, metadata.enabled_modules).size,
    files: checksums.files.length,
    bytes: totalBytes,
    repository_commit: metadata.repository_commit,
    host_architecture: metadata.host_architecture,
    enabled_modules: metadata.enabled_modules,
    metadata,
    manifest: bundleManifest,
    checksums,
  };
}

function currentCommit() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "unknown";
  }
}

function composeDigests() {
  const content = fs.readFileSync(path.join(repoRoot, "docker-compose.yml"), "utf8");
  const result = {};
  let service = null;
  for (const line of content.split(/\r?\n/)) {
    const serviceMatch = line.match(/^  ([a-zA-Z0-9_-]+):\s*$/);
    if (serviceMatch) service = serviceMatch[1];
    const imageMatch = line.match(/^    image:\s*[^@]+@(sha256:[0-9a-f]{64})\s*$/);
    if (service && imageMatch) result[service] = imageMatch[1];
  }
  return result;
}

function availableBytesFor(destination) {
  let candidate = path.resolve(destination);
  while (!fs.existsSync(candidate)) {
    const parent = path.dirname(candidate);
    if (parent === candidate) return null;
    candidate = parent;
  }
  if (typeof fs.statfsSync !== "function") return null;
  const stat = fs.statfsSync(candidate);
  return Number(stat.bavail) * Number(stat.bsize);
}

function maskedComponent(item, included, conflict = false) {
  return {
    logical_name: item.logical_name,
    component: item.component,
    module: item.module,
    required: item.required,
    included,
    source: `<private>/${item.logical_name}`,
    destination: `<destination>/${item.logical_name}`,
    consistency_mode: item.consistency_mode,
    services_to_stop: item.service_must_be_stopped,
    dependencies: item.dependencies,
    restore_order: item.restore_order,
    owner: item.owner,
    group: item.group,
    permissions: item.permissions,
    conflict,
  };
}

export function backupPlan({ manifestFile = defaultManifestFile } = {}) {
  const manifest = loadManifest(manifestFile);
  return {
    operation: "backup-plan",
    read_private_content: false,
    copies_data: false,
    encryption_required: manifest.bundle.encryption_required,
    expected_bytes: "installation-dependent",
    components: [...manifest.items].sort((a, b) => a.restore_order - b.restore_order).map((item) => maskedComponent(item, null)),
  };
}

export function restorePlan(backupDir, { destination = null, canonicalManifestFile = defaultManifestFile } = {}) {
  const verification = verifyBundle(backupDir, { canonicalManifestFile });
  const included = new Set(verification.metadata.components.map((component) => component.logical_name));
  const localDigests = composeDigests();
  const digestMismatches = Object.entries(verification.metadata.container_image_digests)
    .filter(([service, digest]) => localDigests[service] && localDigests[service] !== digest)
    .map(([service]) => service);
  const root = destination ? path.resolve(destination) : null;
  const components = [...verification.manifest.items]
    .sort((a, b) => a.restore_order - b.restore_order)
    .map((item) => maskedComponent(item, included.has(item.logical_name), Boolean(root && !isExternalKind(item) && fs.existsSync(path.join(root, item.destination)))));
  const freeBytes = root ? availableBytesFor(root) : null;
  return {
    operation: "restore-plan",
    writes_data: false,
    bundle_verified: true,
    compatibility: {
      repository_commit: verification.repository_commit === "synthetic" ? "synthetic" : verification.repository_commit === currentCommit() ? "exact" : "different-review-required",
      architecture: verification.host_architecture === process.arch ? "exact" : verification.host_architecture === "synthetic" ? "synthetic" : "different-review-required",
      component_versions_recorded: Object.keys(verification.metadata.component_versions).length,
      image_digests_recorded: Object.keys(verification.metadata.container_image_digests).length,
      image_digest_mismatches: digestMismatches,
    },
    capacity: {
      required_bytes: verification.bytes,
      available_bytes: freeBytes,
      sufficient: freeBytes === null ? null : freeBytes >= verification.bytes,
    },
    services_to_stop: [...new Set(verification.manifest.items.filter((item) => included.has(item.logical_name)).flatMap((item) => item.service_must_be_stopped))].sort(),
    components,
  };
}

function isSameOrAncestor(candidate, target) {
  const relative = path.relative(candidate, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function assertNoSymlinkAlong(candidate) {
  const resolved = path.resolve(candidate);
  const { root } = path.parse(resolved);
  let current = root;
  for (const segment of path.relative(root, resolved).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) fail("restore destination contains a symlink");
  }
}

export function assertSafeDestination(destination, { allowNonCanary = null, repositoryRoot = repoRoot } = {}) {
  if (!destination) fail("restore destination is required");
  const resolved = path.resolve(destination);
  const home = path.resolve(os.homedir());
  const repository = path.resolve(repositoryRoot);
  assertNoSymlinkAlong(resolved);
  if (resolved === path.parse(resolved).root || resolved === home || resolved === repository || isSameOrAncestor(resolved, repository)) {
    fail("dangerous restore destination rejected");
  }
  const temp = path.resolve(os.tmpdir());
  const canaryName = /(?:restore-canary|synthetic-restore|restore-test)/.test(path.basename(resolved));
  const isTempCanary = isSameOrAncestor(temp, resolved) && canaryName;
  if (!isTempCanary && allowNonCanary !== NON_CANARY_CONFIRMATION) fail("non-canary destination requires additional confirmation");
  return resolved;
}

function copyPayload(source, destination, kind) {
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  if (kind.includes("file")) fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
  else fs.cpSync(source, destination, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
}

function restoreModeTree(destinationRoot, component, checksums) {
  if (fs.existsSync(destinationRoot) && fs.lstatSync(destinationRoot).isDirectory()) {
    const lockDirectories = (directory) => {
      if (fs.lstatSync(directory).isSymbolicLink()) fail("restored directory symlink rejected");
      fs.chmodSync(directory, 0o700);
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const child = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) fail("restored payload symlink rejected");
        if (entry.isDirectory()) lockDirectories(child);
      }
    };
    lockDirectories(destinationRoot);
  }
  const prefix = `${component.payload_path}/`;
  for (const entry of checksums.files) {
    if (entry.path !== component.payload_path && !entry.path.startsWith(prefix)) continue;
    const suffix = entry.path === component.payload_path ? "" : entry.path.slice(prefix.length);
    const destination = suffix ? path.join(destinationRoot, ...suffix.split("/")) : destinationRoot;
    fs.chmodSync(destination, Number.parseInt(entry.mode, 8));
  }
}

export function applyRestore(backupDir, destination, {
  confirm,
  allowNonCanary = null,
  canonicalManifestFile = defaultManifestFile,
  faultAfter = null,
  repositoryRoot = repoRoot,
} = {}) {
  if (confirm !== APPLY_CONFIRMATION) fail("explicit restore confirmation is required");
  const targetRoot = assertSafeDestination(destination, { allowNonCanary, repositoryRoot });
  const verification = verifyBundle(backupDir, { canonicalManifestFile });
  const plan = restorePlan(backupDir, { destination: targetRoot, canonicalManifestFile });
  if (plan.capacity.sufficient === false) fail("insufficient destination space");
  if (plan.compatibility.repository_commit === "different-review-required" || plan.compatibility.architecture === "different-review-required" || plan.compatibility.image_digest_mismatches.length) {
    fail("restore compatibility requires operator review");
  }
  const componentByName = new Map(verification.metadata.components.map((component) => [component.logical_name, component]));
  const itemByName = new Map(verification.manifest.items.map((item) => [item.logical_name, item]));
  const ordered = [...componentByName.keys()].map((name) => itemByName.get(name)).sort((a, b) => a.restore_order - b.restore_order);
  if (ordered.some((item) => isExternalKind(item))) fail("external state requires its separately approved restore procedure");

  fs.mkdirSync(targetRoot, { recursive: true, mode: 0o700 });
  assertNoSymlinkAlong(targetRoot);
  const rollbackRoot = fs.mkdtempSync(path.join(targetRoot, ".restore-rollback-"));
  const restored = [];
  const snapshots = [];
  try {
    for (const item of ordered) {
      const component = componentByName.get(item.logical_name);
      const source = path.join(path.resolve(backupDir), ...component.payload_path.split("/"));
      const target = path.join(targetRoot, item.destination);
      if (!isSameOrAncestor(targetRoot, target)) fail("restore target escapes destination root");
      assertNoSymlinkAlong(target);
      const rollback = path.join(rollbackRoot, item.logical_name, "payload");
      const existed = fs.existsSync(target);
      if (existed) {
        fs.mkdirSync(path.dirname(rollback), { recursive: true, mode: 0o700 });
        fs.cpSync(target, rollback, { recursive: true, preserveTimestamps: true });
        fs.rmSync(target, { recursive: true, force: true });
      }
      snapshots.push({ target, rollback, existed });
      copyPayload(source, target, item.kind);
      fs.chmodSync(target, Number.parseInt(item.permissions, 8));
      restoreModeTree(target, component, verification.checksums);
      restored.push(item.logical_name);
      if (faultAfter !== null && restored.length >= faultAfter) fail("synthetic injected restore failure");
    }
  } catch (error) {
    for (const snapshot of [...snapshots].reverse()) {
      fs.rmSync(snapshot.target, { recursive: true, force: true });
      if (snapshot.existed) {
        fs.mkdirSync(path.dirname(snapshot.target), { recursive: true, mode: 0o700 });
        fs.cpSync(snapshot.rollback, snapshot.target, { recursive: true, preserveTimestamps: true });
      }
    }
    throw new Error(`restore rolled back after failure: ${error.message}`);
  }
  return {
    operation: "restore-apply",
    applied: true,
    restored,
    rollback_snapshot_prepared: true,
    values_printed: false,
  };
}

export function createSyntheticBundle(bundleDir, manifest, payloads, {
  enabledModules = ["core"],
  repositoryCommit = "synthetic",
  architecture = "synthetic",
} = {}) {
  fs.mkdirSync(bundleDir, { recursive: true, mode: 0o700 });
  const manifestFile = path.join(bundleDir, "manifest.yaml");
  writeJson(manifestFile, manifest);
  const components = [];
  const checksumEntries = [];
  for (const item of [...manifest.items].sort((a, b) => a.restore_order - b.restore_order)) {
    if (!Object.hasOwn(payloads, item.logical_name)) continue;
    const relativePayload = expectedPayloadPath(item.logical_name);
    const payload = path.join(bundleDir, ...relativePayload.split("/"));
    const content = payloads[item.logical_name];
    if (item.kind.includes("file")) {
      fs.mkdirSync(path.dirname(payload), { recursive: true, mode: 0o700 });
      fs.writeFileSync(payload, String(content), { mode: Number.parseInt(item.permissions, 8) });
    } else {
      fs.mkdirSync(payload, { recursive: true, mode: Number.parseInt(item.permissions, 8) });
      for (const [relative, value] of Object.entries(content)) {
        assertSafeRelative(relative, "synthetic payload path");
        const file = path.join(payload, ...relative.split("/"));
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        fs.writeFileSync(file, String(value), { mode: 0o600 });
      }
    }
    const files = walkFiles(payload);
    const bytes = files.reduce((total, file) => total + fs.statSync(file).size, 0);
    components.push({ logical_name: item.logical_name, payload_path: relativePayload, kind: item.kind, bytes });
    for (const file of files) {
      const stat = fs.statSync(file);
      checksumEntries.push({
        path: portableRelative(bundleDir, file),
        sha256: sha256File(file),
        bytes: stat.size,
        mode: `0${(stat.mode & 0o777).toString(8).padStart(3, "0")}`,
      });
    }
  }
  writeJson(path.join(bundleDir, "checksums.json"), { schema_version: 1, algorithm: "sha256", files: checksumEntries });
  writeJson(path.join(bundleDir, "bundle.json"), {
    schema_version: 1,
    repository_commit: repositoryCommit,
    repository_branch_or_release: "synthetic-test",
    created_at_utc: "2000-01-01T00:00:00.000Z",
    host_architecture: architecture,
    component_versions: {},
    container_image_digests: {},
    enabled_modules: enabledModules,
    components,
    manifest_sha256: sha256File(manifestFile),
    checksums: "checksums.json",
    verification_status: "synthetic-verified",
    encryption_method: "none-synthetic",
  });
  return bundleDir;
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith("--")) fail("unexpected positional argument");
    const name = token.slice(2);
    const value = rest[index + 1];
    if (!value || value.startsWith("--")) fail(`missing value for --${name}`);
    options[name] = value;
    index += 1;
  }
  return { command, options };
}

function requireOption(options, name) {
  if (!options[name]) fail(`--${name} is required`);
  return options[name];
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  const manifestFile = options.manifest ? path.resolve(options.manifest) : defaultManifestFile;
  if (command === "manifest-validate") print({ valid: true, items: loadManifest(manifestFile).items.length });
  else if (command === "backup-plan") print(backupPlan({ manifestFile }));
  else if (command === "backup-verify" || command === "restore-verify") {
    const result = verifyBundle(requireOption(options, "backup-dir"), { canonicalManifestFile: manifestFile });
    print({ operation: command, valid: result.valid, components: result.components, required_components: result.required_components, files: result.files, bytes: result.bytes });
  } else if (command === "restore-plan") {
    print(restorePlan(requireOption(options, "backup-dir"), { destination: options.destination, canonicalManifestFile: manifestFile }));
  } else if (command === "restore-apply") {
    print(applyRestore(requireOption(options, "backup-dir"), requireOption(options, "destination"), {
      confirm: options.confirm,
      allowNonCanary: options["allow-non-canary"],
      canonicalManifestFile: manifestFile,
    }));
  } else {
    fail("usage: restore.mjs <manifest-validate|backup-plan|backup-verify|restore-plan|restore-verify|restore-apply> [options]");
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`restore: ${error.message}`);
    process.exit(1);
  }
}
