#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function regularPrivateFile(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
    throw new Error("private off-site policy must be a regular mode-0600 file");
  }
}

export function migrateOffsitePolicy(root = repoRoot) {
  const source = path.join(root, "restore/offsite-backup-policy.json");
  const directory = path.join(root, ".local-secrets");
  const destination = path.join(directory, "offsite-backup-policy.json");
  const sourceExists = fs.existsSync(source);
  if (!sourceExists) {
    if (!fs.existsSync(destination)) throw new Error("old and private off-site policies are both missing");
    regularPrivateFile(destination);
    const policy = JSON.parse(fs.readFileSync(destination, "utf8"));
    if (policy.active !== true) throw new Error("private off-site policy is not activated");
    return "already-migrated";
  }
  const sourceStat = fs.lstatSync(source);
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
    throw new Error("old off-site policy must be a regular file");
  }
  const bytes = fs.readFileSync(source);
  JSON.parse(bytes.toString("utf8"));
  if (!fs.existsSync(directory)) fs.mkdirSync(directory, { mode: 0o700 });
  const directoryStat = fs.lstatSync(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || (directoryStat.mode & 0o077) !== 0) {
    throw new Error("private policy directory must be a mode-0700 directory");
  }
  if (fs.existsSync(destination)) {
    regularPrivateFile(destination);
    if (!fs.readFileSync(destination).equals(bytes)) {
      throw new Error("private off-site policy already differs from the old tracked policy");
    }
    return "already-migrated";
  }
  const temporary = path.join(directory, `.offsite-backup-policy.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, bytes, { flag: "wx", mode: 0o600 });
    regularPrivateFile(temporary);
    fs.linkSync(temporary, destination);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  regularPrivateFile(destination);
  if (!fs.readFileSync(destination).equals(bytes)) throw new Error("private policy copy did not verify");
  return "copied-and-verified";
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(`Off-site policy migration: ${migrateOffsitePolicy()}`);
  } catch (error) {
    console.error(`Off-site policy migration stopped: ${error.message}`);
    process.exitCode = 1;
  }
}
