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
  ["private-email", "identity", /\b[a-z0-9._%+-]+@(?!example\.(?:com|org|net|invalid)\b)(?!users\.noreply\.github\.com\b)[a-z0-9.-]+\.[a-z]{2,}\b/gi],
  ["private-phone", "identity", /\b(?:phone|telephone|telefone|mobile_number|msisdn)\s*[:=]\s*["']?\+?\d[\d ()-]{7,}\d/gi],
  ["private-hostname", "network", /\b[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.(?:local|lan|internal)(?=$|[/:,\s"'}\]])/gi],
  ["private-ssid", "network", /\bssid\s*[:=]\s*["']?(?!CHANGE_ME\b|example\b|synthetic\b|<)[^\s,"'}]{3,}/gi],
  ["private-address", "location", /\b(?:home_address|street_address|postal_address)\s*[:=]\s*["']?(?!example\b|synthetic\b|<)[^\n,"'}]{5,}/gi],
  ["private-name-field", "identity", /\b(?:owner_name|resident_name|first_name|last_name|surname|family_name)\s*[:=]\s*["']?(?!example\b|synthetic\b|resident_(?:primary|secondary)\b|<)[^\n,"'}]{2,}/gi],
  ["private-account-id", "identity", /\b(?:account_id|user_id)\s*[:=]\s*["']?(?!example\b|synthetic\b|resident_(?:primary|secondary)\b|<)[a-z0-9][a-z0-9_-]{7,}/gi],
];
const ignoredText = [
  /^homeassistant\/custom_components\/(?:alexa_media|hacs|kia_uvo|localtuya|tuya_vacuum_maps)\//,
  /^nodered\/package-lock\.json$/,
  /^scripts\/privacy-check(?:\.test)?\.mjs$/,
  /^scripts\/security-scan(?:\.test)?\.(?:mjs|sh)$/,
];
const benchmarkNumericArtifact = /^(?:docs\/benchmarks\/local-ai-high-potential\/(?:[^/]+\.(?:json|jsonl|csv))|scripts\/local-ai\/benchmarks\/high-potential\/(?:[^/]+\.(?:json|jsonl)))$/;
const imageExtensions = new Set([".jpg", ".jpeg", ".png", ".webp", ".heic", ".tiff"]);
const allowedSyntheticImages = new Set(["docs/assets/github-social-preview.png"]);
const privateRuntimePath = /(?:^|\/)(?:\.agent-history|\.claude|\.local-secrets|homeassistant\/\.storage|matter-server|portainer|backups)(?:\/|$)/;
const privateCodexPath = /^\.codex\/(?!(?:hooks\.json$|memories(?:\/|$)))/;
const sensitiveArtifactPath = /(?:^|\/)(?:secrets\.ya?ml|password\.txt|coordinator_backup\.json|\.env)(?:$|\/)|\.(?:bak|backup|db|sqlite\d*|log|tar|tgz|zip)$/i;

function git(args, input, root = repoRoot) {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: args.includes("-z") ? "buffer" : "utf8",
    input,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
  if (result.status !== 0) throw new Error("git command failed");
  return result.stdout;
}

function fileList(mode, root = repoRoot) {
  const output = mode === "staged"
    ? git(["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"], undefined, root)
    : git(["ls-files", "--cached", "-z"], undefined, root);
  return output.toString("utf8").split("\0").filter(Boolean);
}

function contentFor(file, mode, root = repoRoot) {
  if (mode === "staged" || !fs.existsSync(path.join(root, file))) {
    const result = spawnSync("git", ["show", `:${file}`], { cwd: root, encoding: "buffer" });
    return result.status === 0 ? result.stdout : Buffer.alloc(0);
  }
  return fs.readFileSync(path.join(root, file));
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
      if (!file.startsWith("docs/assets/generated/") && !allowedSyntheticImages.has(file)) report("image-location", file, 0, "image");
      if (hasImageMetadata(buffer, extension)) report("image-metadata", file, 0, "metadata");
      continue;
    }
    if (buffer.includes(0) || ignoredText.some((pattern) => pattern.test(file))) continue;
    const text = buffer.toString("utf8");
    for (const [rule, category, pattern] of rules) {
      if (rule === "precise-coordinate" && extension === ".svg") continue;
      // Machine-readable benchmark artifacts contain high-precision scores,
      // latencies and GPU samples but never persist prompts or source inputs.
      // Keep every other privacy rule active for these narrowly scoped paths.
      if (rule === "precise-coordinate" && benchmarkNumericArtifact.test(file)) continue;
      pattern.lastIndex = 0;
      for (const match of text.matchAll(pattern)) {
        if (rule === "mac-address" && match[0].toUpperCase() === "AA:AA:AA:AA:AA:AA") continue;
        if (rule === "private-email" && match[0].toLowerCase() === "github-actions@github.com") continue;
        if (rule === "private-ipv4" && /(?:example|synthetic|sint[eé]tic)/i.test(text.slice(Math.max(0, match.index - 80), match.index))) continue;
        if (rule === "private-hostname" && /(?:example|synthetic|sint[eé]tic)/i.test(text.slice(Math.max(0, match.index - 80), match.index))) continue;
        if (["private-name-field", "private-account-id"].includes(rule) &&
            /(?:\b(?:example|synthetic)|\b(?:resident_(?:primary|secondary)|mobile_(?:primary|secondary)|vehicle_primary|garage_gate|exterior_light|security_panel)\b)/i.test(text.slice(Math.max(0, (match.index ?? 0) - 32), (match.index ?? 0) + 160))) continue;
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

export function scanGitRepository(root, mode = "tracked", options = {}) {
  if (!["tracked", "staged"].includes(mode)) throw new Error("unsupported privacy scan mode");
  const entries = fileList(mode, root).map((file) => ({ file, buffer: contentFor(file, mode, root) }));
  return { entries, findings: scanEntries(entries, options) };
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
  let findings;
  try {
    ({ entries, findings } = scanGitRepository(repoRoot, mode, { denylist: loadDenylist() }));
  } catch {
    console.error("rule=scanner-error file=<repository> line=0 category=tooling");
    process.exit(2);
  }
  for (const item of findings) {
    console.error(`rule=${item.rule} file=${item.file} line=${item.line} category=${item.category}`);
  }
  if (findings.length) process.exit(1);
  console.log(`Privacy check passed (${mode}; ${entries.length} Git file(s)).`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
