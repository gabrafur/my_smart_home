#!/usr/bin/env node
// One-line readiness report of the house's core services after a host stage that can
// restart them (for example the DietPi APT stage upgrading Docker). Report only: it
// never restarts anything and always exits 0; the caller records the line.
// Output: `readiness=ok` or `readiness=degraded:<service>,...` (or `readiness=unknown`).
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { probeService } from "./container-readiness.mjs";

export const CORE_SERVICES = ["homeassistant", "mosquitto", "nodered", "zigbee2mqtt"];

// Home Assistant has a Docker healthcheck; the others use the functional probes the
// image updater already relies on (MQTT connect, Node-RED flows, Zigbee bridge state).
export function homeAssistantHealthy({ execute = execFileSync } = {}) {
  try {
    return execute("docker", ["inspect", "homeassistant", "--format", "{{if .State.Health}}{{.State.Health.Status}}{{end}}"], {
      encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "pipe"],
    }).trim() === "healthy";
  } catch { return false; }
}

export async function readinessReport(services = CORE_SERVICES, {
  probe = (service) => (service === "homeassistant" ? homeAssistantHealthy() : probeService(service)),
  deadlineMs = 180000, intervalMs = 10000, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  const deadline = now() + deadlineMs;
  let pending = [...services];
  for (;;) {
    pending = pending.filter((service) => probe(service) !== true);
    if (!pending.length) return "readiness=ok";
    if (now() + intervalMs > deadline) return `readiness=degraded:${pending.sort().join(",")}`;
    await sleep(intervalMs);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const seconds = Number(process.env.READINESS_DEADLINE_SECONDS ?? 180);
  readinessReport(CORE_SERVICES, { deadlineMs: Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : 180000 })
    .then((line) => console.log(line), () => console.log("readiness=unknown"));
}
