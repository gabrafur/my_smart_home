#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const mergeStateDir = process.env.KIA_UVO_MERGE_STATE_DIR ||
  path.join(repoRoot, ".local-state/kia-uvo-merge");
const workerStatusPath = process.env.KIA_UVO_MERGE_STATUS_PATH ||
  path.join(mergeStateDir, "status.json");
const promotionStatusPath = process.env.KIA_UVO_PROMOTION_STATUS_PATH ||
  path.join(mergeStateDir, "promotion-status.json");
const safeUpdater = process.env.KIA_UVO_SAFE_UPDATER ||
  path.join(scriptDir, "kia-uvo-safe-update.mjs");
const allowedPrefixes = ["homeassistant/custom_components/kia_uvo/"];
const allowedExact = new Set(["scripts/kia-uvo-upstream.json"]);

function log(message) {
  process.stdout.write(`[${new Date().toISOString()}] ${message}\n`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    encoding: Object.hasOwn(options, "encoding") ? options.encoding : "utf8",
    input: options.input,
    maxBuffer: 64 * 1024 * 1024,
    stdio: options.inherit ? "inherit" : [options.input ? "pipe" : "ignore", "pipe", "pipe"],
    env: { ...process.env, ...(options.env ?? {}) },
  });
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "").trim();
    throw new Error(`${command} ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`);
  }
  return typeof result.stdout === "string" ? result.stdout.trim() : result.stdout;
}

function git(args, options = {}) {
  return run("git", args, options);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeStatus(patch) {
  let previous = {};
  try { previous = readJson(promotionStatusPath); } catch { /* first run */ }
  const next = {
    schema_version: 1,
    ...previous,
    ...patch,
    updated_at: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(promotionStatusPath), { recursive: true });
  const temporary = `${promotionStatusPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, promotionStatusPath);
  return next;
}

export function normalizeCandidateStatus(status) {
  const target = String(status?.target ?? "").trim();
  const branch = String(status?.branch ?? "").trim();
  const commit = String(status?.commit ?? "").trim();
  if (status?.state !== "success" || status?.pushed !== true) return null;
  if (!/^v\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.]+)?$/.test(target)) {
    throw new Error("invalid candidate target");
  }
  if (!/^codex\/kia-uvo-[a-z0-9.+-]+-\d{8}t\d{6}z$/.test(branch)) {
    throw new Error("invalid candidate branch");
  }
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error("invalid candidate commit");
  return { target, branch, commit };
}

export function isAllowedCandidatePath(file) {
  return allowedExact.has(file) || allowedPrefixes.some((prefix) => file.startsWith(prefix));
}

function readHaToken() {
  const tokenFile = process.env.KIA_UVO_HA_TOKEN_FILE ||
    path.join(repoRoot, ".local-secrets/ha-long-lived-token.txt");
  if (fs.existsSync(tokenFile)) {
    const token = fs.readFileSync(tokenFile, "utf8").trim();
    if (token) return token;
  }
  if (process.env.HA_LONG_LIVED_TOKEN?.trim()) return process.env.HA_LONG_LIVED_TOKEN.trim();
  throw new Error("Home Assistant token is unavailable");
}

function changedPaths(commit) {
  return git(["diff-tree", "--no-commit-id", "--name-only", "-r", commit])
    .split("\n").filter(Boolean).sort();
}

function workingTreePaths() {
  const tracked = git(["diff", "--name-only"]).split("\n").filter(Boolean);
  const untracked = git(["ls-files", "--others", "--exclude-standard"]).split("\n").filter(Boolean);
  return [...new Set([...tracked, ...untracked])].sort();
}

function samePaths(left, right) {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function fetchAndValidate(candidate) {
  git([
    "fetch",
    "--no-tags",
    "origin",
    "+refs/heads/main:refs/remotes/origin/main",
    `+refs/heads/${candidate.branch}:refs/remotes/origin/${candidate.branch}`,
  ]);
  const fetched = git(["rev-parse", `refs/remotes/origin/${candidate.branch}`]);
  if (fetched !== candidate.commit) throw new Error("candidate branch no longer matches worker commit");
  const remoteMain = git(["rev-parse", "refs/remotes/origin/main"]);
  const currentHead = git(["rev-parse", "HEAD"]);
  if (git(["branch", "--show-current"]) !== "main") throw new Error("active checkout is not on main");
  const ancestor = spawnSync("git", ["merge-base", "--is-ancestor", remoteMain, currentHead], { cwd: repoRoot });
  if (ancestor.status !== 0) throw new Error("local main does not contain origin/main");
  const parent = git(["rev-parse", `${candidate.commit}^`]);
  const basedOnCurrent = spawnSync("git", ["merge-base", "--is-ancestor", parent, currentHead], { cwd: repoRoot });
  if (basedOnCurrent.status !== 0) throw new Error("candidate is stale relative to main");
  const paths = changedPaths(candidate.commit);
  if (!paths.length || paths.some((file) => !isAllowedCandidatePath(file))) {
    throw new Error(`candidate paths rejected: ${paths.join(", ") || "none"}`);
  }
  const newerProtectedChanges = git([
    "diff",
    "--name-only",
    `${parent}..HEAD`,
    "--",
    "homeassistant/custom_components/kia_uvo",
    "scripts/kia-uvo-upstream.json",
  ]).split("\n").filter(Boolean);
  if (newerProtectedChanges.length) {
    throw new Error(`candidate is stale for protected paths: ${newerProtectedChanges.join(", ")}`);
  }
  const subject = git(["show", "-s", "--format=%s", candidate.commit]);
  if (subject !== `fix(kia-uvo): merge upstream ${candidate.target}`) {
    throw new Error("candidate commit subject does not match target");
  }
  const metadataText = git(["show", `${candidate.commit}:scripts/kia-uvo-upstream.json`]);
  const metadata = JSON.parse(metadataText);
  if (metadata.base_version !== candidate.target || !/^[0-9a-f]{40}$/.test(metadata.base_commit)) {
    throw new Error("candidate metadata does not match target");
  }
  const refs = git([
    "ls-remote",
    "https://github.com/Hyundai-Kia-Connect/kia_uvo.git",
    `refs/tags/${candidate.target}`,
    `refs/tags/${candidate.target}^{}`,
  ]).split("\n").filter(Boolean);
  const official = refs.find((line) => line.endsWith("^{}"))?.split(/\s+/)[0] ||
    refs[0]?.split(/\s+/)[0];
  if (!official || official !== metadata.base_commit) {
    throw new Error("candidate metadata is not bound to the official upstream tag");
  }
  return paths;
}

function extractCandidate(candidate, destination) {
  const archive = run("git", [
    "archive",
    candidate.commit,
    "homeassistant/custom_components/kia_uvo",
    "scripts/kia-uvo-upstream.json",
  ], { encoding: null });
  run("tar", ["-x", "-C", destination], { input: archive });
}

function assertCandidateContent(candidate, paths) {
  for (const file of paths) {
    const expected = run("git", ["show", `${candidate.commit}:${file}`], { encoding: null });
    const actualPath = path.join(repoRoot, file);
    if (!fs.existsSync(actualPath) ||
        !Buffer.from(expected).equals(fs.readFileSync(actualPath))) {
      throw new Error(`runtime result differs from candidate content: ${file}`);
    }
  }
}

function commitAndPush(candidate, expectedPaths) {
  const actualPaths = workingTreePaths();
  if (actualPaths.length && !samePaths(actualPaths, expectedPaths)) {
    throw new Error(`runtime result differs from candidate paths: ${actualPaths.join(", ") || "none"}`);
  }
  if (actualPaths.length) {
    assertCandidateContent(candidate, actualPaths);
    git(["add", "--", ...actualPaths]);
    const subject = `fix(kia-uvo): merge upstream ${candidate.target}`;
    run("node", ["scripts/commit-message-check.mjs", "--subject", subject]);
    git(["commit", "-m", subject], { inherit: true });
  } else {
    const subject = git(["show", "-s", "--format=%s", "HEAD"]);
    const headPaths = changedPaths("HEAD");
    if (subject !== `fix(kia-uvo): merge upstream ${candidate.target}` ||
        !samePaths(headPaths, expectedPaths)) {
      throw new Error("runtime is applied but the promotion commit is unavailable");
    }
  }
  git(["push", "origin", "HEAD:main"], { inherit: true });
  return git(["rev-parse", "HEAD"]);
}

export async function promote({ checkOnly = false } = {}) {
  if (!fs.existsSync(workerStatusPath)) return false;
  const candidate = normalizeCandidateStatus(readJson(workerStatusPath));
  if (!candidate) return false;
  let promotion = {};
  try { promotion = readJson(promotionStatusPath); } catch { /* first run */ }
  if (promotion.source_commit === candidate.commit &&
      ["completed", "failed"].includes(promotion.state)) return false;
  const resumeGit = promotion.source_commit === candidate.commit &&
    ["runtime_applied", "applied_pending_git"].includes(promotion.state);
  let expectedPaths;
  let candidateRoot;
  try {
    if (!checkOnly && !resumeGit && workingTreePaths().length) {
      writeStatus({ state: "deferred", source_commit: candidate.commit, target: candidate.target, reason: "working_tree_not_clean" });
      return false;
    }
    expectedPaths = fetchAndValidate(candidate);
    if (checkOnly) {
      const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kia-uvo-promotion-check-"));
      try {
        extractCandidate(candidate, temporaryRoot);
        run("node", [safeUpdater, "check-candidate", "--target", candidate.target, "--candidate-root", temporaryRoot], { inherit: true });
      } finally {
        fs.rmSync(temporaryRoot, { recursive: true, force: true });
      }
      log(`Kia UVO candidate preflight passed target=${candidate.target}`);
      return true;
    }
    if (!resumeGit) {
      const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kia-uvo-promotion-"));
      candidateRoot = temporaryRoot;
      extractCandidate(candidate, candidateRoot);
      writeStatus({ state: "applying", source_commit: candidate.commit, target: candidate.target, branch: candidate.branch, reason: null });
      run("node", [safeUpdater, "apply-candidate", "--target", candidate.target, "--candidate-root", candidateRoot], {
        inherit: true,
        env: { HA_LONG_LIVED_TOKEN: readHaToken() },
      });
      writeStatus({ state: "runtime_applied", source_commit: candidate.commit, target: candidate.target, branch: candidate.branch, reason: null });
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
      candidateRoot = undefined;
    }
    const commit = commitAndPush(candidate, expectedPaths);
    writeStatus({ state: "completed", source_commit: candidate.commit, target: candidate.target, branch: candidate.branch, commit, pushed: true, finished_at: new Date().toISOString(), reason: null });
    log(`Kia UVO candidate promoted target=${candidate.target} commit=${commit.slice(0, 12)}`);
    return true;
  } catch (error) {
    const current = (() => { try { return readJson(promotionStatusPath); } catch { return {}; } })();
    const state = ["runtime_applied", "applied_pending_git"].includes(current.state)
      ? "applied_pending_git"
      : "failed";
    writeStatus({ state, source_commit: candidate.commit, target: candidate.target, reason: String(error.message).slice(0, 800), finished_at: new Date().toISOString() });
    log(`Kia UVO candidate promotion failed target=${candidate.target}: ${error.message}`);
    throw error;
  } finally {
    if (candidateRoot) fs.rmSync(candidateRoot, { recursive: true, force: true });
  }
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  try {
    await promote({ checkOnly: process.argv.includes("--check") });
  } catch {
    process.exitCode = 1;
  }
}
