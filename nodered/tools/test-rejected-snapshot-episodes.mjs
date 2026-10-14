#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";

const load = (name) => new Function("msg", "flow", "node", "global",
  fs.readFileSync(new URL(`./functions/${name}.js`, import.meta.url), "utf8"));
const security = load("security-light-context-cache");
const arrivalRead = load("arrival-context-snapshot-read");
const arrivalMutate = load("arrival-context-cache-mutate");
const reset = load("arrival-context-test-reset");
const now = Date.now();
const observed = now - 10_000;
const olderReliable = observed - 90_000;
const newer = observed + 1_000;
const policy = { future_tolerance_s: 60 };
const global = { get(name) { return name === "location_policy_v1"
  ? { version: 1, complete: true, future_tolerance_seconds: 60 }
  : { version: 1, complete: true }; } };

function memory() {
  const stores = new Map();
  return {
    get(key, store = "default") { return stores.get(`${store}:${key}`); },
    set(key, value, store = "default") { stores.set(`${store}:${key}`, structuredClone(value)); },
  };
}
function logger() {
  return { warnings: [], endings: [], warn(value) { this.warnings.push(value); },
    log(value) { this.endings.push(value); }, status() {}, error(value) { throw Error(value); } };
}
function snapshot(kind, at, extra = {}) {
  return { payload: { kind, updated_at: at, context: { updated_at: at, source: "reliable", ...extra } } };
}
function delivery(fn, flow, node, kind, at, extra = {}) {
  return fn(snapshot(kind, at, extra), flow, node, global);
}
function arrival(flow, node, kind, at, extra = {}) {
  const msg = arrivalRead({ ...snapshot(kind, at, extra), policy, monitor_now: now }, flow, node, global);
  msg.context_snapshot_action = msg.context_is_future || msg.context_is_out_of_order ? "reject"
    : msg.context_is_newer || msg.context_same_changed ? "accept" : "reject";
  msg.context_rejected_reason = msg.context_is_future ? "future_timestamp"
    : msg.context_is_out_of_order ? "out_of_order"
      : msg.context_missing_timestamp ? "missing_timestamp" : "duplicate";
  return arrivalMutate(msg, flow, node, global);
}

for (const [name, run, cacheName] of [
  ["security light", delivery.bind(null, security), "people_context_v1"],
  ["arrival context", arrival, "people_context_v1"],
]) {
  const flow = memory();
  const node = logger();
  const people = "people_context";
  assert.equal(run(flow, node, people, observed).payload.context.updated_at, observed);
  for (let i = 0; i < 4; i++) {
    const result = run(flow, node, people, olderReliable, { changed: i });
    assert(result, `${name}: rejected messages still traverse the flow`);
    assert.equal(flow.get(cacheName).updated_at, observed, `${name}: old source cannot replace cache`);
    assert.equal(name === "security light" ? result._light_context.accepted : result.context_snapshot_accepted,
      false, `${name}: monotonic gate remains active`);
  }
  assert.equal(node.warnings.length, 1, `${name}: one warning per repeated observation`);
  assert.equal(node.endings.length, 0);
  run(flow, node, people, newer);
  assert.equal(flow.get(cacheName).updated_at, newer);
  assert.equal(node.endings.length, 1, `${name}: recovery ends episode`);
  run(flow, node, people, newer);
  assert.equal(node.warnings.length, 1, `${name}: duplicate is silent`);
  run(flow, node, people, newer, { changed: true });
  assert.equal(flow.get(cacheName).changed, true, `${name}: same-time derived state is reevaluated`);
  run(flow, node, people, olderReliable);
  assert.equal(node.warnings.length, 2, `${name}: new episode after recovery is visible`);

  const second = "vehicle_primary_context";
  run(flow, node, second, observed);
  run(flow, node, second, olderReliable);
  assert.equal(node.warnings.length, 3, `${name}: domains have independent episodes`);
  run(flow, node, second, now + 61_000);
  run(flow, node, second, now + 61_000);
  assert.equal(node.warnings.length, 4, `${name}: future timestamp has its own episode`);
  assert.match(node.endings.at(-1), /out_of_order/,
    `${name}: changing rejection reason closes the previous episode`);
  assert.match(node.warnings.at(-1), /future_timestamp/);

  const restarted = memory();
  restarted.set(cacheName, { updated_at: observed });
  const restartLog = logger();
  run(restarted, restartLog, people, olderReliable);
  run(restarted, restartLog, people, olderReliable);
  assert.equal(restartLog.warnings.length, 1, `${name}: replay after restart stays monotonic and bounded`);
  assert.equal(restartLog.endings.length, 0, `${name}: startup is not a false recovery`);
  assert.equal(restarted.get(cacheName).updated_at, observed);

  const expiryFlow = memory();
  const expiryLog = logger();
  run(expiryFlow, expiryLog, people, observed);
  run(expiryFlow, expiryLog, people, olderReliable);
  const episodeKey = name === "security light"
    ? "people_context_v1_rejected_snapshot_episode_v1"
    : "people_rejected_snapshot_episode_v1";
  const episode = expiryFlow.get(episodeKey);
  expiryFlow.set(episodeKey, { ...episode, started_at: now - 6 * 60 * 60 * 1000 - 1 });
  run(expiryFlow, expiryLog, people, olderReliable);
  assert.equal(expiryLog.warnings.length, 2, `${name}: long-running incident is reported again`);
  assert.equal(expiryLog.endings.length, 1);
  assert.match(expiryLog.endings[0], /expir/, `${name}: expiration is not called recovery`);
  assert.equal(expiryFlow.get(cacheName).updated_at, observed);
  run(expiryFlow, expiryLog, people, newer);
  assert.equal(expiryLog.endings.length, 2, `${name}: newer observation ends the renewed episode`);

  const residentsFlow = memory();
  const residentsLog = logger();
  run(residentsFlow, residentsLog, people, observed,
    { resident_primary: { updated_at: observed }, resident_secondary: { updated_at: observed } });
  run(residentsFlow, residentsLog, people, newer,
    { resident_primary: { updated_at: olderReliable }, resident_secondary: { updated_at: newer } });
  assert.equal(residentsFlow.get(cacheName).resident_secondary.updated_at, newer,
    `${name}: one resident's older observation does not block the other's newer one`);
  assert.equal(residentsLog.warnings.length, 0);
}

const testFlow = memory();
const testLog = logger();
testFlow.set("people_context_v1__test", { updated_at: observed });
let testMsg = { ...snapshot("people_context", olderReliable), _location_test: true };
testMsg = arrivalRead({ ...testMsg, policy, monitor_now: now }, testFlow, testLog, global);
testMsg.context_snapshot_action = "reject";
testMsg.context_rejected_reason = "out_of_order";
arrivalMutate(testMsg, testFlow, testLog, global);
assert(testFlow.get("people_rejected_snapshot_episode_v1__test"));
reset({ _location_test: true, payload: { test_mode: true } }, testFlow, testLog, global);
assert.equal(testFlow.get("people_rejected_snapshot_episode_v1__test"), undefined,
  "manual synthetic reset clears only the synthetic episode");

console.log("Rejected snapshot episodes: monotonic gates, bounded logs, recovery, domains and replay OK");
