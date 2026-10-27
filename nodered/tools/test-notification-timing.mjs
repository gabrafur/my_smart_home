import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import jsonata from "jsonata";
import { notificationTimingObservation as observe } from "./notification-timing.mjs";

const iso = milliseconds => new Date(milliseconds).toISOString();
const base = Date.parse("2030-01-02T03:04:05.000Z");
const accepted = base + 3500;
const timing = () => ({ version: 1, source_observed_at: iso(base),
  source_time_kind: "producer_occurrence", first_detected_at: iso(base + 1000),
  policy_decided_at: iso(base + 3000) });
const expected = observe(timing(), iso(accepted));
assert.equal(expected.state, "observed");
assert.equal(expected.source_to_detection_ms, 1000);
assert.equal(expected.detection_to_decision_ms, 2000);
assert.equal(expected.decision_to_accept_ms, 500);

assert.equal(observe(undefined, iso(accepted)).reason, "metadata_not_supplied");
assert.equal(observe(undefined, iso(accepted)).decision_to_accept_ms, null);
assert.equal(observe({ version: 1, source_observed_at: null, source_time_kind: "unknown",
  first_detected_at: null, policy_decided_at: null }, iso(accepted)).state, "unknown");
const partial = observe({ ...timing(), source_observed_at: null, source_time_kind: "unknown" }, iso(accepted));
assert.equal(partial.state, "partial");
assert.equal(partial.source_to_detection_ms, null);
assert.equal(partial.detection_to_decision_ms, 2000);
assert.equal(partial.decision_to_accept_ms, 500);
for (const input of [null, [], { ...timing(), private: "PRIVATE_SENTINEL" },
  { ...timing(), source_observed_at: "PRIVATE_SENTINEL" },
  { ...timing(), first_detected_at: "2030-02-30T00:00:00Z" },
  { ...timing(), policy_decided_at: "2030-01-02T03:04:08+03:00" },
  { ...timing(), first_detected_at: 0 },
  { ...timing(), source_observed_at: null },
  { ...timing(), source_time_kind: "unknown" }]) {
  const result = observe(input, iso(accepted));
  assert.equal(result.state, "unknown");
  assert.equal(result.reason, "invalid_metadata");
  assert.ok(!JSON.stringify(result).includes("PRIVATE_SENTINEL"));
}
for (const input of [{ ...timing(), first_detected_at: iso(base - 1) },
  { ...timing(), policy_decided_at: iso(accepted + 1) },
  { ...timing(), source_observed_at: null, source_time_kind: "unknown", first_detected_at: iso(accepted + 10) }]) {
  const result = observe(input, iso(accepted));
  assert.equal(result.state, "clock_conflict");
  for (const field of ["source_to_detection_ms", "detection_to_decision_ms", "decision_to_accept_ms"]) {
    assert.equal(result[field], null);
  }
}

const flows = JSON.parse(fs.readFileSync(process.env.GLOBAL_OBSERVER_TEST_FLOW ?? new URL("../flows.json", import.meta.url), "utf8"));
const nodes = new Map(flows.map(node => [node.id, node]));
const store = new Map();
const fixedDate = class extends Date {
  constructor(...args) { super(...(args.length ? args : [accepted])); }
  static now() { return accepted; }
};
function run(id, input) {
  const node = nodes.get(id);
  assert.equal(node?.type, "function", id);
  return vm.runInNewContext(`(function () { ${node.func}\n})()`, {
    msg: structuredClone(input), Date: fixedDate,
    flow: { get: key => store.get(`${node.z}:${key}`), set: (key, value) => store.set(`${node.z}:${key}`, value) },
    node: { log() {}, status() {}, error(reason) { throw Error(reason); } },
  });
}
const plain = value => JSON.parse(JSON.stringify(value));
const source = { payload: { ...timing(), version: undefined, test_mode: false, observer_kind: "host_failure" },
  alert: { title: "Synthetic title", message: "Synthetic message" } };
delete source.payload.version;
const guarded = run("global_observer_dispatch_guard", source);
assert.ok(guarded[0] && guarded[1]);

// Run the actual generated JSONata adapters; unrelated message fields must
// survive both request transformations and each hub validator.
for (const [channel, branch, adapter] of [
  ["mobile", 0, "global_observer_notify_primary"],
  ["persistent", 1, "global_observer_notify_persistent"],
]) {
  let message = structuredClone(guarded[branch]);
  for (const rule of nodes.get(adapter).rules) {
    assert.equal(rule.t, "set");
    message[rule.p] = rule.tot === "jsonata" ? await jsonata(rule.to).evaluate(message) : rule.to;
  }
  const validated = run(`notification_hub_${channel}_validate`, message);
  assert.ok(validated[0]);
  message = { ...validated[0], _notification_hub_channel: channel };
  const [entry, dry] = run(`notification_hub_${channel}_history_record`, message);
  assert.equal(dry, null);
  const record = JSON.parse(entry.payload);
  assert.deepEqual(record.timing, expected);
  assert.equal(record.message, "Synthetic message");
  assert.equal(record.status, "accepted");
  const result = run(`notification_hub_${channel}_success`, message);
  assert.deepEqual(plain(result.notification_delivery.timing), expected);
  // Simulated history never yields a filename or write output.
  message.notification.test_mode = true;
  const simulated = run(`notification_hub_${channel}_history_record`, message);
  assert.equal(simulated[0], null);
  assert.equal(simulated[1].filename, undefined);
  assert.deepEqual(plain(simulated[1].notification_delivery.timing), expected);
  const dryResult = run(`notification_hub_${channel}_dry_run_terminal`, message)[0];
  assert.equal(dryResult.notification_delivery.simulated, true);
  assert.equal(dryResult.notification_delivery.dispatched, false);
  assert.deepEqual(plain(dryResult.notification_delivery.timing), expected);
}

// The production and manual global paths build the same canonical object
// before the final effect gate; no notification/service executor is run here.
const dryGuard = run("global_observer_dispatch_guard", { ...source, _global_observer_test: true });
assert.equal(dryGuard[0], null);
assert.equal(dryGuard[1], null);
run("global_observer_dry_run_terminal", dryGuard[2]);
const terminal = store.get("global_flow_observer_tab:global_flow_observer_last_dry_run_v1");
assert.equal(terminal.simulated, true);
assert.equal(terminal.dispatched, false);
assert.deepEqual(plain(terminal.timing), expected);

// A legacy pending incident keeps its old detection time, without inferring
// a missing source clock from a newer resource sample.
const hostKey = "host_observer_tab:host_observer_incidents_v1__test";
store.set(hostKey, { version: 1, incidents: { resource_host_memory: {
  first_seen_at: base, last_seen_at: base, notified_at: null,
  kind: "resource", current_evidence: "failed", sample_count: 1, last_sample_at: iso(base),
} } });
const hostMessage = { _host_observer_test: true, _host_now: base + 3000,
  _host_policy: { resource_confirm_ms: 1000 }, _host_signal: "failed",
  _host_fact: { kind: "resource", name: "memory", observed_at: iso(base + 2000) } };
const legacy = run("host_obs_lifecycle", hostMessage);
assert.equal(legacy.payload.source_observed_at, null);
assert.equal(legacy.payload.first_detected_at, iso(base));
assert.equal(legacy.payload.source_time_kind, "unknown");
store.delete(hostKey);
assert.equal(run("host_obs_lifecycle", { ...hostMessage, _host_now: base,
  _host_fact: { ...hostMessage._host_fact, observed_at: iso(base - 1000) } }), null);
const fresh = run("host_obs_lifecycle", { ...hostMessage, _host_now: base + 3000,
  _host_fact: { ...hostMessage._host_fact, observed_at: iso(base + 3000) } });
assert.equal(fresh.payload.source_observed_at, iso(base - 1000));
assert.equal(fresh.payload.first_detected_at, iso(base));
console.log("Notification timing: closed metadata, unknown legacy clocks, conflict handling, generated requests, history and full dry-run boundaries passed.");
