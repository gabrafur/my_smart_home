#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { checkPublicMemory } from "./public-memory-check.mjs";
import { digest, reconcileRecord } from "./memory-evidence.mjs";

export function applyCandidate(root, candidate, { apply = false, trackedFiles } = {}) {
  const tracked = trackedFiles ?? execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
  const file = candidate.file;
  if (typeof file !== "string" || !/^\.codex\/memories\/[a-z0-9-]+\/[a-z0-9-]+\.md$/.test(file) ||
      file.endsWith("/indice.md") || !tracked.includes(file)) throw new Error("target must be existing indexed public memory");
  const target = path.join(root, file);
  if (fs.realpathSync(target) !== path.resolve(target)) throw new Error("memory symlink rejected");
  const original = fs.readFileSync(target, "utf8");
  if (digest(original) !== candidate.expected_memory_sha256) throw new Error("memory changed; rebuild candidate against current content");
  const proposed = reconcileRecord(original, candidate);
  const result = checkPublicMemory({ repoRoot: root, trackedFiles: tracked, contentsOverrides: new Map([[file, proposed]]) });
  if (result.errors.length) throw new Error(`candidate rejected: ${result.errors.join("; ")}`);
  if (proposed === original) return { changed: false, applied: false };
  if (!apply) return { changed: true, applied: false };
  const lock = `${target}.memory-lock`;
  const descriptor = fs.openSync(lock, "wx", 0o600);
  const temporary = `${lock}.tmp`;
  let temporaryOwned = false;
  try {
    if (fs.readFileSync(target, "utf8") !== original) throw new Error("memory changed during validation");
    const temporaryDescriptor = fs.openSync(temporary, "wx", fs.statSync(target).mode & 0o777);
    temporaryOwned = true;
    try { fs.writeFileSync(temporaryDescriptor, proposed); fs.fsyncSync(temporaryDescriptor); }
    finally { fs.closeSync(temporaryDescriptor); }
    if (fs.readFileSync(target, "utf8") !== original) throw new Error("memory changed during write");
    fs.renameSync(temporary, target);
  } finally {
    fs.closeSync(descriptor);
    if (temporaryOwned && fs.existsSync(temporary)) fs.unlinkSync(temporary);
    fs.unlinkSync(lock);
  }
  return { changed: true, applied: true };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.some((arg) => arg !== "--apply")) throw new Error("usage: memory-candidate.mjs [--apply] < sanitized-candidate.json");
    let candidate;
    try { candidate = JSON.parse(fs.readFileSync(0, "utf8")); }
    catch { throw new Error("invalid candidate JSON"); }
    console.log(JSON.stringify(applyCandidate(path.resolve(import.meta.dirname, ".."), candidate, { apply: args.includes("--apply") })));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
