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
  const userHome = path.join(root, "user home");
  const userCacheRoot = path.join(userHome, ".cache");
  const npmCacheRoot = path.join(userHome, ".npm");
  const pm2Root = path.join(userHome, ".pm2");
  const vscodeRoot = path.join(userHome, ".vscode-server");
  const cursorRoot = path.join(userHome, ".cursor-server");
  fs.mkdirSync(bin);
  fs.mkdirSync(filesystem);
  fs.mkdirSync(metricsRoot);
  fs.mkdirSync(tempRoot);
  fs.mkdirSync(path.join(userCacheRoot, "pip"), { recursive: true });
  fs.mkdirSync(path.join(npmCacheRoot, "_cacache"), { recursive: true });
  fs.mkdirSync(path.join(pm2Root, "logs"), { recursive: true });
  fs.mkdirSync(path.join(vscodeRoot, "cli", "servers"), { recursive: true });
  fs.mkdirSync(path.join(vscodeRoot, "data", "CachedExtensionVSIXs"), { recursive: true });
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
  "image ls")
    case " $* " in
      *" --all "*) [ -z "$FAKE_DOCKER_IMAGE_LIST" ] || printf '%b\n' "$FAKE_DOCKER_IMAGE_LIST" ;;
    esac
    ;;
  "image inspect")
    case "$*" in
      *"{{.Created}}"*) printf '%s\n' '2020-01-01T00:00:00Z' ;;
      *"{{.Size}}"*) printf '%s\n' '500000000' ;;
    esac
    ;;
  "inspect --format") [ -z "$FAKE_HA_CONFIG_SOURCE" ] || printf '%s\n' "$FAKE_HA_CONFIG_SOURCE" ;;
  "exec homeassistant")
    if [ "$3" = rm ] && [ "$4" = -- ]; then
      chmod u+w "$FAKE_HA_CONFIG_SOURCE/backups"
      rm -- "$FAKE_HA_CONFIG_SOURCE/backups/$(basename -- "$5")"
    fi
    ;;
  "image prune") printf '%s\n' 'Total reclaimed space: 0B' ;;
  "image rm") : ;;
  "builder du") printf '%s\n' 'Reclaimable: 500MB' ;;
  "builder prune") printf '%s\n' 'Total reclaimed: 0B' ;;
  "ps -a") : ;;
esac
`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "npm"), String.raw`#!/bin/sh
printf '%s\n' "$*" >> "$FAKE_NPM_CALLS"
case "$1 $2" in
  "config get") printf '%s\n' "$FAKE_NPM_CACHE" ;;
  "cache verify") printf '%s\n' 'Cache verified' ;;
  "cache clean") find "$FAKE_NPM_CACHE/_cacache" -mindepth 1 -delete 2>/dev/null || true ;;
esac
`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "python3"), String.raw`#!/bin/sh
printf '%s\n' "$*" >> "$FAKE_PYTHON_CALLS"
case "$*" in
  "-m pip --version") printf '%s\n' 'pip 1.0' ;;
  "-m pip cache dir") printf '%s\n' "$FAKE_PIP_CACHE" ;;
  "-m pip cache info") printf '%s\n' 'Package index page cache size: 1 MB' ;;
  "-m pip cache purge") find "$FAKE_PIP_CACHE" -mindepth 1 -delete 2>/dev/null || true ;;
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
    userHome,
    userCacheRoot,
    npmCacheRoot,
    pm2Root,
    vscodeRoot,
    cursorRoot,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      FAKE_DOCKER_CALLS: calls,
      FAKE_FILESYSTEM: filesystem,
      FAKE_NPM_CALLS: path.join(root, "npm-calls"),
      FAKE_NPM_CACHE: npmCacheRoot,
      FAKE_PYTHON_CALLS: path.join(root, "python-calls"),
      FAKE_PIP_CACHE: path.join(userCacheRoot, "pip"),
      STORAGE_MAINTENANCE_FILESYSTEM: filesystem,
      STORAGE_MAINTENANCE_LOCK_PATH: root,
      STORAGE_MAINTENANCE_MEMINFO_FILE: meminfo,
      STORAGE_MAINTENANCE_METRICS_ROOT: metricsRoot,
      STORAGE_MAINTENANCE_METRICS_FILE: metricsFile,
      STORAGE_MAINTENANCE_TEMP_ROOT: tempRoot,
      STORAGE_MAINTENANCE_NODE_RED_ROOT: nodeRedRoot,
      STORAGE_MAINTENANCE_USER_HOME: userHome,
      STORAGE_MAINTENANCE_USER_CACHE_ROOT: userCacheRoot,
      STORAGE_MAINTENANCE_NPM_CACHE_ROOT: npmCacheRoot,
      STORAGE_MAINTENANCE_PM2_ROOT: pm2Root,
      STORAGE_MAINTENANCE_VSCODE_ROOT: vscodeRoot,
      STORAGE_MAINTENANCE_CURSOR_ROOT: cursorRoot,
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
  assert.match(calls, /image ls --all --no-trunc/);
  assert.doesNotMatch(calls, /image prune/);
  assert.doesNotMatch(calls, /volume|container prune|system prune|image prune -a/);
  const metrics = JSON.parse(fs.readFileSync(item.metricsFile, "utf8"));
  assert.equal(metrics.docker_logical_bytes, 2_500_000_000);
  assert.equal(metrics.last_result, "success");
  removeFixture(item);
});

test("containerd-only untagged images are explicitly removed after safety checks", () => {
  const item = fixture();
  const removable = `sha256:${["unreferenced", "fixture", "image"].join("-")}`;
  const result = spawnSync(script, ["--apply", "--category", "docker-images"], {
    encoding: "utf8",
    env: {
      ...item.env,
      FAKE_DOCKER_IMAGE_LIST: `${removable}\\t<none>\\t<none>\\t0`,
    },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /candidate action=untagged-unreferenced-image/);
  const calls = fs.readFileSync(item.calls, "utf8");
  assert.match(calls, /image ls --all --no-trunc/);
  assert.match(calls, new RegExp(`ps -aq --filter ancestor=${removable}`));
  assert.match(calls, new RegExp(`image rm ${removable}`));
  removeFixture(item);
});

test("untagged images pinned by repository digest are preserved", () => {
  const item = fixture();
  const pinned = "sha256:storage-maintenance-referenced-fixture";
  const result = spawnSync(script, ["--apply", "--category", "docker-images"], {
    encoding: "utf8",
    env: {
      ...item.env,
      FAKE_DOCKER_IMAGE_LIST: `${pinned}\\t<none>\\t<none>\\t0`,
    },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /reason=repository-reference/);
  assert.doesNotMatch(fs.readFileSync(item.calls, "utf8"), /image rm sha256:storage-maintenance-referenced-fixture/);
  removeFixture(item);
});

test("automatic HA backup retention keeps only the two newest archives", () => {
  const item = fixture();
  const backupRoot = path.join(item.root, "ha-backups");
  fs.mkdirSync(backupRoot);
  const archives = ["one.tar", "two.tar", "three.tar", "four.tar"];
  archives.forEach((name, index) => {
    const target = path.join(backupRoot, name);
    fs.writeFileSync(target, name);
    const when = new Date(Date.UTC(2026, 0, index + 1));
    fs.utimesSync(target, when, when);
  });
  const manualSnapshot = path.join(backupRoot, "manual-snapshot.db");
  fs.writeFileSync(manualSnapshot, "preserve");
  const result = spawnSync(script, ["--apply", "--category", "home-assistant-backups"], {
    encoding: "utf8",
    env: {
      ...item.env,
      STORAGE_MAINTENANCE_HA_BACKUP_ROOT: backupRoot,
    },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(fs.readdirSync(backupRoot).sort(), ["four.tar", "manual-snapshot.db", "three.tar"]);
  removeFixture(item);
});

test("HA backup retention uses the validated container mount for root-owned archives", () => {
  const item = fixture();
  const configRoot = path.join(item.root, "ha-config");
  const backupRoot = path.join(configRoot, "backups");
  fs.mkdirSync(backupRoot, { recursive: true });
  for (const [index, name] of ["one.tar", "two.tar", "three.tar"].entries()) {
    const target = path.join(backupRoot, name);
    fs.writeFileSync(target, name);
    const when = new Date(Date.UTC(2026, 0, index + 1));
    fs.utimesSync(target, when, when);
  }
  fs.chmodSync(backupRoot, 0o555);
  const result = spawnSync(script, ["--apply", "--category", "home-assistant-backups"], {
    encoding: "utf8",
    env: {
      ...item.env,
      FAKE_HA_CONFIG_SOURCE: configRoot,
      STORAGE_MAINTENANCE_HA_CONFIG_ROOT: configRoot,
      STORAGE_MAINTENANCE_HA_BACKUP_ROOT: backupRoot,
    },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(fs.readdirSync(backupRoot).sort(), ["three.tar", "two.tar"]);
  assert.match(fs.readFileSync(item.calls, "utf8"), /exec homeassistant rm -- \/config\/backups\/one\.tar/);
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

test("supported npm and pip cleanup preserve projects and are idempotent", () => {
  const item = fixture();
  const npmCached = path.join(item.npmCacheRoot, "_cacache", "cached package");
  const pipCached = path.join(item.userCacheRoot, "pip", "cached wheel");
  const projectModules = path.join(item.root, "project", "node_modules", "kept.txt");
  fs.writeFileSync(npmCached, "npm cache");
  fs.writeFileSync(pipCached, "pip cache");
  fs.mkdirSync(path.dirname(projectModules), { recursive: true });
  fs.writeFileSync(projectModules, "installed dependency");
  const args = ["--apply", "--category", "npm-cache", "--category", "python-cache"];
  const first = spawnSync(script, args, { encoding: "utf8", env: item.env });
  assert.equal(first.status, 0, first.stdout + first.stderr);
  assert.ok(!fs.existsSync(npmCached));
  assert.ok(!fs.existsSync(pipCached));
  assert.equal(fs.readFileSync(projectModules, "utf8"), "installed dependency");
  assert.match(fs.readFileSync(item.env.FAKE_NPM_CALLS, "utf8"), /cache clean --force/);
  assert.match(fs.readFileSync(item.env.FAKE_PYTHON_CALLS, "utf8"), /-m pip cache purge/);
  const second = spawnSync(script, args, { encoding: "utf8", env: item.env });
  assert.equal(second.status, 0, second.stdout + second.stderr);
  removeFixture(item);
});

test("PM2 logs rotate with copytruncate and bounded compressed retention", () => {
  const item = fixture();
  const active = path.join(item.pm2Root, "pm2.log");
  fs.writeFileSync(active, "active log content");
  const result = spawnSync(script, [
    "--apply", "--category", "pm2-logs",
    "--pm2-log-max-bytes", "1",
    "--pm2-log-retention-files", "7",
  ], { encoding: "utf8", env: item.env });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(fs.readFileSync(active, "utf8"), "");
  const rotations = fs.readdirSync(item.pm2Root).filter((name) => /^pm2\.log\.\d{8}T\d{6}Z\.gz$/.test(name));
  assert.equal(rotations.length, 1);
  const second = spawnSync(script, [
    "--apply", "--category", "pm2-logs", "--pm2-log-max-bytes", "1",
  ], { encoding: "utf8", env: item.env });
  assert.equal(second.status, 0, second.stdout + second.stderr);
  assert.match(second.stdout, /removed_count=0/);
  removeFixture(item);
});

test("VS Code cleanup needs no prompt and preserves the newest versions", () => {
  const item = fixture();
  const servers = path.join(item.vscodeRoot, "cli", "servers");
  const versions = ["old-version", "rollback-version", "current-version"];
  versions.forEach((version, index) => {
    const directory = path.join(servers, `Stable-${version}`);
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, "server file"), version);
    const timestamp = new Date((index + 1) * 1000);
    fs.utimesSync(directory, timestamp, timestamp);
  });
  const result = spawnSync(script, [
    "--apply", "--category", "vscode-versions", "--vscode-keep-versions", "2",
  ], { encoding: "utf8", env: item.env });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(!fs.existsSync(path.join(servers, "Stable-old-version")));
  assert.ok(fs.existsSync(path.join(servers, "Stable-rollback-version")));
  assert.ok(fs.existsSync(path.join(servers, "Stable-current-version")));
  removeFixture(item);
});

test("VS Code cache cleanup is allowlisted and does not remove installed extensions", () => {
  const item = fixture();
  const cached = path.join(item.vscodeRoot, "data", "CachedExtensionVSIXs", "cached extension with spaces");
  const installed = path.join(item.vscodeRoot, "extensions", "publisher.extension", "extension.js");
  fs.writeFileSync(cached, "download cache");
  fs.mkdirSync(path.dirname(installed), { recursive: true });
  fs.writeFileSync(installed, "installed");
  const result = spawnSync(script, ["--apply", "--category", "vscode-cache"], {
    encoding: "utf8", env: item.env,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(!fs.existsSync(cached));
  assert.equal(fs.readFileSync(installed, "utf8"), "installed");
  removeFixture(item);
});

test("extended metrics remain schema-compatible and exclude private content", () => {
  const item = fixture();
  fs.writeFileSync(path.join(item.pm2Root, "logs", "application.log"), "log");
  const result = spawnSync(script, [
    "--apply", "--category", "developer-tools", "--category", "deleted-open-files",
  ], { encoding: "utf8", env: item.env });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const metrics = JSON.parse(fs.readFileSync(item.metricsFile, "utf8"));
  assert.equal(metrics.schema_version, 1);
  assert.equal(metrics.cursor_server_logical_bytes, 0);
  assert.equal(metrics.pm2_logs_logical_bytes, 3);
  assert.equal(typeof metrics.last_reclaimed_by_category, "object");
  assert.equal(metrics.last_filesystem_net_reclaimed_bytes, 0);
  assert.ok(!JSON.stringify(metrics).includes("application.log"));
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
