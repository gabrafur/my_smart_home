#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { recoverCodexRemote } from "./codex-remote-recovery.mjs";

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

fs.rmSync(temp, { recursive: true, force: true });
console.log("Codex remote recovery tests passed.");
