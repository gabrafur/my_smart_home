#!/usr/bin/env node
// Prints the docs/CHANGELOG.md section for one release tag, so the release
// workflow publishes exactly what the changelog says and nothing else.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const tagPattern = /^v\d{4}\.(?:0[1-9]|1[0-2])\.\d+$/;

export function releaseNotes(changelog, tag) {
  if (!tagPattern.test(tag)) throw new Error(`invalid release tag: ${tag} (expected vYYYY.MM.N)`);
  const lines = changelog.split("\n");
  const start = lines.findIndex((line) => line.startsWith(`## ${tag} `) || line === `## ${tag}`);
  if (start < 0) throw new Error(`docs/CHANGELOG.md has no section for ${tag}`);
  const next = lines.findIndex((line, index) => index > start && line.startsWith("## "));
  const body = lines.slice(start + 1, next < 0 ? undefined : next).join("\n").trim();
  if (!body) throw new Error(`docs/CHANGELOG.md section for ${tag} is empty`);
  return `${body}\n\nFull changelog: docs/CHANGELOG.md\n`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const changelog = fs.readFileSync(path.join(repoRoot, "docs", "CHANGELOG.md"), "utf8");
    process.stdout.write(releaseNotes(changelog, process.argv[2] ?? ""));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
