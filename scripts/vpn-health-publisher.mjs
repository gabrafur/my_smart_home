#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const VPN_HEALTH_TOPIC = "nodered/infrastructure/vpn/host-health";

export function evaluateTailscaleStatus(raw, checkedAt = new Date().toISOString()) {
  let status;
  try {
    status = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return {
      role: "vpn_primary",
      kind: "tailscale",
      installed: true,
      healthy: false,
      status: "offline",
      reason: "invalid_status",
      checked_at: checkedAt,
    };
  }

  const backend = String(status?.BackendState ?? "unknown").toLowerCase();
  const selfOnline = status?.Self?.Online === true;
  const healthy = backend === "running" && selfOnline;
  let reason = "not_online";
  if (healthy) reason = "running";
  else if (backend === "needslogin") reason = "authentication_required";
  else if (backend === "stopped") reason = "backend_stopped";
  else if (backend !== "running" && backend !== "unknown") reason = "backend_unavailable";

  return {
    role: "vpn_primary",
    kind: "tailscale",
    installed: true,
    healthy,
    status: healthy ? "online" : "offline",
    reason,
    checked_at: checkedAt,
  };
}

export function collectVpnHealth({
  tailscaleBin = process.env.VPN_HEALTH_TAILSCALE_BIN || "tailscale",
  now = new Date(),
  run = spawnSync,
} = {}) {
  const checkedAt = now.toISOString();
  const result = run(tailscaleBin, ["status", "--json"], {
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
  });
  const vpns = [];

  if (result?.error?.code !== "ENOENT") {
    if (result?.status === 0) {
      vpns.push(evaluateTailscaleStatus(result.stdout, checkedAt));
    } else {
      vpns.push({
        role: "vpn_primary",
        kind: "tailscale",
        installed: true,
        healthy: false,
        status: "offline",
        reason: result?.error?.code === "ETIMEDOUT"
          ? "status_timeout"
          : "status_command_failed",
        checked_at: checkedAt,
      });
    }
  }

  return {
    schema_version: 1,
    checked_at: checkedAt,
    supported_vpn_count: vpns.length,
    vpns,
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
  const client = mqtt.connect({
    protocol: "mqtt",
    host: broker.broker,
    port: Number(broker.port || 1883),
    username: auth.user,
    password: auth.password,
    connectTimeout: 5000,
    reconnectPeriod: 0,
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("MQTT connect timeout")), 6000);
    client.once("connect", () => { clearTimeout(timer); resolve(); });
    client.once("error", (error) => { clearTimeout(timer); reject(error); });
  });
  await new Promise((resolve, reject) => {
    client.publish(process.env.VPN_HEALTH_TOPIC, payload, { qos: 1, retain: true }, (error) => error ? reject(error) : resolve());
  });
  await new Promise((resolve) => client.end(false, {}, resolve));
})().catch((error) => {
  console.error("VPN_HEALTH_PUBLISH_FAILED " + error.message);
  process.exit(1);
});
`;

export function publishVpnHealth(report, { run = spawnSync } = {}) {
  const encoded = Buffer.from(JSON.stringify(report)).toString("base64url");
  const result = run(
    "docker",
    [
      "exec",
      "-i",
      "-e",
      `VPN_HEALTH_TOPIC=${VPN_HEALTH_TOPIC}`,
      "nodered",
      "node",
      "-e",
      PUBLISH_SCRIPT,
      encoded,
    ],
    { encoding: "utf8", timeout: 15_000, windowsHide: true },
  );
  if (result?.error || result?.status !== 0) {
    throw new Error("VPN health MQTT publish failed");
  }
}

export function main(argv = process.argv.slice(2)) {
  const mode = argv[0];
  if (!new Set(["--dry-run", "--publish"]).has(mode) || argv.length !== 1) {
    throw new Error("Use --dry-run ou --publish");
  }
  const report = collectVpnHealth();
  if (mode === "--dry-run") {
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return;
  }
  publishVpnHealth(report);
  process.stdout.write(
    `VPN_HEALTH_PUBLISHED checked_at=${report.checked_at} vpn_count=${report.supported_vpn_count}\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(`VPN_HEALTH_FAILED ${error.message}`);
    process.exitCode = 1;
  }
}
