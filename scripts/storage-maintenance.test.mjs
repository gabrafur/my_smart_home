import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "storage-maintenance.sh");

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "storage-maintenance-test-"));
  const bin = path.join(root, "bin");
  const calls = path.join(root, "docker-calls");
  const meminfo = path.join(root, "meminfo");
  fs.mkdirSync(bin);
  fs.writeFileSync(meminfo, "MemAvailable:       4194304 kB\n");
  fs.writeFileSync(path.join(bin, "docker"), `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_CALLS"
case "$1 $2" in
  "system df") printf '%s\\n' 'TYPE TOTAL ACTIVE SIZE RECLAIMABLE' ;;
  "image ls"|"ps -a") : ;;
esac
`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "df"), `#!/bin/sh
case "$1" in
  -P) printf '%s\\n' 'Filesystem 1024-blocks Used Available Capacity Mounted on' "/dev/test 100000 70000 30000 \${FAKE_DISK_PERCENT:-70}% /" ;;
  -B1) printf '%s\\n' 'Used' '70000' ;;
  *) exit 2 ;;
esac
`, { mode: 0o755 });
  return {
    root,
    calls,
    meminfo,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      FAKE_DOCKER_CALLS: calls,
      STORAGE_MAINTENANCE_LOCK_FILE: path.join(root, "lock"),
      STORAGE_MAINTENANCE_MEMINFO_FILE: meminfo,
    },
  };
}

test("dry-run inventories without pruning", () => {
  const item = fixture();
  const result = spawnSync(script, ["--dry-run"], { encoding: "utf8", env: item.env });
  assert.equal(result.status, 0, result.stderr);
  const calls = fs.readFileSync(item.calls, "utf8");
  assert.match(calls, /system df/);
  assert.doesNotMatch(calls, /builder prune|image prune|volume|system prune/);
  assert.match(result.stdout, /status=success mode=dry-run/);
  fs.rmSync(item.root, { recursive: true, force: true });
});

test("apply enforces bounded cache and old dangling images only", () => {
  const item = fixture();
  const result = spawnSync(script, ["--apply", "--min-age", "24", "--max-build-cache", "2GB"], {
    encoding: "utf8",
    env: item.env,
  });
  assert.equal(result.status, 0, result.stderr);
  const calls = fs.readFileSync(item.calls, "utf8");
  assert.match(calls, /builder prune --all --force --max-used-space 2GB/);
  assert.match(calls, /image prune --force --filter until=24h/);
  assert.doesNotMatch(calls, /volume|container prune|system prune|image prune -a/);
  fs.rmSync(item.root, { recursive: true, force: true });
});

test("apply refuses host pressure before pruning", () => {
  const item = fixture();
  fs.writeFileSync(item.meminfo, "MemAvailable:       1048576 kB\n");
  const result = spawnSync(script, ["--apply"], { encoding: "utf8", env: item.env });
  assert.equal(result.status, 75);
  assert.match(result.stdout, /reason=low_available_memory/);
  const calls = fs.readFileSync(item.calls, "utf8");
  assert.doesNotMatch(calls, /builder prune|image prune/);
  fs.rmSync(item.root, { recursive: true, force: true });
});
