#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const statePath = path.join(scriptDir, "kia-uvo-upstream.json");
const componentDir = path.join(
  repoRoot,
  "homeassistant/custom_components/kia_uvo",
);
const hacsContainerPath = "/config/.storage/hacs.repositories";
const statusContainerPath = "/config/.storage/kia_uvo_safe_update";
const backupRoot = path.join(
  repoRoot,
  ".kia-uvo-updater-state/backups",
);
const REQUIRED_MARKERS = [
  ["coordinator.py", "BR_WAKE_MIN_INTERVAL_S = 15 * 60"],
  ["coordinator.py", "async_refresh_day_trip_info"],
  ["coordinator.py", "_async_update_fuel_efficiency"],
  ["coordinator.py", "REMOTE_LOCATE_MIN_INTERVAL_S = 60"],
  ["sensor.py", "RecentTripInfoEntity"],
  ["sensor.py", "RemoteCommandStatusEntity"],
];

function normalizeVersion(value) {
  if (!value) return null;
  return String(value).startsWith("v") ? String(value) : `v${value}`;
}

export function updateMatchesTarget(entity, hacs, targetVersion) {
  const target = normalizeVersion(targetVersion);
  return normalizeVersion(entity?.attributes?.installed_version) === target &&
    normalizeVersion(hacs?.version_installed) === target;
}

export function preferFullCommit(currentCommit, reportedCommit) {
  if (!currentCommit) return reportedCommit ?? null;
  if (!reportedCommit) return currentCommit;
  if (currentCommit.startsWith(reportedCommit)) return currentCommit;
  if (reportedCommit.startsWith(currentCommit)) return reportedCommit;
  return reportedCommit;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  fs.renameSync(temporary, filePath);
}

function readHacsRecord() {
  const code = [
    "import json",
    `data=json.load(open('${hacsContainerPath}')).get('data',{})`,
    "record=next((v for v in data.values() if v.get('full_name')=='Hyundai-Kia-Connect/kia_uvo'),None)",
    "keys=['full_name','installed','installed_commit','last_commit','last_fetched','last_updated','last_version','version_installed']",
    "print(json.dumps({k:record.get(k) for k in keys} if record else None))",
  ].join(";");
  const output = command(
    "docker",
    ["exec", "homeassistant", "python", "-c", code],
    { capture: true },
  ).trim();
  return output ? JSON.parse(output) : null;
}

function readLocalManifest() {
  return readJson(path.join(componentDir, "manifest.json"));
}

function command(commandName, args, options = {}) {
  return execFileSync(commandName, args, {
    cwd: options.cwd ?? repoRoot,
    encoding: "utf8",
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    env: { ...process.env, ...(options.env ?? {}) },
  });
}

function readStatus() {
  const code = [
    "import os",
    `path='${statusContainerPath}'`,
    "print(open(path).read() if os.path.exists(path) else '')",
  ].join(";");
  const output = command(
    "docker",
    ["exec", "homeassistant", "python", "-c", code],
    { capture: true },
  ).trim();
  return output ? JSON.parse(output) : null;
}

function writeStatus(value) {
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  const code = [
    "import os,sys",
    `path='${statusContainerPath}'`,
    "tmp=path+'.tmp'",
    "open(tmp,'w').write(sys.stdin.read())",
    "os.chmod(tmp,0o600)",
    "os.replace(tmp,path)",
  ].join(";");
  const result = spawnSync(
    "docker",
    ["exec", "-i", "homeassistant", "python", "-c", code],
    { cwd: repoRoot, input: payload, encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(`could not persist updater status: ${result.stderr}`);
  }
}

async function downloadArchive(version, destination) {
  const normalized = normalizeVersion(version);
  const url = `https://github.com/Hyundai-Kia-Connect/kia_uvo/archive/refs/tags/${normalized}.tar.gz`;
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`download ${normalized} failed: HTTP ${response.status}`);
  }
  const archive = path.join(destination, `${normalized}.tar.gz`);
  fs.writeFileSync(archive, Buffer.from(await response.arrayBuffer()));
  const extract = path.join(destination, `extract-${normalized}`);
  fs.mkdirSync(extract, { recursive: true });
  command("tar", ["-xzf", archive, "-C", extract]);
  const root = fs.readdirSync(extract)
    .map((name) => path.join(extract, name))
    .find((candidate) => fs.statSync(candidate).isDirectory());
  if (!root) throw new Error(`archive ${normalized} has no root directory`);
  return path.join(root, "custom_components/kia_uvo");
}

function copyComponent(source, destination) {
  fs.cpSync(source, destination, {
    recursive: true,
    filter: (candidate) =>
      !candidate.includes(`${path.sep}__pycache__`) &&
      !candidate.endsWith(".pyc"),
  });
}

function makeComponentWritable() {
  const image = command(
    "docker",
    ["inspect", "-f", "{{.Image}}", "homeassistant"],
    { capture: true },
  ).trim();
  command("docker", [
    "run",
    "--rm",
    "--entrypoint",
    "chown",
    "-v",
    `${componentDir}:/target`,
    image,
    "-R",
    `${process.getuid?.() ?? 1001}:${process.getgid?.() ?? 1001}`,
    "/target",
  ]);
}

function runDiff(oldDir, localDir, cwd) {
  const result = spawnSync(
    "diff",
    ["-ruN", "--exclude=__pycache__", "old/kia_uvo", "local/kia_uvo"],
    { cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  );
  if (![0, 1].includes(result.status)) {
    throw new Error(`diff failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

function applyDelta(delta, mergedDir) {
  if (!delta) return { state: "absorbed", conflicts: [] };
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
      const output = `${result.error?.message ?? ""}\n${result.stdout ?? ""}\n${result.stderr ?? ""}`;
      let details = output
        .split("\n")
        .filter((line) => /FAILED|malformed|can't find|saving rejects/i.test(line))
        .slice(0, 20);
      if (!details.length) {
        details = output.split("\n").filter(Boolean).slice(0, 20);
      }
      return { state: "conflict", conflicts: details };
    }
  }
  return { state: "applied", conflicts: [] };
}

function validateMerged(mergedDir, targetVersion) {
  const manifest = readJson(path.join(mergedDir, "manifest.json"));
  if (normalizeVersion(manifest.version) !== normalizeVersion(targetVersion)) {
    throw new Error(
      `merged manifest is ${manifest.version}, expected ${targetVersion}`,
    );
  }
  const missing = REQUIRED_MARKERS.filter(([fileName, marker]) =>
    !fs.readFileSync(path.join(mergedDir, fileName), "utf8").includes(marker));
  if (missing.length) {
    throw new Error(
      `required local features missing: ${missing.map(([file]) => file).join(", ")}`,
    );
  }
  command("python3", ["-m", "compileall", "-q", mergedDir]);
  return {
    compileall: "passed",
    required_markers: `${REQUIRED_MARKERS.length}/${REQUIRED_MARKERS.length}`,
  };
}

export async function prepareUpdate(targetVersion) {
  const config = readJson(statePath);
  const target = normalizeVersion(targetVersion);
  const base = normalizeVersion(config.base_version);
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "kia-uvo-safe-update-"));
  const oldRoot = path.join(workspace, "old/kia_uvo");
  const localRoot = path.join(workspace, "local/kia_uvo");
  const mergedRoot = path.join(workspace, "merged/kia_uvo");
  fs.mkdirSync(path.dirname(oldRoot), { recursive: true });
  fs.mkdirSync(path.dirname(localRoot), { recursive: true });
  fs.mkdirSync(path.dirname(mergedRoot), { recursive: true });

  const baseSource = await downloadArchive(base, workspace);
  const targetSource = base === target
    ? baseSource
    : await downloadArchive(target, workspace);
  copyComponent(baseSource, oldRoot);
  copyComponent(componentDir, localRoot);
  copyComponent(targetSource, mergedRoot);
  const delta = runDiff(oldRoot, localRoot, workspace);
  const patch = applyDelta(delta, mergedRoot);
  const changedFiles = [...new Set(
    [...delta.matchAll(/^diff .*? old\/kia_uvo\/(.+?) local\/kia_uvo\//gm)]
      .map((match) => match[1]),
  )];
  let tests = {};
  if (patch.state !== "conflict") tests = validateMerged(mergedRoot, target);
  return {
    workspace,
    mergedRoot,
    base,
    target,
    patch,
    changedFiles,
    tests,
  };
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
          reject(new Error(`Home Assistant API ${response.statusCode}: ${data}`));
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

async function publishEvent(token, eventType, eventData) {
  if (!token) return;
  await haRequest("POST", `/api/events/${eventType}`, token, eventData);
}

function statusFor(prepared, state, extra = {}) {
  const hacs = readHacsRecord();
  return {
    state,
    installed_version: readLocalManifest().version,
    hacs_installed_version: hacs?.version_installed ?? null,
    latest_version: prepared?.target ?? hacs?.last_version ?? null,
    upstream_commit: hacs?.last_commit ?? null,
    patch_state: prepared?.patch.state ?? null,
    files_changed_locally: prepared?.changedFiles ?? [],
    conflicts: prepared?.patch.conflicts ?? [],
    tests: prepared?.tests ?? {},
    checked_at: new Date().toISOString(),
    message: extra.message ?? null,
    ...extra,
  };
}

async function check(targetVersion, options = {}) {
  const hacs = readHacsRecord();
  const target = normalizeVersion(targetVersion ?? hacs?.last_version);
  if (!target) throw new Error("no target version supplied or reported by HACS");
  if (!options.force) {
    const cached = readStatus();
    if (cached) {
      const age = Date.now() - Date.parse(cached.checked_at ?? 0);
      if (
        normalizeVersion(cached.latest_version) === target &&
        ["compatible", "ready"].includes(cached.state) &&
        age >= 0 && age < 6 * 60 * 60 * 1000
      ) {
        console.log(JSON.stringify(cached, null, 2));
        return cached;
      }
    }
  }

  console.log(
    `CRETA_INTEGRATION_UPDATE_AVAILABLE installed=${hacs?.version_installed ?? "unknown"} latest=${target}`,
  );
  const token = process.env.HA_LONG_LIVED_TOKEN?.trim();
  await publishEvent(token, "creta_integration_update_available", {
    installed_version: hacs?.version_installed ?? null,
    latest_version: target,
    detected_at: new Date().toISOString(),
  });
  const prepared = await prepareUpdate(target);
  const state = prepared.patch.state === "conflict" ? "conflict" : "compatible";
  const status = statusFor(prepared, state, {
    message: prepared.patch.state === "conflict"
      ? "A instalação atual foi preservada; intervenção manual necessária."
      : "Upstream compatível em staging; nenhuma instalação automática foi feita.",
  });
  writeStatus(status);
  fs.rmSync(prepared.workspace, { recursive: true, force: true });
  console.log(JSON.stringify(status, null, 2));
  return status;
}

async function waitForHomeAssistant(token, timeoutMs = 240_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const states = await haRequest("GET", "/api/states", token);
      const required = [
        "sensor.creta_fuel_level",
        "button.creta_force_refresh",
        "button.creta_start_hazard_lights_and_horn",
        "sensor.garagem_creta_recent_trip_info",
        "sensor.garagem_creta_remote_command_status",
      ];
      const missing = required.filter(
        (entityId) => !states.some((state) => state.entity_id === entityId),
      );
      const fuel = states.find((state) => state.entity_id === "sensor.creta_fuel_level");
      if (!missing.length && fuel && !["unknown", "unavailable"].includes(fuel.state)) {
        return { entities: "passed", fuel_state: fuel.state };
      }
    } catch {
      // Home Assistant may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
  throw new Error("Home Assistant runtime validation timed out");
}

async function apply(targetVersion) {
  const token = process.env.HA_LONG_LIVED_TOKEN?.trim();
  if (!token) {
    throw new Error("HA_LONG_LIVED_TOKEN is required for explicit --apply");
  }
  const prepared = await prepareUpdate(targetVersion);
  if (prepared.patch.state === "conflict") {
    const status = statusFor(prepared, "conflict", {
      message: "Conflitos detectados; instalação atual preservada.",
    });
    writeStatus(status);
    throw new Error("local patch conflicts with target; nothing was installed");
  }

  const states = await haRequest("GET", "/api/states", token);
  const updateEntity = states.find((entity) =>
    entity.entity_id.startsWith("update.") &&
    /kia|uvo|hyundai|bluelink/i.test(
      `${entity.entity_id} ${entity.attributes?.friendly_name ?? ""}`,
    ));
  if (!updateEntity) throw new Error("HACS Kia UVO update entity was not found");
  const hacsBefore = readHacsRecord();
  const alreadyInstalled = updateMatchesTarget(
    updateEntity,
    hacsBefore,
    prepared.target,
  );

  const stamp = new Date().toISOString().replaceAll(":", "-");
  const backupDir = path.join(backupRoot, stamp);
  fs.mkdirSync(backupDir, { recursive: true });
  copyComponent(componentDir, path.join(backupDir, "kia_uvo"));
  command("docker", [
    "cp",
    `homeassistant:${hacsContainerPath}`,
    path.join(backupDir, "hacs.repositories"),
  ]);

  writeStatus(statusFor(prepared, "applying", {
    message: `Backup criado em ${path.relative(repoRoot, backupDir)}.`,
  }));
  try {
    if (!alreadyInstalled) {
      await haRequest("POST", "/api/services/update/install", token, {
        entity_id: updateEntity.entity_id,
        version: prepared.target,
      });
    }
    command("docker", ["compose", "stop", "homeassistant"]);
    makeComponentWritable();
    fs.rmSync(componentDir, { recursive: true, force: true });
    copyComponent(prepared.mergedRoot, componentDir);
    command("python3", ["-m", "compileall", "-q", componentDir]);
    command("docker", ["compose", "start", "homeassistant"]);
    const runtimeTests = await waitForHomeAssistant(token);
    const libraryVersion = command(
      "docker",
      [
        "exec",
        "homeassistant",
        "python",
        "-c",
        "import importlib.metadata; print(importlib.metadata.version('hyundai-kia-connect-api'))",
      ],
      { capture: true },
    ).trim();
    const hacsAfter = readHacsRecord();
    if (normalizeVersion(hacsAfter?.version_installed) !== prepared.target) {
      throw new Error(
        `HACS still reports ${hacsAfter?.version_installed ?? "unknown"}`,
      );
    }
    const config = readJson(statePath);
    config.base_version = prepared.target;
    config.base_commit = preferFullCommit(
      config.base_commit,
      hacsAfter?.installed_commit ?? hacsAfter?.last_commit ?? null,
    );
    writeJson(statePath, config);
    const status = statusFor(prepared, "applied", {
      applied_at: new Date().toISOString(),
      tests: { ...prepared.tests, ...runtimeTests, library_version: libraryVersion },
      message: "HACS instalou a versão oficial e o delta local foi reaplicado.",
    });
    writeStatus(status);
    await publishEvent(token, "creta_integration_update_applied", status);
    fs.rmSync(prepared.workspace, { recursive: true, force: true });
    console.log(JSON.stringify(status, null, 2));
    return status;
  } catch (error) {
    command("docker", ["compose", "stop", "homeassistant"]);
    makeComponentWritable();
    fs.rmSync(componentDir, { recursive: true, force: true });
    copyComponent(path.join(backupDir, "kia_uvo"), componentDir);
    command("docker", [
      "cp",
      path.join(backupDir, "hacs.repositories"),
      `homeassistant:${hacsContainerPath}`,
    ]);
    command("docker", ["compose", "start", "homeassistant"]);
    const rollback = statusFor(prepared, "rollback", {
      rollback_at: new Date().toISOString(),
      message: `Falha: ${error.message}. Backup restaurado.`,
    });
    writeStatus(rollback);
    await publishEvent(token, "creta_integration_update_rollback", rollback)
      .catch(() => undefined);
    throw error;
  }
}

const invoked = process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  const args = process.argv.slice(2);
  const mode = args[0] ?? "check";
  const targetIndex = args.indexOf("--target");
  const target = targetIndex >= 0 ? args[targetIndex + 1] : null;
  if (mode === "check") {
    await check(target, { force: args.includes("--force") });
  } else if (mode === "apply") {
    await apply(target);
  } else {
    throw new Error("usage: kia-uvo-safe-update.mjs check|apply [--target vX.Y.Z]");
  }
}
