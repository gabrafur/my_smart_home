#!/usr/bin/env node
// Proactive maintenance review: bounded, read-mostly inspection of the host,
// repository and operational files. It produces evidence with identity,
// revision, origin, time, age and collection error, turns it into tracked
// recommendations with deduplication and history, runs only catalogued
// automatic actions, and announces changes through one stable private notice
// that the existing event pipeline carries without showing it in the Home
// Assistant frontend. Only items that need a person reach the owner.
//
// It never reads credentials, never restarts services, and never touches
// household devices. The client assistant is not named here on purpose: any
// MCP client or operator can consume the same ledger and CLI.

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.dirname(scriptDir);
export const DEFAULT_POLICY_PATH = path.join(scriptDir, "proactive-maintenance-review.policy.json");
export const DEFAULT_STATE_DIR = path.join(REPO_ROOT, ".local-state", "proactive-maintenance-review");
export const LEDGER_SCHEMA = "proactive_maintenance_ledger_v1";
const PRIORITIES = ["P1", "P2", "P3"];
const OPEN_STATES = new Set(["open", "acknowledged"]);

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const iso = (date) => new Date(date).toISOString();

// ---------------------------------------------------------------- policy --

export function validatePolicy(policy) {
  const fail = (reason) => { throw new Error(`invalid_policy:${reason}`); };
  if (!policy || typeof policy !== "object" || policy.schema_version !== 1) fail("schema_version");
  if (typeof policy.enabled !== "boolean") fail("enabled");
  const positive = (value, name, max) => {
    if (!Number.isFinite(value) || value <= 0 || value > max) fail(name);
  };
  positive(policy.schedule?.interval_hours, "schedule.interval_hours", 168);
  positive(policy.budget?.max_runtime_seconds, "budget.max_runtime_seconds", 300);
  positive(policy.budget?.command_timeout_ms, "budget.command_timeout_ms", 30000);
  positive(policy.budget?.max_source_bytes, "budget.max_source_bytes", 1048576);
  positive(policy.budget?.max_evidence_output_bytes, "budget.max_evidence_output_bytes", 65536);
  for (const [name, value] of Object.entries(policy.thresholds ?? {})) positive(value, `thresholds.${name}`, 1e12);
  positive(policy.dedupe?.remind_after_hours, "dedupe.remind_after_hours", 8760);
  positive(policy.history?.max_runs, "history.max_runs", 5000);
  positive(policy.history?.max_events, "history.max_events", 5000);
  if (!/^[a-z][a-z0-9_]{2,63}$/.test(policy.notification?.notification_id ?? "")) fail("notification.notification_id");
  if (!["private_spool", "home_assistant"].includes(policy.notification.channel)) fail("notification.channel");
  if (policy.notification.channel === "private_spool") {
    // The reserved prefix is what keeps the notice out of Home Assistant.
    if (!/^eva_private_[a-z0-9_]{1,64}$/.test(policy.notification.notification_id)) fail("notification.notification_id");
    if (typeof policy.notification.spool_dir !== "string" || !path.isAbsolute(policy.notification.spool_dir)) fail("notification.spool_dir");
  }
  const escalation = policy.owner_escalation;
  if (!escalation || typeof escalation.enabled !== "boolean") fail("owner_escalation.enabled");
  if (!/^[a-z][a-z0-9_]{2,63}$/.test(escalation.notification_id ?? "") || escalation.notification_id.startsWith("eva_private_") ||
    escalation.notification_id === policy.notification.notification_id) fail("owner_escalation.notification_id");
  if (!Array.isArray(escalation.priorities) || escalation.priorities.some((item) => !PRIORITIES.includes(item))) fail("owner_escalation.priorities");
  positive(escalation.unresolved_after_hours, "owner_escalation.unresolved_after_hours", 8760);
  positive(escalation.max_items, "owner_escalation.max_items", 20);
  const rotate = policy.auto_actions?.catalog?.rotate_worker_log;
  if (rotate) {
    if (!Array.isArray(rotate.paths) || rotate.paths.some((item) =>
      typeof item !== "string" || path.isAbsolute(item) || item.split("/").includes("..") ||
      !/^\.[a-z0-9-]+\.cron\.log$/.test(item))) fail("auto_actions.rotate_worker_log.paths");
    positive(rotate.min_bytes, "rotate.min_bytes", 1e10);
    positive(rotate.keep_bytes, "rotate.keep_bytes", rotate.min_bytes);
  }
  return policy;
}

export function loadPolicy(file = DEFAULT_POLICY_PATH) {
  return validatePolicy(JSON.parse(fs.readFileSync(file, "utf8")));
}

// ------------------------------------------------------------- redaction --

const REDACTIONS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "<private-key>"],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 <redacted>"],
  [/\b([A-Za-z0-9_.-]*(?:password|passwd|secret|token|api[_-]?key|authorization|cookie)[A-Za-z0-9_.-]*)(\s*[=:]\s*)("?)[^\s"',;]{3,}/gi, "$1$2$3<redacted>"],
  [/\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@/g, "<url-credentials>@"],
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "<email>"],
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "<ip>"],
  [/\b(?:[0-9a-f]{2}:){5}[0-9a-f]{2}\b/gi, "<mac>"],
  [/\b[A-Za-z0-9+/_-]{48,}={0,2}/g, "<opaque>"],
];

export function redact(text) {
  let output = String(text ?? "");
  for (const [pattern, replacement] of REDACTIONS) output = output.replace(pattern, replacement);
  return output;
}

// --------------------------------------------------------------- sources --

function boundedTail(file, maxBytes) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error("not_a_regular_file");
    const length = Math.min(stat.size, maxBytes);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, stat.size - length);
    return { text: buffer.toString("utf8"), size: stat.size, mtimeMs: stat.mtimeMs, truncated: stat.size > length };
  } finally {
    fs.closeSync(fd);
  }
}

function runCommand(ctx, command, args) {
  const result = ctx.run(command, args, {
    cwd: ctx.repoRoot, encoding: "utf8", timeout: ctx.policy.budget.command_timeout_ms,
    maxBuffer: ctx.policy.budget.max_source_bytes, windowsHide: true,
  });
  if (result?.error) throw new Error(`command_failed:${result.error.code ?? "error"}`);
  if (result?.status !== 0) throw new Error(`command_exit_${result?.status ?? "unknown"}`);
  return String(result.stdout ?? "");
}

const parseKeyValue = (text) => Object.fromEntries(text.split("\n").map((line) => line.match(/^([a-z_]+)=(.*)$/))
  .filter(Boolean).map((match) => [match[1], match[2]]));

// Every source is registered here. `origin` states where the fact comes from;
// collectors return plain data and never include file contents beyond the
// bounded, redacted excerpts they declare.
export const SOURCES = [
  {
    id: "host.resources",
    origin: "procfs and df on the repository filesystem",
    collect(ctx) {
      const meminfo = Object.fromEntries(fs.readFileSync(ctx.procPath("meminfo"), "utf8").split("\n")
        .map((line) => line.match(/^(\w+):\s+(\d+)/)).filter(Boolean).map((m) => [m[1], Number(m[2])]));
      const load = fs.readFileSync(ctx.procPath("loadavg"), "utf8").trim().split(/\s+/).slice(0, 3).map(Number);
      const df = runCommand(ctx, "df", ["-P", ctx.repoRoot]).trim().split("\n").pop().split(/\s+/);
      return {
        memory_available_kb: meminfo.MemAvailable ?? null,
        memory_total_kb: meminfo.MemTotal ?? null,
        swap_total_kb: meminfo.SwapTotal ?? null,
        load_1m: load[0], load_5m: load[1], load_15m: load[2],
        cpu_count: os.cpus().length,
        disk_used_percent: Number(String(df[4]).replace("%", "")),
        disk_available_kb: Number(df[3]),
        uptime_seconds: Math.round(Number(fs.readFileSync(ctx.procPath("uptime"), "utf8").split(" ")[0])),
      };
    },
  },
  {
    id: "host.failed_units",
    origin: "systemctl --failed",
    collect(ctx) {
      const text = runCommand(ctx, "systemctl", ["--failed", "--no-legend", "--plain", "--no-pager"]);
      const units = text.split("\n").map((line) => line.trim().split(/\s+/)[0]).filter(Boolean);
      // Instance names can embed process and account numbers; group by template.
      const families = {};
      for (const unit of units) {
        const family = unit.replace(/@[^.]*\./, "@.");
        families[family] = (families[family] ?? 0) + 1;
      }
      return { failed_count: units.length, families };
    },
  },
  {
    id: "containers.state",
    origin: "docker ps -a",
    collect(ctx) {
      const text = runCommand(ctx, "docker", ["ps", "-a", "--format", "{{.Names}}|{{.State}}|{{.Status}}"]);
      const containers = text.split("\n").filter(Boolean).map((line) => {
        const [name, state, status] = line.split("|");
        // A one-shot helper that exited with code 0 completed its job.
        const exitCode = Number(String(status ?? "").match(/^Exited \((\d+)\)/)?.[1] ?? NaN);
        return { name, state, unhealthy: /unhealthy/i.test(status ?? ""), restarting: state === "restarting",
          exit_code: Number.isFinite(exitCode) ? exitCode : null };
      });
      return { total: containers.length, containers };
    },
  },
  {
    id: "backup.git_result",
    origin: "homeassistant/.git-backup-trigger/result",
    collect(ctx) {
      const file = path.join(ctx.repoRoot, "homeassistant/.git-backup-trigger/result");
      const { text, mtimeMs } = boundedTail(file, 4096);
      const row = parseKeyValue(text);
      return {
        status: row.status ?? null, reason: row.reason ?? null, request_id: row.request_id ?? null,
        finished_at: row.finished_at ?? null,
        age_hours: Number(((ctx.now - (Date.parse(row.finished_at ?? "") || mtimeMs)) / 3600000).toFixed(2)),
      };
    },
  },
  {
    id: "backup.git_history",
    origin: ".git-backup.log (bounded tail)",
    collect(ctx) {
      const { text, truncated } = boundedTail(path.join(ctx.repoRoot, ".git-backup.log"), ctx.policy.budget.max_source_bytes);
      const since = ctx.now - 7 * 86400000;
      const failures = [];
      let lastSuccessAt = null;
      for (const line of text.split("\n")) {
        const match = line.match(/^\[(\d{4}-\d\d-\d\dT[\d:+-]+)\] (.*)$/);
        if (!match) continue;
        const at = Date.parse(match[1]);
        if (!Number.isFinite(at)) continue;
        if (/^backup (failed|aborted)/.test(match[2]) && at >= since) {
          const reason = match[2].match(/reason=([a-z0-9_]+)/)?.[1] ??
            (/security scan/.test(match[2]) ? "security_scan_failed" : "unclassified");
          failures.push({ at: iso(at), reason });
        }
        if (/^backup finished|origin=worker .*remote_commit=/.test(match[2])) lastSuccessAt = iso(at);
      }
      const reasons = {};
      for (const failure of failures) reasons[failure.reason] = (reasons[failure.reason] ?? 0) + 1;
      return { window_days: 7, failures_7d: failures.length, reasons, last_failure_at: failures.at(-1)?.at ?? null,
        last_worker_success_at: lastSuccessAt, tail_truncated: truncated };
    },
  },
  {
    id: "updates.workers",
    origin: "modification time and last status line of the update worker logs",
    collect(ctx) {
      const workers = {};
      for (const [name, file] of Object.entries({
        host_packages: ".dietpi-update-request.cron.log",
        core: ".home-assistant-core-update-request.cron.log",
        containers: ".container-update-request.cron.log",
      })) {
        try {
          const { text, mtimeMs } = boundedTail(path.join(ctx.repoRoot, file), 8192);
          workers[name] = {
            last_activity_at: iso(mtimeMs),
            age_hours: Number(((ctx.now - mtimeMs) / 3600000).toFixed(2)),
            last_run_failed: /Error: Command failed|status=failed|git-backup-reason=|update blocked reason=/.test(text.split("\n").slice(-30).join("\n")),
            // The latest static reason wins: backup push refusal or a safety gate that blocked the update.
            last_reason: [...text.matchAll(/(?:git-backup-reason|update blocked reason)=([a-z0-9_]+)/g)].pop()?.[1] ?? null,
          };
        } catch (error) {
          workers[name] = { collection_error: error.code ?? error.message };
        }
      }
      // Unreadable logs are a collection gap, never evidence of healthy updates.
      const unreadable = Object.values(workers).filter((worker) => worker.collection_error).length;
      if (unreadable === Object.keys(workers).length) throw new Error("update_worker_logs_unreadable");
      return { workers, unreadable };
    },
  },
  {
    id: "repo.state",
    origin: "git status and local refs (no fetch)",
    collect(ctx) {
      const status = runCommand(ctx, "git", ["status", "--porcelain=v1", "--untracked-files=normal"]);
      const lines = status.split("\n").filter(Boolean);
      const head = runCommand(ctx, "git", ["rev-parse", "HEAD"]).trim();
      const branch = runCommand(ctx, "git", ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
      let ahead = null;
      try { ahead = Number(runCommand(ctx, "git", ["rev-list", "--count", "origin/main..HEAD"]).trim()); } catch { ahead = null; }
      let oldestChangeHours = null;
      for (const line of lines.slice(0, 200)) {
        try {
          const stat = fs.lstatSync(path.join(ctx.repoRoot, line.slice(3).split(" -> ").pop()));
          oldestChangeHours = Math.max(oldestChangeHours ?? 0, (ctx.now - stat.mtimeMs) / 3600000);
        } catch { /* deleted paths have no age */ }
      }
      return {
        head, branch, ahead_of_origin_main: ahead,
        modified: lines.filter((line) => !line.startsWith("??")).length,
        untracked: lines.filter((line) => line.startsWith("??")).length,
        sample_paths: lines.slice(0, 12).map((line) => redact(line.slice(3))),
        oldest_change_hours: oldestChangeHours === null ? null : Number(oldestChangeHours.toFixed(1)),
      };
    },
  },
  {
    id: "logs.sizes",
    origin: "sizes of worker logs in the repository root",
    collect(ctx) {
      const logs = fs.readdirSync(ctx.repoRoot).filter((name) => /^\.[a-z0-9-]+(\.cron)?\.log$/.test(name)).map((name) => {
        const stat = fs.lstatSync(path.join(ctx.repoRoot, name));
        return { name, bytes: stat.size, regular: stat.isFile() };
      }).sort((a, b) => b.bytes - a.bytes);
      return { total_bytes: logs.reduce((sum, log) => sum + log.bytes, 0), largest: logs.slice(0, 8) };
    },
  },
  {
    id: "executor.peer_binding",
    origin: "task executor peer proof compared with the current boot and socket",
    collect(ctx) {
      const proof = JSON.parse(boundedTail(ctx.resolvePath(ctx.policy.paths.peer_proof), 8192).text);
      const bootId = fs.readFileSync(ctx.procPath("sys/kernel/random/boot_id"), "utf8").trim();
      let socket = null;
      try {
        const stat = fs.statSync(ctx.resolvePath(ctx.policy.paths.executor_socket));
        socket = [Number(stat.dev), Number(stat.ino)];
      } catch { socket = null; }
      let cgroup = null;
      try { cgroup = fs.readFileSync(ctx.procPath(`${proof.peer_pid}/cgroup`), "utf8").trim(); } catch { cgroup = null; }
      return {
        boot_matches: proof.boot_id === bootId,
        peer_process_alive: cgroup !== null,
        cgroup_matches: cgroup === null ? null : cgroup === proof.daemon_cgroup,
        socket_matches: socket === null ? null : JSON.stringify(socket) === JSON.stringify(proof.socket_identity),
        proof_revision: sha256(JSON.stringify(proof)).slice(0, 16),
      };
    },
  },
  {
    id: "ha.unavailable_entities",
    origin: "latest state of every entity in the Home Assistant recorder database, opened read-only",
    collect(ctx) {
      // 19/11/2026: 95 of 737 entities were unavailable and nothing reported how long. Only
      // entity ids and ages leave this source. Age = time since the last usable state
      // (a restart rewrites the unavailable state, so its own timestamp would hide it).
      const out = runCommand(ctx, "sqlite3", ["-readonly", path.join(ctx.repoRoot, "homeassistant", "home-assistant_v2.db"),
        "select m.entity_id||'|'||coalesce((select max(last_updated_ts) from states where metadata_id=m.metadata_id and state not in ('unavailable','unknown')),(select min(last_updated_ts) from states where metadata_id=m.metadata_id)) from states_meta m join states s on s.state_id=(select state_id from states where metadata_id=m.metadata_id order by last_updated_ts desc limit 1) where s.state = 'unavailable';"]);
      const rows = out.split("\n").map((line) => line.match(/^([a-z_]+\.[a-z0-9_]+)\|([0-9.]+)$/)).filter(Boolean)
        .map((match) => ({ entity_id: match[1], days: Math.floor((ctx.now - Number(match[2]) * 1000) / 86400000) }));
      return { total: rows.length, stale_over_7_days: rows.filter((row) => row.days >= 7).sort((a, b) => b.days - a.days).slice(0, 40) };
    },
  },
  {
    id: "zigbee.batteries",
    origin: "latest recorded battery level of each Zigbee2MQTT device (names from its configuration, levels from the recorder, read-only)",
    collect(ctx) {
      // The IR controller died on 18/11 without any warning. Only device names and levels leave here.
      const config = fs.readFileSync(path.join(ctx.repoRoot, "zigbee2mqtt", "configuration.yaml"), "utf8");
      const names = [...config.matchAll(/^\s*friendly_name:\s*([a-z0-9_]+)\s*$/gim)].map((match) => match[1]);
      if (!names.length) return { levels: [] };
      const list = names.map((name) => `'sensor.${name}_battery'`).join(",");
      const out = runCommand(ctx, "sqlite3", ["-readonly", path.join(ctx.repoRoot, "homeassistant", "home-assistant_v2.db"),
        `select m.entity_id||'|'||s.state from states_meta m join states s on s.state_id=(select state_id from states where metadata_id=m.metadata_id order by last_updated_ts desc limit 1) where m.entity_id in (${list});`]);
      const levels = out.split("\n").map((line) => line.match(/^sensor\.([a-z0-9_]+)_battery\|(.*)$/)).filter(Boolean)
        .map((match) => ({ name: match[1], percent: /^[0-9]+(\.[0-9]+)?$/.test(match[2]) ? Number(match[2]) : null }));
      return { levels };
    },
  },
  {
    id: "zigbee.devices_offline",
    origin: "Zigbee2MQTT device database (last contact per device) and friendly names, read-only",
    collect(ctx) {
      // 19/11/2026: two mains-powered routers and a battery IR controller went silent and
      // nothing noticed; coordinator recovery only covers the coordinator. Report names,
      // kinds and ages only, never keys or addresses.
      const base = path.join(ctx.repoRoot, "zigbee2mqtt");
      const rows = fs.readFileSync(path.join(base, "database.db"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
      const names = new Map();
      const config = fs.readFileSync(path.join(base, "configuration.yaml"), "utf8");
      for (const match of config.matchAll(/^\s*'?(0x[0-9a-f]{16})'?:\s*\n\s*friendly_name:\s*(\S+)/gim)) names.set(match[1].toLowerCase(), match[2]);
      const devices = rows.filter((row) => row.type !== "Coordinator").map((row) => ({
        name: names.get(String(row.ieeeAddr).toLowerCase()) ?? "dispositivo sem nome",
        mains: /mains/i.test(String(row.powerSource ?? "")),
        silent_minutes: Number.isFinite(row.lastSeen) ? Math.round((ctx.now - row.lastSeen) / 60000) : null,
      }));
      return { devices };
    },
  },
  {
    id: "nodered_admin.chain_drift",
    origin: "status of the read-only Node-RED administration chain drift check",
    collect(ctx) {
      const tail = boundedTail(ctx.resolvePath(ctx.policy.paths.nodered_admin_drift_status), 16384);
      const status = JSON.parse(tail.text);
      const ledgers = status.checks?.ledger_schemas ?? {};
      const container = status.checks?.container ?? {};
      const drifted = [
        ...Object.entries(ledgers).filter(([, v]) => v.state !== "aligned").map(([name, v]) => `ledger:${name}:${v.state}`),
        ...Object.entries(container).filter(([name, v]) => name !== "collection_error" && v !== "aligned").map(([name, v]) => `container:${name}:${v}`),
        ...(status.checks?.guard_pins === "aligned" ? [] : [`guard_pins:${status.checks?.guard_pins ?? "unknown"}`]),
        // Every other check the drift timer reports (17/11: session_cleanup_pins drifted after
        // the docker-ce upgrade replaced the container's ancestor binaries) must be named too;
        // otherwise the recommendation says "drift" with an empty list.
        ...Object.entries(status.checks ?? {})
          .filter(([name]) => !["ledger_schemas", "container", "guard_pins"].includes(name))
          .map(([name, value]) => [name, typeof value === "string" ? value : value?.state ?? "unknown"])
          .filter(([, state]) => state !== "aligned")
          .map(([name, state]) => `${name}:${state}`),
      ].sort();
      return { state: status.state, drifted, age_hours: Math.round((Date.now() - tail.mtimeMs) / 36e5 * 10) / 10 };
    },
  },
  {
    id: "ai.codex_account",
    origin: "read-only Codex/ChatGPT account usage (account/read, account/rateLimits/read) through the fixed broker",
    collect(ctx) {
      // Same broker the MCP uses; it reads plan, usage and reset only (no tokens or identity).
      const broker = path.join(ctx.repoRoot, "scripts/raspberry-mcp/codex-account-status/broker.cjs");
      const r = spawnSync(process.execPath, [broker], { input: '{"name":"codex_account_status"}\n', encoding: "utf8", timeout: 15000 });
      if (r.status !== 0) throw new Error("codex_account_probe_failed");
      const v = JSON.parse(r.stdout);
      if (v.state !== "observed") throw new Error(v.collection_error || "codex_account_unknown");
      return { reason: v.reason, plan: v.plan, usage_allowed: v.usage_allowed, limit_reached_type: v.limit_reached_type,
        paid_credits_available: v.paid_credits_available, resets_at: v.resets_at };
    },
  },
  {
    id: "host.update_protections",
    origin: "docker info and the cgroup v2 root controllers",
    collect(ctx) {
      // Protections that keep the house up and memory bounded during nightly updates.
      const live = runCommand(ctx, "docker", ["info", "--format", "{{.LiveRestoreEnabled}}"]).trim();
      if (live !== "true" && live !== "false") throw new Error("docker_live_restore_unreadable");
      const controllers = fs.readFileSync(ctx.cgroupControllersPath, "utf8").trim().split(/\s+/);
      return { docker_live_restore: live === "true", cgroup_memory_controller: controllers.includes("memory") };
    },
  },
  {
    id: "ai.client_execution_policy",
    origin: "Root-installed client policy of the task terminal observer (read-only, world-readable)",
    collect(ctx) {
      // Eva's standing continuation depends on this sealed policy. Report only its state
      // fields, never the allowed tools, identity recipe or workflows.
      const stat = fs.statSync(ctx.clientPolicyPath);
      const value = JSON.parse(fs.readFileSync(ctx.clientPolicyPath, "utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("client_policy_unreadable");
      const expires = value.expires_at;
      return {
        enabled: value.enabled === true,
        revoked: value.revoked !== false,
        expires_at: typeof expires === "number" ? new Date(expires * 1000).toISOString() : null,
        expired: typeof expires === "number" && expires * 1000 <= ctx.now,
        approval_recorded: typeof value.approval_sha256 === "string" && /^[a-f0-9]{64}$/.test(value.approval_sha256),
        changed_hours_ago: Math.round((ctx.now - stat.mtimeMs) / 360000) / 10,
      };
    },
  },
  {
    id: "ci.public",
    origin: "gh run list on main (GitHub Actions, read-only)",
    collect(ctx) {
      // Latest completed runs of the public validation on main, newest first.
      const rows = JSON.parse(runCommand(ctx, "gh", ["run", "list", "--branch", "main", "--limit", "20",
        "--json", "conclusion,status,headSha,createdAt,workflowName"]));
      if (!Array.isArray(rows)) throw new Error("ci_runs_unreadable");
      const done = rows.filter((r) => r.status === "completed" && r.workflowName === "public-validation");
      let failures = 0;
      while (failures < done.length && done[failures].conclusion === "failure") failures += 1;
      const first = failures ? done[failures - 1] : null;
      return {
        latest_conclusion: done[0]?.conclusion ?? null,
        latest_commit: done[0]?.headSha?.slice(0, 7) ?? null,
        consecutive_failures: failures,
        failing_since_commit: first?.headSha?.slice(0, 7) ?? null,
        failing_since: first?.createdAt ?? null,
      };
    },
  },
  {
    id: "workers.stale_markers",
    origin: "processing markers under the Home Assistant trigger directories",
    collect(ctx) {
      const base = path.join(ctx.repoRoot, "homeassistant");
      const markers = [];
      for (const dir of fs.readdirSync(base).filter((name) => /^\.[a-z0-9-]+-trigger$/.test(name))) {
        // Every in-flight marker counts, including per-kind ones such as
        // build-cache-processing; an absent marker is the normal state.
        let names = [];
        try { names = fs.readdirSync(path.join(base, dir)).filter((name) => /^(?:[a-z0-9-]+-)?processing$/.test(name)); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
        for (const name of names.sort()) {
          try {
            const stat = fs.lstatSync(path.join(base, dir, name));
            markers.push({ trigger: name === "processing" ? dir : `${dir}/${name}`, age_minutes: Math.round((ctx.now - stat.mtimeMs) / 60000) });
          } catch { /* removed between listing and stat */ }
        }
      }
      return { markers };
    },
  },
];

export function createContext({ policy, repoRoot = REPO_ROOT, now = Date.now(), run = spawnSync, procRoot = "/proc", home = os.homedir(),
  cgroupControllersPath = "/sys/fs/cgroup/cgroup.controllers",
  clientPolicyPath = "/usr/local/lib/raspberry-task-terminal-observer/client-policy.json" } = {}) {
  return {
    policy, repoRoot, now, run, cgroupControllersPath, clientPolicyPath,
    procPath: (name) => path.join(procRoot, name),
    resolvePath: (value) => (value.startsWith("~/") ? path.join(home, value.slice(2)) : value),
  };
}

export function collectEvidence(ctx, sources = SOURCES) {
  const deadline = Date.now() + ctx.policy.budget.max_runtime_seconds * 1000;
  return sources.map((source) => {
    const observedAt = Date.now();
    const base = { id: source.id, origin: source.origin, observed_at: iso(observedAt), age_seconds: 0 };
    if (Date.now() > deadline) return { ...base, revision: null, collection_error: "runtime_budget_exhausted", data: null };
    try {
      const data = source.collect(ctx);
      const serialized = JSON.stringify(data);
      if (Buffer.byteLength(serialized) > ctx.policy.budget.max_source_bytes) throw new Error("source_output_over_budget");
      return { ...base, revision: sha256(serialized).slice(0, 16), collection_error: null, data };
    } catch (error) {
      return { ...base, revision: null, collection_error: redact(error.code ?? error.message).slice(0, 120), data: null };
    }
  });
}

// ------------------------------------------------------------ evaluation --

// Each finding names the evidence it rests on and declares benefit, priority,
// risk of the proposed action and the action itself. `key` is the stable
// identity used for deduplication; `bucket` is the part of the detail whose
// change counts as an aggravation worth announcing again.
export function evaluate(evidence, policy) {
  const by = Object.fromEntries(evidence.map((item) => [item.id, item]));
  const t = policy.thresholds;
  const findings = [];
  const add = (finding) => findings.push({ auto_action: null, bucket: "", ...finding });
  const data = (id) => by[id]?.data ?? null;

  const resources = data("host.resources");
  if (resources) {
    if (resources.disk_used_percent >= t.disk_warn_percent) {
      const high = resources.disk_used_percent >= t.disk_high_percent;
      add({
        key: "host.disk_pressure", priority: high ? "P1" : "P2", risk: "baixo",
        title: `Disco do repositório em ${resources.disk_used_percent}%`,
        benefit: "Evita que validações, backups e atualizações sejam recusados por falta de espaço.",
        proposed_action: "Rodar a manutenção de armazenamento catalogada e revisar imagens e caches antigos.",
        bucket: high ? "high" : "warn", evidence: ["host.resources"],
      });
    }
    if (resources.memory_available_kb !== null && resources.memory_available_kb < t.memory_available_warn_kb) {
      add({
        key: "host.memory_pressure", priority: "P2", risk: "baixo",
        title: `Memória disponível baixa (${Math.round(resources.memory_available_kb / 1024)} MiB)`,
        benefit: "Evita encerramentos por falta de memória e recusas do executor de validação.",
        proposed_action: "Identificar o maior consumidor pelo inventário de processos antes de qualquer reinício.",
        evidence: ["host.resources"],
      });
    }
  }

  const units = data("host.failed_units");
  if (units?.failed_count > 0) {
    add({
      key: "host.failed_units", priority: "P3", risk: "baixo",
      title: `${units.failed_count} unidade(s) systemd em estado failed`,
      benefit: "Remove ruído do diagnóstico e revela falhas reais de serviços por instância.",
      proposed_action: "Ler o journal de cada família, corrigir a causa e só então limpar o estado failed.",
      bucket: Object.keys(units.families).sort().join(","), evidence: ["host.failed_units"],
      detail: units.families,
    });
  }

  const containers = data("containers.state");
  const bad = containers?.containers.filter((c) => c.unhealthy || c.restarting || c.state === "dead" || (c.state === "exited" && c.exit_code !== 0)) ?? [];
  if (bad.length) {
    add({
      key: "containers.degraded", priority: bad.some((c) => c.unhealthy || c.restarting) ? "P1" : "P2", risk: "médio",
      title: `Contêiner(es) degradado(s): ${bad.map((c) => c.name).sort().join(", ")}`,
      benefit: "Restaura serviços da casa antes que automações dependentes falhem.",
      proposed_action: "Diagnosticar pelo serviço afetado e usar a prévia de reinício existente; não reiniciar a stack.",
      bucket: bad.map((c) => `${c.name}:${c.state}`).sort().join(","), evidence: ["containers.state"],
    });
  }

  const backup = data("backup.git_result");
  if (backup) {
    if (backup.status && backup.status !== "success") {
      add({
        key: "backup.git_last_failed", priority: "P1", risk: "baixo",
        title: `Último backup Git falhou (${backup.reason ?? "motivo não informado"})`,
        benefit: "Sem backup com sucesso as atualizações diárias não são disparadas e a recuperação fica desatualizada.",
        proposed_action: "Consultar a mesma operação e o log, corrigir a causa indicada e pedir novo ciclo pela rota existente.",
        bucket: String(backup.reason), evidence: ["backup.git_result", "backup.git_history"],
        detail: { request_id: backup.request_id, finished_at: backup.finished_at },
      });
    } else if (backup.age_hours > t.backup_max_age_hours) {
      add({
        key: "backup.git_stale", priority: "P2", risk: "baixo",
        title: `Backup Git sem novo resultado há ${Math.round(backup.age_hours)} h`,
        benefit: "Confirma que a agenda noturna continua produzindo ciclos.",
        proposed_action: "Verificar o agendador e o worker de pedidos antes de solicitar um ciclo manual.",
        evidence: ["backup.git_result"],
      });
    }
  }

  const history = data("backup.git_history");
  if (history?.failures_7d >= t.backup_failures_7d_warn) {
    add({
      key: "backup.git_recurring_failures", priority: "P2", risk: "médio",
      title: `${history.failures_7d} falhas de backup Git em 7 dias`,
      benefit: "Elimina a causa recorrente em vez de tratar cada noite isoladamente.",
      proposed_action: "Agrupar as falhas por motivo e corrigir a origem comum; trabalho interativo em andamento no checkout é a causa mais frequente.",
      bucket: Object.keys(history.reasons).sort().join(","), evidence: ["backup.git_history"], detail: history.reasons,
    });
  }

  const workers = data("updates.workers")?.workers;
  if (workers) {
    const stale = Object.entries(workers).filter(([, w]) => w.age_hours > t.update_worker_max_age_hours).map(([name]) => name).sort();
    const failed = Object.entries(workers).filter(([, w]) => w.last_run_failed).map(([name]) => name).sort();
    if (stale.length) {
      add({
        key: "updates.workers_stale", priority: "P2", risk: "baixo",
        title: `Atualizações sem atividade recente: ${stale.join(", ")}`,
        benefit: "Mantém correções de segurança e de estabilidade sendo aplicadas.",
        proposed_action: "Conferir se o backup anterior terminou com sucesso, pois ele libera a etapa de atualizações.",
        bucket: stale.join(","), evidence: ["updates.workers", "backup.git_result"],
      });
    }
    if (failed.length) {
      add({
        key: "updates.workers_failed", priority: "P2", risk: "médio",
        title: `Última execução com falha: ${failed.map((name) => workers[name].last_reason ? `${name} (${workers[name].last_reason})` : name).join(", ")}`,
        benefit: "Evita que uma etapa parcialmente aplicada fique sem verificação.",
        proposed_action: failed.some((name) => /^unsupported_|_unconfirmed$|_blocked$/.test(workers[name].last_reason ?? ""))
          ? "Uma trava de segurança bloqueou a atualização (veja o motivo no título); resolver a compatibilidade antes de liberar a cadeia, que também segura as etapas seguintes."
          : "Ler o recibo da mesma execução e distinguir falha da atualização de falha do backup posterior.",
        bucket: failed.map((name) => `${name}:${workers[name].last_reason ?? "unknown"}`).join(","), evidence: ["updates.workers"],
      });
    }
  }

  const repo = data("repo.state");
  if (repo) {
    if (repo.ahead_of_origin_main > 0) {
      add({
        key: "repo.unpublished_commits", priority: "P2", risk: "baixo",
        title: `${repo.ahead_of_origin_main} commit(s) locais ainda não publicados`,
        benefit: "Mantém o remoto como cópia recuperável do estado atual.",
        proposed_action: "Publicar pelo procedimento canônico depois de confirmar quem é o responsável pelos commits.",
        evidence: ["repo.state"],
      });
    }
    if ((repo.modified + repo.untracked) > 0 && (repo.oldest_change_hours ?? 0) > t.dirty_worktree_warn_hours) {
      add({
        key: "repo.stale_local_changes", priority: "P3", risk: "baixo",
        title: `Alterações locais antigas no checkout (${repo.modified} modificados, ${repo.untracked} novos)`,
        benefit: "Evita que o backup noturno seja reprovado por trabalho inacabado.",
        proposed_action: "Identificar o responsável e concluir, publicar ou mover o trabalho para fora do checkout ativo.",
        evidence: ["repo.state"], detail: { sample_paths: repo.sample_paths },
      });
    }
  }

  const logs = data("logs.sizes");
  const rotate = policy.auto_actions?.catalog?.rotate_worker_log;
  for (const log of logs?.largest ?? []) {
    if (log.bytes < t.log_warn_bytes) continue;
    const eligible = Boolean(rotate?.enabled && rotate.paths.includes(log.name) && log.regular && log.bytes >= rotate.min_bytes);
    add({
      key: `logs.oversized:${log.name}`, priority: "P3", risk: "baixo",
      title: `Log ${log.name} com ${(log.bytes / 1048576).toFixed(1)} MiB`,
      benefit: "Reduz uso de disco e o custo de leitura dos diagnósticos.",
      proposed_action: eligible ? "Rotação automática catalogada, com cópia compactada e reversão." :
        "Fora do catálogo automático: decidir retenção com o responsável pelo log.",
      evidence: ["logs.sizes"], auto_action: eligible ? { id: "rotate_worker_log", params: { path: log.name } } : null,
    });
  }

  const peer = data("executor.peer_binding");
  if (peer && (!peer.boot_matches || !peer.peer_process_alive || peer.cgroup_matches === false || peer.socket_matches === false)) {
    add({
      key: "executor.peer_binding_stale", priority: "P1", risk: "médio",
      title: "Vínculo do executor de tarefas não corresponde ao processo atual",
      benefit: "Sem o vínculo, criação e envio de tarefas ficam fechados embora a política continue válida.",
      proposed_action: "Aguardar um ciclo do atestador; se persistir, comparar a origem de inicialização do executor com a inscrição e seguir a recuperação documentada.",
      bucket: [peer.boot_matches, peer.peer_process_alive, peer.cgroup_matches, peer.socket_matches].join(","),
      evidence: ["executor.peer_binding"],
    });
  }

  const chain = data("nodered_admin.chain_drift");
  if (chain && (chain.state !== "aligned" || chain.age_hours > t.nodered_admin_drift_max_age_hours)) {
    const drift = chain.state === "drift";
    add({
      key: "nodered_admin.chain_drift", priority: drift ? "P2" : "P3", risk: "baixo",
      title: drift ? `Cadeia administrativa do Node-RED defasada: ${chain.drifted.join(", ") || "item não identificado"}`
        : "Verificação da cadeia administrativa do Node-RED sem resultado atual",
      benefit: "Evita descobrir a recusa do guarda somente na hora de um deploy Node-RED.",
      proposed_action: drift
        ? "Atualizar o guarda ou religar a identidade do contêiner pelo procedimento documentado antes do próximo deploy."
        : "Conferir o timer raspberry-nodered-admin-drift e a leitura do Docker e dos ledgers.",
      bucket: [chain.state, ...chain.drifted].join(","),
      evidence: ["nodered_admin.chain_drift"],
    });
  }

  const ai = data("ai.codex_account");
  if (ai && ai.reason && ai.reason !== "codex_usage_available") {
    const reset = ai.resets_at ? new Date(ai.resets_at) : null;
    const when = reset && Number.isFinite(reset.getTime())
      ? `${reset.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short" })} (horário de Brasília)` : "horário de reset desconhecido";
    const limit = ai.reason === "codex_usage_limit_reached" || ai.reason === "codex_included_usage_unavailable";
    add({
      key: "ai.codex_usage_unavailable", priority: "P1", risk: "baixo",
      title: limit ? `Créditos do ChatGPT/Codex esgotados até ${when}` : "Conta Codex sem assinatura pessoal aceita",
      benefit: "Explica por que a Eva não consegue criar tarefas, enviar turnos Codex, revisar ou propor reparos, em vez de um erro genérico.",
      proposed_action: limit
        ? `Aguardar o reset (${when}) ou adicionar créditos; até lá tarefas Codex, revisões delegadas e reparos do componente ficam parados.`
        : "Conferir o login do Codex no host; a cota só é aceita com assinatura ChatGPT pessoal.",
      bucket: [ai.reason, ai.resets_at ?? "unknown"].join(","),
      evidence: ["ai.codex_account"],
    });
  }

  const ci = data("ci.public");
  if (ci?.latest_conclusion === "failure") {
    const since = ci.failing_since ? new Date(ci.failing_since) : null;
    const when = since && Number.isFinite(since.getTime())
      ? since.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short" }) : "horário desconhecido";
    add({
      key: "ci.public_red", priority: "P1", risk: "baixo",
      title: `CI público vermelho em main desde ${ci.failing_since_commit ?? "?"} (${when}, ${ci.consecutive_failures} execução(ões))`,
      benefit: "Publicações seguem direto para main; sem CI verde uma regressão passa despercebida (já ficou 9 dias vermelho sem aviso).",
      proposed_action: "Ler o primeiro teste que falhou com gh run view --log-failed e corrigir antes da próxima publicação.",
      bucket: String(ci.failing_since_commit), evidence: ["ci.public"],
    });
  }

  const protections = data("host.update_protections");
  if (protections && protections.docker_live_restore === false) {
    add({
      key: "host.docker_live_restore_off", priority: "P1", risk: "baixo",
      title: "Docker sem live-restore: reinício ou atualização do motor derruba a casa",
      benefit: "Com live-restore, um upgrade do docker-ce pelo APT ou um reinício do daemon mantém os contêineres rodando (em 17/11 a pilha caiu às 04:03).",
      proposed_action: "Executar sudo scripts/install-docker-live-restore.sh (reload, sem reiniciar contêineres) e conferir docker info.",
      evidence: ["host.update_protections"],
    });
  }
  if (protections && protections.cgroup_memory_controller === false) {
    add({
      key: "host.cgroup_memory_disabled", priority: "P3", risk: "médio",
      title: "Limites de memória dos contêineres são ignorados (controlador de memória do cgroup desligado)",
      benefit: "Com o controlador ativo, testes isolados e contêineres respeitam --memory e uma atualização não consome a RAM do Raspberry.",
      proposed_action: "Decisão do proprietário: acrescentar cgroup_enable=memory ao cmdline.txt e agendar um reboot autorizado.",
      evidence: ["host.update_protections"],
    });
  }

  const batteries = data("zigbee.batteries");
  const low = (batteries?.levels ?? []).filter((item) => item.percent !== null && item.percent <= 20);
  if (low.length) {
    add({
      key: "zigbee.batteries_low", priority: "P2", risk: "baixo",
      title: `Bateria baixa em módulo(s) Zigbee: ${low.map((item) => `${item.name} (${item.percent}%)`).join(", ")}`,
      benefit: "Trocar antes de morrer evita perder o botão do portão ou o controlador IR sem aviso (o IR caiu em 18/11 sem alerta).",
      proposed_action: "Trocar a bateria do dispositivo indicado; o nível volta a subir no próximo relato do módulo.",
      evidence: ["zigbee.batteries"],
    });
  }

  const unavailable = data("ha.unavailable_entities");
  if (unavailable?.stale_over_7_days.length) {
    const stale = unavailable.stale_over_7_days;
    const groups = new Map();
    for (const row of stale) {
      const name = row.entity_id.split(".")[1].split("_").slice(0, 2).join("_");
      groups.set(name, (groups.get(name) ?? 0) + 1);
    }
    const top = [...groups.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([name, count]) => `${name} (${count})`).join(", ");
    add({
      key: "ha.unavailable_entities_stale", priority: "P3", risk: "baixo",
      title: `${stale.length} entidade(s) indisponível(is) há 7 dias ou mais: ${top}`,
      benefit: "Entidades mortas poluem painéis, mascaram falhas reais (medidor de energia, bateria) e custam estado no recorder.",
      proposed_action: "Separar o que é equipamento fora do ar (religar) do que é órfão (remover do registro de entidades). Mais antiga: " + `${stale[0].entity_id} (${stale[0].days} dias).`,
      evidence: ["ha.unavailable_entities"], detail: { total_unavailable: unavailable.total, sample: stale.slice(0, 12) },
    });
  }

  const zigbee = data("zigbee.devices_offline");
  if (zigbee) {
    // Router on mains: it answers within minutes, so 45 silent minutes is a real loss.
    // Battery device: reports sporadically, so only 36 h of silence counts.
    const lost = zigbee.devices.filter((item) => item.silent_minutes === null || item.silent_minutes > (item.mains ? 45 : 36 * 60));
    const routers = lost.filter((item) => item.mains);
    if (lost.length) {
      const label = (item) => `${item.name} (${item.mains ? "rede elétrica" : "bateria"}, ${item.silent_minutes === null ? "sem contato registrado" : `${Math.round(item.silent_minutes / 6) / 10} h sem contato`})`;
      add({
        key: "zigbee.devices_offline", priority: routers.length ? "P1" : "P2", risk: "baixo",
        title: `Módulo(s) Zigbee sem resposta: ${lost.map(label).join("; ")}`,
        benefit: "A recuperação existente só cobre o coordenador; sem este alerta um módulo perdido passa despercebido até alguém tentar usá-lo.",
        proposed_action: "Conferir energia/bateria e religar o módulo; se continuar sem resposta, revisar interferência no canal e a rota. Não acionar equipamentos sensíveis (portão) sem autorização específica.",
        evidence: ["zigbee.devices_offline"],
      });
    }
  }

  const clientPolicy = data("ai.client_execution_policy");
  if (clientPolicy && (!clientPolicy.enabled || clientPolicy.revoked || clientPolicy.expired || !clientPolicy.approval_recorded)) {
    const why = [!clientPolicy.enabled && "desativada", clientPolicy.revoked && "revogada",
      clientPolicy.expired && "vencida", !clientPolicy.approval_recorded && "sem aprovação registrada"].filter(Boolean).join(", ");
    add({
      key: "ai.client_execution_policy_inactive", priority: "P1", risk: "baixo",
      title: `Política de continuação da Eva ${why}`,
      benefit: "Sem a política aprovada a Eva não continua tarefas nem incidentes sozinha (em 16/11 o desbloqueio dependeu dela).",
      proposed_action: "Conferir com maintenance_capabilities (client_execution_policy) e, se a revogação não foi do proprietário, reinstalar a política pelo operador Root revisado.",
      evidence: ["ai.client_execution_policy"],
    });
  }

  const markers = data("workers.stale_markers")?.markers.filter((m) => m.age_minutes > t.stale_marker_minutes) ?? [];
  if (markers.length) {
    add({
      key: "workers.stale_processing", priority: "P2", risk: "médio",
      title: `Pedido em processamento há muito tempo: ${markers.map((m) => m.trigger).sort().join(", ")}`,
      benefit: "Destrava a fila do worker sem repetir um efeito de resultado incerto.",
      proposed_action: "Consultar a mesma operação e o recibo antes de qualquer nova tentativa.",
      bucket: markers.map((m) => m.trigger).sort().join(","), evidence: ["workers.stale_markers"],
    });
  }

  const failedSources = evidence.filter((item) => item.collection_error).map((item) => item.id).sort();
  if (failedSources.length) {
    add({
      key: "review.collection_gaps", priority: "P3", risk: "baixo",
      title: `Fontes sem coleta nesta revisão: ${failedSources.join(", ")}`,
      benefit: "Torna explícito o que a revisão não conseguiu observar.",
      proposed_action: "Verificar permissão e disponibilidade das fontes; ausência de coleta não é confirmação de saúde.",
      bucket: failedSources.join(","), evidence: failedSources,
    });
  }

  return findings.map((finding) => ({
    ...finding,
    id: `rec-${sha256(finding.key).slice(0, 12)}`,
    signature: sha256(`${finding.key}|${finding.priority}|${finding.bucket}`).slice(0, 16),
    evidence: finding.evidence.map((id) => ({ id, revision: by[id]?.revision ?? null, observed_at: by[id]?.observed_at ?? null,
      collection_error: by[id]?.collection_error ?? null })),
  }));
}

// ---------------------------------------------------------------- ledger --

export function emptyLedger() {
  return { schema: LEDGER_SCHEMA, revision: 0, recommendations: {}, events: [], runs: [], actions: [],
    notification: { digest: null, published_at: null, pending: false } };
}

function withLock(stateDir, body) {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const lock = path.join(stateDir, "lock");
  const acquire = () => {
    try {
      const fd = fs.openSync(lock, "wx", 0o600);
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return true;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      return false;
    }
  };
  if (!acquire()) {
    // Reclaim only a lock whose owner is gone; a live owner means "busy".
    let owner = NaN;
    try { owner = Number(fs.readFileSync(lock, "utf8")); } catch { /* raced with release */ }
    let alive = false;
    if (Number.isInteger(owner) && owner > 0) {
      try { process.kill(owner, 0); alive = true; } catch (error) { alive = error.code === "EPERM"; }
    }
    if (alive) throw new Error("review_busy");
    try { fs.unlinkSync(lock); } catch { /* another process reclaimed it */ }
    if (!acquire()) throw new Error("review_busy");
  }
  const release = () => { try { fs.unlinkSync(lock); } catch { /* already gone */ } };
  let result;
  try { result = body(); } catch (error) { release(); throw error; }
  // An asynchronous body keeps the lock until it settles.
  if (result && typeof result.then === "function") return result.finally(release);
  release();
  return result;
}

export function readLedger(stateDir) {
  try {
    const ledger = JSON.parse(fs.readFileSync(path.join(stateDir, "ledger.json"), "utf8"));
    if (ledger.schema !== LEDGER_SCHEMA) throw new Error("ledger_schema_unknown");
    return ledger;
  } catch (error) {
    if (error.code === "ENOENT") return emptyLedger();
    throw error;
  }
}

function writeLedger(stateDir, ledger, expectedRevision) {
  // Compare-and-swap on the revision read at the start of the transaction.
  const current = readLedger(stateDir);
  if (current.revision !== expectedRevision) throw new Error("ledger_revision_changed");
  ledger.revision = expectedRevision + 1;
  const file = path.join(stateDir, "ledger.json");
  const temporary = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(temporary, "w", 0o600);
  try { fs.writeSync(fd, `${JSON.stringify(ledger, null, 1)}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temporary, file);
}

const pushEvent = (ledger, policy, at, type, id, extra = {}) => {
  ledger.events.push({ at: iso(at), type, id, ...extra });
  if (ledger.events.length > policy.history.max_events) ledger.events.splice(0, ledger.events.length - policy.history.max_events);
};

// Merge the current findings into the ledger. Returns the announcements that
// justify a notification: new, aggravated, reminder due, or resolved.
export function reconcile(ledger, findings, evidence, policy, now) {
  const announcements = [];
  const present = new Set(findings.map((finding) => finding.id));
  const failedSources = new Set(evidence.filter((item) => item.collection_error).map((item) => item.id));
  for (const finding of findings) {
    const existing = ledger.recommendations[finding.id];
    const snapshot = {
      id: finding.id, key: finding.key, title: finding.title, priority: finding.priority, risk: finding.risk,
      benefit: finding.benefit, proposed_action: finding.proposed_action, evidence: finding.evidence,
      detail: finding.detail ?? null, auto_action: finding.auto_action, signature: finding.signature, last_seen_at: iso(now),
    };
    if (!existing || existing.status === "resolved") {
      ledger.recommendations[finding.id] = { ...snapshot, status: "open", first_seen_at: iso(now), occurrences: 1,
        announced_at: iso(now), task_ref: null, note: null, reopened: Boolean(existing) };
      pushEvent(ledger, policy, now, existing ? "reopened" : "opened", finding.id, { priority: finding.priority });
      announcements.push({ id: finding.id, reason: existing ? "reopened" : "new" });
      continue;
    }
    const aggravated = PRIORITIES.indexOf(finding.priority) < PRIORITIES.indexOf(existing.priority) ||
      (existing.signature !== finding.signature && finding.priority === "P1");
    Object.assign(existing, snapshot, { occurrences: existing.occurrences + 1 });
    if (existing.status === "dismissed") {
      const expired = existing.dismissed_until && Date.parse(existing.dismissed_until) <= now;
      if (!aggravated && !expired) continue;
      existing.status = "open";
      pushEvent(ledger, policy, now, "dismissal_ended", finding.id, { aggravated });
    }
    const reminderDue = now - Date.parse(existing.announced_at) >= policy.dedupe.remind_after_hours * 3600000;
    if (aggravated || reminderDue) {
      existing.announced_at = iso(now);
      pushEvent(ledger, policy, now, aggravated ? "aggravated" : "reminded", finding.id, { priority: finding.priority });
      announcements.push({ id: finding.id, reason: aggravated ? "aggravated" : "reminder" });
    }
  }
  for (const record of Object.values(ledger.recommendations)) {
    if (present.has(record.id) || record.status === "resolved") continue;
    // A finding that vanished only because its source failed is unknown, not resolved.
    if (record.evidence.some((item) => failedSources.has(item.id))) continue;
    record.status = "resolved";
    record.resolved_at = iso(now);
    pushEvent(ledger, policy, now, "resolved", record.id);
    announcements.push({ id: record.id, reason: "resolved" });
  }
  return announcements;
}

// --------------------------------------------------------- auto actions --

const ACTIONS = {
  // Keeps the newest bytes in place and stores the complete previous content
  // compressed, so the action can be undone while the archive is retained.
  rotate_worker_log: {
    precheck(ctx, config, params, evidence) {
      if (!config.paths.includes(params.path)) return "path_not_in_catalog";
      const disk = evidence.find((item) => item.id === "host.resources")?.data?.disk_used_percent;
      if (!Number.isFinite(disk)) return "disk_state_unknown";
      if (disk >= config.blocked_above_disk_percent) return "disk_too_full_for_archive";
      const stat = fs.lstatSync(path.join(ctx.repoRoot, params.path));
      if (!stat.isFile() || stat.nlink !== 1) return "not_a_plain_file";
      if (stat.size < config.min_bytes) return "below_threshold";
      return null;
    },
    apply(ctx, config, params, stateDir, actionId) {
      const file = path.join(ctx.repoRoot, params.path);
      const archiveDir = path.join(stateDir, "rotated");
      fs.mkdirSync(archiveDir, { recursive: true, mode: 0o700 });
      const before = fs.readFileSync(file);
      const archive = path.join(archiveDir, `${params.path.replace(/^\./, "")}.${actionId}.gz`);
      fs.writeFileSync(archive, zlib.gzipSync(before), { mode: 0o600 });
      const tail = before.subarray(Math.max(0, before.length - config.keep_bytes));
      const firstNewline = tail.indexOf(0x0a);
      const kept = firstNewline >= 0 && tail.length < before.length ? tail.subarray(firstNewline + 1) : tail;
      // Writers append with O_APPEND, so truncating in place keeps them valid.
      fs.truncateSync(file, 0);
      fs.appendFileSync(file, kept);
      const after = fs.statSync(file).size;
      const verified = after <= config.keep_bytes + 65536 &&
        sha256(zlib.gunzipSync(fs.readFileSync(archive))) === sha256(before);
      const own = fs.readdirSync(archiveDir).filter((name) => name.startsWith(`${params.path.replace(/^\./, "")}.`)).sort();
      for (const name of own.slice(0, Math.max(0, own.length - config.max_archives))) fs.unlinkSync(path.join(archiveDir, name));
      return { verified, before_bytes: before.length, after_bytes: after, kept_sha256: sha256(kept),
        archive: path.relative(stateDir, archive) };
    },
    rollback(ctx, record, stateDir) {
      const file = path.join(ctx.repoRoot, record.params.path);
      const archive = path.join(stateDir, record.result.archive);
      const current = fs.readFileSync(file);
      // Only undo when the kept bytes are still the prefix: newer lines are preserved after the restored content.
      const keptLength = Math.min(current.length, record.result.after_bytes);
      if (sha256(current.subarray(0, keptLength)) !== record.result.kept_sha256) throw new Error("log_changed_since_rotation");
      const restored = Buffer.concat([zlib.gunzipSync(fs.readFileSync(archive)), current.subarray(keptLength)]);
      fs.truncateSync(file, 0);
      fs.appendFileSync(file, restored);
      return { restored_bytes: restored.length };
    },
  },
};

export function runAutoActions(ctx, ledger, findings, evidence, stateDir, now) {
  const catalog = ctx.policy.auto_actions?.enabled ? ctx.policy.auto_actions.catalog : {};
  const results = [];
  const perRun = {};
  for (const finding of findings) {
    const request = finding.auto_action;
    const config = request && catalog[request.id];
    if (!config?.enabled || !ACTIONS[request.id]) continue;
    const today = ledger.actions.filter((a) => a.action === request.id && now - Date.parse(a.at) < 86400000 && a.state === "applied_verified").length;
    perRun[request.id] = perRun[request.id] ?? 0;
    const unresolved = ledger.actions.some((a) => a.action === request.id && ["intent", "uncertain", "applied_unverified"].includes(a.state) &&
      JSON.stringify(a.params) === JSON.stringify(request.params));
    if (unresolved) continue;
    const record = { at: iso(now), action: request.id, params: request.params, recommendation: finding.id,
      action_id: sha256(`${request.id}|${JSON.stringify(request.params)}|${now}`).slice(0, 16) };
    let refusal = perRun[request.id] >= config.max_per_run ? "run_limit" :
      today + perRun[request.id] >= config.max_per_day ? "daily_limit" : null;
    try {
      refusal = refusal ?? ACTIONS[request.id].precheck(ctx, config, request.params, evidence);
    } catch (error) {
      refusal = redact(error.code ?? error.message).slice(0, 120);
    }
    ledger.actions.push(record);
    results.push(record);
    if (refusal) {
      record.state = "refused";
      record.reason = refusal;
      continue;
    }
    // The intent is recorded before the effect; an interrupted or failed
    // action stays visible as `uncertain` and is never retried blindly.
    record.state = "intent";
    try {
      record.result = ACTIONS[request.id].apply(ctx, config, request.params, stateDir, record.action_id);
      record.state = record.result.verified ? "applied_verified" : "applied_unverified";
      perRun[request.id] += 1;
    } catch (error) {
      record.state = "uncertain";
      record.reason = redact(error.code ?? error.message).slice(0, 120);
    }
  }
  if (ledger.actions.length > 200) ledger.actions.splice(0, ledger.actions.length - 200);
  return results;
}

// ----------------------------------------------------------- notification --

export function openRecommendations(ledger) {
  return Object.values(ledger.recommendations).filter((record) => OPEN_STATES.has(record.status))
    .sort((a, b) => PRIORITIES.indexOf(a.priority) - PRIORITIES.indexOf(b.priority) || a.id.localeCompare(b.id));
}

export function notificationDigest(ledger) {
  return sha256(JSON.stringify(openRecommendations(ledger).map((r) => [r.id, r.priority, r.status, r.signature])));
}

export function renderNotification(ledger, policy, now) {
  const open = openRecommendations(ledger);
  const lines = open.slice(0, policy.notification.max_items).map((r) =>
    `- **${r.priority}** \`${r.id}\` ${r.title}${r.status === "acknowledged" ? ` (em acompanhamento${r.task_ref ? `: ${r.task_ref}` : ""})` : ""}\n` +
    `  Benefício: ${r.benefit}\n  Risco da ação: ${r.risk}. Ação proposta: ${r.proposed_action}`);
  const hidden = open.length - lines.length;
  return {
    title: `Revisão proativa de manutenção: ${open.length} recomendação(ões)`,
    message: redact([
      `Revisão técnica do servidor em ${iso(now)}. Registro rev. ${ledger.revision + 1}.`,
      ...lines,
      hidden > 0 ? `… e mais ${hidden}; consulte o registro completo.` : null,
      "Detalhes e evidências: `node scripts/proactive-maintenance-review.mjs status` e `show <id>`.",
    ].filter(Boolean).join("\n")),
  };
}

export function haRequest(servicePath, body, { tokenFile, host = "127.0.0.1", port = 8123, timeoutMs = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    const token = fs.readFileSync(tokenFile, "utf8").trim();
    const payload = JSON.stringify(body);
    const request = http.request({ host, port, path: servicePath, method: "POST", timeout: timeoutMs, headers: {
      Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload),
    } }, (response) => {
      response.resume();
      response.on("end", () => (response.statusCode >= 200 && response.statusCode < 300 ? resolve(response.statusCode)
        : reject(new Error(`home_assistant_api_${response.statusCode}`))));
    });
    request.on("timeout", () => request.destroy(new Error("home_assistant_api_timeout")));
    request.on("error", reject);
    request.end(payload);
  });
}

// Private channel: one closed JSON file in the fixed spool that the notification
// collector reads. Nothing is created in Home Assistant, so neither its
// frontend nor a phone ever shows it. `created_at` moves on every publication
// because the collector derives the event revision from it.
export function writeSpoolNotice(directory, id, notice, now) {
  const file = path.join(directory, `${id}.json`);
  if (!notice) {
    try { fs.unlinkSync(file); } catch (error) { if (error.code !== "ENOENT") throw error; }
    return;
  }
  const body = JSON.stringify({ schema_version: 1, notification_id: id, title: notice.title.slice(0, 200),
    message: notice.message.slice(0, 6000), created_at: iso(now) });
  if (Buffer.byteLength(body) > 16384) throw new Error("private_notice_over_budget");
  const temporary = path.join(directory, `.${id}.${process.pid}.tmp`);
  const fd = fs.openSync(temporary, "wx", 0o640);
  try { fs.fchmodSync(fd, 0o640); fs.writeSync(fd, body); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try { fs.renameSync(temporary, file); } catch (error) { fs.rmSync(temporary, { force: true }); throw error; }
}

async function publish(ledger, policy, now, send) {
  const digest = notificationDigest(ledger);
  const channel = policy.notification.channel;
  if (digest === ledger.notification.digest && !ledger.notification.pending && (ledger.notification.channel ?? "home_assistant") === channel) {
    return { state: "unchanged", channel };
  }
  const id = policy.notification.notification_id;
  const notice = openRecommendations(ledger).length === 0 ? null : renderNotification(ledger, policy, now);
  try {
    if (channel === "private_spool") writeSpoolNotice(policy.notification.spool_dir, id, notice, now);
    else if (notice) await send("/api/services/persistent_notification/create", { notification_id: id, ...notice });
    else await send("/api/services/persistent_notification/dismiss", { notification_id: id });
    ledger.notification = { digest, published_at: iso(now), pending: false, channel };
    return { state: "published", channel };
  } catch (error) {
    // Keep the old digest so the next run retries the same announcement once.
    ledger.notification.pending = true;
    return { state: "publication_failed", channel, reason: redact(error.code ?? error.message).slice(0, 120) };
  }
}

// ------------------------------------------------------ owner escalation --
// The owner hears about a recommendation only when it needs a person: it was
// explicitly escalated for a decision, or it has a priority listed in the
// policy and stayed unresolved past the allowed time. Everything else stays in
// the private channel. Recovery withdraws the owner notice.

export function escalatedRecommendations(ledger, policy, now) {
  const rule = policy.owner_escalation;
  return openRecommendations(ledger).filter((record) => record.owner_decision_required === true ||
    (rule.priorities.includes(record.priority) && now - Date.parse(record.first_seen_at) >= rule.unresolved_after_hours * 3600000));
}

export function renderEscalation(ledger, policy, now) {
  const items = escalatedRecommendations(ledger, policy, now);
  const lines = items.slice(0, policy.owner_escalation.max_items).map((r) =>
    `- **${r.priority}** ${r.title}\n  ${r.owner_decision_required ? `Decisão necessária: ${r.owner_decision_note ?? r.proposed_action}`
      : `Sem solução há ${Math.floor((now - Date.parse(r.first_seen_at)) / 3600000)} h. Ação proposta: ${r.proposed_action}`}`);
  return {
    title: `Manutenção do servidor: ${items.length} item(ns) precisam da sua atenção`,
    message: redact([...lines, items.length > lines.length ? `… e mais ${items.length - lines.length}.` : null,
      "Os demais achados técnicos seguem com a assistente e não geram aviso aqui."].filter(Boolean).join("\n")),
  };
}

async function publishEscalation(ledger, policy, now, send) {
  const rule = policy.owner_escalation;
  ledger.escalation ??= { digest: null, published_at: null, pending: false };
  const items = rule.enabled ? escalatedRecommendations(ledger, policy, now) : [];
  const digest = sha256(JSON.stringify(items.map((r) => [r.id, r.priority, r.signature, r.owner_decision_required === true])));
  const empty = sha256("[]");
  if ((digest === ledger.escalation.digest || (digest === empty && ledger.escalation.digest === null)) && !ledger.escalation.pending) {
    return { state: "unchanged", items: items.length };
  }
  try {
    if (items.length) await send("/api/services/persistent_notification/create", { notification_id: rule.notification_id, ...renderEscalation(ledger, policy, now) });
    else await send("/api/services/persistent_notification/dismiss", { notification_id: rule.notification_id });
    for (const record of items) if (!record.escalated_at) { record.escalated_at = iso(now); pushEvent(ledger, policy, now, "escalated_to_owner", record.id, { priority: record.priority }); }
    ledger.escalation = { digest, published_at: iso(now), pending: false };
    return { state: items.length ? "published" : "withdrawn", items: items.length };
  } catch (error) {
    ledger.escalation.pending = true;
    return { state: "publication_failed", items: items.length, reason: redact(error.code ?? error.message).slice(0, 120) };
  }
}

// ------------------------------------------------------------------ run --

export async function runReview({ policy = loadPolicy(), stateDir = DEFAULT_STATE_DIR, ctx, now = Date.now(), dryRun = false,
  publishNotification = true, send } = {}) {
  if (!policy.enabled || fs.existsSync(path.join(stateDir, "disabled"))) {
    return { state: "disabled", reason: policy.enabled ? "revocation_marker_present" : "policy_disabled" };
  }
  const context = ctx ?? createContext({ policy, now });
  const started = Date.now();
  const evidence = collectEvidence(context, context.sources ?? SOURCES);
  const findings = evaluate(evidence, policy);
  if (dryRun) return { state: "dry_run", evidence, findings };
  return withLock(stateDir, async () => {
    const ledger = readLedger(stateDir);
    const revision = ledger.revision;
    const last = ledger.runs.at(-1);
    const actions = runAutoActions(context, ledger, findings, evidence, stateDir, now);
    const announcements = reconcile(ledger, findings, evidence, policy, now);
    let publication = { state: "not_requested" };
    let escalation = { state: "not_requested" };
    if (publishNotification && policy.notification.enabled) {
      const tokenFile = path.join(context.repoRoot, ".local-secrets/ha-long-lived-token.txt");
      const deliver = send ?? ((servicePath, body) => haRequest(servicePath, body, { tokenFile }));
      publication = await publish(ledger, policy, now, deliver);
      escalation = await publishEscalation(ledger, policy, now, deliver);
    }
    ledger.runs.push({
      at: iso(now), duration_ms: Date.now() - started, sources: evidence.length,
      collection_errors: evidence.filter((item) => item.collection_error).map((item) => item.id),
      findings: findings.length, announcements: announcements.length, actions: actions.map((a) => `${a.action}:${a.state}`),
      publication: publication.state, channel: publication.channel ?? null, owner_escalation: escalation.state,
      previous_run_at: last?.at ?? null,
    });
    if (ledger.runs.length > policy.history.max_runs) ledger.runs.splice(0, ledger.runs.length - policy.history.max_runs);
    writeLedger(stateDir, ledger, revision);
    fs.writeFileSync(path.join(stateDir, "latest-evidence.json"), `${JSON.stringify({ observed_at: iso(now), evidence }, null, 1)}\n`, { mode: 0o600 });
    return { state: "completed", ledger_revision: ledger.revision, findings: findings.length, announcements, actions, publication,
      owner_escalation: escalation,
      open: openRecommendations(ledger).map((r) => ({ id: r.id, priority: r.priority, status: r.status, title: r.title })) };
  });
}

// Owner- or executor-driven status changes. `expectedRevision` is optional CAS.
export function updateRecommendation({ stateDir = DEFAULT_STATE_DIR, policy = loadPolicy(), id, status, taskRef = null, note = null,
  expectedRevision = null, ownerDecision = null, now = Date.now() }) {
  if (!["acknowledged", "dismissed", "open"].includes(status)) throw new Error("status_not_allowed");
  if (taskRef !== null && !/^[A-Za-z0-9._:-]{1,96}$/.test(taskRef)) throw new Error("task_ref_invalid");
  return withLock(stateDir, () => {
    const ledger = readLedger(stateDir);
    if (expectedRevision !== null && ledger.revision !== expectedRevision) throw new Error("ledger_revision_changed");
    const record = ledger.recommendations[id];
    if (!record) throw new Error("recommendation_not_found");
    if (record.status === "resolved") throw new Error("recommendation_already_resolved");
    const revision = ledger.revision;
    record.status = status;
    if (ownerDecision !== null) {
      // Explicit request for a human decision: the next run tells the owner.
      record.owner_decision_required = ownerDecision;
      record.owner_decision_note = ownerDecision && note ? redact(note).slice(0, 300) : null;
    }
    record.task_ref = taskRef ?? record.task_ref;
    record.note = note ? redact(note).slice(0, 300) : record.note;
    record.dismissed_until = status === "dismissed" ? iso(now + policy.dedupe.dismiss_default_hours * 3600000) : null;
    pushEvent(ledger, policy, now, ownerDecision === true ? "owner_decision_requested" : status, id, { task_ref: record.task_ref });
    writeLedger(stateDir, ledger, revision);
    return { id, status, task_ref: record.task_ref, owner_decision_required: record.owner_decision_required === true,
      ledger_revision: ledger.revision };
  });
}

export function rollbackAction({ stateDir = DEFAULT_STATE_DIR, policy = loadPolicy(), actionId, ctx, now = Date.now() }) {
  const context = ctx ?? createContext({ policy, now });
  return withLock(stateDir, () => {
    const ledger = readLedger(stateDir);
    const revision = ledger.revision;
    const record = ledger.actions.find((a) => a.action_id === actionId);
    if (!record || record.state !== "applied_verified") throw new Error("action_not_reversible");
    record.rollback = ACTIONS[record.action].rollback(context, record, stateDir);
    record.state = "rolled_back";
    pushEvent(ledger, policy, now, "action_rolled_back", record.recommendation, { action_id: actionId });
    writeLedger(stateDir, ledger, revision);
    return { action_id: actionId, state: record.state, ...record.rollback };
  });
}

// ------------------------------------------------------------------ CLI --

function parseArgs(argv) {
  const options = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json" || arg === "--dry-run" || arg === "--no-publish") options[arg.slice(2)] = true;
    else if (arg.startsWith("--")) { options[arg.slice(2)] = argv[index + 1]; index += 1; }
    else options._.push(arg);
  }
  return options;
}

async function main(argv) {
  const options = parseArgs(argv);
  const [command = "status", target] = options._;
  const policy = loadPolicy(options.policy ?? DEFAULT_POLICY_PATH);
  const stateDir = options["state-dir"] ?? DEFAULT_STATE_DIR;
  const expectedRevision = options["expected-revision"] === undefined ? null : Number(options["expected-revision"]);
  let output;
  if (command === "run") {
    output = await runReview({ policy, stateDir, dryRun: Boolean(options["dry-run"]), publishNotification: !options["no-publish"] });
  } else if (command === "status") {
    const ledger = readLedger(stateDir);
    output = { ledger_revision: ledger.revision, last_run: ledger.runs.at(-1) ?? null, notification: ledger.notification,
      enabled: policy.enabled && !fs.existsSync(path.join(stateDir, "disabled")),
      owner_escalation: { ...(ledger.escalation ?? { digest: null, published_at: null, pending: false }),
        current: escalatedRecommendations(ledger, policy, Date.now()).map((r) => r.id) },
      open: openRecommendations(ledger).map(({ id, priority, risk, status, title, benefit, proposed_action, task_ref, first_seen_at, last_seen_at, occurrences, owner_decision_required }) =>
        ({ id, priority, risk, status, title, benefit, proposed_action, task_ref, first_seen_at, last_seen_at, occurrences,
          owner_decision_required: owner_decision_required === true })),
      recent_events: ledger.events.slice(-10), recent_actions: ledger.actions.slice(-5) };
  } else if (command === "show") {
    const record = readLedger(stateDir).recommendations[target];
    if (!record) throw new Error("recommendation_not_found");
    output = record;
  } else if (command === "ack") {
    output = updateRecommendation({ stateDir, policy, id: target, status: "acknowledged", taskRef: options.task ?? null, note: options.note ?? null, expectedRevision });
  } else if (command === "dismiss") {
    output = updateRecommendation({ stateDir, policy, id: target, status: "dismissed", note: options.note ?? null, expectedRevision });
  } else if (command === "reopen") {
    output = updateRecommendation({ stateDir, policy, id: target, status: "open", note: options.note ?? null, expectedRevision });
  } else if (command === "escalate") {
    // Keeps the current status; only marks that a person has to decide.
    const current = readLedger(stateDir).recommendations[target];
    if (!current) throw new Error("recommendation_not_found");
    if (!options.note) throw new Error("decision_note_required");
    output = updateRecommendation({ stateDir, policy, id: target, status: current.status === "dismissed" ? "open" : current.status,
      note: options.note, ownerDecision: true, expectedRevision });
  } else if (command === "retire-legacy-notice") {
    // One-off removal of the Home Assistant notice used before the private
    // channel. Run it only after the private notice was read through the MCP.
    const legacy = "proactive_maintenance_review";
    if (policy.notification.channel !== "private_spool") throw new Error("private_channel_not_active");
    if (readLedger(stateDir).notification.channel !== "private_spool") throw new Error("private_publication_not_recorded");
    await haRequest("/api/services/persistent_notification/dismiss", { notification_id: legacy },
      { tokenFile: path.join(REPO_ROOT, ".local-secrets/ha-long-lived-token.txt") });
    output = { state: "legacy_notice_dismissed", notification_id: legacy };
  } else if (command === "sources") {
    output = SOURCES.map(({ id, origin }) => ({ id, origin }));
  } else if (command === "evidence") {
    const source = SOURCES.find((item) => item.id === target);
    if (!source) throw new Error("source_not_registered");
    const [item] = collectEvidence(createContext({ policy }), [source]);
    const text = JSON.stringify(item);
    if (Buffer.byteLength(text) > policy.budget.max_evidence_output_bytes) throw new Error("evidence_over_output_budget");
    output = item;
  } else if (command === "rollback-action") {
    output = rollbackAction({ stateDir, policy, actionId: target });
  } else {
    throw new Error("unknown_command");
  }
  process.stdout.write(`${JSON.stringify(output, null, options.json ? 0 : 1)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${JSON.stringify({ state: "error", reason: redact(error.message).slice(0, 160) })}\n`);
    process.exit(error.message === "review_busy" ? 75 : 1);
  });
}
