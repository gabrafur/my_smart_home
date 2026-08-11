#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const promptPath = path.join(repoRoot, "scripts", "weekly-docs-review.prompt.md");
const lockPath = path.join(repoRoot, ".git-backup.lock");
const maxRuntimeMs = integerEnv("WEEKLY_DOCS_REVIEW_TIMEOUT_MS", 3 * 60 * 60 * 1000, 60_000, 24 * 60 * 60 * 1000);
const schedule = {
  day: integerEnv("WEEKLY_DOCS_REVIEW_DAY_UTC", 1, 0, 6),
  hour: integerEnv("WEEKLY_DOCS_REVIEW_HOUR_UTC", 6, 0, 23),
  minute: integerEnv("WEEKLY_DOCS_REVIEW_MINUTE_UTC", 0, 0, 59),
};

let scheduledTimer;
let activeChild;

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
    return false;
  }

  let prompt;
  try {
    prompt = fs.readFileSync(promptPath, "utf8");
  } catch (error) {
    log(`weekly review skipped: cannot read prompt: ${error.message}`);
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

  log("weekly documentation review started");
  return new Promise((resolve) => {
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
      log(`weekly review exceeded ${maxRuntimeMs} ms; terminating process group`);
      killProcessGroup(child);
    }, maxRuntimeMs);

    child.once("error", (error) => {
      clearTimeout(timeout);
      activeChild = undefined;
      log(`weekly review failed to start: ${error.message}`);
      resolve(false);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      activeChild = undefined;
      if (code === 0) {
        log("weekly documentation review finished successfully");
        resolve(true);
      } else {
        log(`weekly review failed: exit=${code ?? "null"} signal=${signal ?? "none"}`);
        resolve(false);
      }
    });
  });
}

function scheduleNext() {
  const next = nextWeeklyRun(new Date(), schedule);
  const delay = next.getTime() - Date.now();
  log(`next weekly documentation review: ${next.toISOString()}`);
  scheduledTimer = setTimeout(async () => {
    try {
      await runReview();
    } catch (error) {
      log(`weekly review failed unexpectedly: ${error.message}`);
    } finally {
      scheduleNext();
    }
  }, delay);
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
  if (scheduledTimer) clearTimeout(scheduledTimer);
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
}
