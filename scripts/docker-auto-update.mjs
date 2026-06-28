import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const repoRoot = "/mnt/data/docker";
const composePath = path.join(repoRoot, "docker-compose.yml");
const logPath = path.join(repoRoot, ".docker-auto-update.log");
const lockPath = path.join(repoRoot, ".docker-auto-update.lock");

const imageChannels = [
  { service: "portainer", repo: "portainer/portainer-ce", tag: "latest" },
  { service: "mosquitto", repo: "eclipse-mosquitto", tag: "latest" },
  { service: "homeassistant", repo: "ghcr.io/home-assistant/home-assistant", tag: "stable" },
  { service: "appdaemon", repo: "acockburn/appdaemon", tag: "latest" },
  { service: "nodered", repo: "nodered/node-red", tag: "latest" },
  { service: "zigbee2mqtt", repo: "koenkk/zigbee2mqtt", tag: "latest" },
];

const args = new Set(process.argv.slice(2));
const mode = process.argv.find((arg) => ["daily", "ha-updates"].includes(arg)) || "daily";
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

function updateComposeDigests() {
  let compose = fs.readFileSync(composePath, "utf8");
  const changes = [];

  for (const channel of imageChannels) {
    const nextDigest = repoDigest(channel.repo, channel.tag);
    const servicePattern = new RegExp(`(^\\s{2}${channel.service}:\\n[\\s\\S]*?)(?=^\\s{2}[a-zA-Z0-9_-]+:|\\s*$)`, "m");
    const serviceMatch = compose.match(servicePattern);
    if (!serviceMatch) {
      throw new Error(`Could not find compose image line for service ${channel.service}`);
    }

    const block = serviceMatch[1];
    const current = block.match(/^\s{4}image:\s*(\S+)/m)?.[1];
    if (!current) {
      throw new Error(`Could not find image property for service ${channel.service}`);
    }
    if (current !== nextDigest) {
      changes.push(`${channel.service}: ${current} -> ${nextDigest}`);
      const updatedBlock = block.replace(/^(\s{4}image:\s*)\S+/m, `$1${nextDigest}`);
      compose = compose.replace(block, updatedBlock);
    }
  }

  if (changes.length === 0) {
    log("docker images already match latest channel digests");
    return false;
  }

  log(`docker image updates found: ${changes.join("; ")}`);
  if (!dryRun) {
    fs.writeFileSync(composePath, compose);
  }
  return true;
}

function validateLocalFiles() {
  run("docker", ["compose", "config", "--quiet"]);
  run("npm", ["run", "flows:validate"], { env: {}, capture: false, mutates: false, cwd: path.join(repoRoot, "nodered") });
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

function dailyUpdate() {
  run("bash", ["scripts/git-backup.sh"], { mutates: true });
  const changed = updateComposeDigests();
  validateAfterComposeEdit();

  if (changed) {
    run("docker", ["compose", "up", "-d"], { mutates: true });
    run("docker", ["compose", "ps"]);
    run("bash", ["scripts/git-backup.sh"], { mutates: true });
  }

  run("docker", ["image", "prune", "-f"], { mutates: true });
  log("daily docker update finished");
}

function parseEnvFile() {
  const envPath = path.join(repoRoot, ".env");
  if (!fs.existsSync(envPath)) {
    return {};
  }
  return Object.fromEntries(
    fs.readFileSync(envPath, "utf8")
      .split(/\r?\n/)
      .filter((line) => line && !line.trimStart().startsWith("#") && line.includes("="))
      .map((line) => {
        const index = line.indexOf("=");
        return [line.slice(0, index), line.slice(index + 1).replaceAll("$$", "$")];
      }),
  );
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
          reject(new Error(`Home Assistant API ${method} ${requestPath} failed: ${response.statusCode} ${data}`));
          return;
        }
        resolve(data ? JSON.parse(data) : {});
      });
    });
    request.on("error", reject);
    if (payload) {
      request.write(payload);
    }
    request.end();
  });
}

function updateLooksSafe(entity) {
  if (!entity.entity_id.startsWith("update.")) {
    return false;
  }
  if (entity.state !== "on") {
    return false;
  }
  const name = `${entity.entity_id} ${entity.attributes?.friendly_name || ""}`.toLowerCase();
  if (name.includes("firmware") || name.includes("slzb")) {
    return false;
  }
  return true;
}

async function haUpdates() {
  const env = parseEnvFile();
  const token = env.HA_LONG_LIVED_TOKEN;
  if (!token) {
    log("ha-updates skipped: set HA_LONG_LIVED_TOKEN in .env to allow Home Assistant API updates");
    return;
  }

  const states = await haRequest("GET", "/api/states", token);
  const pending = states.filter(updateLooksSafe);
  if (pending.length === 0) {
    log("ha-updates: no safe integration updates pending");
    return;
  }

  log(`ha-updates pending: ${pending.map((entity) => entity.entity_id).join(", ")}`);
  for (const entity of pending) {
    if (dryRun) {
      continue;
    }
    await haRequest("POST", "/api/services/update/install", token, { entity_id: entity.entity_id });
  }

  if (!dryRun) {
    run("docker", ["compose", "restart", "homeassistant"], { mutates: true });
  }
  log("ha-updates finished");
}

await withLock(async () => {
  if (mode === "ha-updates") {
    await haUpdates();
  } else {
    dailyUpdate();
  }
});
