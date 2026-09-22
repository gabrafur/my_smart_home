#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  evaluateSnapshot,
  parseMeminfo,
  parseProcStat,
  parseSshConnection,
  readProcessEntries,
  reclaimTemporaryArtifacts,
  runGuardian,
  sshConnectionState,
} from "./host-memory-guardian.mjs";

const MiB = 1024;

function ageTree(root, date = new Date(0)) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) ageTree(target, date);
    if (entry.isSymbolicLink()) fs.lutimesSync(target, date, date);
    else fs.utimesSync(target, date, date);
  }
  fs.utimesSync(root, date, date);
}

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

test("temporary process scan retries transient failures and still fails closed", () => {
  let calls = 0;
  const waits = [];
  const expected = ["123", "self", "meminfo"];
  const recovered = readProcessEntries("/proc", {
    retryDelayMs: 10,
    readDirectory(root, options) {
      calls += 1;
      assert.equal(root, "/proc");
      assert.equal(options, undefined, "enumeration must not stat entries that can disappear");
      if (calls < 3) {
        const error = new Error("temporarily unavailable");
        error.code = "EAGAIN";
        throw error;
      }
      return expected;
    },
    wait(delayMs) { waits.push(delayMs); },
  });
  assert.equal(recovered, expected);
  assert.equal(calls, 3);
  assert.deepEqual(waits, [10, 20]);

  let permanentCalls = 0;
  assert.throws(() => readProcessEntries("/missing-proc", {
    retryDelayMs: 0,
    readDirectory() {
      permanentCalls += 1;
      const error = new Error("missing");
      error.code = "ENOENT";
      throw error;
    },
    wait() {},
  }), /temporary_process_scan_unavailable_ENOENT/);
  assert.equal(permanentCalls, 1);
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

test("temporary cleanup removes only old allowlisted and inactive trees", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "host-memory-cleanup-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const temporaryRoot = path.join(root, "tmp");
  const procRoot = path.join(root, "proc");
  const prefixFile = path.join(root, "prefixes.txt");
  fs.mkdirSync(temporaryRoot);
  fs.mkdirSync(procRoot);
  fs.writeFileSync(prefixFile, "safe-fixture-\n");

  const create = (name, old = true) => {
    const directory = path.join(temporaryRoot, name);
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, "payload"), Buffer.alloc(8192, 1));
    if (old) ageTree(directory);
    return directory;
  };
  const removable = create("safe-fixture-removable");
  const active = create("safe-fixture-active");
  const recent = create("safe-fixture-recent", false);
  const unknown = create("other-fixture-old");
  const external = path.join(root, "must-survive");
  fs.writeFileSync(external, "preserved");
  fs.symlinkSync(external, path.join(removable, "external-link"));
  ageTree(removable);

  const pidRoot = path.join(procRoot, "123");
  fs.mkdirSync(path.join(pidRoot, "fd"), { recursive: true });
  fs.writeFileSync(path.join(pidRoot, "status"), `Name:\ttest\nUid:\t${process.getuid()}\t${process.getuid()}\t${process.getuid()}\t${process.getuid()}\n`);
  fs.symlinkSync(path.join(active, "payload"), path.join(pidRoot, "fd", "3"));

  const input = {
    snapshot: { ...snapshot({ availableMiB: 1024 }), selfUid: process.getuid() },
    temporaryRoot,
    prefixFile,
    procRoot,
    nowMs: Date.now(),
    config: { temporaryMinimumAgeSeconds: 60, maximumTemporaryReclaimKiB: 1024 },
  };
  const preview = reclaimTemporaryArtifacts({ ...input, dryRun: true });
  assert.equal(preview.selectedCount, 1);
  assert.ok(fs.existsSync(removable));

  const applied = reclaimTemporaryArtifacts(input);
  assert.equal(applied.removedCount, 1);
  assert.ok(applied.reclaimedBytes > 0);
  assert.ok(!fs.existsSync(removable));
  assert.ok(fs.existsSync(active));
  assert.ok(fs.existsSync(recent));
  assert.ok(fs.existsSync(unknown));
  assert.equal(fs.readFileSync(external, "utf8"), "preserved");
});

test("temporary cleanup fails closed for an invalid prefix contract", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "host-memory-prefix-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const prefixFile = path.join(root, "prefixes.txt");
  fs.writeFileSync(prefixFile, "../\n");
  assert.throws(() => reclaimTemporaryArtifacts({
    snapshot: { ...snapshot(), selfUid: process.getuid() },
    temporaryRoot: root,
    prefixFile,
    procRoot: path.join(root, "missing-proc"),
  }), /temporary_prefix_invalid/);
});
