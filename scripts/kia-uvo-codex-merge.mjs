#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const promptPath = path.join(repoRoot, "scripts", "kia-uvo-codex-merge.prompt.md");
const triggerPath = process.env.KIA_UVO_MERGE_TRIGGER_PATH || "/run/kia-uvo-merge-trigger/requested";
const processingPath = process.env.KIA_UVO_MERGE_PROCESSING_PATH || "/run/kia-uvo-merge-trigger/processing";
const statusPath = process.env.KIA_UVO_MERGE_STATUS_PATH || "/run/kia-uvo-merge/status.json";
const patchPath = process.env.KIA_UVO_MERGE_PATCH_PATH || "/run/kia-uvo-merge/candidate.patch";
const lockPath = process.env.KIA_UVO_MERGE_LOCK_PATH || "/run/kia-uvo-merge/codex-agent.lock";
const maxRuntimeMs = Number(process.env.KIA_UVO_MERGE_TIMEOUT_MS || 3 * 60 * 60 * 1000);
const pushEnabled = process.env.KIA_UVO_MERGE_PUSH !== "false";
const allowedPrefixes = ["homeassistant/custom_components/kia_uvo/"];
const allowedExact = new Set(["scripts/kia-uvo-upstream.json"]);
const requiredMarkers = [
  ["coordinator.py", "BR_CURRENT_APPLICATION_ID"],
  ["coordinator.py", "_install_br_client_compatibility"],
  ["coordinator.py", "async_refresh_day_trip_info"],
  ["coordinator.py", "_async_update_fuel_efficiency"],
  ["coordinator.py", "REMOTE_LOCATE_MIN_INTERVAL_S = 60"],
  ["sensor.py", "RecentTripInfoEntity"],
  ["sensor.py", "RemoteCommandStatusEntity"],
];
let activeChild;
let running = false;
let timer;

function log(message) { process.stdout.write(`[${new Date().toISOString()}] ${message}\n`); }
export function normalizeTarget(value) {
  const target = String(value || "").trim();
  const normalized = target.startsWith("v") ? target : `v${target}`;
  if (!/^v\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.]+)?$/.test(normalized)) throw new Error("invalid target version");
  return normalized;
}
export function isAllowedMergePath(file) {
  return allowedExact.has(file) || allowedPrefixes.some((prefix) => file.startsWith(prefix));
}
function run(command, args, cwd = repoRoot, options = {}) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"], env: { ...process.env, ...(options.env || {}) } });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed: ${(result.stderr || result.stdout || "").trim()}`);
  return (result.stdout || "").trim();
}
function git(args, cwd = repoRoot, options = {}) { return run("git", args, cwd, options); }
function updateStatus(patch) {
  const next = { schema_version: 1, ...patch, updated_at: new Date().toISOString() };
  fs.mkdirSync(path.dirname(statusPath), { recursive: true });
  const temporary = `${statusPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(next) + "\n", { mode: 0o644 });
  fs.renameSync(temporary, statusPath);
}
function readStatus() {
  try { return JSON.parse(fs.readFileSync(statusPath, "utf8")); } catch { return {}; }
}
export function startupStatusPatch(existing) {
  if (["success", "failed"].includes(existing?.state)) return null;
  if (existing?.state === "running") {
    return { ...existing, state: "failed", reason: "worker_restarted", finished_at: new Date().toISOString() };
  }
  return { state: "waiting" };
}
function changedPaths(worktree) {
  const tracked = git(["diff", "--name-only", "-z", "HEAD"], worktree).split("\0").filter(Boolean);
  const untracked = git(["ls-files", "--others", "--exclude-standard", "-z"], worktree).split("\0").filter(Boolean);
  return [...new Set([...tracked, ...untracked])].sort();
}
function officialCommit(target) {
  const output = git(["ls-remote", "https://github.com/Hyundai-Kia-Connect/kia_uvo.git", `refs/tags/${target}`, `refs/tags/${target}^{}`]);
  const lines = output.split("\n").filter(Boolean);
  if (!lines.length) throw new Error(`upstream tag ${target} was not found`);
  return lines.find((line) => line.endsWith("^{}"))?.split(/\s+/)[0] || lines[0].split(/\s+/)[0];
}
function killChild(child) { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } }
function runAgent(prompt, worktree) {
  const args = ["-n", lockPath, "codex", "exec", "--ephemeral", "--model", "gpt-5.6-terra", "--config", 'model_reasoning_effort="high"', "--approve-for-me", "-C", worktree, "-"];
  return new Promise((resolve) => {
    let settled = false;
    const child = spawn("flock", args, { cwd: worktree, detached: true, env: { ...process.env, CI: "1", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "remote.origin.pushurl", GIT_CONFIG_VALUE_0: "kia-uvo-codex-push-disabled" }, stdio: ["pipe", "inherit", "inherit"] });
    activeChild = child;
    child.stdin.on("error", (error) => log(`prompt stream closed early: ${error.message}`));
    child.stdin.end(prompt);
    const timeout = setTimeout(() => { log("Codex merge timed out; terminating"); killChild(child); }, maxRuntimeMs);
    child.once("error", (error) => { if (!settled) { settled = true; clearTimeout(timeout); activeChild = undefined; resolve({ ok: false, error }); } });
    child.once("close", (code, signal) => { if (!settled) { settled = true; clearTimeout(timeout); activeChild = undefined; resolve({ ok: code === 0, code, signal }); } });
  });
}
function validateCandidate(worktree, target, upstreamCommit) {
  const changed = changedPaths(worktree);
  if (!changed.length) throw new Error("Codex produced no merge changes");
  const rejected = changed.filter((file) => !isAllowedMergePath(file));
  if (rejected.length) throw new Error(`paths outside allowlist: ${rejected.join(", ")}`);
  for (const file of changed) {
    const candidate = path.join(worktree, file);
    if (fs.existsSync(candidate) && fs.lstatSync(candidate).isSymbolicLink()) throw new Error(`symlink rejected: ${file}`);
  }
  const component = path.join(worktree, "homeassistant/custom_components/kia_uvo");
  const manifest = JSON.parse(fs.readFileSync(path.join(component, "manifest.json"), "utf8"));
  if (normalizeTarget(manifest.version) !== target) throw new Error(`manifest version ${manifest.version} does not match ${target}`);
  const metadata = JSON.parse(fs.readFileSync(path.join(worktree, "scripts/kia-uvo-upstream.json"), "utf8"));
  if (normalizeTarget(metadata.base_version) !== target || metadata.base_commit !== upstreamCommit) throw new Error("upstream metadata does not match the official target tag");
  const missing = requiredMarkers.filter(([file, marker]) => !fs.readFileSync(path.join(component, file), "utf8").includes(marker));
  if (missing.length) throw new Error(`required local markers missing: ${missing.map(([file]) => file).join(", ")}`);
  run("python3", ["-m", "compileall", "-q", component]);
  git(["diff", "--check"], worktree);
  return changed;
}
export async function runMerge(rawTarget) {
  const target = normalizeTarget(rawTarget);
  const upstreamCommit = officialCommit(target);
  const remote = git(["remote", "get-url", "origin"]);
  const baseline = git(["rev-parse", "HEAD"]);
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kia-uvo-codex-merge-"));
  const worktree = path.join(temporaryRoot, "repo");
  updateStatus({ state: "running", target, baseline: baseline.slice(0, 12), started_at: new Date().toISOString() });
  try {
    git(["clone", "--no-hardlinks", repoRoot, worktree]);
    git(["remote", "set-url", "origin", remote], worktree);
    const prompt = `${fs.readFileSync(promptPath, "utf8")}\n\n## Alvo desta execução\n\n- versão: \`${target}\`\n- commit oficial da tag: \`${upstreamCommit}\`\n`;
    const agent = await runAgent(prompt, worktree);
    if (!agent.ok) throw new Error(`Codex failed code=${agent.code ?? "start"} signal=${agent.signal ?? "none"}${agent.error ? `: ${agent.error.message}` : ""}`);
    if (git(["rev-parse", "HEAD"], worktree) !== baseline) throw new Error("Codex created a commit despite the worker contract");
    const changed = validateCandidate(worktree, target, upstreamCommit);
    git(["add", "--", ...changed], worktree);
    const subject = `fix(kia-uvo): merge upstream ${target}`;
    run("node", ["scripts/commit-message-check.mjs", "--subject", subject], worktree);
    git(["-c", "user.name=Kia UVO merge worker", "-c", "user.email=kia-uvo-merge@localhost", "commit", "-m", subject], worktree);
    const commit = git(["rev-parse", "HEAD"], worktree);
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "z").toLowerCase();
    const branch = `codex/kia-uvo-${target.slice(1).toLowerCase()}-${stamp}`;
    const patch = git(["format-patch", "--stdout", `${baseline}..${commit}`], worktree);
    fs.writeFileSync(patchPath, patch + "\n", { mode: 0o640 });
    if (pushEnabled) git(["push", "origin", `HEAD:refs/heads/${branch}`], worktree, { inherit: true });
    updateStatus({ state: "success", target, upstream_commit: upstreamCommit, commit, branch: pushEnabled ? branch : null, pushed: pushEnabled, patch_path: patchPath, finished_at: new Date().toISOString() });
    log(`Kia UVO merge candidate ready target=${target} commit=${commit.slice(0, 12)} pushed=${pushEnabled} branch=${branch}`);
    return true;
  } catch (error) {
    updateStatus({ state: "failed", target, reason: String(error.message).slice(0, 800), finished_at: new Date().toISOString() });
    log(`Kia UVO merge failed target=${target}: ${error.message}`);
    return false;
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}
async function consume() {
  if (running || !fs.existsSync(triggerPath)) return;
  running = true;
  try {
    fs.renameSync(triggerPath, processingPath);
    const target = fs.readFileSync(processingPath, "utf8").trim();
    await runMerge(target);
  } catch (error) {
    updateStatus({ state: "failed", reason: String(error.message).slice(0, 800), finished_at: new Date().toISOString() });
    log(`cannot consume Kia UVO merge request: ${error.message}`);
  } finally {
    fs.rmSync(processingPath, { force: true });
    running = false;
  }
}
function selfTest() {
  assert.equal(normalizeTarget("3.11.0"), "v3.11.0");
  assert.equal(isAllowedMergePath("homeassistant/custom_components/kia_uvo/manifest.json"), true);
  assert.equal(isAllowedMergePath("scripts/kia-uvo-upstream.json"), true);
  assert.equal(isAllowedMergePath("docker-compose.yml"), false);
  assert.throws(() => normalizeTarget("main"));
  console.log("Kia UVO Codex merge worker self-test passed");
}
function shutdown() { if (timer) clearInterval(timer); if (activeChild) killChild(activeChild); process.exit(0); }
const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  if (process.argv.includes("--self-test")) selfTest();
  else if (process.argv.includes("--run-now")) process.exitCode = (await runMerge(process.argv.at(-1))) ? 0 : 1;
  else {
    const initialPatch = startupStatusPatch(readStatus());
    if (initialPatch) updateStatus(initialPatch);
    timer = setInterval(consume, 2_000);
    await consume();
  }
}
