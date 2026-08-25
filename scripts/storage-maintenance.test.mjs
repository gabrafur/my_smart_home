import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "storage-maintenance.sh");

function fixture({ name = "storage-maintenance-test-" } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), name));
  const bin = path.join(root, "bin");
  const calls = path.join(root, "docker-calls");
  const meminfo = path.join(root, "meminfo");
  const filesystem = path.join(root, "filesystem");
  const metricsRoot = path.join(root, "metrics");
  const metricsFile = path.join(metricsRoot, "status.json");
  const tempRoot = path.join(root, "temporary");
  const nodeRedRoot = path.join(root, "Node RED data");
  fs.mkdirSync(bin);
  fs.mkdirSync(filesystem);
  fs.mkdirSync(metricsRoot);
  fs.mkdirSync(tempRoot);
  fs.mkdirSync(path.join(nodeRedRoot, ".npm", "_logs"), { recursive: true });
  fs.mkdirSync(path.join(nodeRedRoot, "backups", "codex-flows"), { recursive: true });
  fs.writeFileSync(meminfo, "MemAvailable:       4194304 kB\n");
  fs.writeFileSync(path.join(bin, "docker"), String.raw`#!/bin/sh
printf '%s\n' "$*" >> "$FAKE_DOCKER_CALLS"
if [ "$FAKE_DOCKER_DOWN" = 1 ] && [ "$1" = info ]; then exit 1; fi
case "$1 $2" in
  "info ") exit 0 ;;
  "system df")
    case " $* " in
      *" --format "*) printf '%s\n' '{"Type":"Images","Size":"2GB"}' '{"Type":"Build Cache","Size":"500MB"}' ;;
      *) printf '%s\n' 'TYPE TOTAL ACTIVE SIZE RECLAIMABLE' ;;
    esac
    ;;
  "image ls") : ;;
  "image prune") printf '%s\n' 'Total reclaimed space: 0B' ;;
  "image rm") : ;;
  "builder du") printf '%s\n' 'Reclaimable: 500MB' ;;
  "builder prune") printf '%s\n' 'Total reclaimed: 0B' ;;
  "ps -a") : ;;
esac
`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "df"), String.raw`#!/bin/sh
case " $* " in
  *" -Pi "*) printf '%s\n' 'Filesystem Inodes IUsed IFree IUse% Mounted on' '/dev/test 10000 1000 9000 10% /test' ;;
  *" -B1 "*) printf '%s\n' 'Filesystem 1B-blocks Used Available Capacity Mounted on' "/dev/test 10000000000 7000000000 3000000000 70% $FAKE_FILESYSTEM" ;;
  *" -P "*) printf '%s\n' 'Filesystem 1024-blocks Used Available Capacity Mounted on' "/dev/test 10000000 7000000 3000000 70% $FAKE_FILESYSTEM" ;;
  *) exit 2 ;;
esac
`, { mode: 0o755 });
  return {
    root,
    calls,
    meminfo,
    filesystem,
    metricsRoot,
    metricsFile,
    tempRoot,
    nodeRedRoot,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      FAKE_DOCKER_CALLS: calls,
      FAKE_FILESYSTEM: filesystem,
      STORAGE_MAINTENANCE_FILESYSTEM: filesystem,
      STORAGE_MAINTENANCE_LOCK_PATH: root,
      STORAGE_MAINTENANCE_MEMINFO_FILE: meminfo,
      STORAGE_MAINTENANCE_METRICS_ROOT: metricsRoot,
      STORAGE_MAINTENANCE_METRICS_FILE: metricsFile,
      STORAGE_MAINTENANCE_TEMP_ROOT: tempRoot,
      STORAGE_MAINTENANCE_NODE_RED_ROOT: nodeRedRoot,
    },
  };
}

function removeFixture(item) {
  fs.rmSync(item.root, { recursive: true, force: true });
}

test("dry-run inventories without changing candidates or status files", () => {
  const item = fixture();
  const candidate = path.join(item.nodeRedRoot, ".npm", "_logs", "old log.txt");
  fs.writeFileSync(candidate, "discardable");
  fs.utimesSync(candidate, new Date(0), new Date(0));
  const result = spawnSync(script, [
    "--dry-run",
    "--category", "report",
    "--category", "docker-images",
    "--category", "docker-build-cache",
    "--category", "project-artifacts",
    "--log-retention-days", "0",
  ], { encoding: "utf8", env: item.env });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(fs.existsSync(candidate));
  assert.ok(!fs.existsSync(item.metricsFile));
  const calls = fs.readFileSync(item.calls, "utf8");
  assert.match(calls, /system df/);
  assert.doesNotMatch(calls, /builder prune|image prune|image rm|volume|system prune/);
  assert.match(result.stdout, /status=success mode=dry-run/);
  removeFixture(item);
});

test("apply enforces bounded cache and image policy without broad prune", () => {
  const item = fixture();
  const result = spawnSync(script, [
    "--apply",
    "--category", "docker-images",
    "--category", "docker-build-cache",
    "--min-age", "24",
    "--max-build-cache", "2GB",
  ], { encoding: "utf8", env: item.env });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const calls = fs.readFileSync(item.calls, "utf8");
  assert.match(calls, /builder prune --all --force --max-used-space 2GB/);
  assert.match(calls, /image prune --force --filter until=24h/);
  assert.doesNotMatch(calls, /volume|container prune|system prune|image prune -a/);
  const metrics = JSON.parse(fs.readFileSync(item.metricsFile, "utf8"));
  assert.equal(metrics.docker_logical_bytes, 2_500_000_000);
  assert.equal(metrics.last_result, "success");
  removeFixture(item);
});

test("apply refuses resource pressure before cleanup", () => {
  const item = fixture();
  fs.writeFileSync(item.meminfo, "MemAvailable:       1048576 kB\n");
  const result = spawnSync(script, ["--apply", "--category", "docker-build-cache"], {
    encoding: "utf8",
    env: item.env,
  });
  assert.equal(result.status, 75);
  assert.match(result.stderr, /low-available-memory/);
  assert.ok(!fs.existsSync(item.calls));
  assert.ok(!fs.existsSync(item.metricsFile));
  removeFixture(item);
});

test("allowlisted project artifacts support spaces and are idempotent", () => {
  const item = fixture();
  const candidate = path.join(item.nodeRedRoot, ".npm", "_logs", "old log with spaces.txt");
  fs.writeFileSync(candidate, "regenerable");
  fs.utimesSync(candidate, new Date(0), new Date(0));
  const args = ["--apply", "--category", "project-artifacts", "--log-retention-days", "0"];
  const first = spawnSync(script, args, { encoding: "utf8", env: item.env });
  assert.equal(first.status, 0, first.stdout + first.stderr);
  assert.ok(!fs.existsSync(candidate));
  assert.match(first.stdout, /removed action=old-npm-log/);
  const second = spawnSync(script, args, { encoding: "utf8", env: item.env });
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /removed_count=0/);
  removeFixture(item);
});

test("an unreadable allowlisted directory fails closed", () => {
  const item = fixture();
  const logs = path.join(item.nodeRedRoot, ".npm", "_logs");
  fs.chmodSync(logs, 0o000);
  const result = spawnSync(script, ["--dry-run", "--category", "project-artifacts"], {
    encoding: "utf8",
    env: item.env,
  });
  fs.chmodSync(logs, 0o755);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /status=failed/);
  removeFixture(item);
});

test("Docker absence is a safe partial result", () => {
  const item = fixture();
  const result = spawnSync(script, ["--dry-run", "--category", "docker-images"], {
    encoding: "utf8",
    env: { ...item.env, FAKE_DOCKER_DOWN: "1" },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /reason=docker-unavailable/);
  assert.match(result.stdout, /status=partial mode=dry-run/);
  removeFixture(item);
});

test("empty and symlinked paths are rejected", () => {
  const emptyItem = fixture();
  const empty = spawnSync(script, ["--dry-run", "--category", "report"], {
    encoding: "utf8",
    env: { ...emptyItem.env, STORAGE_MAINTENANCE_METRICS_FILE: "" },
  });
  assert.equal(empty.status, 64);
  assert.match(empty.stderr, /metrics-file-is-empty/);
  removeFixture(emptyItem);

  const linkItem = fixture({ name: "storage-maintenance-symlink-test-" });
  const link = path.join(linkItem.root, "node-red-link");
  fs.symlinkSync(linkItem.nodeRedRoot, link);
  const linked = spawnSync(script, ["--dry-run", "--category", "project-artifacts"], {
    encoding: "utf8",
    env: { ...linkItem.env, STORAGE_MAINTENANCE_NODE_RED_ROOT: link },
  });
  assert.equal(linked.status, 65);
  assert.match(linked.stderr, /node-red-root-cannot-be-a-symlink/);
  removeFixture(linkItem);
});

test("privileged categories do not escalate privileges", () => {
  const item = fixture();
  const result = spawnSync(script, ["--apply", "--category", "apt-cache", "--allow-privileged-cleanup"], {
    encoding: "utf8",
    env: item.env,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /apt-cache-requires-root/);
  assert.match(result.stdout, /status=partial mode=apply/);
  removeFixture(item);
});

test("flock prevents concurrent executions", async () => {
  const item = fixture();
  const holder = spawn("bash", ["-c", 'exec 8<"$1"; flock 8; printf "ready\\n"; sleep 10', "holder", item.root], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((resolve, reject) => {
    holder.stdout.once("data", resolve);
    holder.once("error", reject);
  });
  const result = spawnSync(script, ["--dry-run", "--category", "report"], {
    encoding: "utf8",
    env: item.env,
  });
  holder.kill("SIGTERM");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /reason=already-running/);
  assert.ok(!fs.existsSync(item.metricsFile));
  removeFixture(item);
});
