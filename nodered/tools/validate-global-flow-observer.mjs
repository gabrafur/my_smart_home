#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const flows = JSON.parse(
  fs.readFileSync(path.resolve(here, "..", "flows.json"), "utf8"),
);
const byId = new Map(flows.map((node) => [node.id, node]));
const required = (id) => {
  const node = byId.get(id);
  assert.ok(node, `Cobertura global ausente: ${id}`);
  return node;
};
const observerTab = required("global_flow_observer_tab");
assert.equal(observerTab.type, "tab");

const expectedOuts = [];
const tabs = flows.filter(
  (node) => node.type === "tab" && node.id !== observerTab.id,
);
for (const tab of tabs) {
  const prefix = `global_observer_coverage__${tab.id}`;
  const group = required(`${prefix}__group`);
  const catcher = required(`${prefix}__catch`);
  const status = required(`${prefix}__status`);
  const annotate = required(`${prefix}__annotate`);
  const output = required(`${prefix}__out`);
  assert.equal(group.z, tab.id, `grupo de observação fora de ${tab.label}`);
  assert.deepEqual(new Set(group.nodes), new Set([
    catcher.id,
    status.id,
    annotate.id,
    output.id,
  ]));
  assert.equal(catcher.scope, null, `catch não cobre toda a aba ${tab.label}`);
  assert.equal(catcher.uncaught, false, `catch ignora erros já tratados em ${tab.label}`);
  assert.equal(status.scope, null, `status não cobre toda a aba ${tab.label}`);
  assert.deepEqual(catcher.wires, [[annotate.id]]);
  assert.deepEqual(status.wires, [[annotate.id]]);
  assert.match(annotate.func, new RegExp(JSON.stringify(tab.id)));
  assert.match(annotate.func, new RegExp(JSON.stringify(tab.label).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.deepEqual(annotate.wires, [[output.id]]);
  assert.deepEqual(output.links, ["global_observer_events_in"]);
  expectedOuts.push(output.id);
}

const input = required("global_observer_events_in");
for (const outputId of expectedOuts) {
  assert.ok(input.links.includes(outputId), `link in não referencia ${outputId}`);
}
assert.deepEqual(input.wires, [["global_observer_ingest"]]);
const notify = required("global_observer_notify_primary");
const persistent = required("global_observer_notify_persistent");
const guard = required("global_observer_dispatch_guard");
assert.equal(notify.action, "public_bindings.call");
assert.match(notify.data, /"role":"mobile_primary"/);
assert.match(notify.data, /"action":"notify_3"/);
assert.equal(notify.queue, "all");
assert.equal(persistent.action, "persistent_notification.create");
assert.equal(persistent.domain, "persistent_notification");
assert.match(persistent.data, /_observer_persistent_notification_id/);
assert.equal(persistent.queue, "all");
assert.equal(guard.outputs, 3);
assert.deepEqual(guard.wires, [
  [notify.id],
  [persistent.id],
  ["global_observer_dry_run_out"],
]);
assert.deepEqual(
  required("global_observer_notification_catch").scope,
  [notify.id, persistent.id],
);
const internalCatch = required("global_observer_internal_catch");
const expectedInternalScope = [
  "global_observer_ingest",
  "global_observer_error_accepted_save",
  "global_observer_error_connection_save",
  "global_observer_error_mutate",
  "global_observer_error_alert",
  "global_observer_status_unmonitored",
  "global_observer_status_failure",
  "global_observer_status_recovery",
  "global_observer_unknown_ignore",
  "global_observer_evaluate",
  "global_observer_evaluate_clear_uncorroborated",
  "global_observer_evaluate_clear_transient",
  "global_observer_evaluate_confirm",
  "global_observer_evaluate_alert",
  guard.id,
];
assert.deepEqual(internalCatch.scope, expectedInternalScope);
assert.deepEqual(internalCatch.wires, [["global_observer_internal_failure"]]);
assert.deepEqual(required("global_observer_internal_failure").wires, [
  [notify.id],
  [persistent.id],
]);
assert.ok(required("global_observer_test_delivery").props.some(
  (property) => property.p === "_observer_delivery_test" && property.v === "true",
));
assert.match(required("global_observer_dry_run_terminal").func, /dispatched: false/);
for (const id of [
  "global_observer_event_kind",
  "global_observer_error_accepted_gate",
  "global_observer_error_connection_gate",
  "global_observer_error_notification_gate",
  "global_observer_status_monitored_gate",
  "global_observer_status_failure_gate",
  "global_observer_evaluate_corroboration_gate",
  "global_observer_evaluate_duration_gate",
  "global_observer_evaluate_notification_gate",
]) {
  assert.equal(required(id).type, "switch", `decisão não visual: ${id}`);
}
for (const [id, topic, value] of [
  ["global_observer_policy_default_grace", "connection_recovery_grace_seconds", "90"],
  ["global_observer_policy_default_confirm", "status_confirm_seconds", "60"],
  ["global_observer_policy_default_reminder", "reminder_hours", "6"],
  ["global_observer_policy_default_retention", "error_retention_days", "7"],
  ["global_observer_policy_default_corroboration", "ha_corroboration_sources", "2"],
]) {
  const parameter = required(id);
  assert.equal(parameter.type, "inject");
  assert.equal(parameter.topic, topic);
  assert.equal(parameter.payload, value);
  assert.deepEqual(parameter.wires, [["global_observer_policy_validate"]]);
}

console.log(`Global flow observer policy valid: ${tabs.length} tabs covered.`);
