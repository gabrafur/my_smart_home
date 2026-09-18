#!/usr/bin/env node

import assert from "node:assert/strict";
import { collectCodexRemoteHealth, publishCodexRemoteHealth, CODEX_REMOTE_HEALTH_TOPIC } from "./codex-remote-health-publisher.mjs";

const calls = [];
const healthy = collectCodexRemoteHealth({
  now: new Date("2026-09-18T20:00:00Z"),
  codexBin: "/opt/codex",
  controlSocket: "/tmp/control.sock",
  run(command, args) {
    calls.push([command, args]);
    if (command === "systemctl") return { status: 0, stdout: "active\n" };
    if (command === "ss") return { status: 0, stdout: "LISTEN /tmp/control.sock\n" };
    return { status: 0, stdout: "codex-cli test\n" };
  },
});
assert.equal(healthy.schema_version, 1);
assert.equal(healthy.services.remote_shell.healthy, true);
assert.equal(healthy.services.codex_remote.healthy, true);
assert.equal(JSON.stringify(healthy).includes("/tmp"), false, "relatório não expõe caminho privado");
assert.equal(calls.length, 3);

const absent = collectCodexRemoteHealth({
  run(command) {
    if (command === "systemctl") return { status: 0, stdout: "active\n" };
    if (command === "ss") return { status: 0, stdout: "" };
    return { status: 0, stdout: "codex-cli test\n" };
  },
});
assert.equal(absent.services.codex_remote.healthy, false);
assert.equal(absent.services.codex_remote.reason, "app_server_absent");

let publishCall;
publishCodexRemoteHealth(healthy, { run(command, args, options) {
  publishCall = { command, args, options };
  return { status: 0, stdout: "" };
} });
assert.equal(publishCall.command, "docker");
assert.ok(publishCall.args.includes(`CODEX_REMOTE_HEALTH_TOPIC=${CODEX_REMOTE_HEALTH_TOPIC}`));
assert.equal(publishCall.options.timeout, 15000);

console.log("Codex remote health publisher tests passed.");
