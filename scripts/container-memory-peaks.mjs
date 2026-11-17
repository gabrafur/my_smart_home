#!/usr/bin/env node
// Keep each container's daily memory peak, so container limits can be sized from real
// data (including the nightly update window). The kernel's cgroup v2 memory.peak resets
// when a container restarts, and the nightly updates restart them, so this recorder runs
// periodically and keeps the highest value seen per container per UTC day (30 days).
// Read only: it never changes a container. Requires the cgroup memory controller
// (cgroup_enable=memory, enabled on 17/11/2026).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_FILE = path.join(repoRoot, ".local-state/host-memory-guardian/container-peaks.json");
const NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/;
const ID = /^[a-f0-9]{64}$/;
const DAYS = 30;

export function listContainers({ execute = execFileSync } = {}) {
  const text = execute("docker", ["ps", "--no-trunc", "--format", "{{.ID}} {{.Names}}"], {
    encoding: "utf8", timeout: 15000, stdio: ["ignore", "pipe", "pipe"],
  });
  return text.split("\n").filter(Boolean).map((line) => line.split(" "))
    .filter(([id, name]) => ID.test(id) && NAME.test(name)).map(([id, name]) => ({ id, name }));
}

export function readPeak(id, { cgroupRoot = "/sys/fs/cgroup", read = fs.readFileSync } = {}) {
  const value = (file) => {
    const text = String(read(path.join(cgroupRoot, "system.slice", `docker-${id}.scope`, file), "utf8")).trim();
    if (!/^\d{1,20}$/.test(text)) throw new Error("memory_value_invalid");
    return Math.round(Number(text) / 1048576);
  };
  return { peak_mib: value("memory.peak"), current_mib: value("memory.current") };
}

// Pure merge: per day and container, keep the highest peak; drop days older than 30.
export function mergePeaks(ledger, day, samples) {
  const days = { ...(ledger?.days ?? {}) };
  const today = { ...(days[day] ?? {}) };
  for (const { name, peak_mib: peak } of samples) {
    if (!NAME.test(name) || !Number.isSafeInteger(peak) || peak < 0) continue;
    today[name] = Math.max(today[name] ?? 0, peak);
  }
  days[day] = today;
  const kept = Object.keys(days).sort().slice(-DAYS);
  return { schema_version: 1, unit: "MiB", days: Object.fromEntries(kept.map((key) => [key, days[key]])) };
}

export function record({ file = DEFAULT_FILE, now = new Date(), containers = listContainers(), peak = readPeak } = {}) {
  const samples = [];
  for (const container of containers) {
    try { samples.push({ name: container.name, ...peak(container.id) }); } catch { /* not running or no cgroup file */ }
  }
  let ledger = null;
  try { ledger = JSON.parse(fs.readFileSync(file, "utf8")); } catch { ledger = null; }
  const merged = mergePeaks(ledger?.schema_version === 1 ? ledger : null, now.toISOString().slice(0, 10), samples);
  merged.updated_at = now.toISOString();
  const temporary = `${file}.${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(merged, null, 1)}\n`, { mode: 0o640, flag: "wx" });
  fs.renameSync(temporary, file);
  return { recorded: samples.length, file };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const result = record();
    console.log(`container-memory-peaks recorded=${result.recorded}`);
  } catch (error) {
    console.log(`container-memory-peaks status=failed reason=${/^[a-z_]{3,64}$/.test(error?.message) ? error.message : "unclassified"}`);
    process.exitCode = 1;
  }
}
