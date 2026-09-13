import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const composePath = path.join(repoRoot, "docker-compose.yml");
const logPath = path.join(repoRoot, ".docker-auto-update.log");
const lockPath = path.join(repoRoot, ".docker-auto-update.lock");

const imageChannels = [
  { service: "portainer", repo: "portainer/portainer-ce", tag: "latest" },
  { service: "mosquitto", repo: "eclipse-mosquitto", tag: "latest" },
  { service: "homeassistant", repo: "ghcr.io/home-assistant/home-assistant", tag: "stable" },
  { service: "matter_server", repo: "ghcr.io/home-assistant-libs/python-matter-server", tag: "stable" },
  { service: "appdaemon", repo: "acockburn/appdaemon", tag: "latest" },
  { service: "nodered", repo: "nodered/node-red", tag: "latest" },
  { service: "zigbee2mqtt", repo: "koenkk/zigbee2mqtt", tag: "latest" },
];

export function imageChannelsForMode(selectedMode) {
  if (selectedMode === "daily") return [...imageChannels];
  if (selectedMode === "home-assistant-core") {
    return imageChannels.filter((channel) => channel.service === "homeassistant");
  }
  if (selectedMode === "containers") {
    return imageChannels.filter((channel) => channel.service !== "homeassistant");
  }
  return null;
}

const cliArgs = process.argv.slice(2);
const args = new Set(cliArgs);
const mode = cliArgs.find((arg) => !arg.startsWith("--")) || "daily";
const dryRun = args.has("--dry-run");

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  fs.appendFileSync(logPath, `${line}\n`);
  console.log(line);
}

function run(command, commandArgs, options = {}) {
  log(`run: ${command} ${commandArgs.join(" ")}`);
  if (dryRun && options.mutates) {
    return "";
  }
  return execFileSync(command, commandArgs, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    env: { ...process.env, ...(options.env || {}) },
  });
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function waitForHealthyService(service, options = {}) {
  const inspect = options.inspect ?? ((selectedService) => run(
    "docker",
    [
      "inspect",
      selectedService,
      "--format",
      "{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}",
    ],
    { capture: true },
  ));
  const pause = options.pause ?? delay;
  const attempts = options.attempts ?? 36;
  const intervalMs = options.intervalMs ?? 5000;
  let lastState = "unavailable";

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      lastState = inspect(service).trim();
    } catch {
      lastState = "unavailable";
    }

    if (lastState === "running|healthy") {
      return lastState;
    }
    if (/^(exited|dead)\|/.test(lastState) || lastState === "running|unhealthy") {
      throw new Error(`Service ${service} failed while waiting for health: ${lastState}`);
    }
    if (attempt < attempts) {
      await pause(intervalMs);
    }
  }

  throw new Error(`Service ${service} did not become healthy: ${lastState}`);
}

async function withLock(fn) {
  if (fs.existsSync(lockPath)) {
    const ageMs = Date.now() - fs.statSync(lockPath).mtimeMs;
    if (ageMs < 6 * 60 * 60 * 1000) {
      log("skipped: update lock is active");
      return;
    }
    log("removing stale update lock");
    fs.rmSync(lockPath, { force: true });
  }

  fs.writeFileSync(lockPath, `${process.pid}\n`, { mode: 0o644 });
  try {
    await fn();
  } finally {
    fs.rmSync(lockPath, { force: true });
  }
}

function imageReference({ repo, tag }) {
  return `${repo}:${tag}`;
}

function repoDigest(repo, tag) {
  const reference = imageReference({ repo, tag });
  run("docker", ["pull", reference], { mutates: true });
  const digests = run("docker", ["image", "inspect", reference, "--format", "{{json .RepoDigests}}"], { capture: true }).trim();
  const parsed = JSON.parse(digests);
  const digest = parsed.find((entry) => entry.startsWith(`${repo}@sha256:`));
  if (!digest) {
    throw new Error(`Could not resolve digest for ${reference}`);
  }
  return digest;
}

export function replaceServiceImage(compose, service, nextDigest) {
  const lines = compose.split("\n");
  const serviceIndex = lines.findIndex((line) => line === `  ${service}:`);
  if (serviceIndex === -1) {
    throw new Error(`Could not find compose service ${service}`);
  }
  let serviceEnd = lines.length;
  for (let index = serviceIndex + 1; index < lines.length; index += 1) {
    if (/^  [a-zA-Z0-9_-]+:\s*$/.test(lines[index])) {
      serviceEnd = index;
      break;
    }
  }
  const imageIndex = lines.findIndex(
    (line, index) => index > serviceIndex && index < serviceEnd && /^    image:\s*\S+/.test(line),
  );
  if (imageIndex === -1) {
    throw new Error(`Could not find image property for service ${service}`);
  }
  const current = lines[imageIndex].match(/^    image:\s*(\S+)/)?.[1];
  lines[imageIndex] = lines[imageIndex].replace(/^(    image:\s*)\S+/, `$1${nextDigest}`);
  return { compose: lines.join("\n"), current };
}

function updateComposeDigests(channels = imageChannels) {
  let compose = fs.readFileSync(composePath, "utf8");
  const changes = [];
  const changedServices = [];

  for (const channel of channels) {
    const nextDigest = repoDigest(channel.repo, channel.tag);
    const replacement = replaceServiceImage(compose, channel.service, nextDigest);
    const { current } = replacement;
    if (current !== nextDigest) {
      changes.push(`${channel.service}: ${current} -> ${nextDigest}`);
      changedServices.push(channel.service);
      compose = replacement.compose;
    }
  }

  if (changes.length === 0) {
    log("docker images already match latest channel digests");
    return [];
  }

  log(`docker image updates found: ${changes.join("; ")}`);
  if (!dryRun) {
    fs.writeFileSync(composePath, compose);
  }
  return changedServices;
}

function runInDir(command, commandArgs, cwd, options = {}) {
  log(`run: ${command} ${commandArgs.join(" ")} (cwd=${cwd})`);
  if (dryRun && options.mutates) {
    return "";
  }
  return execFileSync(command, commandArgs, {
    cwd,
    encoding: "utf8",
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    env: { ...process.env, ...(options.env || {}) },
  });
}

function validateAfterComposeEdit() {
  run("docker", ["compose", "config", "--quiet"]);
  runInDir("npm", ["run", "flows:validate"], path.join(repoRoot, "nodered"));
}

async function reconcileImages(channels, options = {}) {
  try {
    const changedServices = updateComposeDigests(channels);
    validateAfterComposeEdit();

    if (changedServices.length > 0) {
      run("docker", ["compose", "up", "-d", "--no-deps", ...changedServices], { mutates: true });
      if (changedServices.includes("homeassistant")) {
        log("waiting for Home Assistant runtime health before backup");
        await waitForHealthyService("homeassistant");
      }
      run("docker", ["compose", "ps"]);
      run("bash", ["scripts/git-backup.sh"], { mutates: true });
    }
  } finally {
    // Cleanup must still run when a pull, parse, validation or recreate step
    // fails. The helper never removes volumes, containers or tagged images.
    if (options.cleanup) {
      run(
        "bash",
        ["scripts/storage-maintenance.sh", dryRun ? "--dry-run" : "--apply", "--min-age", "24"],
        { mutates: !dryRun },
      );
    }
  }
  log(`${options.label ?? "docker"} image update finished`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  await withLock(async () => {
    if (mode === "daily") await reconcileImages(imageChannelsForMode(mode), { cleanup: true, label: "daily docker" });
    else if (mode === "home-assistant-core") {
      await reconcileImages(imageChannelsForMode(mode), {
        cleanup: false,
        label: "Home Assistant Core",
      });
    } else if (mode === "containers") {
      await reconcileImages(imageChannelsForMode(mode), {
        cleanup: true,
        label: "non-Core container",
      });
    } else if (mode === "ha-updates") {
      throw new Error("ha-updates was retired; update.* policy is canonical in Node-RED tab atualizacoes_diarias");
    } else {
      throw new Error("usage: docker-auto-update.mjs daily|home-assistant-core|containers [--dry-run]");
    }
  });
}
