#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const defaultRepoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extensions = new Set([".gif", ".jpeg", ".jpg", ".md", ".mmd", ".png", ".svg", ".webp"]);
const requiredAssets = [
  "docs/assets/smart-home-architecture.mmd",
  "docs/assets/smart-home-architecture.svg",
  "docs/assets/github-social-preview.svg",
  "docs/assets/github-social-preview.png",
];

function gitFiles(repoRoot) {
  const result = spawnSync("git", ["ls-files", "--cached", "-z", "docs/assets/**"], {
    cwd: repoRoot,
    encoding: "buffer",
  });
  if (result.status !== 0) throw new Error("git ls-files failed");
  return result.stdout.toString("utf8").split("\0").filter(Boolean);
}

function pngInfo(data) {
  const signature = Buffer.from("89504e470d0a1a0a", "hex");
  if (!data.subarray(0, 8).equals(signature)) throw new Error("invalid PNG signature");
  const chunks = [];
  let offset = 8;
  while (offset < data.length) {
    if (offset + 12 > data.length) throw new Error("truncated PNG chunk");
    const length = data.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > data.length) throw new Error("truncated PNG payload");
    chunks.push(data.toString("ascii", offset + 4, offset + 8));
    offset = end;
  }
  return {
    width: data.readUInt32BE(16),
    height: data.readUInt32BE(20),
    bitDepth: data[24],
    colorType: data[25],
    chunks,
  };
}

export function checkAssets({ repoRoot = defaultRepoRoot, trackedFiles } = {}) {
  const files = (trackedFiles ?? gitFiles(repoRoot)).filter((file) => file.startsWith("docs/assets/"));
  const tracked = new Set(files);
  const errors = [];
  for (const required of requiredAssets) if (!tracked.has(required)) errors.push(`${required}: required asset is not tracked`);

  for (const file of files) {
    const absolute = path.join(repoRoot, file);
    const extension = path.extname(file).toLowerCase();
    if (!extensions.has(extension)) errors.push(`${file}: unsupported documentation asset type`);
    if (!fs.existsSync(absolute)) {
      errors.push(`${file}: tracked asset is missing from worktree`);
      continue;
    }
    if (fs.lstatSync(absolute).isSymbolicLink()) errors.push(`${file}: documentation assets cannot be symlinks`);
    const data = fs.readFileSync(absolute);

    if (extension === ".png") {
      let info;
      try { info = pngInfo(data); } catch (error) { errors.push(`${file}: ${error.message}`); continue; }
      if (file === "docs/assets/github-social-preview.png") {
        if (info.width !== 1280 || info.height !== 640) errors.push(`${file}: expected 1280x640, got ${info.width}x${info.height}`);
        if (info.bitDepth !== 8 || info.colorType !== 2) errors.push(`${file}: expected 8-bit RGB PNG without alpha`);
        if (data.length >= 1_000_000) errors.push(`${file}: expected size below 1 MB`);
        const ancillary = info.chunks.filter((chunk) => !new Set(["IHDR", "PLTE", "IDAT", "IEND"]).has(chunk));
        if (ancillary.length) errors.push(`${file}: metadata/ancillary PNG chunks are not allowed: ${[...new Set(ancillary)].join(", ")}`);
      }
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
    if (extension === ".svg") {
      const content = data.toString("utf8");
      if (!/<svg\b/i.test(content)) errors.push(`${file}: invalid SVG document`);
      if (/data:image\//i.test(content)) errors.push(`${file}: embedded raster data is not reproducible`);
      if (file === "docs/assets/smart-home-architecture.svg") {
        for (const label of [
          "PUBLIC REPOSITORY", "PRIVATE RUNTIME STATE", "PHYSICAL DEVICES",
          "OPTIONAL CLOUD SERVICES", "BACKUP / RESTORE", "AGENT / LOCAL-AI BOUNDARY",
          "Home Assistant", "Node-RED", "Optional agent bridge",
          "Private bindings and secrets", "Encrypted private restore bundle",
        ]) {
          if (!content.includes(label)) errors.push(`${file}: missing architecture label: ${label}`);
        }
      }
      if (file === "docs/assets/github-social-preview.svg") {
        if (!/width="1280" height="640"/.test(content)) errors.push(`${file}: source canvas must be 1280x640`);
        for (const text of ["Self-hosted", "Smart Home Platform", "Security · Observability · Recovery · Local AI"]) {
          if (!content.includes(text)) errors.push(`${file}: missing social-preview text: ${text}`);
        }
      }
    }
    if (extension === ".mmd") {
      const content = data.toString("utf8");
      for (const label of [
        "PUBLIC REPOSITORY", "PRIVATE RUNTIME STATE", "PHYSICAL DEVICES",
        "OPTIONAL CLOUD SERVICES", "BACKUP / RESTORE", "AGENT / LOCAL-AI BOUNDARY",
        "Home Assistant", "Node-RED",
      ]) {
        if (!content.includes(label)) errors.push(`${file}: missing Mermaid architecture label: ${label}`);
      }
    }
  }
  return { errors: [...new Set(errors)].sort(), files: files.length };
}

function main() {
  const result = checkAssets();
  if (result.errors.length) {
    console.error(`Asset check failed (${result.errors.length} issue(s)):`);
    for (const error of result.errors) console.error(`- ${error}`);
    process.exit(1);
  }
  console.log(`Asset check passed: ${result.files} tracked documentation asset(s).`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
