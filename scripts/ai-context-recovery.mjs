#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requiredContext = ["AGENTS.md", "MEMORY.md", ".codex/memories/projeto/indice.md"];

function fail(message) {
  throw new Error(message);
}

function git(root, args) {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    fail("Git context verification failed");
  }
}

export function memoryLinks(markdown) {
  return [...markdown.matchAll(/\((\.codex\/memories\/[^)#]+\.md)(?:#[^)]+)?\)/g)].map((match) => match[1]);
}

function tracked(root, file) {
  try {
    execFileSync("git", ["ls-files", "--error-unmatch", "--", file], { cwd: root, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function readContext(root, file, mode, commit, { trackedFiles = null, commitFiles = null } = {}) {
  if (mode === "commit") {
    if (commitFiles) {
      if (!commitFiles.has(file)) fail(`public context file is missing from commit: ${file}`);
      return commitFiles.get(file);
    }
    return git(root, ["show", `${commit}:${file}`]);
  }
  if (trackedFiles ? !trackedFiles.has(file) : !tracked(root, file)) fail(`public context file is not tracked: ${file}`);
  const resolved = path.join(root, ...file.split("/"));
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) fail(`public context file is missing: ${file}`);
  return fs.readFileSync(resolved, "utf8");
}

export function verifyAgentContext(root = repoRoot, { commit = null, mode = "worktree", topics = ["restore"], trackedFiles = null, commitFiles = null } = {}) {
  if (!new Set(["worktree", "commit"]).has(mode)) fail("invalid context recovery mode");
  if (!Array.isArray(topics) || !topics.length || topics.some((topic) => !/^[a-z0-9][a-z0-9-]*$/.test(topic))) fail("invalid public memory topic selection");
  let resolvedCommit = commit;
  if (mode === "commit") {
    resolvedCommit = commitFiles ? (commit ?? "synthetic") : (commit ?? "HEAD");
    if (!commitFiles) {
      git(root, ["cat-file", "-e", `${resolvedCommit}^{commit}`]);
      resolvedCommit = git(root, ["rev-parse", `${resolvedCommit}^{commit}`]);
    }
  } else {
    resolvedCommit = trackedFiles ? (commit ?? "synthetic-worktree") : git(root, ["rev-parse", "HEAD"]);
  }
  const adapters = { trackedFiles, commitFiles };
  const contents = new Map(requiredContext.map((file) => [file, readContext(root, file, mode, resolvedCommit, adapters)]));
  const indexedLinks = [...new Set(memoryLinks(contents.get("MEMORY.md")))];
  if (!indexedLinks.length) fail("MEMORY.md does not reference thematic public memory");
  const links = indexedLinks.filter((file) => topics.some((topic) => file.includes(`/${topic}/`) || path.basename(file, ".md").includes(topic)));
  if (!links.length) fail("selected public memory topic is not indexed");
  for (const file of links) readContext(root, file, mode, resolvedCommit, adapters);
  const canonicalIndex = contents.get(".codex/memories/projeto/indice.md");
  for (const file of links) {
    const basename = path.basename(file);
    if (!canonicalIndex.includes(basename)) fail(`canonical memory index does not reference ${basename}`);
  }
  return {
    operation: "ai-context-recovery-check",
    mode,
    sequence: [
      { step: "infrastructure_restored", status: "operator-prerequisite" },
      { step: "configuration_validated", status: "operator-prerequisite" },
      { step: "repository_commit_identified", status: "verified" },
      { step: "agents_loaded", status: "verified" },
      { step: "memory_index_loaded", status: "verified" },
      { step: "relevant_thematic_memory_loaded", status: "verified" },
      { step: "memory_verified_against_commit", status: "verified" },
      { step: "agent_context_ready", status: "verified" }
    ],
    repository_commit: resolvedCommit,
    memory_topics: topics,
    thematic_memories: links.length,
    private_runtime_read: false,
    knowledge_not_versioned: "report when required knowledge exists only in private runtime; do not copy it",
    agent_context_ready: true,
  };
}

function parseArgs(argv) {
  let mode = "worktree";
  let commit = null;
  let topics = ["restore"];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--worktree") mode = "worktree";
    else if (argv[index] === "--commit" && argv[index + 1]) {
      mode = "commit";
      commit = argv[index + 1];
      index += 1;
    } else if (argv[index] === "--topics" && argv[index + 1]) {
      topics = argv[index + 1].split(",").filter(Boolean);
      index += 1;
    } else fail("usage: ai-context-recovery.mjs [--worktree | --commit <revision>] [--topics <topic,...>]");
  }
  return { mode, commit, topics };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify(verifyAgentContext(repoRoot, parseArgs(process.argv.slice(2))), null, 2));
  } catch (error) {
    console.error(`ai-context-recovery: ${error.message}`);
    process.exit(1);
  }
}
