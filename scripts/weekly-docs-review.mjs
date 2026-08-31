#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const promptPath = path.join(repoRoot, "scripts", "weekly-docs-review.prompt.md");
const lockPath = path.join(repoRoot, ".git-backup.lock");
const statusPath = process.env.WEEKLY_DOCS_REVIEW_STATUS_PATH || "";
const triggerPath = process.env.WEEKLY_DOCS_REVIEW_TRIGGER_PATH || "";
const maxRuntimeMs = integerEnv("WEEKLY_DOCS_REVIEW_TIMEOUT_MS", 3 * 60 * 60 * 1000, 60_000, 24 * 60 * 60 * 1000);
const schedule = {
  day: integerEnv("WEEKLY_DOCS_REVIEW_DAY_UTC", 1, 0, 6),
  hour: integerEnv("WEEKLY_DOCS_REVIEW_HOUR_UTC", 6, 0, 23),
  minute: integerEnv("WEEKLY_DOCS_REVIEW_MINUTE_UTC", 0, 0, 59),
};
const scheduleOwner = process.env.WEEKLY_DOCS_REVIEW_SCHEDULE_OWNER || "internal";
if (!new Set(["internal", "node-red"]).has(scheduleOwner)) {
  throw new Error("WEEKLY_DOCS_REVIEW_SCHEDULE_OWNER must be internal or node-red");
}

let scheduledTimer;
let heartbeatTimer;
let triggerTimer;
let activeChild;
let reviewInProgress = false;
let status = readStatus();

function log(message) {
  process.stdout.write(`[${new Date().toISOString()}] ${message}\n`);
}

function integerEnv(name, fallback, minimum, maximum) {
  const raw = process.env[name];
  const value = raw === undefined || raw === "" ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function readStatus() {
  if (!statusPath) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(statusPath, "utf8"));
    if (["sigterm", "sigint"].includes(parsed.last_reason)) {
      parsed.last_reason = null;
    }
    return parsed;
  } catch {
    return {};
  }
}

function updateStatus(patch) {
  if (!statusPath) return;
  const nextStatus = {
    schema_version: 1,
    run_count: 0,
    success_count: 0,
    failure_count: 0,
    skipped_count: 0,
    ...status,
    ...patch,
    updated_at: new Date().toISOString(),
  };
  const temporaryPath = `${statusPath}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(statusPath), { recursive: true });
    fs.writeFileSync(temporaryPath, `${JSON.stringify(nextStatus)}\n`, { mode: 0o644 });
    fs.renameSync(temporaryPath, statusPath);
    status = nextStatus;
  } catch (error) {
    log(`cannot update Home Assistant status file: ${error.message}`);
    try {
      fs.rmSync(temporaryPath, { force: true });
    } catch {
      // The next update will retry. Status failures must not stop the scheduler.
    }
  }
}

function preflightReason(error) {
  const message = String(error?.message || "");
  if (message.startsWith("expected branch")) return "unexpected_branch";
  if (message.includes("working tree is not clean")) return "dirty_worktree";
  if (message.startsWith("prompt not found")) return "prompt_missing";
  if (message.startsWith("cannot authenticate")) return "remote_authentication_failed";
  if (message.includes("not synchronized")) return "remote_not_synchronized";
  return "preflight_failed";
}

export function nextWeeklyRun(now, { day, hour, minute }) {
  const candidate = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    hour,
    minute,
    0,
    0,
  ));
  candidate.setUTCDate(candidate.getUTCDate() + ((day - now.getUTCDay() + 7) % 7));
  if (candidate <= now) candidate.setUTCDate(candidate.getUTCDate() + 7);
  return candidate;
}

function gitOutput(args, cwd = repoRoot) {
  const result = spawnSync("git", ["-c", `safe.directory=${repoRoot}`, ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

export function isAllowedReviewPath(file) {
  if (["README.md", "README.pt-BR.md", "MEMORY.md"].includes(file)) return true;
  if (/^\.codex\/memories\/.+\.md$/.test(file)) return true;
  if (/^docs\/.+\.md$/.test(file)) return true;
  return /^docs\/assets\/generated\/.+\.(?:jpe?g|png|svg|webp)$/i.test(file);
}

function changedReviewPaths(worktree) {
  const tracked = gitOutput(["diff", "--name-only", "-z", "HEAD"], worktree)
    .split("\0").filter(Boolean);
  const untracked = gitOutput(["ls-files", "--others", "--exclude-standard", "-z"], worktree)
    .split("\0").filter(Boolean);
  return [...new Set([...tracked, ...untracked])].sort();
}

function runChecked(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit", env: { ...process.env, CI: "1" } });
  if (result.status !== 0) throw new Error(`${command} validation failed`);
}

function preflight() {
  const branch = gitOutput(["branch", "--show-current"]);
  const expectedBranch = process.env.WEEKLY_DOCS_REVIEW_BRANCH || "main";
  if (branch !== expectedBranch) {
    throw new Error(`expected branch ${expectedBranch}, found ${branch || "detached HEAD"}`);
  }
  const status = gitOutput(["status", "--porcelain", "--untracked-files=all"]);
  if (status) {
    throw new Error("working tree is not clean; refusing to mix scheduled and interactive changes");
  }
  if (!fs.existsSync(promptPath)) {
    throw new Error(`prompt not found: ${promptPath}`);
  }
  const remote = process.env.WEEKLY_DOCS_REVIEW_REMOTE || "origin";
  try {
    gitOutput(["fetch", "--quiet", remote, expectedBranch]);
  } catch (error) {
    throw new Error(`cannot authenticate to Git remote ${remote}: ${error.message}`);
  }
  const baseline = gitOutput(["rev-parse", "HEAD"]);
  const remoteHead = gitOutput(["rev-parse", "FETCH_HEAD"]);
  if (baseline !== remoteHead) {
    throw new Error("local branch is not synchronized with the configured remote");
  }
  return { baseline, expectedBranch, remote };
}

function killProcessGroup(child) {
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

function runAgent(prompt, worktree, remote) {
  const args = [
    "-n", lockPath,
    "codex", "exec", "--ephemeral",
    "--model", "gpt-5.6-terra",
    "--config", 'model_reasoning_effort="medium"',
    "--approve-for-me",
    "-C", worktree, "-",
  ];
  return new Promise((resolve) => {
    let timedOut = false;
    let settled = false;
    const child = spawn("flock", args, {
      cwd: worktree,
      detached: true,
      env: {
        ...process.env,
        CI: "1",
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: `remote.${remote}.pushurl`,
        GIT_CONFIG_VALUE_0: "weekly-docs-review-push-disabled",
      },
      stdio: ["pipe", "inherit", "inherit"],
    });
    activeChild = child;
    child.stdin.on("error", (error) => log(`weekly review prompt stream closed early: ${error.message}`));
    child.stdin.end(prompt);
    const timeout = setTimeout(() => {
      timedOut = true;
      log(`weekly review exceeded ${maxRuntimeMs} ms; terminating process group`);
      killProcessGroup(child);
    }, maxRuntimeMs);
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      activeChild = undefined;
      resolve({ ok: false, reason: "process_start_failed", error });
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      activeChild = undefined;
      resolve({ ok: code === 0, reason: timedOut ? "timeout" : "process_failed", code, signal });
    });
  });
}

function failReview(reason, error) {
  log(`weekly review failed (${reason}): ${error?.message || "validation rejected"}`);
  updateStatus({
    state: "failed",
    last_finished: new Date().toISOString(),
    last_result: "failed",
    last_reason: reason,
    failure_count: Number(status.failure_count || 0) + 1,
  });
  return false;
}

export async function runReview() {
  let initial;
  try {
    initial = preflight();
  } catch (error) {
    log(`weekly review skipped: ${error.message}`);
    updateStatus({
      state: "skipped",
      last_finished: new Date().toISOString(),
      last_result: "skipped",
      last_reason: preflightReason(error),
      skipped_count: Number(status.skipped_count || 0) + 1,
    });
    return false;
  }

  let prompt;
  try {
    prompt = fs.readFileSync(promptPath, "utf8");
  } catch (error) {
    return failReview("prompt_unreadable", error);
  }

  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "weekly-docs-review-"));
  const worktree = path.join(temporaryRoot, "worktree");
  let worktreeCreated = false;
  const startedAt = new Date().toISOString();
  log("weekly documentation review started in isolated worktree");
  updateStatus({
    state: "running",
    next_run: null,
    last_started: startedAt,
    last_reason: null,
    last_exit_code: null,
    last_signal: null,
    run_count: Number(status.run_count || 0) + 1,
  });

  try {
    gitOutput(["worktree", "add", "--detach", worktree, initial.baseline]);
    worktreeCreated = true;
    const agent = await runAgent(prompt, worktree, initial.remote);
    if (!agent.ok) return failReview(agent.reason, agent.error);
    if (gitOutput(["rev-parse", "HEAD"], worktree) !== initial.baseline) {
      return failReview("agent_created_commit", new Error("agent changed isolated HEAD"));
    }

    const changed = changedReviewPaths(worktree);
    if (changed.length === 0) {
      log("weekly documentation review completed with no changes");
      updateStatus({
        state: "success", last_finished: new Date().toISOString(), last_result: "no_changes",
        last_reason: null, success_count: Number(status.success_count || 0) + 1,
      });
      return true;
    }
    const rejected = changed.filter((file) => !isAllowedReviewPath(file));
    if (rejected.length) {
      return failReview("unapproved_paths", new Error(`${rejected.length} path(s) outside documentation allowlist`));
    }
    for (const file of changed) {
      const candidate = path.join(worktree, file);
      if (fs.existsSync(candidate) && fs.lstatSync(candidate).isSymbolicLink()) {
        return failReview("symlink_rejected", new Error("documentation symlink is not allowed"));
      }
    }

    gitOutput(["add", "--", ...changed], worktree);
    runChecked("make", ["validate-public"], worktree);
    runChecked("make", ["validate-staged"], worktree);
    gitOutput(["commit", "-m", "docs: weekly public-repository review"], worktree);
    const reviewCommit = gitOutput(["rev-parse", "HEAD"], worktree);

    gitOutput(["fetch", "--quiet", initial.remote, initial.expectedBranch]);
    const remoteHead = gitOutput(["rev-parse", "FETCH_HEAD"]);
    if (remoteHead !== initial.baseline) {
      return failReview("remote_advanced", new Error("remote branch changed during review"));
    }
    if (gitOutput(["branch", "--show-current"]) !== initial.expectedBranch ||
        gitOutput(["rev-parse", "HEAD"]) !== initial.baseline ||
        gitOutput(["status", "--porcelain", "--untracked-files=all"])) {
      return failReview("main_changed_during_review", new Error("main worktree no longer matches baseline"));
    }
    gitOutput(["merge", "--ff-only", reviewCommit]);
    gitOutput(["push", initial.remote, `HEAD:${initial.expectedBranch}`]);
    log("weekly documentation review committed and pushed successfully");
    updateStatus({
      state: "success", last_finished: new Date().toISOString(), last_result: "success",
      last_reason: null, last_commit: reviewCommit.slice(0, 12),
      success_count: Number(status.success_count || 0) + 1,
    });
    return true;
  } catch (error) {
    return failReview("validation_or_delivery_failed", error);
  } finally {
    if (worktreeCreated) {
      spawnSync("git", ["-c", `safe.directory=${repoRoot}`, "worktree", "remove", "--force", worktree], {
        cwd: repoRoot, stdio: "ignore",
      });
    }
    try {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    } catch {
      log("temporary weekly review directory could not be removed");
    }
  }
}

async function runManagedReview(source) {
  if (reviewInProgress) {
    log(`${source} documentation review request ignored: a review is already running`);
    return false;
  }
  reviewInProgress = true;
  try {
    log(`${source} documentation review requested`);
    return await runReview();
  } finally {
    reviewInProgress = false;
  }
}

function waitingStatus() {
  const next = nextWeeklyRun(new Date(), schedule);
  return {
    state: "waiting",
    next_run: next.toISOString(),
    schedule_utc: `day=${schedule.day} ${String(schedule.hour).padStart(2, "0")}:${String(schedule.minute).padStart(2, "0")}`,
  };
}

function scheduleNext() {
  const next = nextWeeklyRun(new Date(), schedule);
  const delay = next.getTime() - Date.now();
  log(`next weekly documentation review: ${next.toISOString()}`);
  updateStatus(waitingStatus());
  scheduledTimer = setTimeout(async () => {
    try {
      await runManagedReview("scheduled");
    } catch (error) {
      log(`weekly review failed unexpectedly: ${error.message}`);
      updateStatus({
        state: "failed",
        last_finished: new Date().toISOString(),
        last_result: "failed",
        last_reason: "unexpected_error",
        failure_count: Number(status.failure_count || 0) + 1,
      });
    } finally {
      scheduleNext();
    }
  }, delay);
}

function startNodeRedManagedSchedule() {
  const next = nextWeeklyRun(new Date(), schedule);
  log(`weekly documentation schedule managed by Node-RED; next expected request: ${next.toISOString()}`);
  updateStatus(waitingStatus());
}

function startManualTriggerWatcher() {
  if (!triggerPath) return;
  triggerTimer = setInterval(async () => {
    if (!fs.existsSync(triggerPath)) return;
    let source = "manual";
    try {
      const requestedSource = fs.readFileSync(triggerPath, "utf8").trim();
      if (requestedSource === "manual" || requestedSource === "scheduled") source = requestedSource;
      fs.rmSync(triggerPath);
    } catch (error) {
      log(`cannot consume documentation review trigger: ${error.message}`);
      return;
    }
    if (reviewInProgress) {
      log(`${source} documentation review request coalesced: a review is already running`);
      return;
    }
    try {
      await runManagedReview(source);
    } catch (error) {
      log(`${source} review failed unexpectedly: ${error.message}`);
      updateStatus({
        state: "failed",
        last_finished: new Date().toISOString(),
        last_result: "failed",
        last_reason: "unexpected_error",
        failure_count: Number(status.failure_count || 0) + 1,
      });
    } finally {
      updateStatus(waitingStatus());
    }
  }, 2_000);
}

function startHeartbeat() {
  heartbeatTimer = setInterval(() => {
    if (scheduleOwner === "node-red" && !reviewInProgress) updateStatus(waitingStatus());
    else updateStatus({});
  }, 60_000);
}

function selfTest() {
  assert.equal(
    nextWeeklyRun(new Date("2026-08-10T05:59:00Z"), schedule).toISOString(),
    "2026-08-10T06:00:00.000Z",
  );
  assert.equal(
    nextWeeklyRun(new Date("2026-08-10T06:00:00Z"), schedule).toISOString(),
    "2026-08-17T06:00:00.000Z",
  );
  assert.equal(
    nextWeeklyRun(new Date("2026-08-12T12:00:00Z"), schedule).toISOString(),
    "2026-08-17T06:00:00.000Z",
  );
  assert.ok(fs.readFileSync(promptPath, "utf8").includes("Português do Brasil"));
  assert.equal(isAllowedReviewPath("README.md"), true);
  assert.equal(isAllowedReviewPath("README.pt-BR.md"), true);
  assert.equal(isAllowedReviewPath("docs/PRIVACY_MODEL.md"), true);
  assert.equal(isAllowedReviewPath("docs/assets/generated/diagram.svg"), true);
  assert.equal(isAllowedReviewPath("nodered/flows.json"), false);
  assert.equal(isAllowedReviewPath("scripts/security-scan.sh"), false);
  assert.equal(isAllowedReviewPath(".github/workflows/public-validation.yml"), false);
  console.log("weekly documentation scheduler self-test passed");
}

function shutdown(signal) {
  log(`received ${signal}; stopping scheduler`);
  updateStatus({ state: "stopped", next_run: null });
  if (scheduledTimer) clearTimeout(scheduledTimer);
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  if (triggerTimer) clearInterval(triggerTimer);
  if (activeChild) killProcessGroup(activeChild);
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

if (process.argv.includes("--self-test")) {
  selfTest();
} else if (process.argv.includes("--print-next")) {
  console.log(nextWeeklyRun(new Date(), schedule).toISOString());
} else if (process.argv.includes("--check")) {
  try {
    preflight();
    console.log("weekly documentation scheduler preflight passed");
  } catch (error) {
    console.error(`weekly documentation scheduler preflight failed: ${error.message}`);
    process.exitCode = 1;
  }
} else if (process.argv.includes("--run-now")) {
  process.exitCode = (await runReview()) ? 0 : 1;
} else {
  if (scheduleOwner === "node-red") startNodeRedManagedSchedule();
  else scheduleNext();
  startHeartbeat();
  startManualTriggerWatcher();
}
