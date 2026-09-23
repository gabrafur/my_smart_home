#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { listenerReady } from "./codex-remote-recovery.mjs";

export const CODEX_REMOTE_HEALTH_TOPIC = "nodered/infrastructure/remote-access/host-health";

export function collectCodexRemoteHealth({
  now = new Date(),
  run = spawnSync,
  codexBin = process.env.CODEX_REMOTE_CODEX_BIN || "/home/gabriel/.local/bin/codex",
  controlSocket = process.env.CODEX_REMOTE_CONTROL_SOCKET || "/home/gabriel/.codex/app-server-control/app-server-control.sock",
} = {}) {
  const checkedAt = now.toISOString();
  const service = run("systemctl", ["is-active", "dropbear.service"], { encoding: "utf8", timeout: 5000 });
  const socketReady = listenerReady(controlSocket, run);
  const version = run(codexBin, ["--version"], { encoding: "utf8", timeout: 10_000 });
  const sshHealthy = service?.status === 0 && String(service.stdout).trim() === "active";
  const codexInstalled = version?.status === 0;
  const codexHealthy = codexInstalled && socketReady;
  return {
    schema_version: 1,
    checked_at: checkedAt,
    services: {
      remote_shell: {
        healthy: sshHealthy,
        reason: sshHealthy ? "service_active" : "service_inactive",
      },
      codex_remote: {
        installed: codexInstalled,
        healthy: codexHealthy,
        reason: !codexInstalled ? "binary_unavailable" : socketReady ? "app_server_ready" : "app_server_absent",
      },
    },
  };
}

const PUBLISH_SCRIPT = String.raw`
const fs = require("fs");
const crypto = require("crypto");
const mqtt = require("mqtt");
function credentials() {
  const encrypted = JSON.parse(fs.readFileSync("/data/flows_cred.json", "utf8")).$;
  const iv = Buffer.from(encrypted.slice(0, 32), "hex");
  const key = crypto.createHash("sha256").update(process.env.NODE_RED_CREDENTIAL_SECRET).digest();
  const decipher = crypto.createDecipheriv("aes-256-ctr", key, iv);
  const values = JSON.parse(decipher.update(encrypted.slice(32), "base64", "utf8") + decipher.final("utf8"));
  const flows = JSON.parse(fs.readFileSync("/data/flows.json", "utf8"));
  const broker = flows.find((node) => node.type === "mqtt-broker" && values[node.id]);
  if (!broker) throw new Error("MQTT credential unavailable");
  return { broker, auth: values[broker.id] };
}
(async () => {
  const payload = Buffer.from(process.argv[1], "base64url").toString("utf8");
  JSON.parse(payload);
  const { broker, auth } = credentials();
  const client = mqtt.connect({ protocol: "mqtt", host: broker.broker, port: Number(broker.port || 1883),
    username: auth.user, password: auth.password, connectTimeout: 5000, reconnectPeriod: 0 });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("MQTT connect timeout")), 6000);
    client.once("connect", () => { clearTimeout(timer); resolve(); });
    client.once("error", (error) => { clearTimeout(timer); reject(error); });
  });
  await new Promise((resolve, reject) => client.publish(process.env.CODEX_REMOTE_HEALTH_TOPIC, payload,
    { qos: 1, retain: true }, (error) => error ? reject(error) : resolve()));
  await new Promise((resolve) => client.end(false, {}, resolve));
})().catch((error) => { console.error("CODEX_REMOTE_HEALTH_PUBLISH_FAILED " + error.message); process.exit(1); });
`;

export function publishCodexRemoteHealth(report, { run = spawnSync } = {}) {
  const encoded = Buffer.from(JSON.stringify(report)).toString("base64url");
  const result = run("docker", ["exec", "-i", "-e", `CODEX_REMOTE_HEALTH_TOPIC=${CODEX_REMOTE_HEALTH_TOPIC}`,
    "nodered", "node", "-e", PUBLISH_SCRIPT, encoded], { encoding: "utf8", timeout: 15_000 });
  if (result?.error || result?.status !== 0) throw new Error("Codex remote health MQTT publish failed");
}

export function main(argv = process.argv.slice(2)) {
  if (argv.length !== 1 || !new Set(["--dry-run", "--publish"]).has(argv[0])) {
    throw new Error("Use --dry-run ou --publish");
  }
  const report = collectCodexRemoteHealth();
  if (argv[0] === "--publish") publishCodexRemoteHealth(report);
  process.stdout.write(`${argv[0] === "--publish" ? "CODEX_REMOTE_HEALTH_PUBLISHED" : JSON.stringify(report)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); } catch (error) { console.error(`CODEX_REMOTE_HEALTH_FAILED ${error.message}`); process.exitCode = 1; }
}
