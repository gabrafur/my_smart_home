import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { probeService, requireReadinessCoverage } from "./container-readiness.mjs";
import { createDockerRecoveryStore } from "./docker-update-recovery.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const composePath = path.join(repoRoot, "docker-compose.yml");
const logPath = path.join(repoRoot, ".docker-auto-update.log");
const lockPath = path.join(repoRoot, ".docker-auto-update.lock");
const recovery = createDockerRecoveryStore(repoRoot);

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
    timeout: options.timeout,
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
    { capture: true, timeout: 10000 },
  ));
  const pause = options.pause ?? delay;
  const attempts = options.attempts ?? 36;
  const intervalMs = options.intervalMs ?? 5000;
  const probe = options.probe ?? probeService;
  let lastState = "unavailable";

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      lastState = inspect(service).trim();
    } catch {
      lastState = "unavailable";
    }

    if (lastState === "running|healthy" || lastState === "running|none") {
      const ready = await probe(service);
      if (ready === true || (ready === null && lastState === "running|healthy")) return lastState;
      if (ready === null) {
        throw new Error(`Service ${service} has no readiness probe or healthcheck; manual recovery required`);
      }
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

export async function recreateAndVerify(services, { recreate, wait, record, clear, report }) {
  // Record before the first mutation: interruption must not silently pass on retry.
  record({ status: "pending", services, automatic_downgrade: false });
  let failedService = null;
  try {
    await recreate();
    for (const service of services) {
      failedService = service;
      report(`readiness service=${service} status=checking`);
      await wait(service);
      report(`readiness service=${service} status=ready`);
    }
    clear();
  } catch (error) {
    record({ status: "failed", services, failed_service: failedService, automatic_downgrade: false });
    report(`readiness service=${failedService ?? "recreation"} status=failed recovery=manual images_and_volumes=preserved automatic_downgrade=false`);
    throw error;
  }
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
  const before = fs.readFileSync(composePath, "utf8");
  let compose = before;
  const changes = [];
  const changedServices = [];
  const desiredImages = [];

  for (const channel of channels) {
    const nextDigest = repoDigest(channel.repo, channel.tag);
    desiredImages.push({ service: channel.service, image: nextDigest });
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
    return { before, compose, changedServices, desiredImages };
  }

  log(`docker image updates found: ${changes.join("; ")}`);
  return { before, compose, changedServices, desiredImages };
}

export function servicesNeedingRecreate(desiredImages, inspectImage, inspectContainer) {
  return desiredImages.filter(({ service, image }) => {
    const desired = inspectImage(image).trim();
    const running = inspectContainer(service).trim();
    if (!desired || !running) throw new Error(`Image identity unavailable for ${service}`);
    return desired !== running;
  }).map(({ service }) => service);
}

export function validateComposeCandidate(plan, { read, write, validate }) {
  if (read() !== plan.before) throw new Error("Compose changed while resolving images");
  write(plan.compose);
  try {
    validate();
  } catch (error) {
    // Revert only our candidate, never a concurrent operator's edit.
    if (read() === plan.compose) write(plan.before);
    throw error;
  }
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
  let completed = false;
  try {
    if (recovery.hasPending()) {
      throw new Error("Unresolved Docker update recovery record; review persistent data and readiness before clearing it manually");
    }
    const plan = updateComposeDigests(channels);
    const previousImages = {};
    // A previous run can have written the digest before recreation failed.
    // Compare actual image IDs even when the Compose digest is unchanged.
    const changedServices = [...new Set([...plan.changedServices, ...servicesNeedingRecreate(
      plan.desiredImages,
      (image) => run("docker", ["image", "inspect", image, "--format", "{{.Id}}"], { capture: true }),
      (service) => {
        const identity = run("docker", ["inspect", service, "--format", "{{.Image}}"], { capture: true, timeout: 10000 }).trim();
        previousImages[service] = identity;
        return identity;
      },
    )])];
    requireReadinessCoverage(changedServices, (service) => run("docker", ["inspect", service,
      "--format", "{{if .Config.Healthcheck}}{{json .Config.Healthcheck.Test}}{{else}}null{{end}}"],
    { capture: true, timeout: 10000 }).trim().match(/^\["CMD(?:-SHELL)?"/) !== null);
    if (dryRun) validateAfterComposeEdit();
    else validateComposeCandidate(plan, {
      read: () => fs.readFileSync(composePath, "utf8"),
      write: (content) => fs.writeFileSync(composePath, content),
      validate: validateAfterComposeEdit,
    });

    if (changedServices.length > 0) {
      if (!dryRun) {
        await recreateAndVerify(changedServices, {
          recreate: () => run("docker", ["compose", "up", "-d", "--no-deps", ...changedServices], { mutates: true }),
          wait: waitForHealthyService,
          report: log,
          record: (state) => {
            recovery.record({ ...state,
              previous_compose: plan.before, candidate_compose: plan.compose,
              previous_images: previousImages, desired_images: plan.desiredImages });
          },
          clear: recovery.clear,
        });
      }
      run("docker", ["compose", "ps"]);
      run("bash", ["scripts/git-backup.sh"], { mutates: true });
    }
    completed = true;
  } finally {
    // Preserve recovery evidence and old images on failure, including partial up.
    if (options.cleanup && completed) {
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
