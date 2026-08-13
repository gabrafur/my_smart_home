#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";

const flows = JSON.parse(fs.readFileSync(new URL("../flows.json", import.meta.url), "utf8"));

function getFunction(id) {
  const node = flows.find((item) => item.id === id);
  assert.equal(node?.type, "function", `Function node ausente: ${id}`);
  return new Function("msg", "flow", "node", "global", node.func);
}

function context(defaultStore = new Map(), memoryStore = new Map()) {
  return {
    stores: { default: defaultStore, memoryOnly: memoryStore },
    get(key, store = "default") {
      return this.stores[store].get(key);
    },
    set(key, value, store = "default") {
      this.stores[store].set(key, structuredClone(value));
    },
  };
}

const nodeMock = { status() {}, warn() {}, error(error) { throw new Error(String(error)); } };
const globalMock = { get() { return undefined; } };

function run(fn, flow, msg) {
  return fn(msg, flow, nodeMock, globalMock);
}

function pingResult(okCount, now) {
  const targets = ["1.1.1.1", "8.8.8.8", "9.9.9.9"];
  return {
    monitor_now: now,
    payload: {
      checked_at: new Date(now).toISOString(),
      results: targets.map((address, index) => ({
        name: `target-${index}`,
        address,
        ok: index < okCount,
      })),
    },
  };
}

const internet = getFunction("internet_evaluate");
const internetFlow = context();
let now = Date.UTC(2026, 7, 13, 12, 0, 0);

// Healthy baseline and one external host failing: still online, no recovery.
let result = run(internet, internetFlow, pingResult(3, now));
assert.equal(result[0], null);
assert.equal(result[1], null);
assert.equal(internetFlow.get("internet_monitor_state_v1").phase, "online");
result = run(internet, internetFlow, pingResult(2, now += 30_000));
assert.equal(result[0], null);
assert.equal(internetFlow.get("internet_monitor_state_v1").phase, "online");

// Three consecutive failed cycles confirm one incident.
for (let attempt = 1; attempt <= 3; attempt += 1) {
  result = run(internet, internetFlow, pingResult(0, now += 30_000));
  assert.equal(Boolean(result[0]), attempt === 3);
}
assert.equal(internetFlow.get("internet_monitor_state_v1").phase, "offline");
result = run(internet, internetFlow, pingResult(0, now += 30_000));
assert.equal(result[0], null, "offline contínuo não pode duplicar queda");

// One positive cycle is recovering; oscillation returns to offline; two positives recover.
result = run(internet, internetFlow, pingResult(3, now += 30_000));
assert.equal(result[1], null);
assert.equal(internetFlow.get("internet_monitor_state_v1").phase, "recovering");
run(internet, internetFlow, pingResult(0, now += 30_000));
assert.equal(internetFlow.get("internet_monitor_state_v1").phase, "offline");
run(internet, internetFlow, pingResult(3, now += 30_000));
result = run(internet, internetFlow, pingResult(3, now += 30_000));
assert.ok(result[1], "dois sucessos devem notificar recuperação");
assert.ok(internetFlow.get("internet_monitor_state_v1").last_outage_duration_s > 0);
result = run(internet, internetFlow, pingResult(3, now += 30_000));
assert.equal(result[1], null, "online contínuo não pode duplicar recuperação");

// A second outage is a distinct incident.
run(internet, internetFlow, pingResult(1, now += 30_000));
run(internet, internetFlow, pingResult(1, now += 30_000));
result = run(internet, internetFlow, pingResult(1, now += 30_000));
assert.ok(result[0], "segunda queda deve gerar novo alerta");

// Simulate Node-RED restart: persistent incident remains, volatile memory is empty.
const restartedInternetFlow = context(internetFlow.stores.default, new Map());
result = run(internet, restartedInternetFlow, pingResult(3, now += 30_000));
assert.equal(result[1], null);
result = run(internet, restartedInternetFlow, pingResult(3, now += 30_000));
assert.ok(result[1], "incidente persistido deve recuperar sem nova queda");

// The production ping node uses only IP literals and a volatile no-overlap lock.
const pingNode = flows.find((item) => item.id === "internet_ping");
for (const address of ["1.1.1.1", "8.8.8.8", "9.9.9.9"]) assert.match(pingNode.func, new RegExp(address.replaceAll(".", "\\.")));
assert.doesNotMatch(pingNode.func, /https?:|\.com|\.net|dns/i);
assert.match(pingNode.func, /internet_ping_cycle_running/);
assert.match(pingNode.func, /memoryOnly/);

const observeZigbee = getFunction("zigbee_store_observation");
const zigbee = getFunction("zigbee_network_evaluate");
const zigbeeComponent = getFunction("zigbee_component_evaluate");
const zigbeeFlow = context();
now = Date.UTC(2026, 7, 13, 13, 0, 0);
zigbeeFlow.set("zigbee_bridge_observation", { state: "unknown", changed_at: now }, "memoryOnly");

// Startup online establishes baseline without a false recovery.
run(observeZigbee, zigbeeFlow, { payload: "online", monitor_now: now + 1_000 });
result = run(zigbee, zigbeeFlow, { monitor_now: now + 1_000 });
assert.equal(result[0], null);
assert.equal(result[1], null);
assert.equal(zigbeeFlow.get("zigbee_network_monitor_state_v1").phase, "online");

// A transient failure under 30 seconds is ignored.
run(observeZigbee, zigbeeFlow, { payload: "offline", monitor_now: now + 10_000 });
result = run(zigbee, zigbeeFlow, { monitor_now: now + 39_000 });
assert.equal(result[0], null);
run(observeZigbee, zigbeeFlow, { payload: "online", monitor_now: now + 40_000 });
result = run(zigbee, zigbeeFlow, { monitor_now: now + 40_000 });
assert.equal(result[0], null);

// 30 seconds offline and 60 seconds online preserve the previous behavior.
run(observeZigbee, zigbeeFlow, { payload: "offline", monitor_now: now + 50_000 });
result = run(zigbee, zigbeeFlow, { monitor_now: now + 80_000 });
assert.ok(result[0]);
result = run(zigbee, zigbeeFlow, { monitor_now: now + 90_000 });
assert.equal(result[0], null, "queda Zigbee não pode duplicar");
run(observeZigbee, zigbeeFlow, { payload: "online", monitor_now: now + 100_000 });
result = run(zigbee, zigbeeFlow, { monitor_now: now + 159_000 });
assert.equal(result[1], null);
result = run(zigbee, zigbeeFlow, { monitor_now: now + 160_000 });
assert.ok(result[1]);

// A persisted Zigbee incident survives Node-RED restart without duplicate down.
run(observeZigbee, zigbeeFlow, { payload: "offline", monitor_now: now + 170_000 });
result = run(zigbee, zigbeeFlow, { monitor_now: now + 200_000 });
assert.ok(result[0]);
const restartedZigbeeFlow = context(zigbeeFlow.stores.default, new Map());
restartedZigbeeFlow.set("zigbee_bridge_observation", { state: "online", changed_at: now + 210_000 }, "memoryOnly");
result = run(zigbee, restartedZigbeeFlow, { monitor_now: now + 269_000 });
assert.equal(result[1], null);
result = run(zigbee, restartedZigbeeFlow, { monitor_now: now + 270_000 });
assert.ok(result[1], "restart deve recuperar incidente persistido uma única vez");

// Component retained online at startup is silent; offline/duplicate/online is one pair.
const componentTopic = "zigbee2mqtt/teste/sensor/availability";
result = run(zigbeeComponent, zigbeeFlow, { topic: componentTopic, payload: "online", monitor_now: now });
assert.equal(result, null);
result = run(zigbeeComponent, zigbeeFlow, { topic: componentTopic, payload: { state: "offline" }, monitor_now: now + 1_000 });
assert.ok(result[0]);
result = run(zigbeeComponent, zigbeeFlow, { topic: componentTopic, payload: "offline", monitor_now: now + 2_000 });
assert.equal(result, null);
result = run(zigbeeComponent, zigbeeFlow, { topic: componentTopic, payload: "online", monitor_now: now + 3_000 });
assert.ok(result[1]);
result = run(zigbeeComponent, zigbeeFlow, { topic: componentTopic, payload: "online", monitor_now: now + 4_000 });
assert.equal(result, null);
result = run(zigbeeComponent, zigbeeFlow, { topic: componentTopic, payload: "offline", monitor_now: now + 5_000 });
assert.ok(result[0], "nova queda do componente após recuperação deve alertar");

// Structural review: unique ids, valid wires, shared notifier and left-to-right layout.
const ids = flows.map((item) => item.id);
assert.equal(new Set(ids).size, ids.length, "IDs de nodes devem ser únicos");
const idSet = new Set(ids);
for (const item of flows) {
  for (const output of item.wires || []) {
    for (const target of output) assert.ok(idSet.has(target), `wire órfão: ${item.id} -> ${target}`);
  }
}
for (const item of flows.filter((entry) => entry.type === "group" && ["monitoramento_internet_tab", "monitoramento_zigbee_tab"].includes(entry.z))) {
  for (const member of item.nodes) {
    const memberNode = flows.find((entry) => entry.id === member);
    assert.ok(memberNode, `grupo ${item.id} contém node ausente: ${member}`);
    assert.equal(memberNode.g, item.id, `node ${member} não referencia seu grupo`);
  }
}
assert.equal(flows.filter((item) => item.type === "subflow:infra_notify_all_mobiles").length, 6);
assert.ok(flows.find((item) => item.id === "internet_ping").x < flows.find((item) => item.id === "internet_evaluate").x);
assert.ok(flows.find((item) => item.id === "zigbee_store_observation").x < flows.find((item) => item.id === "zigbee_network_evaluate").x);

console.log("Infrastructure monitoring tests: state, restart, dedupe and layout scenarios passed.");
