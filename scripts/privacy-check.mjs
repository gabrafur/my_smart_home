#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const allowedRoles = "(?:resident_(?:primary|secondary)|mobile_(?:primary|secondary)|vehicle_primary|garage_gate|exterior_light|security_panel|example_[a-z0-9_]+)";
const rules = [
  ["private-ipv4", "network", /\b(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})\b/g],
  ["mac-address", "physical-id", /\b(?:[0-9a-f]{2}:){5}[0-9a-f]{2}\b/gi],
  ["precise-coordinate", "location", /(?<![\w.])-?(?:[1-8]?\d(?:\.\d{6,})|90\.0{6,})(?![\w.])/g],
  ["vin-or-serial", "physical-id", /\b(?=[A-HJ-NPR-Z0-9]{17}\b)(?=.*\d)[A-HJ-NPR-Z0-9]{17}\b/g],
  ["personal-person-entity", "identity", new RegExp(`\\bperson\\.(?!${allowedRoles}\\b)[a-z0-9_]+`, "g")],
  ["personal-tracker", "identity", new RegExp(`\\bdevice_tracker\\.(?!${allowedRoles}\\b)[a-z0-9_]*(?:iphone|phone|pixel|galaxy|mobile_app|find_my)[a-z0-9_]*`, "g")],
  ["personal-notifier", "identity", new RegExp(`\\bnotify\\.(?!${allowedRoles}\\b)(?:mobile_app_)?[a-z0-9_]*(?:iphone|phone|pixel|galaxy)[a-z0-9_]*`, "g")],
  ["residential-device-topic", "routine", /\bzigbee2mqtt\/(?!bridge(?:\/|$)|example_|<)[a-z0-9_-]+\/(?:set|get|state)\b/g],
  ["event-timestamp", "routine", /\b(?:arrival|presence|trip|trajectory|event|payload|log)[^\n]{0,80}\b20\d{2}-\d{2}-\d{2}[t ][0-2]\d:[0-5]\d/gi],
  ["real-log-line", "runtime-data", /^\s*(?:START|RESULT|CANDIDATE|INSPECT)\|.*(?:path|at|before_bytes|after_bytes)=/gim],
];
const ignoredText = [
  /^homeassistant\/custom_components\/(?:alexa_media|hacs|kia_uvo|localtuya|tuya_vacuum_maps)\//,
  /^nodered\/package-lock\.json$/,
  /^scripts\/privacy-check(?:\.test)?\.mjs$/,
];
const imageExtensions = new Set([".jpg", ".jpeg", ".png", ".webp", ".heic", ".tiff"]);
const privateRuntimePath = /(?:^|\/)(?:\.agent-history|\.claude|\.local-secrets|homeassistant\/\.storage|matter-server|portainer|backups)(?:\/|$)/;
const privateCodexPath = /^\.codex\/(?!memories(?:\/|$))/;
const sensitiveArtifactPath = /(?:^|\/)(?:secrets\.ya?ml|password\.txt|coordinator_backup\.json|\.env)(?:$|\/)|\.(?:bak|backup|db|sqlite\d*|log|tar|tgz|zip)$/i;

function git(args, input) {
  const result = spawnSync("git", args, {
    cwd: repoRoot,
    encoding: args.includes("-z") ? "buffer" : "utf8",
    input,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
  if (result.status !== 0) throw new Error("git command failed");
  return result.stdout;
}

function fileList(mode) {
  const output = mode === "staged"
    ? git(["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"])
    : git(["ls-files", "--cached", "-z"]);
  return output.toString("utf8").split("\0").filter(Boolean);
}

function contentFor(file, mode) {
  if (mode === "staged" || !fs.existsSync(path.join(repoRoot, file))) {
    const result = spawnSync("git", ["show", `:${file}`], { cwd: repoRoot, encoding: "buffer" });
    return result.status === 0 ? result.stdout : Buffer.alloc(0);
  }
  return fs.readFileSync(path.join(repoRoot, file));
}

function lineNumber(text, offset) {
  return text.slice(0, offset).split("\n").length;
}

function hasImageMetadata(buffer, extension) {
  if (extension === ".png") {
    return ["tEXt", "zTXt", "iTXt", "eXIf"].some((chunk) => buffer.includes(Buffer.from(chunk)));
  }
  if ([".jpg", ".jpeg"].includes(extension)) return buffer.includes(Buffer.from("Exif\0\0"));
  return false;
}

export function scanEntries(entries, { denylist = [] } = {}) {
  const findings = [];
  const report = (rule, file, line, category) => findings.push({ rule, file, line, category });
  for (const { file, buffer } of entries) {
    if (privateRuntimePath.test(file) || privateCodexPath.test(file)) {
      report("private-runtime-path", file, 0, "runtime-data");
      continue;
    }
    if (sensitiveArtifactPath.test(file) && !file.endsWith(".env.example")) {
      report("sensitive-artifact", file, 0, "runtime-data");
      continue;
    }
    if (file.endsWith("flows_cred.json") && !["", "{}"].includes(buffer.toString("utf8").trim())) {
      report("credential-state", file, 0, "runtime-data");
      continue;
    }
    const extension = path.extname(file).toLowerCase();
    if (imageExtensions.has(extension)) {
      if (!file.startsWith("docs/assets/generated/")) report("image-location", file, 0, "image");
      if (hasImageMetadata(buffer, extension)) report("image-metadata", file, 0, "metadata");
      continue;
    }
    if (buffer.includes(0) || ignoredText.some((pattern) => pattern.test(file))) continue;
    const text = buffer.toString("utf8");
    for (const [rule, category, pattern] of rules) {
      pattern.lastIndex = 0;
      for (const match of text.matchAll(pattern)) {
        if (rule === "mac-address" && match[0].toUpperCase() === "AA:AA:AA:AA:AA:AA") continue;
        if (rule === "private-ipv4" && /(?:example|synthetic|sint[eé]tic)/i.test(text.slice(Math.max(0, match.index - 80), match.index))) continue;
        report(rule, file, lineNumber(text, match.index ?? 0), category);
      }
    }
    for (const term of denylist) {
      if (!term) continue;
      const lower = text.toLocaleLowerCase("pt-BR");
      const needle = term.toLocaleLowerCase("pt-BR");
      let offset = lower.indexOf(needle);
      while (offset >= 0) {
        report("private-denylist", file, lineNumber(text, offset), "identity");
        offset = lower.indexOf(needle, offset + needle.length);
      }
    }
  }
  return findings;
}

function loadDenylist() {
  const configured = process.env.PRIVACY_DENYLIST_FILE;
  if (!configured) return [];
  const content = fs.readFileSync(configured, "utf8");
  return content.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
}

function main() {
  const mode = process.argv.includes("--staged") ? "staged" : "tracked";
  let entries;
  try {
    entries = fileList(mode).map((file) => ({ file, buffer: contentFor(file, mode) }));
  } catch {
    console.error("rule=scanner-error file=<repository> line=0 category=tooling");
    process.exit(2);
  }
  const findings = scanEntries(entries, { denylist: loadDenylist() });
  for (const item of findings) {
    console.error(`rule=${item.rule} file=${item.file} line=${item.line} category=${item.category}`);
  }
  if (findings.length) process.exit(1);
  console.log(`Privacy check passed (${mode}; ${entries.length} Git file(s)).`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
