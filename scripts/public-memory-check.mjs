#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const defaultRepoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const memoryRoot = ".codex/memories";
const canonicalIndex = `${memoryRoot}/projeto/indice.md`;
const requiredFiles = [
  "AGENTS.md",
  "MEMORY.md",
  canonicalIndex,
  "docs/MEMORIA_VERSIONADA_AGENTES.md",
  "scripts/weekly-docs-review.prompt.md",
  "Makefile",
];
const privateRuntimePrefixes = [
  ".agent-history/",
  ".agents/",
  ".claude/",
  ".local-secrets/",
];
const repoPathPrefixes = [
  ".codex/",
  "docs/",
  "homeassistant/",
  "nodered/",
  "scripts/",
];
const exactRepoPaths = new Set([
  ".gitignore",
  "AGENTS.md",
  "MEMORY.md",
  "Makefile",
]);
const authorityMarkers = [
  "1. código e configuração executável atual;",
  "2. testes e contratos executáveis;",
  "3. documentação operacional atual;",
  "4. decisões arquiteturais vigentes;",
  "5. memória versionada dos agentes.",
];
const privacyPatterns = [
  ["private-ipv4", /\b(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})\b/g],
  ["mac-address", /\b(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}\b/g],
  ["precise-coordinate", /-?\d{1,3}\.\d{6,}/g],
  ["private-key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
  ["provider-token", /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|sk-ant-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{32,})\b/g],
];

function normalizePath(value) {
  return value.split(path.sep).join("/");
}

function lineNumber(content, offset) {
  return content.slice(0, offset).split("\n").length;
}

function isPublicMemoryFile(file) {
  return file.startsWith(`${memoryRoot}/`) && file.endsWith(".md");
}

function isPrivateRuntimeFile(file) {
  return privateRuntimePrefixes.some((prefix) => file.startsWith(prefix))
    || (file.startsWith(".codex/")
      && file !== ".codex/hooks.json"
      && !isPublicMemoryFile(file));
}

function markdownLinks(content) {
  return [...content.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)].map((match) => ({
    raw: match[1].trim().replace(/^<|>$/g, ""),
    offset: match.index ?? 0,
  }));
}

function resolveTrackedReference(repoRoot, source, rawTarget) {
  const pathPart = rawTarget.split("#", 1)[0];
  if (!pathPart || /^[a-z][a-z0-9+.-]*:/i.test(pathPart)) return null;
  let decoded;
  try {
    decoded = decodeURIComponent(pathPart);
  } catch {
    return { error: "invalid URL encoding" };
  }
  const absolute = path.resolve(repoRoot, path.dirname(source), decoded);
  const relative = normalizePath(path.relative(repoRoot, absolute));
  if (relative === ".." || relative.startsWith("../") || path.isAbsolute(relative)) {
    return { error: "reference escapes the repository" };
  }
  return { relative };
}

function linkedTopicFiles(repoRoot, source, content) {
  const topics = new Set();
  for (const { raw } of markdownLinks(content)) {
    const resolved = resolveTrackedReference(repoRoot, source, raw);
    if (resolved?.relative?.startsWith(`${memoryRoot}/`)
      && resolved.relative.endsWith(".md")
      && resolved.relative !== canonicalIndex) {
      topics.add(resolved.relative);
    }
  }
  return topics;
}

function makeTargets(content) {
  const targets = new Set();
  for (const match of content.matchAll(/^([A-Za-z0-9_.-]+(?:\s+[A-Za-z0-9_.-]+)*):(?:\s|$)/gm)) {
    for (const target of match[1].split(/\s+/)) targets.add(target);
  }
  return targets;
}

function referencedCodeSpans(content) {
  return [...content.matchAll(/(?<!`)`([^`\n]+)`(?!`)/g)].map((match) => ({
    value: match[1].trim(),
    offset: match.index ?? 0,
  }));
}

function looksLikeRepoPath(value) {
  return repoPathPrefixes.some((prefix) => value.startsWith(prefix))
    || exactRepoPaths.has(value);
}

function trackedPathExists(candidate, tracked) {
  if (candidate.includes("<") || candidate.includes(">")) return true;
  if (candidate.includes("*")) {
    const prefix = candidate.slice(0, candidate.search(/[?*[]/));
    return [...tracked].some((file) => file.startsWith(prefix));
  }
  return tracked.has(candidate) || [...tracked].some((file) => file.startsWith(`${candidate.replace(/\/$/, "")}/`));
}

function uniqueHeadingErrors(source, content) {
  const errors = [];
  const seen = new Map();
  for (const match of content.matchAll(/^## ([^#].*)$/gm)) {
    const heading = match[1].trim();
    if (seen.has(heading)) {
      errors.push(`${source}:${lineNumber(content, match.index ?? 0)}: duplicate level-two heading: ${heading}`);
    } else {
      seen.set(heading, match.index ?? 0);
    }
  }
  return errors;
}

function gitFiles(repoRoot, args) {
  const result = spawnSync("git", ["ls-files", ...args, "-z"], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(`git ls-files failed: ${result.stderr.trim()}`);
  }
  return result.stdout.split("\0").filter(Boolean).map(normalizePath);
}

export function checkPublicMemory({ repoRoot = defaultRepoRoot, trackedFiles } = {}) {
  const tracked = new Set((trackedFiles ?? gitFiles(repoRoot, ["--cached"])).map(normalizePath));
  const errors = [];

  for (const file of requiredFiles) {
    if (!tracked.has(file)) errors.push(`missing required tracked file: ${file}`);
  }
  for (const file of tracked) {
    if (isPrivateRuntimeFile(file)) {
      errors.push(`${file}: private runtime path must not be tracked`);
    }
  }

  const readable = new Map();
  const readTracked = (file) => {
    if (!tracked.has(file)) return "";
    if (!readable.has(file)) readable.set(file, fs.readFileSync(path.join(repoRoot, file), "utf8"));
    return readable.get(file);
  };

  const memoryFiles = [...tracked].filter(isPublicMemoryFile).sort();
  const topicFiles = memoryFiles.filter((file) => file !== canonicalIndex);
  const memorySources = ["MEMORY.md", ...memoryFiles].filter((file) => tracked.has(file));

  for (const file of memoryFiles) {
    const relative = file.slice(`${memoryRoot}/`.length);
    const parts = relative.split("/");
    const basename = parts.pop().replace(/\.md$/, "");
    if (basename === "memoria") errors.push(`${file}: generic memory filename is forbidden`);
    if (![...parts, basename].every((part) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(part))) {
      errors.push(`${file}: memory directories and filenames must use kebab-case`);
    }
  }

  for (const source of memorySources) {
    const content = readTracked(source);
    for (const { raw, offset } of markdownLinks(content)) {
      const resolved = resolveTrackedReference(repoRoot, source, raw);
      if (!resolved) continue;
      if (resolved.error) {
        errors.push(`${source}:${lineNumber(content, offset)}: ${resolved.error}: ${raw}`);
      } else if (isPrivateRuntimeFile(resolved.relative)) {
        errors.push(`${source}:${lineNumber(content, offset)}: link points to private runtime: ${resolved.relative}`);
      } else if (!tracked.has(resolved.relative)) {
        errors.push(`${source}:${lineNumber(content, offset)}: broken or untracked relative link: ${raw}`);
      }
    }
  }

  const rootTopics = linkedTopicFiles(repoRoot, "MEMORY.md", readTracked("MEMORY.md"));
  const canonicalTopics = linkedTopicFiles(repoRoot, canonicalIndex, readTracked(canonicalIndex));
  for (const topic of topicFiles) {
    if (!rootTopics.has(topic)) errors.push(`${topic}: orphaned from MEMORY.md`);
    if (!canonicalTopics.has(topic)) errors.push(`${topic}: orphaned from ${canonicalIndex}`);
  }
  for (const topic of rootTopics) {
    if (!topicFiles.includes(topic)) errors.push(`MEMORY.md: points to unknown thematic memory: ${topic}`);
  }
  for (const topic of canonicalTopics) {
    if (!topicFiles.includes(topic)) errors.push(`${canonicalIndex}: points to unknown thematic memory: ${topic}`);
  }
  if ([...rootTopics].sort().join("\n") !== [...canonicalTopics].sort().join("\n")) {
    errors.push(`MEMORY.md and ${canonicalIndex} must index the same thematic memories`);
  }

  const makefile = readTracked("Makefile");
  const targets = makeTargets(makefile);
  if (!targets.has("validate-public")) errors.push("Makefile: missing validate-public target");
  if (!makefile.includes("node scripts/public-memory-check.mjs")) {
    errors.push("Makefile: validate-public must execute scripts/public-memory-check.mjs");
  }

  for (const source of memorySources) {
    const content = readTracked(source);
    for (const { value, offset } of referencedCodeSpans(content)) {
      if (value.startsWith("make ")) {
        for (const target of value.slice(5).trim().split(/\s+/)) {
          if (target && !targets.has(target)) {
            errors.push(`${source}:${lineNumber(content, offset)}: unknown make target: ${target}`);
          }
        }
        continue;
      }
      const candidate = value.split(/\s+/, 1)[0].replace(/[),;:]$/, "");
      if (looksLikeRepoPath(candidate) && !trackedPathExists(candidate, tracked)) {
        errors.push(`${source}:${lineNumber(content, offset)}: referenced path is missing or untracked: ${candidate}`);
      }
    }
  }

  for (const source of memorySources) {
    const content = readTracked(source);
    for (const [rule, pattern] of privacyPatterns) {
      pattern.lastIndex = 0;
      for (const match of content.matchAll(pattern)) {
        if (rule === "mac-address" && match[0] === "AA:AA:AA:AA:AA:AA") continue;
        errors.push(`${source}:${lineNumber(content, match.index ?? 0)}: prohibited private-data pattern: ${rule}`);
      }
    }
  }

  const agents = readTracked("AGENTS.md");
  let previousAuthorityOffset = -1;
  for (const marker of authorityMarkers) {
    const offset = agents.indexOf(marker);
    if (offset === -1 || offset <= previousAuthorityOffset) {
      errors.push(`AGENTS.md: missing or unordered memory authority rule: ${marker}`);
      break;
    }
    previousAuthorityOffset = offset;
  }
  if (!agents.includes(".codex/memories/<assunto>/<nome-descritivo>.md")) {
    errors.push(`AGENTS.md: canonical memory location is not declared`);
  }
  if (!readTracked("MEMORY.md").includes(canonicalIndex)) {
    errors.push(`MEMORY.md: canonical index is not declared: ${canonicalIndex}`);
  }

  const weeklyPrompt = readTracked("scripts/weekly-docs-review.prompt.md");
  errors.push(...uniqueHeadingErrors("AGENTS.md", agents));
  errors.push(...uniqueHeadingErrors("scripts/weekly-docs-review.prompt.md", weeklyPrompt));
  if (!weeklyPrompt.includes(".codex/memories/**")) {
    errors.push("scripts/weekly-docs-review.prompt.md: canonical memory glob is missing");
  }
  if (/^memories\/\*\*$/m.test(weeklyPrompt)) {
    errors.push("scripts/weekly-docs-review.prompt.md: obsolete memory glob: memories/**");
  }

  return {
    errors: [...new Set(errors)].sort(),
    stats: {
      memoryFiles: memoryFiles.length,
      thematicMemories: topicFiles.length,
      linksChecked: memorySources.reduce((total, source) => total + markdownLinks(readTracked(source)).length, 0),
    },
  };
}

function main() {
  const result = checkPublicMemory();
  if (result.errors.length > 0) {
    console.error(`Public memory check failed (${result.errors.length} issue(s)):`);
    for (const error of result.errors) console.error(`- ${error}`);
    process.exit(1);
  }
  console.log(
    `Public memory check passed: ${result.stats.memoryFiles} memory files, `
      + `${result.stats.thematicMemories} thematic memories, ${result.stats.linksChecked} links.`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
