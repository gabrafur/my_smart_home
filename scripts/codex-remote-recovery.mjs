#!/usr/bin/env node

import fs from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const sleep = (milliseconds) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);

export function listenerReady(controlSocket, run = spawnSync) {
  const result = run("ss", ["-xl"], { encoding: "utf8", timeout: 5000 });
  return result?.status === 0 && String(result.stdout).includes(controlSocket);
}

export function recoverCodexRemote({
  codexBin = process.env.CODEX_REMOTE_CODEX_BIN || "/home/gabriel/.local/bin/codex",
  controlSocket = process.env.CODEX_REMOTE_CONTROL_SOCKET || "/home/gabriel/.codex/app-server-control/app-server-control.sock",
  run = spawnSync,
  launch = spawn,
  wait = sleep,
} = {}) {
  if (listenerReady(controlSocket, run)) return { status: "healthy", action: "none", reason: "app_server_ready" };
  const version = run(codexBin, ["--version"], { encoding: "utf8", timeout: 10_000 });
  if (version?.status !== 0) return { status: "failed", action: "none", reason: "binary_unavailable" };

  if (fs.existsSync(controlSocket)) fs.rmSync(controlSocket);
  const child = launch(codexBin, ["-c", "features.code_mode_host=true", "app-server", "--listen", "unix://"], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (listenerReady(controlSocket, run)) return { status: "recovered", action: "start", reason: "app_server_started" };
    wait(250);
  }
  return { status: "failed", action: "start", reason: "startup_timeout" };
}

export function main(argv = process.argv.slice(2)) {
  if (argv.length !== 1 || argv[0] !== "--recover") throw new Error("Use --recover");
  const result = recoverCodexRemote();
  process.stdout.write(`codex-remote-recovery status=${result.status} action=${result.action} reason=${result.reason}\n`);
  if (result.status === "failed") process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); } catch (error) { console.error(`codex-remote-recovery status=failed action=none reason=${error.message}`); process.exitCode = 1; }
}
