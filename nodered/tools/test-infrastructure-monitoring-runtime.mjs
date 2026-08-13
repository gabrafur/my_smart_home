#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const IMAGE = "nodered/node-red@sha256:10f40d0a83e7e5852b13d4d472b2006b05b1cca6d55e2f29a55a12c25a630cb6";
const TAB = "infrastructure_runtime_test_tab";
const sourceFlows = JSON.parse(fs.readFileSync(new URL("../flows.json", import.meta.url), "utf8"));
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nodered-infrastructure-runtime-"));
fs.chmodSync(tempDir, 0o777);

function docker(args, options = {}) {
  const result = spawnSync("docker", args, {
    encoding: "utf8",
    timeout: options.timeout ?? 30_000,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`docker ${args.join(" ")} failed: ${result.error?.message || result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

function cloneFunction(id, wires) {
  const source = sourceFlows.find((node) => node.id === id);
  assert.equal(source?.type, "function", `Function node ausente: ${id}`);
  const node = structuredClone(source);
  node.z = TAB;
  delete node.g;
  node.x = 600;
  node.y = 200;
  node.wires = wires;
  return node;
}

function functionNode(id, name, func, wires = [], outputs = 1) {
  return {
    id, type: "function", z: TAB, name, func, outputs,
    timeout: 0, noerr: 0, initialize: "", finalize: "", libs: [],
    x: 600, y: 200, wires,
  };
}

function inject(id, delay, target, payload = {}) {
  return {
    id, type: "inject", z: TAB, name: id,
    props: [{ p: "payload" }, { p: "topic", vt: "str" }, { p: "monitor_now", v: String(payload.monitor_now ?? 0), vt: "num" }],
    repeat: "", crontab: "", once: true, onceDelay: delay,
    topic: payload.topic || "",
    payload: JSON.stringify(payload.payload ?? {}), payloadType: "json",
    x: 120, y: 100, wires: [[target]],
  };
}

function tick(id, delay, target, monitorNow) {
  return inject(id, delay, target, { monitor_now: monitorNow, payload: {} });
}

const resetCode = `
flow.set("runtime_counts", { persistent: 0, mobile: 0, dismiss: 0, ids: {}, states: [] });
flow.set("runtime_ping_outputs", 0);
return null;`;

function captureCode(channel) {
  return `
const counts = flow.get("runtime_counts") || { persistent: 0, mobile: 0, dismiss: 0, ids: {}, states: [] };
counts.${channel} += 1;
const id = msg.notification?.id || msg.notification?.dismiss_id;
if (id) counts.ids[id] = (counts.ids[id] || 0) + 1;
flow.set("runtime_counts", counts);
return null;`;
}

const captureStateCode = `
if (!String(msg.topic || "").endsWith("/state")) return null;
const counts = flow.get("runtime_counts") || { persistent: 0, mobile: 0, dismiss: 0, ids: {}, states: [] };
counts.states.push(msg.payload);
flow.set("runtime_counts", counts);
return null;`;

function verificationCode(phase, checks) {
  return `
const counts = flow.get("runtime_counts") || { persistent: 0, mobile: 0, dismiss: 0, ids: {}, states: [] };
const internet = flow.get("internet_monitor_state_v1", "persistent");
const zigbee = flow.get("zigbee_network_monitor_state_v1", "persistent");
const components = flow.get("zigbee_component_incidents_v1", "persistent") || {};
const pingOutputs = flow.get("runtime_ping_outputs") || 0;
const metrics = global.get("pingMetrics");
const failures = [];
const expect = (condition, message) => { if (!condition) failures.push(message); };
${checks}
if (failures.length) {
  node.error("RUNTIME_TEST_FAIL:${phase}:" + failures.join(" | ") + ":" + JSON.stringify({ counts, internet, zigbee, components, pingOutputs, metrics }));
} else {
  node.warn("RUNTIME_TEST_PASS:${phase}:" + JSON.stringify({ counts, internet, zigbee, components, pingOutputs, metrics }));
}
return null;`;
}

function baseNodes() {
  return [
    { id: TAB, type: "tab", label: "infrastructure-runtime-test", disabled: false, info: "isolated runtime test", env: [] },
    functionNode("runtime_reset", "reset counters", resetCode),
    cloneFunction("infra_notify_route", [["runtime_persistent"], ["runtime_mobile"], ["runtime_dismiss"]]),
    functionNode("runtime_persistent", "capture persistent", captureCode("persistent")),
    functionNode("runtime_mobile", "capture mobile", captureCode("mobile")),
    functionNode("runtime_dismiss", "capture dismiss", captureCode("dismiss")),
    functionNode("runtime_state", "capture state", captureStateCode),
  ];
}

function internetResult(okCount, monitorNow) {
  const addresses = ["1.1.1.1", "8.8.8.8", "9.9.9.9"];
  return {
    monitor_now: monitorNow,
    payload: {
      checked_at: new Date(monitorNow).toISOString(),
      results: addresses.map((address, index) => ({ name: `target-${index}`, address, ok: index < okCount })),
    },
  };
}

let internetClock = Date.UTC(2026, 7, 13, 12, 0, 0);

function internetPhase(name, okCounts, checks) {
  const nodes = baseNodes();
  nodes.push(cloneFunction("internet_evaluate", [["infra_notify_route"], ["infra_notify_route"], ["runtime_state"]]));
  nodes.push(inject(`${name}_reset`, 0.1, "runtime_reset"));
  const phaseStart = internetClock;
  okCounts.forEach((okCount, index) => {
    const payload = internetResult(okCount, phaseStart + index * 30_000);
    nodes.push(inject(`${name}_${index}`, 0.3 + index * 0.12, "internet_evaluate", payload));
  });
  internetClock += (okCounts.length + 1) * 30_000;
  nodes.push(functionNode(`${name}_verify`, `verify ${name}`, verificationCode(name, checks)));
  nodes.push(inject(`${name}_verify_tick`, 0.7 + okCounts.length * 0.12, `${name}_verify`));
  return nodes;
}

function zigbeeObservationInject(id, delay, payload, monitorNow) {
  return inject(id, delay, "zigbee_store_observation", { payload, monitor_now: monitorNow });
}

function zigbeePhase(name, steps, checks) {
  const nodes = baseNodes();
  nodes.push(cloneFunction("zigbee_store_observation", [["zigbee_network_evaluate"]]));
  nodes.push(cloneFunction("zigbee_network_evaluate", [["infra_notify_route"], ["infra_notify_route"], ["runtime_state"]]));
  nodes.push(inject(`${name}_reset`, 0.1, "runtime_reset"));
  steps.forEach((step, index) => {
    const delay = 0.3 + index * 0.12;
    nodes.push(step.kind === "observation"
      ? zigbeeObservationInject(`${name}_${index}`, delay, step.payload, step.now)
      : tick(`${name}_${index}`, delay, "zigbee_network_evaluate", step.now));
  });
  nodes.push(functionNode(`${name}_verify`, `verify ${name}`, verificationCode(name, checks)));
  nodes.push(inject(`${name}_verify_tick`, 0.7 + steps.length * 0.12, `${name}_verify`));
  return nodes;
}

function componentPhase() {
  const name = "components";
  const nodes = baseNodes();
  nodes.push(cloneFunction("zigbee_component_evaluate", [["infra_notify_route"], ["infra_notify_route"]]));
  nodes.push(inject(`${name}_reset`, 0.1, "runtime_reset"));
  const messages = [
    ["andar1/cozinha/sensor", "offline"],
    ["andar1/cozinha/sensor", "offline"],
    ["externo/portao/sensor", "offline"],
    ["andar1-cozinha/sensor", "offline"],
    ["andar1/cozinha/sensor", "online"],
  ];
  messages.forEach(([component, state], index) => nodes.push(inject(
    `${name}_${index}`, 0.3 + index * 0.12, "zigbee_component_evaluate",
    { topic: `zigbee2mqtt/${component}/availability`, payload: state, monitor_now: index + 1 },
  )));
  nodes.push(functionNode(`${name}_verify`, `verify ${name}`, verificationCode(name, `
expect(counts.persistent === 4, "expected 3 down + 1 recovery persistent events");
expect(counts.mobile === 4, "expected 3 down + 1 recovery mobile calls");
expect(counts.dismiss === 1, "expected one dismiss");
expect(Object.keys(counts.ids).filter((id) => id.startsWith("zigbee_component_") && !id.includes("recovered")).length === 3, "hierarchical IDs must be unique");
expect(Object.keys(components).length >= 3, "complete friendly names must remain distinct");
expect(components["andar1/cozinha/sensor"]?.offline === false, "recovered hierarchical component");
expect(components["externo/portao/sensor"]?.offline === true, "second hierarchical component");
`)));
  nodes.push(inject(`${name}_verify_tick`, 1.2, `${name}_verify`));
  return nodes;
}

function pingPhase(name) {
  const nodes = baseNodes();
  nodes.push(cloneFunction("internet_ping", [["runtime_ping_capture"]]));
  nodes.push(functionNode("runtime_ping_capture", "capture ping output", `
flow.set("runtime_ping_outputs", (flow.get("runtime_ping_outputs") || 0) + 1);
return null;`));
  nodes.push(inject(`${name}_reset`, 0.1, "runtime_reset"));
  nodes.push(inject(`${name}_first`, 0.3, "internet_ping"));
  nodes.push(inject(`${name}_overlap`, 0.3, "internet_ping"));
  nodes.push(inject(`${name}_after`, 4.0, "internet_ping"));
  nodes.push(functionNode(`${name}_verify`, `verify ${name}`, verificationCode(name, `
expect(pingOutputs === 2, "only one initial cycle plus one later cycle");
expect(metrics?.calls === 6, "exactly six ping spawns across two cycles");
expect(metrics?.peak <= 3, "no more than three concurrent ping processes");
expect(metrics?.active === 0, "all ping processes completed");
expect(flow.get("internet_ping_cycle_running", "memoryOnly") === false, "lock released");
`)));
  nodes.push(inject(`${name}_verify_tick`, 7.5, `${name}_verify`));
  return nodes;
}

const settings = `
const realChildProcess = require("child_process");
const pingMetrics = { calls: 0, active: 0, peak: 0, throwFirst: process.env.PING_THROW_FIRST === "1" };
const childProcess = {
  execFile(file, args, options, callback) {
    pingMetrics.calls += 1;
    if (pingMetrics.throwFirst && pingMetrics.calls === 1) throw new Error("simulated synchronous spawn failure");
    pingMetrics.active += 1;
    pingMetrics.peak = Math.max(pingMetrics.peak, pingMetrics.active);
    return realChildProcess.execFile(file, args, options, (...result) => {
      pingMetrics.active -= 1;
      callback(...result);
    });
  }
};
module.exports = {
  flowFile: "flows.json",
  credentialSecret: false,
  uiPort: 1880,
  diagnostics: { enabled: false, ui: false },
  runtimeState: { enabled: false, ui: false },
  telemetry: { enabled: false, updateNotification: false },
  contextStorage: {
    default: "memoryOnly",
    memoryOnly: { module: "memory" },
    persistent: { module: "localfilesystem", config: { flushInterval: 1 } }
  },
  functionGlobalContext: { childProcess, pingMetrics },
  logging: { console: { level: "info", metrics: false, audit: false } },
  editorTheme: { projects: { enabled: false } }
};`;

fs.writeFileSync(path.join(tempDir, "settings.js"), settings);
fs.writeFileSync(path.join(tempDir, "package.json"), JSON.stringify({ name: "infrastructure-runtime-test", private: true }));

async function runPhase(name, nodes, env = {}) {
  fs.writeFileSync(path.join(tempDir, "flows.json"), `${JSON.stringify(nodes, null, 2)}\n`);
  const container = `codex-nr-infra-${process.pid}-${name}`.replace(/[^a-zA-Z0-9_.-]/g, "-");
  const envArgs = Object.entries(env).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
  try {
    docker(["run", "-d", "--name", container, "--user", `${process.getuid()}:${process.getgid()}`, ...envArgs, "-v", `${tempDir}:/data:rw`, IMAGE]);
    const deadline = Date.now() + 15_000;
    let logs = "";
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      logs = docker(["logs", container]);
      if (logs.includes(`RUNTIME_TEST_FAIL:${name}:`)) throw new Error(logs);
      if (logs.includes(`RUNTIME_TEST_PASS:${name}:`)) {
        // Let localfilesystem flush the just-validated state before a restart.
        await new Promise((resolve) => setTimeout(resolve, 1_250));
        return logs.split("\n").find((line) => line.includes(`RUNTIME_TEST_PASS:${name}:`));
      }
    }
    throw new Error(`Timeout waiting for ${name}:\n${logs}`);
  } finally {
    try { docker(["stop", "-t", "2", container], { timeout: 10_000 }); } catch {}
    try { docker(["rm", "-f", container], { timeout: 10_000 }); } catch {}
  }
}

const results = [];
try {
  results.push(await runPhase("internet_flapping", internetPhase(
    "internet_flapping",
    [3, 2, 1, 2, 1, 1, 2, 1, 1, 1, 2, 1, 2, 3],
    `
expect(internet?.phase === "online", "final internet phase online");
expect(counts.ids.internet_connection_failure === 2, "one down routed to persistent + mobile");
expect(counts.ids.internet_connection_recovered === 3, "one recovery routed to persistent + mobile + dismiss");
expect(counts.persistent === 2 && counts.mobile === 2 && counts.dismiss === 1, "one route per event");
expect(internet?.last_outage_duration_s === 180, "outage duration 180 seconds");
expect(JSON.stringify(counts.states) === JSON.stringify(["online","online","checking","online","checking","checking","online","checking","checking","offline","recovering","offline","recovering","online"]), "exact flapping state sequence");
`,
  )));

  results.push(await runPhase("internet_restart_online", internetPhase(
    "internet_restart_online", [3], `
expect(internet?.phase === "online", "online after restart");
expect(counts.persistent === 0 && counts.mobile === 0 && counts.dismiss === 0, "no startup notification");
`,
  )));

  results.push(await runPhase("internet_incident_before_restart", internetPhase(
    "internet_incident_before_restart", [1, 1, 1], `
expect(internet?.phase === "offline" && internet?.incident_open === true, "offline incident persisted");
expect(counts.ids.internet_connection_failure === 2, "one down before restart");
`,
  )));
  results.push(await runPhase("internet_incident_after_restart", internetPhase(
    "internet_incident_after_restart", [3, 3], `
expect(internet?.phase === "online" && internet?.incident_open === false, "recovered after restart");
expect(!counts.ids.internet_connection_failure, "no duplicate down after restart");
expect(counts.ids.internet_connection_recovered === 3, "one recovery after restart");
`,
  )));

  results.push(await runPhase("internet_recovery_before_restart", internetPhase(
    "internet_recovery_before_restart", [1, 1, 1, 3], `
expect(internet?.phase === "recovering" && internet?.consecutive_successes === 1, "recovery state persisted");
expect(counts.ids.internet_connection_failure === 2, "one down in recovery incident");
`,
  )));
  results.push(await runPhase("internet_recovery_after_restart", internetPhase(
    "internet_recovery_after_restart", [3], `
expect(internet?.phase === "online", "one post-restart success completes persisted recovery");
expect(!counts.ids.internet_connection_failure, "no duplicate down during recovery restart");
expect(counts.ids.internet_connection_recovered === 3, "one recovery during recovery restart");
`,
  )));

  const zigbeeSteps = [
    { kind: "observation", payload: "online", now: 1_000 },
    { kind: "observation", payload: "offline", now: 10_000 },
    { kind: "tick", now: 39_000 },
    { kind: "observation", payload: "online", now: 40_000 },
    { kind: "observation", payload: "offline", now: 50_000 },
    { kind: "tick", now: 80_000 },
    { kind: "tick", now: 90_000 },
    { kind: "observation", payload: "online", now: 100_000 },
    { kind: "tick", now: 159_000 },
    { kind: "observation", payload: "offline", now: 160_000 },
    { kind: "observation", payload: "online", now: 170_000 },
    { kind: "tick", now: 230_000 },
  ];
  results.push(await runPhase("zigbee_thresholds", zigbeePhase("zigbee_thresholds", zigbeeSteps, `
expect(zigbee?.phase === "online", "final Zigbee phase online");
expect(counts.ids.zigbee_network_failure === 2, "one Zigbee down routed twice");
expect(counts.ids.zigbee_network_recovered === 3, "one Zigbee recovery routed three ways");
expect(counts.persistent === 2 && counts.mobile === 2 && counts.dismiss === 1, "one Zigbee route per event");
`)));

  results.push(await runPhase("zigbee_before_restart", zigbeePhase("zigbee_before_restart", [
    { kind: "observation", payload: "offline", now: 300_000 },
    { kind: "tick", now: 330_000 },
  ], `
expect(zigbee?.phase === "offline" && zigbee?.incident_open === true, "Zigbee incident before restart");
expect(counts.ids.zigbee_network_failure === 2, "one Zigbee down before restart");
`)));

  results.push(await runPhase("zigbee_after_restart", zigbeePhase("zigbee_after_restart", [
    { kind: "tick", now: 335_000 },
    { kind: "observation", payload: "online", now: 340_000 },
    { kind: "tick", now: 399_000 },
    { kind: "tick", now: 400_000 },
  ], `
expect(zigbee?.phase === "online" && zigbee?.incident_open === false, "Zigbee recovery after restart");
expect(!counts.ids.zigbee_network_failure, "no duplicate Zigbee down after restart");
expect(counts.ids.zigbee_network_recovered === 3, "one Zigbee recovery after restart");
`)));

  results.push(await runPhase("components", componentPhase()));
  results.push(await runPhase("ping_lock", pingPhase("ping_lock")));
  results.push(await runPhase("ping_spawn_error", pingPhase("ping_spawn_error"), { PING_THROW_FIRST: "1" }));

  console.log("Node-RED isolated runtime integration tests passed:");
  for (const result of results) console.log(`- ${result}`);
} finally {
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch (error) {
    console.warn(`Temporary runtime directory could not be removed: ${error.message}`);
  }
}
