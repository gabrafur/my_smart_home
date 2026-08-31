#!/usr/bin/env node

import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateSnapshot,
  parseMeminfo,
  parseProcStat,
  parseSshConnection,
  runGuardian,
  sshConnectionState,
} from "./host-memory-guardian.mjs";

const MiB = 1024;

function extensionHost({
  pid,
  startTicks,
  connectionState,
  rssKiB = 600 * MiB,
  cpuTicks = 100,
  ageSeconds = 7200,
}) {
  return {
    pid,
    ppid: 1,
    uid: 1001,
    startTicks,
    connectionState,
    rssKiB,
    cpuTicks,
    ageSeconds,
    cmdline: "/home/user/.vscode-server/server/node bootstrap-fork --type=extensionHost --transformURIs",
  };
}

function snapshot({ nowMs = 1_000_000, availableMiB = 1024, processes = [] } = {}) {
  return {
    nowMs,
    totalKiB: 8 * 1024 * MiB,
    availableKiB: availableMiB * MiB,
    selfUid: 1001,
    clockTicks: 100,
    processes,
  };
}

test("parsers reject incomplete host telemetry and preserve process counters", () => {
  assert.deepEqual(
    parseMeminfo("MemTotal:        8192000 kB\nMemAvailable:   1024000 kB\n"),
    { totalKiB: 8_192_000, availableKiB: 1_024_000 },
  );
  assert.throws(() => parseMeminfo("MemTotal: 1 kB\n"), /meminfo_missing/);

  const fields = ["S", "1", "0", "0", "0", "0", "0", "0", "0", "0", "0", "12", "8", "0", "0", "0", "0", "0", "1", "4000"];
  assert.deepEqual(parseProcStat(`42 (extension host) ${fields.join(" ")}`), {
    pid: 42,
    ppid: 1,
    cpuTicks: 20,
    startTicks: 4000,
  });
});

test("SSH activity is proven by the exact four-tuple", () => {
  const connection = parseSshConnection("100.64.0.5 50123 100.64.0.10 22");
  assert.equal(
    sshConnectionState(connection, "0 0 100.64.0.10:22 100.64.0.5:50123\n"),
    "connected",
  );
  assert.equal(
    sshConnectionState(connection, "0 0 1100.64.0.10:22 1100.64.0.5:50123\n"),
    "disconnected",
  );
  assert.equal(
    sshConnectionState(connection, "0 0 100.64.0.10:220 100.64.0.5:501230\n"),
    "disconnected",
  );
  assert.equal(sshConnectionState(connection, ""), "disconnected");
  assert.equal(sshConnectionState(null, ""), "unknown");
});

test("healthy memory and a single active session never arm cleanup", () => {
  const active = extensionHost({ pid: 200, startTicks: 20_000, connectionState: "connected" });
  assert.equal(evaluateSnapshot(snapshot({ availableMiB: 4096, processes: [active] })).decision.status, "healthy");
  assert.equal(evaluateSnapshot(snapshot({ processes: [active] })).decision.status, "pressure_no_safe_duplicate");
});

test("a standalone disconnected session is cleaned even with healthy memory", () => {
  const stale = extensionHost({ pid: 100, startTicks: 10_000, connectionState: "disconnected" });
  const first = evaluateSnapshot(snapshot({ availableMiB: 4096, processes: [stale] }));
  assert.equal(first.decision.status, "candidate_observed");
  assert.equal(first.decision.action, "none");

  const second = evaluateSnapshot(
    snapshot({
      nowMs: 1_060_000,
      availableMiB: 4096,
      processes: [{ ...stale, cpuTicks: 105 }],
    }),
    first.state,
  );
  assert.equal(second.decision.status, "terminate");
  assert.equal(second.decision.candidate.pid, 100);
});

test("ambiguous standalone sessions fail closed without memory pressure", () => {
  const unknown = extensionHost({ pid: 100, startTicks: 10_000, connectionState: "unknown" });
  assert.equal(
    evaluateSnapshot(snapshot({ availableMiB: 4096, processes: [unknown] })).decision.status,
    "healthy",
  );
});

test("two connected sessions and ambiguous connectivity fail closed", () => {
  const oldConnected = extensionHost({ pid: 100, startTicks: 10_000, connectionState: "connected" });
  const newest = extensionHost({ pid: 200, startTicks: 20_000, connectionState: "connected" });
  let result = evaluateSnapshot(snapshot({ processes: [oldConnected, newest] }));
  assert.equal(result.decision.status, "pressure_no_safe_candidate");

  const ambiguous = { ...oldConnected, connectionState: "unknown" };
  result = evaluateSnapshot(snapshot({ processes: [ambiguous, newest] }));
  assert.equal(result.decision.status, "pressure_no_safe_candidate");
});

test("a stale duplicate must remain idle for consecutive observations", () => {
  const old = extensionHost({ pid: 100, startTicks: 10_000, connectionState: "disconnected" });
  const newest = extensionHost({ pid: 200, startTicks: 20_000, connectionState: "connected" });
  const first = evaluateSnapshot(snapshot({ processes: [old, newest] }));
  assert.equal(first.decision.status, "candidate_observed");
  assert.equal(first.decision.action, "none");

  const secondSnapshot = snapshot({
    nowMs: 1_060_000,
    processes: [{ ...old, cpuTicks: 105 }, { ...newest, cpuTicks: 120 }],
  });
  const second = evaluateSnapshot(secondSnapshot, first.state);
  assert.equal(second.decision.status, "terminate");
  assert.equal(second.decision.candidate.pid, 100);
  assert.ok(second.decision.candidate.rssKiB >= 600 * MiB);
});

test("CPU activity, small trees, young sessions, and essential descendants block termination", () => {
  const old = extensionHost({ pid: 100, startTicks: 10_000, connectionState: "disconnected" });
  const newest = extensionHost({ pid: 200, startTicks: 20_000, connectionState: "connected" });
  const first = evaluateSnapshot(snapshot({ processes: [old, newest] }));
  let result = evaluateSnapshot(
    snapshot({ nowMs: 1_060_000, processes: [{ ...old, cpuTicks: 1000 }, newest] }),
    first.state,
  );
  assert.equal(result.decision.status, "candidate_active");

  result = evaluateSnapshot(snapshot({ processes: [{ ...old, rssKiB: 10 * MiB }, newest] }));
  assert.equal(result.decision.status, "pressure_no_safe_candidate");

  result = evaluateSnapshot(snapshot({ processes: [{ ...old, ageSeconds: 60 }, newest] }));
  assert.equal(result.decision.status, "pressure_no_safe_candidate");

  const essentialChild = {
    pid: 101,
    ppid: 100,
    uid: 1001,
    startTicks: 10_100,
    cpuTicks: 0,
    rssKiB: 10 * MiB,
    ageSeconds: 7000,
    connectionState: "unknown",
    cmdline: "/usr/bin/dockerd",
  };
  result = evaluateSnapshot(snapshot({ processes: [old, essentialChild, newest] }));
  assert.equal(result.decision.status, "pressure_no_safe_candidate");
});

test("cooldown prevents serial cleanup actions", () => {
  const old = extensionHost({ pid: 100, startTicks: 10_000, connectionState: "disconnected" });
  const newest = extensionHost({ pid: 200, startTicks: 20_000, connectionState: "connected" });
  const first = evaluateSnapshot(snapshot({ processes: [old, newest] }));
  const prior = { ...first.state, lastActionAt: 1_030_000 };
  const result = evaluateSnapshot(
    snapshot({ nowMs: 1_060_000, processes: [{ ...old, cpuTicks: 101 }, newest] }),
    prior,
  );
  assert.equal(result.decision.status, "pressure_cooldown");
});

test("dry-run reaches the action boundary without sending a signal", () => {
  const old = extensionHost({ pid: 100, startTicks: 10_000, connectionState: "disconnected" });
  const newest = extensionHost({ pid: 200, startTicks: 20_000, connectionState: "connected" });
  const first = evaluateSnapshot(snapshot({ processes: [old, newest] }));
  const ready = snapshot({ nowMs: 1_060_000, processes: [{ ...old, cpuTicks: 101 }, newest] });
  let calls = 0;
  const result = runGuardian({
    snapshot: ready,
    previousState: first.state,
    dryRun: true,
    terminate() { calls += 1; return 1; },
  });
  assert.equal(result.decision.status, "would_terminate");
  assert.equal(result.terminated, 0);
  assert.equal(calls, 0);
});

test("production invokes only the prevalidated candidate once", () => {
  const old = extensionHost({ pid: 100, startTicks: 10_000, connectionState: "disconnected" });
  const newest = extensionHost({ pid: 200, startTicks: 20_000, connectionState: "connected" });
  const first = evaluateSnapshot(snapshot({ processes: [old, newest] }));
  const ready = snapshot({ nowMs: 1_060_000, processes: [{ ...old, cpuTicks: 101 }, newest] });
  const seen = [];
  const result = runGuardian({
    snapshot: ready,
    previousState: first.state,
    terminate(candidate) { seen.push(candidate.pid); return candidate.tree.length; },
  });
  assert.deepEqual(seen, [100]);
  assert.equal(result.decision.status, "terminated");
  assert.equal(result.state.lastActionAt, ready.nowMs);
});
