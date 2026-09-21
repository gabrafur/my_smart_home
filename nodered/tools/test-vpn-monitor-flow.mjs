#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";

const flowsPath = process.argv[2] ?? new URL("../flows.json", import.meta.url);
const flows = JSON.parse(fs.readFileSync(flowsPath, "utf8"));
const byId = new Map(flows.map((node) => [node.id, node]));
const tabNodes = flows.filter((node) => node.z === "monitoramento_vpn_tab");
const compile = (id) => {
  const node = byId.get(id);
  assert.equal(node?.type, "function", `function ausente: ${id}`);
  return new Function("msg", "flow", "node", "Buffer", node.func);
};
function context() {
  const stores = { default: new Map(), persistent: new Map() };
  return {
    stores,
    get(key, store = "default") { return stores[store].get(key); },
    set(key, value, store = "default") { stores[store].set(key, structuredClone(value)); },
  };
}
const nodeMock = { status() {}, log() {}, warn() {}, error() {} };
const call = (fn, msg, flow) => fn(msg, flow, nodeMock, Buffer);
const f = Object.fromEntries([
  "policy_validate", "policy_store", "policy_load", "report_ingest", "internet_ingest", "facts_read",
  "suppress", "failure_update", "offline_update", "down_build", "online_update", "recovery_update",
  "recovery_build", "state_write", "publications_build"
].map((name) => [name, compile(`vpn_monitor_${name}`)]));
f.guard = compile("vpn_monitor_notify_guard");
f.dry_run = compile("vpn_monitor_dry_run_terminal");
const defaults = { failure_confirm_s: 120, recovery_confirm_s: 60, report_stale_s: 180, reminder_s: 86400 };

for (const id of [
  "vpn_monitor_policy_switch", "vpn_monitor_policy_available", "vpn_monitor_internet_online",
  "vpn_monitor_healthy", "vpn_monitor_failure_confirmed", "vpn_monitor_notification_due",
  "vpn_monitor_incident_open", "vpn_monitor_recovery_confirmed",
]) assert.equal(byId.get(id)?.type, "switch", `decisão visual ausente: ${id}`);

const store = context();
let msg = call(f.policy_validate, { payload: defaults }, store);
assert.equal(msg.policy_valid, true);
call(f.policy_store, msg, store);
assert.deepEqual(call(f.policy_load, {}, store).policy, { version: 1, ...defaults });
for (const invalid of [
  { ...defaults, failure_confirm_s: 0 }, { ...defaults, failure_confirm_s: 601 },
  { ...defaults, recovery_confirm_s: 0 }, { ...defaults, recovery_confirm_s: 301 },
  { ...defaults, report_stale_s: 29 }, { ...defaults, report_stale_s: 901 },
  { ...defaults, reminder_s: 299 }, { ...defaults, reminder_s: 172801 },
]) assert.equal(call(f.policy_validate, { payload: invalid }, store).policy_valid, false);
assert.equal(call(f.policy_validate, { payload: { failure_confirm_s: 1, recovery_confirm_s: 1, report_stale_s: 30, reminder_s: 300 } }, store).policy_valid, true);
assert.equal(call(f.policy_validate, { payload: { failure_confirm_s: 600, recovery_confirm_s: 300, report_stale_s: 900, reminder_s: 172800 } }, store).policy_valid, true);
assert.deepEqual(call(f.policy_load, {}, store).policy, { version: 1, ...defaults }, "inválido não substitui política");

const internet = (phase, now) => ({ _vpn_test: true, vpn_now: now, payload: phase });
const report = (healthy, now, reason = healthy ? "running" : "backend_stopped") => ({
  _vpn_test: true, vpn_now: now, payload: {
    schema_version: 1, checked_at: new Date(now).toISOString(),
    vpns: [{ role: "vpn_primary", kind: "tailscale", installed: true, healthy, reason, checked_at: new Date(now).toISOString() }],
  },
});
function evaluate(target, now) {
  let current = call(f.policy_load, { _vpn_test: true, vpn_now: now, payload: { test_mode: true } }, target);
  current = call(f.facts_read, current, target);
  let notification = null;
  if (!current.vpn.internet_online) current = call(f.suppress, current, target);
  else if (!current.vpn.healthy) {
    current = call(f.failure_update, current, target);
    if (current.vpn.failure_elapsed_s >= current.policy.failure_confirm_s) {
      current = call(f.offline_update, current, target);
      if (current.vpn.notification_due) {
        const outputs = call(f.down_build, current, target);
        notification = outputs[0];
        current = outputs[1];
      }
    }
  } else if (current.vpn.current.incident_open) {
    current = call(f.recovery_update, current, target);
    if (current.vpn.recovery_elapsed_s >= current.policy.recovery_confirm_s) {
      const outputs = call(f.recovery_build, current, target);
      notification = outputs[0];
      current = outputs[1];
    }
  } else current = call(f.online_update, current, target);
  current = call(f.state_write, current, target);
  const publications = call(f.publications_build, current, target)[0];
  return { current, notification, publications };
}

call(f.internet_ingest, internet("online", 100000), store);
call(f.report_ingest, report(false, 100000), store);
assert.equal(evaluate(store, 100000).notification, null);
assert.equal(evaluate(store, 219000).notification, null, "119 s não confirma");
let result = evaluate(store, 220000);
assert.match(result.notification.notification.title, /TESTE.*Tailscale.*indisponível/);
assert.equal(result.publications.length, 3);
assert.equal(evaluate(store, 221000).notification, null, "incidente aberto é deduplicado");
let guarded = call(f.guard, result.notification, store);
assert.equal(guarded[0], null);
assert.equal(guarded[1].payload.dispatched, false);
call(f.dry_run, guarded[1], store);
assert.equal(store.stores.default.get("vpn_monitor_last_dry_run_v1").notification_sent, false);

call(f.report_ingest, report(true, 230000), store);
assert.equal(evaluate(store, 230000).notification, null);
result = evaluate(store, 290000);
assert.match(result.notification.notification.title, /TESTE.*recuperada/);

const suppressed = context();
call(f.policy_store, call(f.policy_validate, { payload: defaults }, suppressed), suppressed);
call(f.internet_ingest, internet("offline", 100000), suppressed);
call(f.report_ingest, report(false, 100000), suppressed);
assert.equal(evaluate(suppressed, 400000).notification, null);
assert.equal(suppressed.stores.default.get("vpn_monitor_state_v1__test").vpn_primary.phase, "suppressed_internet");

const stale = context();
call(f.policy_store, call(f.policy_validate, { payload: defaults }, stale), stale);
call(f.internet_ingest, internet("online", 100000), stale);
call(f.report_ingest, report(true, 100000), stale);
evaluate(stale, 400000);
result = evaluate(stale, 520000);
assert.match(result.notification.notification.message, /deixou de atualizar/);

assert.equal(byId.get("vpn_monitor_notify_dispatch")?.type, "change");
assert.match(byId.get("vpn_monitor_notify_dispatch__mobile_prepare")?.rules?.find((rule) => rule.p === "notification")?.to ?? "", /"recipients":\["resident_primary"\]/);
assert.equal(byId.has("vpn_monitor_notify_dispatch__mobile_secondary_prepare"), false);
assert.deepEqual(byId.get("vpn_monitor_notify_dispatch__mobile_call")?.links, ["notification_hub_mobile_in"]);
assert.equal(byId.has("vpn_monitor_notify_dispatch__mobile_secondary_call"), false);
assert.equal(byId.has("vpn_monitor_notify_dispatch__alexa_call"), false);
assert.deepEqual(byId.get("vpn_monitor_notify_dispatch__persistent_call")?.links, ["notification_hub_persistent_in"]);
assert.equal(byId.get("vpn_monitor_state_out")?.retain, "true");
assert.equal(byId.get("vpn_monitor_health_in")?.topic, "nodered/infrastructure/vpn/host-health");
assert.equal(byId.get("vpn_monitor_internet_in")?.topic, "nodered/infrastructure/internet/state");
for (const node of tabNodes.filter((entry) => entry.type === "function" && entry.id !== "vpn_monitor_discovery")) {
  assert.ok(node.func.length < 2000, `JavaScript residual grande: ${node.id} (${node.func.length})`);
}
console.log("VPN visual flow: policy bounds, suppression, failure, recovery, dedupe and dry-run passed.");
