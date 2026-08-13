#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const promptPath = path.join(repoRoot, "scripts", "weekly-docs-review.prompt.md");
const lockPath = path.join(repoRoot, ".git-backup.lock");
const statusPath = process.env.WEEKLY_DOCS_REVIEW_STATUS_PATH || "";
const maxRuntimeMs = integerEnv("WEEKLY_DOCS_REVIEW_TIMEOUT_MS", 3 * 60 * 60 * 1000, 60_000, 24 * 60 * 60 * 1000);
const schedule = {
  day: integerEnv("WEEKLY_DOCS_REVIEW_DAY_UTC", 1, 0, 6),
  hour: integerEnv("WEEKLY_DOCS_REVIEW_HOUR_UTC", 6, 0, 23),
  minute: integerEnv("WEEKLY_DOCS_REVIEW_MINUTE_UTC", 0, 0, 59),
};

let scheduledTimer;
let heartbeatTimer;
let activeChild;
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

function gitOutput(args) {
  const result = spawnSync("git", ["-c", `safe.directory=${repoRoot}`, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
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
  const remoteCheck = spawnSync("git", [
    "-c",
    `safe.directory=${repoRoot}`,
    "ls-remote",
    "--exit-code",
    remote,
    "HEAD",
  ], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "ignore", "pipe"],
  });
  if (remoteCheck.status !== 0) {
    throw new Error(`cannot authenticate to Git remote ${remote}: ${remoteCheck.stderr.trim()}`);
  }
}

function killProcessGroup(child) {
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

export async function runReview() {
  try {
    preflight();
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
    log(`weekly review skipped: cannot read prompt: ${error.message}`);
    updateStatus({
      state: "skipped",
      last_finished: new Date().toISOString(),
      last_result: "skipped",
      last_reason: "prompt_unreadable",
      skipped_count: Number(status.skipped_count || 0) + 1,
    });
    return false;
  }
  const args = [
    "-n",
    lockPath,
    "codex",
    "exec",
    "--ephemeral",
    "--approve-for-me",
    "--sandbox",
    "workspace-write",
    "-C",
    repoRoot,
    "-",
  ];

  const startedAt = new Date().toISOString();
  log("weekly documentation review started");
  updateStatus({
    state: "running",
    next_run: null,
    last_started: startedAt,
    last_reason: null,
    last_exit_code: null,
    last_signal: null,
    run_count: Number(status.run_count || 0) + 1,
  });
  return new Promise((resolve) => {
    let timedOut = false;
    let settled = false;
    const child = spawn("flock", args, {
      cwd: repoRoot,
      detached: true,
      env: { ...process.env, CI: "1" },
      stdio: ["pipe", "inherit", "inherit"],
    });
    activeChild = child;
    child.stdin.on("error", (error) => {
      log(`weekly review prompt stream closed early: ${error.message}`);
    });
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
      log(`weekly review failed to start: ${error.message}`);
      updateStatus({
        state: "failed",
        last_finished: new Date().toISOString(),
        last_result: "failed",
        last_reason: "process_start_failed",
        failure_count: Number(status.failure_count || 0) + 1,
      });
      resolve(false);
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      activeChild = undefined;
      if (code === 0) {
        log("weekly documentation review finished successfully");
        let lastCommit = null;
        try {
          lastCommit = gitOutput(["rev-parse", "--short=12", "HEAD"]);
        } catch {
          // The successful result remains valid even if metadata collection fails.
        }
        updateStatus({
          state: "success",
          last_finished: new Date().toISOString(),
          last_result: "success",
          last_reason: null,
          last_exit_code: 0,
          last_signal: null,
          last_commit: lastCommit,
          success_count: Number(status.success_count || 0) + 1,
        });
        resolve(true);
      } else {
        log(`weekly review failed: exit=${code ?? "null"} signal=${signal ?? "none"}`);
        updateStatus({
          state: "failed",
          last_finished: new Date().toISOString(),
          last_result: "failed",
          last_reason: timedOut ? "timeout" : "process_failed",
          last_exit_code: code,
          last_signal: signal,
          failure_count: Number(status.failure_count || 0) + 1,
        });
        resolve(false);
      }
    });
  });
}

function scheduleNext() {
  const next = nextWeeklyRun(new Date(), schedule);
  const delay = next.getTime() - Date.now();
  log(`next weekly documentation review: ${next.toISOString()}`);
  updateStatus({
    state: "waiting",
    next_run: next.toISOString(),
    schedule_utc: `day=${schedule.day} ${String(schedule.hour).padStart(2, "0")}:${String(schedule.minute).padStart(2, "0")}`,
  });
  scheduledTimer = setTimeout(async () => {
    try {
      await runReview();
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

function startHeartbeat() {
  heartbeatTimer = setInterval(() => updateStatus({}), 60_000);
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
  console.log("weekly documentation scheduler self-test passed");
}

function shutdown(signal) {
  log(`received ${signal}; stopping scheduler`);
  updateStatus({ state: "stopped", next_run: null });
  if (scheduledTimer) clearTimeout(scheduledTimer);
  if (heartbeatTimer) clearInterval(heartbeatTimer);
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
  scheduleNext();
  startHeartbeat();
}
