#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const RETENTION_DAYS = 7;
const HOUR = 60 * 60 * 1000;
const root = fileURLToPath(new URL("../notification-history/", import.meta.url));

// Only old hour buckets are touched. The file node appends to the current hour,
// so pruning never races a writer or requires loading the full history in RAM.
export async function purgeHistory(directory, now = Date.now()) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  if (!(await fs.lstat(directory)).isDirectory()) throw new Error("invalid history directory");
  await fs.chmod(directory, 0o700);
  const cutoff = now - RETENTION_DAYS * 24 * HOUR;
  let removed = 0;
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !/^\d{4}-\d{2}-\d{2}T\d{2}\.jsonl$/.test(entry.name)) continue;
    const start = Date.parse(`${entry.name.slice(0, 13)}:00:00.000Z`);
    if (!Number.isFinite(start) || start >= cutoff) continue;
    const filename = path.join(directory, entry.name);
    if (start + HOUR <= cutoff) {
      await fs.unlink(filename);
      removed += 1;
      continue;
    }
    // Prune the boundary bucket by each timestamp, preserving the exact cutoff.
    const contents = await fs.readFile(filename, "utf8");
    const lines = contents.split("\n").filter(Boolean);
    const retained = lines.filter((line) => {
      const timestamp = Date.parse(JSON.parse(line).accepted_at);
      if (!Number.isFinite(timestamp)) throw new Error("invalid history timestamp");
      return timestamp >= cutoff;
    });
    if (retained.length === lines.length) continue;
    const temporary = `${filename}.purge-tmp`;
    await fs.writeFile(temporary, retained.length ? `${retained.join("\n")}\n` : "", { mode: 0o600 });
    await fs.rename(temporary, filename);
  }
  return { retention_days: RETENTION_DAYS, removed_buckets: removed };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const channel = process.argv[2];
  try {
    if (!["mobile", "alexa", "persistent"].includes(channel)) throw new Error("invalid channel");
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    await fs.chmod(root, 0o700);
    console.log(JSON.stringify(await purgeHistory(path.join(root, channel))));
  } catch {
    console.error("NOTIFICATION_HISTORY_PURGE_FAILED");
    process.exitCode = 1;
  }
}
