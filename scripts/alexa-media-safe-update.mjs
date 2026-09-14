#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const metadataPath = process.env.ALEXA_MEDIA_UPSTREAM_PATH ||
  path.join(scriptDir, "alexa-media-upstream.json");
const stateRoot = process.env.ALEXA_MEDIA_UPDATER_STATE_DIR ||
  path.join(repoRoot, ".alexa-media-updater-state");
const statusPath = path.join(stateRoot, "status.json");
const backupRoot = path.join(stateRoot, "backups");
const hacsContainerPath = "/config/.storage/hacs.repositories";

export function normalizeVersion(value) {
  if (!value) return null;
  const text = String(value).trim();
  return text.startsWith("v") ? text : `v${text}`;
}

export function validVersion(value) {
  return /^v\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(
    normalizeVersion(value) ?? "",
  );
}

export function parseTagRefs(text, version) {
  const target = normalizeVersion(version);
  const refs = String(text).split("\n").filter(Boolean).map((line) => {
    const [commit, ref] = line.trim().split(/\s+/, 2);
    return { commit, ref };
  });
  const tagRef = `refs/tags/${target}`;
  const tag = refs.find((item) => item.ref === tagRef)?.commit ?? null;
  const peeled = refs.find((item) => item.ref === `${tagRef}^{}`)?.commit ?? null;
  const commit = peeled ?? tag;
  if (!commit || !/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error(`official tag ${target} was not resolved`);
  }
  return {
    version: target,
    commit,
    tag_object: peeled ? tag : null,
  };
}

export function repositoryArchiveUrl(metadata, ref) {
  if (!/^[0-9a-f]{40}$/.test(ref?.commit ?? "")) {
    throw new Error("archive commit is invalid");
  }
  return `https://github.com/${metadata.repository}/archive/${ref.commit}.tar.gz`;
}

export function changedFilesFromDelta(delta) {
  return [...new Set(
    [...String(delta).matchAll(/^diff .*? old\/alexa_media\/(.+?) local\/alexa_media\//gm)]
      .map((match) => match[1]),
  )].sort();
}

export function canAcceptAbsorbedDelta(metadata, changedFiles, markerCheck) {
  const allowed = new Set(metadata.absorbable_local_delta_files ?? []);
  return changedFiles.length > 0 &&
    changedFiles.every((file) => allowed.has(file)) &&
    (metadata.required_markers ?? []).every(markerCheck);
}

function safeStatusValue(value, fallback = "unknown") {
  const text = String(value ?? "").trim();
  return text && /^[A-Za-z0-9_.:+-]+$/.test(text) ? text : fallback;
}

export function statusLine(status) {
  if (!status) return "alexa-media-update status=unavailable target=unknown";
  return [
    "alexa-media-update",
    `status=${safeStatusValue(status.state, "unknown")}`,
    `target=${safeStatusValue(status.target)}`,
    `patch_state=${safeStatusValue(status.patch_state)}`,
    `checked_at=${safeStatusValue(status.checked_at)}`,
  ].join(" ");
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value, mode = 0o600) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode });
  fs.renameSync(temporary, filePath);
}

function command(commandName, args, options = {}) {
  return execFileSync(commandName, args, {
    cwd: options.cwd ?? repoRoot,
    encoding: Object.hasOwn(options, "encoding") ? options.encoding : "utf8",
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    env: { ...process.env, ...(options.env ?? {}) },
  });
}

function sha256(filePath) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function validateMetadata(metadata) {
  const requiredStrings = [
    "repository", "component_domain", "component_path", "component_source_path",
    "update_entity_id", "base_version", "base_commit", "license_source_path",
    "license_target_name", "license_sha256",
  ];
  if (metadata?.schema_version !== 1 ||
      requiredStrings.some((key) => typeof metadata[key] !== "string" || !metadata[key])) {
    throw new Error("Alexa Media upstream metadata is invalid");
  }
  if (metadata.repository !== "alandtse/alexa_media_player" ||
      metadata.component_domain !== "alexa_media" ||
      metadata.component_path !== "homeassistant/custom_components/alexa_media" ||
      metadata.component_source_path !== "custom_components/alexa_media" ||
      metadata.update_entity_id !== "update.alexa_media_player_update" ||
      !validVersion(metadata.base_version) ||
      !/^[0-9a-f]{40}$/.test(metadata.base_commit) ||
      !/^[0-9a-f]{64}$/.test(metadata.license_sha256)) {
    throw new Error("Alexa Media upstream metadata violates the fixed allowlist");
  }
  for (const file of [
    ...(metadata.allowed_local_delta_files ?? []),
    ...(metadata.absorbable_local_delta_files ?? []),
    ...(metadata.required_markers ?? []).map((item) => item.file),
  ]) {
    if (!/^[A-Za-z0-9_.\/-]+$/.test(file) || file.includes("..") || path.isAbsolute(file)) {
      throw new Error(`unsafe metadata path: ${file}`);
    }
  }
  return metadata;
}

function componentDir(metadata) {
  const resolved = path.resolve(repoRoot, metadata.component_path);
  const expected = path.resolve(repoRoot, "homeassistant/custom_components/alexa_media");
  if (resolved !== expected) throw new Error("component path escaped the fixed allowlist");
  return resolved;
}

function resolveTag(metadata, version) {
  const target = normalizeVersion(version);
  if (!validVersion(target)) throw new Error(`invalid target version: ${version}`);
  const output = command("git", [
    "ls-remote", "--tags", `https://github.com/${metadata.repository}.git`,
    `refs/tags/${target}`, `refs/tags/${target}^{}`,
  ], { capture: true });
  return parseTagRefs(output, target);
}

async function downloadRepository(metadata, ref, workspace) {
  const url = repositoryArchiveUrl(metadata, ref);
  const response = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`download ${ref.version} failed: HTTP ${response.status}`);
  const archive = path.join(workspace, `${ref.version}.tar.gz`);
  fs.writeFileSync(archive, Buffer.from(await response.arrayBuffer()), { mode: 0o600 });
  const listing = command("tar", ["-tzf", archive], { capture: true });
  const entries = listing.split("\n").filter(Boolean);
  if (!entries.length || entries.some((entry) =>
    entry.startsWith("/") || entry.split("/").includes(".."))) {
    throw new Error(`archive ${ref.version} contains an unsafe path`);
  }
  const verboseListing = command("tar", ["-tvzf", archive], { capture: true });
  if (verboseListing.split("\n").some((line) => /^[lh]/.test(line))) {
    throw new Error(`archive ${ref.version} contains a link`);
  }
  const roots = new Set(entries.map((entry) => entry.split("/", 1)[0]).filter(Boolean));
  if (roots.size !== 1) throw new Error(`archive ${ref.version} has an ambiguous root`);
  const extract = path.join(workspace, `extract-${ref.version}`);
  fs.mkdirSync(extract, { recursive: true });
  command("tar", ["-xzf", archive, "-C", extract]);
  const root = path.join(extract, [...roots][0]);
  const source = path.join(root, metadata.component_source_path);
  const license = path.join(root, metadata.license_source_path);
  if (!fs.statSync(source).isDirectory() || !fs.statSync(license).isFile()) {
    throw new Error(`archive ${ref.version} lacks the component or license`);
  }
  return { root, source, license };
}

function copyComponent(source, destination) {
  fs.cpSync(source, destination, {
    recursive: true,
    filter: (candidate) =>
      !candidate.includes(`${path.sep}__pycache__`) && !candidate.endsWith(".pyc"),
  });
}

function materializeBundle(source, license, destination, metadata) {
  copyComponent(source, destination);
  fs.copyFileSync(license, path.join(destination, metadata.license_target_name));
}

function runDiff(oldDir, localDir, workspace) {
  const result = spawnSync(
    "diff",
    ["-ruN", "--exclude=__pycache__", "old/alexa_media", "local/alexa_media"],
    { cwd: workspace, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  );
  if (![0, 1].includes(result.status)) {
    throw new Error(`diff failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

function applyDelta(delta, mergedDir) {
  if (!delta) return { state: "none", conflicts: [] };
  for (const dryRun of [true, false]) {
    const args = ["apply", "-p2", "--whitespace=nowarn"];
    if (dryRun) args.push("--check");
    args.push("-");
    const result = spawnSync("git", args, {
      cwd: mergedDir,
      input: delta,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
    if (result.status !== 0) {
      const detail = `${result.stdout ?? ""}\n${result.stderr ?? ""}`
        .split("\n").filter(Boolean).slice(0, 20);
      return { state: "conflict", conflicts: detail };
    }
  }
  return { state: "applied", conflicts: [] };
}

function markerPresent(root, marker) {
  const target = path.resolve(root, marker.file);
  if (!target.startsWith(`${path.resolve(root)}${path.sep}`) || !fs.existsSync(target)) return false;
  return fs.readFileSync(target, "utf8").includes(marker.text);
}

function validateMerged(root, metadata, target, expectedLicenseHash) {
  const manifest = readJson(path.join(root, "manifest.json"));
  if (normalizeVersion(manifest.version) !== normalizeVersion(target)) {
    throw new Error(`merged manifest is ${manifest.version}, expected ${target}`);
  }
  const missing = (metadata.required_markers ?? []).filter((marker) => !markerPresent(root, marker));
  if (missing.length) throw new Error(`required Alexa Media guard is missing from ${missing[0].file}`);
  const actualLicenseHash = sha256(path.join(root, metadata.license_target_name));
  if (actualLicenseHash !== expectedLicenseHash) throw new Error("preserved upstream license hash is invalid");
  command("python3", ["-m", "compileall", "-q", root]);
  return {
    compileall: "passed",
    required_markers: `${metadata.required_markers.length}/${metadata.required_markers.length}`,
    license_sha256: actualLicenseHash,
  };
}

export async function prepareUpdate(targetVersion) {
  const metadata = validateMetadata(readJson(metadataPath));
  const baseRef = resolveTag(metadata, metadata.base_version);
  if (baseRef.commit !== metadata.base_commit ||
      (metadata.base_tag_object ?? null) !== (baseRef.tag_object ?? null)) {
    throw new Error("recorded Alexa Media base does not match the official tag");
  }
  const targetRef = resolveTag(metadata, targetVersion);
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "alexa-media-safe-update-"));
  try {
    const baseArchive = await downloadRepository(metadata, baseRef, workspace);
    const targetArchive = baseRef.version === targetRef.version
      ? baseArchive
      : await downloadRepository(metadata, targetRef, workspace);
    if (sha256(baseArchive.license) !== metadata.license_sha256 ||
        sha256(path.join(componentDir(metadata), metadata.license_target_name)) !== metadata.license_sha256) {
      throw new Error("recorded or local Alexa Media license differs from the official base");
    }
    const oldRoot = path.join(workspace, "old/alexa_media");
    const localRoot = path.join(workspace, "local/alexa_media");
    const mergedRoot = path.join(workspace, "merged/alexa_media");
    fs.mkdirSync(path.dirname(oldRoot), { recursive: true });
    fs.mkdirSync(path.dirname(localRoot), { recursive: true });
    fs.mkdirSync(path.dirname(mergedRoot), { recursive: true });
    materializeBundle(baseArchive.source, baseArchive.license, oldRoot, metadata);
    copyComponent(componentDir(metadata), localRoot);
    materializeBundle(targetArchive.source, targetArchive.license, mergedRoot, metadata);
    const delta = runDiff(oldRoot, localRoot, workspace);
    const changedFiles = changedFilesFromDelta(delta);
    const allowed = new Set(metadata.allowed_local_delta_files ?? []);
    if (changedFiles.some((file) => !allowed.has(file))) {
      throw new Error(`unreviewed local Alexa Media delta: ${changedFiles.join(", ")}`);
    }
    let patch = applyDelta(delta, mergedRoot);
    if (patch.state === "conflict" &&
        canAcceptAbsorbedDelta(metadata, changedFiles, (marker) => markerPresent(mergedRoot, marker))) {
      patch = { state: "absorbed", conflicts: [] };
    }
    const targetLicenseHash = sha256(targetArchive.license);
    const tests = patch.state === "conflict"
      ? {}
      : validateMerged(mergedRoot, metadata, targetRef.version, targetLicenseHash);
    return {
      workspace,
      mergedRoot,
      metadata,
      baseRef,
      targetRef,
      patch,
      changedFiles,
      tests,
      targetLicenseHash,
    };
  } catch (error) {
    fs.rmSync(workspace, { recursive: true, force: true });
    throw error;
  }
}

function haRequest(method, requestPath, token, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : "";
    const request = http.request({
      host: "127.0.0.1",
      port: 8123,
      path: requestPath,
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
      },
    }, (response) => {
      let data = "";
      response.on("data", (chunk) => { data += chunk; });
      response.on("end", () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`Home Assistant API ${response.statusCode}`));
          return;
        }
        resolve(data ? JSON.parse(data) : {});
      });
    });
    request.on("error", reject);
    if (payload) request.write(payload);
    request.end();
  });
}

function readHaToken() {
  const tokenFile = process.env.ALEXA_MEDIA_HA_TOKEN_FILE ||
    path.join(repoRoot, ".local-secrets/ha-long-lived-token.txt");
  if (fs.existsSync(tokenFile)) {
    const token = fs.readFileSync(tokenFile, "utf8").trim();
    if (token) return token;
  }
  if (process.env.HA_LONG_LIVED_TOKEN?.trim()) return process.env.HA_LONG_LIVED_TOKEN.trim();
  throw new Error("Home Assistant token is unavailable");
}

function readHacsRecord() {
  const code = [
    "import json",
    `data=json.load(open('${hacsContainerPath}')).get('data',{})`,
    "record=next((v for v in data.values() if v.get('full_name')=='alandtse/alexa_media_player'),None)",
    "keys=['full_name','installed_commit','last_commit','last_version','version_installed']",
    "print(json.dumps({k:record.get(k) for k in keys} if record else None))",
  ].join(";");
  const output = command("docker", ["exec", "homeassistant", "python", "-c", code], { capture: true }).trim();
  return output ? JSON.parse(output) : null;
}

function captureRegistryAndRecorder() {
  const code = [
    "import json,sqlite3",
    "entries=json.load(open('/config/.storage/core.config_entries')).get('data',{}).get('entries',[])",
    "entry_ids={e.get('entry_id') for e in entries if e.get('domain')=='alexa_media'}",
    "registry=json.load(open('/config/.storage/core.entity_registry')).get('data',{}).get('entities',[])",
    "ids=sorted({e.get('entity_id') for e in registry if e.get('platform')=='alexa_media' or e.get('config_entry_id') in entry_ids if e.get('entity_id')})",
    "db=sqlite3.connect('file:/config/home-assistant_v2.db?mode=ro',uri=True)",
    "count=db.execute('select count(*) from states s join states_meta m on m.metadata_id=s.metadata_id where m.entity_id in (%s)' % (','.join('?' for _ in ids) or \"''\"),ids).fetchone()[0]",
    "print(json.dumps({'entity_ids':ids,'recorder_rows':count}))",
  ].join(";");
  return JSON.parse(command("docker", ["exec", "homeassistant", "python", "-c", code], { capture: true }));
}

function updateEntityMatches(states, entityId, target) {
  const entity = states.find((item) => item.entity_id === entityId);
  return normalizeVersion(entity?.attributes?.installed_version) === normalizeVersion(target) &&
    String(entity?.state).toLowerCase() !== "on";
}

function advertisedTargetMatches(states, entityId, target) {
  const entity = states.find((item) => item.entity_id === entityId);
  return String(entity?.state).toLowerCase() === "on" &&
    normalizeVersion(entity?.attributes?.latest_version) === normalizeVersion(target);
}

async function waitForInstallation(token, metadata, target, timeoutMs = 300_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const states = await haRequest("GET", "/api/states", token);
      if (updateEntityMatches(states, metadata.update_entity_id, target)) return states;
    } catch {
      // HACS may still be finalizing the download.
    }
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  throw new Error(`HACS did not confirm Alexa Media ${target}`);
}

async function waitForRuntime(token, metadata, target, before, timeoutMs = 720_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const states = await haRequest("GET", "/api/states", token);
      const byId = new Map(states.map((item) => [item.entity_id, item]));
      const missing = before.active_entity_ids.filter((entityId) => !byId.has(entityId));
      const updateReady = updateEntityMatches(states, metadata.update_entity_id, target);
      if (!missing.length && updateReady) {
        const after = captureRegistryAndRecorder();
        const registryMissing = before.entity_ids.filter((entityId) => !after.entity_ids.includes(entityId));
        if (!registryMissing.length && after.recorder_rows >= before.recorder_rows) {
          return { registry_entities: after.entity_ids.length, recorder_rows: after.recorder_rows };
        }
      }
    } catch {
      // Home Assistant or Alexa Media may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
  throw new Error("Alexa Media runtime validation timed out");
}

async function waitForPreservedRuntime(token, before, timeoutMs = 720_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const states = await haRequest("GET", "/api/states", token);
      const byId = new Map(states.map((item) => [item.entity_id, item]));
      const missing = before.active_entity_ids.filter((entityId) => !byId.has(entityId));
      if (!missing.length) {
        const after = captureRegistryAndRecorder();
        const registryMissing = before.entity_ids.filter((entityId) => !after.entity_ids.includes(entityId));
        if (!registryMissing.length && after.recorder_rows >= before.recorder_rows) {
          return { registry_entities: after.entity_ids.length, recorder_rows: after.recorder_rows };
        }
      }
    } catch {
      // Home Assistant or Alexa Media may still be starting after restoration.
    }
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
  throw new Error("Alexa Media rollback runtime validation timed out");
}

function makeComponentWritable(target) {
  const image = command("docker", ["inspect", "-f", "{{.Image}}", "homeassistant"], { capture: true }).trim();
  command("docker", [
    "run", "--rm", "--entrypoint", "chown", "-v", `${target}:/target`, image,
    "-R", `${process.getuid?.() ?? 1001}:${process.getgid?.() ?? 1001}`, "/target",
  ]);
}

function assertComponentClean(metadata) {
  const output = command("git", ["status", "--porcelain=v1", "--", metadata.component_path], { capture: true }).trim();
  if (output) throw new Error("Alexa Media component has uncommitted changes; refusing automatic update");
}

function statusFor(prepared, state, extra = {}) {
  return {
    schema_version: 1,
    state,
    target: prepared.targetRef.version,
    target_commit: prepared.targetRef.commit,
    target_tag_object: prepared.targetRef.tag_object,
    patch_state: prepared.patch.state,
    changed_files_locally: prepared.changedFiles,
    tests: prepared.tests,
    checked_at: new Date().toISOString(),
    ...extra,
  };
}

async function check(target) {
  const prepared = await prepareUpdate(target);
  try {
    const state = prepared.patch.state === "conflict" ? "conflict" : "compatible";
    const status = statusFor(prepared, state);
    writeJson(statusPath, status);
    console.log(JSON.stringify(status, null, 2));
    return status;
  } finally {
    fs.rmSync(prepared.workspace, { recursive: true, force: true });
  }
}

async function apply(target) {
  const prepared = await prepareUpdate(target);
  const metadataBefore = readJson(metadataPath);
  const targetDir = componentDir(prepared.metadata);
  try {
    if (prepared.patch.state === "conflict") {
      const status = statusFor(prepared, "conflict");
      writeJson(statusPath, status);
      return status;
    }
    assertComponentClean(prepared.metadata);
    const token = readHaToken();
    const statesBefore = await haRequest("GET", "/api/states", token);
    const before = captureRegistryAndRecorder();
    const activeStateIds = new Set(statesBefore.map((item) => item.entity_id));
    before.active_entity_ids = before.entity_ids.filter((entityId) => activeStateIds.has(entityId));
    const localManifest = readJson(path.join(targetDir, "manifest.json"));
    const alreadyInstalled = updateEntityMatches(
      statesBefore,
      prepared.metadata.update_entity_id,
      prepared.targetRef.version,
    );
    if (!alreadyInstalled && !advertisedTargetMatches(
      statesBefore,
      prepared.metadata.update_entity_id,
      prepared.targetRef.version,
    )) {
      throw new Error("queued Alexa Media target is no longer advertised by Home Assistant");
    }
    if (alreadyInstalled &&
        normalizeVersion(localManifest.version) === prepared.targetRef.version &&
        prepared.baseRef.version === prepared.targetRef.version) {
      const status = statusFor(prepared, "current", { runtime: before });
      writeJson(statusPath, status);
      return status;
    }
    const stamp = new Date().toISOString().replaceAll(":", "-");
    const backupDir = path.join(backupRoot, stamp);
    fs.mkdirSync(backupDir, { recursive: true });
    copyComponent(targetDir, path.join(backupDir, "alexa_media"));
    fs.copyFileSync(metadataPath, path.join(backupDir, "alexa-media-upstream.json"));
    command("docker", ["cp", `homeassistant:${hacsContainerPath}`, path.join(backupDir, "hacs.repositories")]);
    writeJson(statusPath, statusFor(prepared, "applying"));
    try {
      if (!alreadyInstalled) {
        await haRequest("POST", "/api/services/update/install", token, {
          entity_id: prepared.metadata.update_entity_id,
          version: prepared.targetRef.version,
        });
        await waitForInstallation(token, prepared.metadata, prepared.targetRef.version);
      }
      command("docker", ["compose", "stop", "homeassistant"]);
      makeComponentWritable(targetDir);
      fs.rmSync(targetDir, { recursive: true, force: true });
      copyComponent(prepared.mergedRoot, targetDir);
      command("python3", ["-m", "compileall", "-q", targetDir]);
      command("docker", ["compose", "start", "homeassistant"]);
      const runtime = await waitForRuntime(token, prepared.metadata, prepared.targetRef.version, before);
      const hacs = readHacsRecord();
      if (normalizeVersion(hacs?.version_installed) !== prepared.targetRef.version ||
          normalizeVersion(readJson(path.join(targetDir, "manifest.json")).version) !== prepared.targetRef.version) {
        throw new Error("HACS and local manifest did not confirm the target version");
      }
      writeJson(metadataPath, {
        ...metadataBefore,
        base_version: prepared.targetRef.version,
        base_commit: prepared.targetRef.commit,
        base_tag_object: prepared.targetRef.tag_object,
        license_sha256: prepared.targetLicenseHash,
      }, 0o644);
      const status = statusFor(prepared, "success", { runtime, applied_at: new Date().toISOString() });
      writeJson(statusPath, status);
      return status;
    } catch (error) {
      let rollbackRuntime = null;
      let rollbackError = null;
      try {
        command("docker", ["compose", "stop", "homeassistant"]);
        makeComponentWritable(targetDir);
        fs.rmSync(targetDir, { recursive: true, force: true });
        copyComponent(path.join(backupDir, "alexa_media"), targetDir);
        fs.copyFileSync(path.join(backupDir, "alexa-media-upstream.json"), metadataPath);
        command("docker", ["cp", path.join(backupDir, "hacs.repositories"), `homeassistant:${hacsContainerPath}`]);
        command("docker", ["compose", "start", "homeassistant"]);
        rollbackRuntime = await waitForPreservedRuntime(token, before);
      } catch (restoreError) {
        rollbackError = restoreError;
      }
      const rollback = statusFor(prepared, "rollback", {
        failed_at: new Date().toISOString(),
        reason: String(error.message).slice(0, 500),
        rollback_validation: rollbackError ? "failed" : "passed",
        rollback_runtime: rollbackRuntime,
        rollback_reason: rollbackError ? String(rollbackError.message).slice(0, 500) : undefined,
      });
      writeJson(statusPath, rollback);
      if (rollbackError) {
        throw new Error(`${error.message}; rollback validation failed: ${rollbackError.message}`);
      }
      throw error;
    }
  } finally {
    fs.rmSync(prepared.workspace, { recursive: true, force: true });
  }
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  const args = process.argv.slice(2);
  const mode = args[0] ?? "status";
  const targetIndex = args.indexOf("--target");
  const target = targetIndex >= 0 ? args[targetIndex + 1] : null;
  if (mode === "check") {
    if (!validVersion(target)) throw new Error("--target is required");
    await check(target);
  } else if (mode === "apply") {
    if (!validVersion(target)) throw new Error("--target is required");
    await apply(target);
  } else if (mode === "status") {
    console.log(statusLine(fs.existsSync(statusPath) ? readJson(statusPath) : null));
  } else {
    throw new Error("usage: alexa-media-safe-update.mjs check|apply|status --target vX.Y.Z");
  }
}
