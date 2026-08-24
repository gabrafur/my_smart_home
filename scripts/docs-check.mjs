#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const defaultRepoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const i18nManifest = "docs/i18n-manifest.json";
const markdownExtensions = new Set([".md", ".markdown"]);
const assetExtensions = new Set([".gif", ".jpeg", ".jpg", ".png", ".svg", ".webp"]);
const repoPrefixes = [
  ".agents/", ".codex/memories/", ".github/", "bindings/", "bootstrap/",
  "demo/", "docs/", "homeassistant/", "ia-bridge/", "modules/", "nodered/",
  "prompts/", "restore/", "scripts/", "templates/", "validation/",
];
const exactRepoPaths = new Set([
  ".env.example", ".gitignore", "AGENTS.md", "MEMORY.md", "Makefile",
  "compose.modules.yml", "docker-compose.yml", "README.md", "README.pt-BR.md",
]);
const privateDocumentedPrefixes = [
  ".agent-history/", ".local-secrets/", "bindings/private/", "homeassistant/.storage/",
  "homeassistant/.git-backup-trigger/", "homeassistant/secrets.yaml", "nodered/flows_cred.json",
];
const rootHumanDocuments = new Set([
  "README.md", "README.pt-BR.md", "CONTRIBUTING.md", "SECURITY.md",
  "CODE_OF_CONDUCT.md", "THIRD_PARTY_NOTICES.md", "THIRD_PARTY_NOTICES.pt-BR.md",
]);
const additionalHumanDocuments = new Set([
  ".github/PULL_REQUEST_TEMPLATE.md",
  "scripts/local-ai/README.md",
  "homeassistant/custom_components/hacs/validate/README.md",
]);

function isHumanDocument(file) {
  return rootHumanDocuments.has(file)
    || additionalHumanDocuments.has(file)
    || (file.startsWith("docs/") && markdownExtensions.has(path.extname(file).toLowerCase()));
}

function isDocumentationGraphFile(file) {
  return /^README(?:\.[^.]+)?\.md$/i.test(file)
    || (file.startsWith("docs/") && markdownExtensions.has(path.extname(file).toLowerCase()));
}

function normalizePath(value) {
  return value.split(path.sep).join("/");
}

function gitFiles(root) {
  const result = spawnSync("git", ["ls-files", "--cached", "-z"], { cwd: root, encoding: "buffer" });
  if (result.status !== 0) throw new Error("git ls-files failed");
  return result.stdout.toString("utf8").split("\0").filter(Boolean).map(normalizePath);
}

function markdownLinks(content) {
  return [...content.matchAll(/(!?)\[[^\]]*\]\(([^)]+)\)/g)].map((match) => ({
    image: match[1] === "!", target: match[2].trim().replace(/^<|>$/g, ""), offset: match.index ?? 0,
  }));
}

function lineNumber(content, offset) {
  return content.slice(0, offset).split("\n").length;
}

function githubSlugs(content) {
  const slugs = new Set();
  const counts = new Map();
  for (const match of content.matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)) {
    let slug = match[1]
      .replace(/<[^>]+>/g, "").replace(/!\[[^\]]*\]\([^)]+\)/g, "")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/[`*_~]/g, "")
      .toLocaleLowerCase("en-US").replace(/[^\p{L}\p{N}_ -]/gu, "")
      .trim().replace(/\s+/g, "-");
    const duplicate = counts.get(slug) ?? 0;
    counts.set(slug, duplicate + 1);
    if (duplicate) slug = `${slug}-${duplicate}`;
    slugs.add(slug);
  }
  for (const match of content.matchAll(/<(?:a|[^>]+\s(?:id|name))\s+(?:id|name)=["']([^"']+)["']/gi)) slugs.add(match[1]);
  return slugs;
}

function makeTargets(content) {
  const targets = new Set();
  for (const match of content.matchAll(/^([A-Za-z0-9_.-]+(?:\s+[A-Za-z0-9_.-]+)*):(?:\s|$)/gm)) {
    for (const target of match[1].split(/\s+/)) targets.add(target);
  }
  return targets;
}

function composeServices(content) {
  const servicesStart = content.search(/^services:[ \t]*$/m);
  if (servicesStart < 0) return [];
  const tail = content.slice(servicesStart).replace(/^services:[ \t]*\n/, "");
  const nextTopLevel = tail.search(/^[a-zA-Z][a-zA-Z0-9_-]*:[ \t]*$/m);
  const block = nextTopLevel < 0 ? tail : tail.slice(0, nextTopLevel);
  return [...block.matchAll(/^ {2}([a-zA-Z0-9_-]+):[ \t]*$/gm)].map((match) => match[1]);
}

function resolveTarget(source, rawTarget) {
  const [beforeAnchor, anchor = ""] = rawTarget.split("#", 2);
  const pathPart = beforeAnchor.split("?", 1)[0];
  if (!pathPart && !anchor) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(pathPart) || pathPart.startsWith("//")) return null;
  let decodedPath;
  let decodedAnchor;
  try {
    decodedPath = decodeURIComponent(pathPart);
    decodedAnchor = decodeURIComponent(anchor);
  } catch {
    return { error: "invalid URL encoding" };
  }
  const target = decodedPath ? normalizePath(path.normalize(path.join(path.dirname(source), decodedPath))) : source;
  if (target === ".." || target.startsWith("../") || path.isAbsolute(target)) return { error: "reference escapes repository" };
  return { target, anchor: decodedAnchor };
}

function referencedCodeSpans(content) {
  return [...content.matchAll(/(?<!`)`([^`\n]+)`(?!`)/g)].map((match) => ({ value: match[1].trim(), offset: match.index ?? 0 }));
}

function looksLikeRepoPath(value) {
  return repoPrefixes.some((prefix) => value.startsWith(prefix)) || exactRepoPaths.has(value);
}

function trackedPathExists(candidate, tracked) {
  if (privateDocumentedPrefixes.some((prefix) => candidate === prefix || candidate.startsWith(prefix))) return true;
  if (/[<>*{}]/.test(candidate)) return true;
  const cleaned = candidate.replace(/[),;:]$/, "").replace(/^\.\//, "");
  return tracked.has(cleaned) || [...tracked].some((file) => file.startsWith(`${cleaned.replace(/\/$/, "")}/`));
}

export function checkDocumentation({ repoRoot = defaultRepoRoot, trackedFiles } = {}) {
  const tracked = new Set((trackedFiles ?? gitFiles(repoRoot)).map(normalizePath));
  const markdownFiles = [...tracked].filter(isHumanDocument).sort();
  const graphFiles = markdownFiles.filter(isDocumentationGraphFile);
  const errors = [];
  const contents = new Map();
  const readTracked = (file) => {
    if (!tracked.has(file)) return "";
    if (!contents.has(file)) contents.set(file, fs.readFileSync(path.join(repoRoot, file), "utf8"));
    return contents.get(file);
  };

  if (!tracked.has(i18nManifest)) errors.push(`missing tracked i18n manifest: ${i18nManifest}`);
  let documents = [];
  let pairs = 0;
  if (tracked.has(i18nManifest)) {
    try {
      const manifest = JSON.parse(readTracked(i18nManifest));
      if (manifest.schema_version !== 2 || manifest.primary_language !== "pt-BR"
          || manifest.github_landing_language !== "en"
          || !Array.isArray(manifest.areas) || !Array.isArray(manifest.strategies)
          || !Array.isArray(manifest.documents)) {
        errors.push(`${i18nManifest}: invalid manifest contract`);
      } else {
        documents = manifest.documents;
        const rootReadme = documents.find((document) => document?.id === "root-readme");
        if (rootReadme?.en !== "README.md" || rootReadme?.pt !== "README.pt-BR.md") {
          errors.push(`${i18nManifest}: root-readme must make README.md the English GitHub landing page`);
        }
        const allowedAreas = new Set(manifest.areas);
        const allowedStrategies = new Set(manifest.strategies);
        const classified = new Map();
        const classify = (file) => classified.set(file, (classified.get(file) ?? 0) + 1);

        for (const document of documents) {
          if (!document || typeof document !== "object") {
            errors.push(`${i18nManifest}: each document requires an object`);
            continue;
          }
          if (!allowedAreas.has(document.area)) errors.push(`${i18nManifest}: invalid area: ${document.area}`);
          if (!allowedStrategies.has(document.strategy)) errors.push(`${i18nManifest}: invalid strategy: ${document.strategy}`);

          if (document.strategy === "full pair" && typeof document.pt === "string" && typeof document.en === "string") {
            pairs += 1;
            for (const file of [document.pt, document.en]) {
              classify(file);
              if (!tracked.has(file)) errors.push(`missing required tracked bilingual document: ${file}`);
            }
            if (tracked.has(document.pt) && !readTracked(document.pt).includes(path.basename(document.en))) {
              errors.push(`${document.pt}: missing reference to English pair ${path.basename(document.en)}`);
            }
            if (tracked.has(document.en) && !readTracked(document.en).includes(path.basename(document.pt))) {
              errors.push(`${document.en}: missing reference to Portuguese pair ${path.basename(document.pt)}`);
            }
            continue;
          }

          if (document.strategy === "full pair" && document.format === "bilingual-single-file"
              && typeof document.path === "string" && Array.isArray(document.languages)
              && document.languages.includes("pt-BR") && document.languages.includes("en")) {
            pairs += 1;
            classify(document.path);
            if (!tracked.has(document.path)) errors.push(`missing tracked bilingual document: ${document.path}`);
            continue;
          }

          if (typeof document.path !== "string") {
            errors.push(`${i18nManifest}: ${document.strategy} entry requires a path`);
            continue;
          }
          classify(document.path);
          if (!tracked.has(document.path)) errors.push(`missing tracked i18n document: ${document.path}`);
          if (document.strategy === "summary pair") {
            if (typeof document.summary !== "string" || !tracked.has(document.summary)) {
              errors.push(`${i18nManifest}: summary pair for ${document.path} requires a tracked summary`);
            }
            if (!new Set(["pt-BR", "en"]).has(document.language)) {
              errors.push(`${i18nManifest}: summary pair for ${document.path} requires a language`);
            }
          }
          if (document.strategy === "third-party/not-translated" && typeof document.upstream !== "string") {
            errors.push(`${i18nManifest}: third-party entry for ${document.path} requires upstream`);
          }
        }

        for (const file of markdownFiles) {
          const count = classified.get(file) ?? 0;
          if (count === 0) errors.push(`${file}: human documentation is not classified in ${i18nManifest}`);
          if (count > 1) errors.push(`${file}: human documentation has ${count} i18n classifications`);
        }
        for (const file of classified.keys()) {
          if (!markdownFiles.includes(file)) errors.push(`${i18nManifest}: classified path is outside human documentation scope: ${file}`);
        }
      }
    } catch (error) {
      errors.push(`${i18nManifest}: invalid JSON: ${error.message}`);
    }
  }

  const linksBySource = new Map();
  let linksChecked = 0;
  let imagesChecked = 0;
  for (const file of markdownFiles) {
    const content = readTracked(file);
    const proseContent = content.replace(/```[\s\S]*?```/g, (block) => block.replace(/[^\n]/g, " "));
    const links = markdownLinks(content);
    linksBySource.set(file, links);
    for (const link of links) {
      const resolved = resolveTarget(file, link.target);
      if (!resolved) continue;
      linksChecked += 1;
      if (link.image) imagesChecked += 1;
      if (resolved.error) {
        errors.push(`${file}:${lineNumber(content, link.offset)}: ${resolved.error}: ${link.target}`);
        continue;
      }
      if (!tracked.has(resolved.target)) {
        errors.push(`${file}:${lineNumber(content, link.offset)}: broken or untracked relative link: ${link.target}`);
        continue;
      }
      if (link.image && !assetExtensions.has(path.extname(resolved.target).toLowerCase())) {
        errors.push(`${file}:${lineNumber(content, link.offset)}: image target has unsupported type: ${link.target}`);
      }
      if (resolved.anchor && markdownExtensions.has(path.extname(resolved.target).toLowerCase())) {
        const slugs = githubSlugs(readTracked(resolved.target));
        if (!slugs.has(resolved.anchor.toLocaleLowerCase("en-US"))) {
          errors.push(`${file}:${lineNumber(content, link.offset)}: missing Markdown anchor: ${link.target}`);
        }
      }
    }

    for (const match of proseContent.matchAll(/\b(?:TODO|TBD|FIXME|XXX)\b/g)) {
      errors.push(`${file}:${lineNumber(content, match.index ?? 0)}: unresolved documentation placeholder`);
    }
    for (const match of content.matchAll(/\b(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})\b/g)) {
      errors.push(`${file}:${lineNumber(content, match.index ?? 0)}: private IPv4 literal must be a placeholder`);
    }
    for (const match of content.matchAll(/-?\d{1,3}\.\d{6,}/g)) {
      errors.push(`${file}:${lineNumber(content, match.index ?? 0)}: precise coordinate-like value is not allowed`);
    }
    for (const match of content.matchAll(/\b(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}\b/g)) {
      if (match[0] !== "AA:AA:AA:AA:AA:AA") errors.push(`${file}:${lineNumber(content, match.index ?? 0)}: MAC address must be a placeholder`);
    }
  }

  const roots = ["README.md", "README.pt-BR.md"].filter((file) => tracked.has(file));
  const reachable = new Set(roots);
  const pending = [...roots];
  while (pending.length) {
    const source = pending.shift();
    for (const link of linksBySource.get(source) ?? []) {
      const resolved = resolveTarget(source, link.target);
      if (!resolved?.target || !graphFiles.includes(resolved.target) || reachable.has(resolved.target)) continue;
      reachable.add(resolved.target);
      pending.push(resolved.target);
    }
  }
  for (const file of graphFiles) if (!reachable.has(file)) errors.push(`${file}: orphaned Markdown document (not reachable from README)`);

  const makefile = tracked.has("Makefile") ? readTracked("Makefile") : "";
  const targets = makeTargets(makefile);
  const packages = new Map();
  for (const packageFile of [...tracked].filter((file) => file.endsWith("/package.json") || file === "package.json")) {
    try { packages.set(path.dirname(packageFile), JSON.parse(readTracked(packageFile))); } catch {}
  }
  for (const file of markdownFiles) {
    const content = readTracked(file);
    for (const match of content.matchAll(/^\s*(?:\$\s+)?make\s+([A-Za-z0-9_.-]+)/gm)) {
      if (!targets.has(match[1])) errors.push(`${file}:${lineNumber(content, match.index ?? 0)}: unknown Make target: ${match[1]}`);
    }
    for (const match of content.matchAll(/\bnpm\s+--prefix\s+([^\s`\\]+)\s+run\s+([A-Za-z0-9:_-]+)/g)) {
      const prefix = match[1].replace(/^\.\//, "");
      const packageDocument = packages.get(prefix);
      if (!packageDocument) errors.push(`${file}:${lineNumber(content, match.index ?? 0)}: unknown npm package prefix: ${prefix}`);
      else if (!Object.hasOwn(packageDocument.scripts ?? {}, match[2])) errors.push(`${file}:${lineNumber(content, match.index ?? 0)}: unknown npm script ${prefix}:${match[2]}`);
    }
    for (const { value, offset } of referencedCodeSpans(content)) {
      const candidate = value.split(/\s+/, 1)[0].replace(/^\.\//, "");
      if (value.startsWith("make ")) {
        const target = value.slice(5).trim().split(/\s+/, 1)[0];
        if (target && !targets.has(target)) errors.push(`${file}:${lineNumber(content, offset)}: unknown Make target: ${target}`);
      }
      const pathShaped = candidate.endsWith("/") || path.extname(candidate) || candidate.split("/").length > 2;
      const nearby = content.slice(Math.max(0, offset - 100), offset + value.length + 100);
      const explicitlyRemoved = /\b(?:antig[oa]|removid[oa]|former|removed|obsolete|obsoleto)\b/i.test(nearby);
      if (looksLikeRepoPath(candidate) && pathShaped && !explicitlyRemoved && !trackedPathExists(candidate, tracked)) {
        errors.push(`${file}:${lineNumber(content, offset)}: referenced path is missing or untracked: ${candidate}`);
      }
    }
  }

  if (!tracked.has("docker-compose.yml")) errors.push("missing tracked docker-compose.yml");
  const services = tracked.has("docker-compose.yml") ? composeServices(readTracked("docker-compose.yml")) : [];
  for (const guide of ["docs/CONTAINERS.md", "docs/CONTAINERS.en.md"]) {
    if (!tracked.has(guide)) continue;
    const content = readTracked(guide);
    for (const service of services) if (!content.includes(`\`${service}\``)) errors.push(`${guide}: Compose service is not documented: ${service}`);
  }

  return {
    errors: [...new Set(errors)].sort(),
    stats: { markdownFiles: markdownFiles.length, linksChecked, imagesChecked, pairs, services: services.length },
  };
}

function main() {
  const result = checkDocumentation();
  if (result.errors.length) {
    console.error(`Documentation check failed (${result.errors.length} issue(s)):`);
    for (const error of result.errors) console.error(`- ${error}`);
    process.exit(1);
  }
  console.log(
    `Documentation check passed: ${result.stats.markdownFiles} Markdown files, `
      + `${result.stats.linksChecked} links, ${result.stats.imagesChecked} images, `
      + `${result.stats.pairs} bilingual pairs, ${result.stats.services} Compose services.`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
