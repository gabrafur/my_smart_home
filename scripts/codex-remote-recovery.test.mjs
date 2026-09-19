#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { recoverCodexRemote, restartCodexRemote } from "./codex-remote-recovery.mjs";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-remote-recovery-"));
const socket = path.join(temp, "control.sock");

let launches = 0;
let checks = 0;
const recovered = recoverCodexRemote({
  codexBin: "/opt/codex",
  controlSocket: socket,
  run(command) {
    if (command === "ss") {
      checks += 1;
      return { status: 0, stdout: checks >= 3 ? `LISTEN ${socket}\n` : "" };
    }
    return { status: 0, stdout: "codex-cli test\n" };
  },
  launch(command, args, options) {
    launches += 1;
    assert.equal(command, "/opt/codex");
    assert.deepEqual(args, ["-c", "features.code_mode_host=true", "app-server", "--listen", "unix://"]);
    assert.equal(options.detached, true);
    return { unref() {} };
  },
  wait() {},
});
assert.equal(recovered.status, "recovered");
assert.equal(launches, 1);

const alreadyHealthy = recoverCodexRemote({
  controlSocket: socket,
  run(command) { return command === "ss" ? { status: 0, stdout: `LISTEN ${socket}\n` } : { status: 0, stdout: "" }; },
  launch() { throw new Error("não deveria iniciar"); },
});
assert.deepEqual(alreadyHealthy, { status: "healthy", action: "none", reason: "app_server_ready" });

let running = true;
let restarted = false;
const restart = restartCodexRemote({
  codexBin: "/opt/codex",
  controlSocket: socket,
  run(command, args) {
    if (command !== "ss") return { status: 0, stdout: "codex-cli test\n" };
    if (!running && !restarted) return { status: 0, stdout: "" };
    if (!running && restarted) return { status: 0, stdout: `LISTEN ${socket}\n` };
    if (args.some((arg) => arg.includes("p"))) return { status: 0, stdout: `LISTEN ${socket} users:((\"codex\",pid=4321,fd=9))\n` };
    return { status: 0, stdout: `LISTEN ${socket}\n` };
  },
  readFile(file) {
    assert.equal(file, "/proc/4321/cmdline");
    return Buffer.from("/opt/codex\0app-server\0--listen\0unix://\0");
  },
  terminate(pid, signal) {
    assert.equal(pid, 4321);
    assert.equal(signal, "SIGTERM");
    running = false;
  },
  launch(command, args, options) {
    assert.equal(command, "/opt/codex");
    assert.deepEqual(args, ["-c", "features.code_mode_host=true", "app-server", "--listen", "unix://"]);
    assert.equal(options.detached, true);
    restarted = true;
    return { unref() {} };
  },
  wait() {},
});
assert.deepEqual(restart, { status: "recovered", action: "restart", reason: "app_server_restarted" });

const unverified = restartCodexRemote({
  codexBin: "/opt/codex",
  controlSocket: socket,
  run(command, args) {
    if (command !== "ss") return { status: 0, stdout: "codex-cli test\n" };
    if (args.some((arg) => arg.includes("p"))) return { status: 0, stdout: `LISTEN ${socket} users:((\"other\",pid=9999,fd=9))\n` };
    return { status: 0, stdout: `LISTEN ${socket}\n` };
  },
  readFile() { return Buffer.from("/usr/bin/other\0--listen\0unix://\0"); },
  terminate() { throw new Error("must not terminate an unverified process"); },
  launch() { throw new Error("must not start over an unverified listener"); },
});
assert.deepEqual(unverified, { status: "failed", action: "restart", reason: "listener_owner_unverified" });

fs.rmSync(temp, { recursive: true, force: true });
console.log("Codex remote recovery tests passed.");
