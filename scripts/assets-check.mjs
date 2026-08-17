#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extensions = new Set([".gif", ".jpeg", ".jpg", ".png", ".svg", ".webp"]);

function gitFiles() {
  const result = spawnSync("git", ["ls-files", "--cached", "-z", "docs/assets/**"], {
    cwd: repoRoot,
    encoding: "buffer",
  });
  if (result.status !== 0) throw new Error("git ls-files failed");
  return result.stdout.toString("utf8").split("\0").filter(Boolean);
}

const files = gitFiles();
const errors = [];
for (const file of files) {
  const absolute = path.join(repoRoot, file);
  const extension = path.extname(file).toLowerCase();
  if (!extensions.has(extension)) errors.push(`${file}: unsupported documentation asset type`);
  if (fs.lstatSync(absolute).isSymbolicLink()) errors.push(`${file}: documentation assets cannot be symlinks`);
  const data = fs.readFileSync(absolute);
  if (extension === ".png" && !data.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) {
    errors.push(`${file}: invalid PNG signature`);
  }
  if ([".jpg", ".jpeg"].includes(extension) && !data.subarray(0, 2).equals(Buffer.from("ffd8", "hex"))) {
    errors.push(`${file}: invalid JPEG signature`);
  }
  if (extension === ".gif" && !/^GIF8[79]a/.test(data.subarray(0, 6).toString("ascii"))) {
    errors.push(`${file}: invalid GIF signature`);
  }
  if (extension === ".webp" && (data.subarray(0, 4).toString("ascii") !== "RIFF" || data.subarray(8, 12).toString("ascii") !== "WEBP")) {
    errors.push(`${file}: invalid WebP signature`);
  }
  if (extension === ".svg" && !/<svg\b/i.test(data.toString("utf8"))) errors.push(`${file}: invalid SVG document`);
}

if (errors.length) {
  console.error(`Asset check failed (${errors.length} issue(s)):`);
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}
console.log(`Asset check passed: ${files.length} tracked documentation asset(s).`);
