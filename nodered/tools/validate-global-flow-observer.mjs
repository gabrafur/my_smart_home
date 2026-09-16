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
const logicalWireTargets = (id, output = 0) => (required(id).wires?.[output] ?? []).flatMap((targetId) => {
  const target = required(targetId);
  const generatedRoute = target.notification_hub_wire_route ||
    /^notification_hub_wire_out_[a-f0-9]{12}$/.test(target.id);
  if (target.type !== "link out" || !generatedRoute) return [targetId];
  return (target.links ?? []).flatMap((linkInId) => required(linkInId).wires?.[0] ?? []);
});
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
assert.equal(input.links.includes("local_ai_rtx_alert_out"), false);
const dispatchInput = required("global_observer_alert_to_dispatch_in");
for (const [clearId, outputId] of [
  ["global_observer_evaluate_clear_uncorroborated", "global_observer_uncorroborated_recovery_out"],
  ["global_observer_evaluate_clear_transient", "global_observer_transient_recovery_out"],
]) {
  const clear = required(clearId);
  const output = required(outputId);
  assert.deepEqual(clear.wires, [[output.id]]);
  assert.equal(output.type, "link out");
  assert.deepEqual(output.links, [dispatchInput.id]);
  assert.ok(dispatchInput.links.includes(output.id));
}
for (const id of [
  "global_observer_integration_alert_out",
  "local_ai_rtx_alert_out",
  "notification_hub_mobile_observer_out",
  "notification_hub_alexa_observer_out",
  "notification_hub_persistent_observer_out",
]) assert.ok(dispatchInput.links.includes(id), `entrada de domínio não referencia ${id}`);
assert.deepEqual(input.wires, [["global_observer_ingest"]]);
const notify = required("global_observer_notify_primary");
const persistent = required("global_observer_notify_persistent");
const guard = required("global_observer_dispatch_guard");
assert.equal(notify.type, "change");
const notifyRules = notify.rules.map((rule) => String(rule.to ?? "")).join("\n");
assert.match(notifyRules, /"recipients":\["resident_primary"\]/);
assert.match(notifyRules, /delivery_under_test/);
assert.equal(required("global_observer_notify_primary__hub_call").type, "link call");
assert.deepEqual(required("global_observer_notify_primary__hub_call").links, ["notification_hub_mobile_in"]);
assert.equal(persistent.type, "change");
const persistentRules = persistent.rules
  .map((rule) => String(rule.to ?? ""))
  .join("\n");
assert.match(persistentRules, /_observer_persistent_notification_id/);
assert.match(persistentRules, /persistent_notification_operation/);
assert.equal(required("global_observer_notify_persistent__hub_call").type, "link call");
assert.deepEqual(required("global_observer_notify_persistent__hub_call").links, ["notification_hub_persistent_in"]);
assert.equal(guard.outputs, 3);
assert.deepEqual(logicalWireTargets(guard.id, 0), [notify.id]);
assert.deepEqual(logicalWireTargets(guard.id, 1), [persistent.id]);
assert.deepEqual(logicalWireTargets(guard.id, 2), ["global_observer_dry_run_out"]);
assert.deepEqual(
  required("global_observer_notification_catch").scope,
  ["global_observer_notify_primary__hub_call", "global_observer_notify_persistent__hub_call"],
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
  "global_observer_integration_entries",
  "global_observer_integration_normalize",
  "global_observer_integration_lifecycle",
];
assert.deepEqual(internalCatch.scope, expectedInternalScope);
assert.deepEqual(internalCatch.wires, [["global_observer_internal_failure"]]);
assert.deepEqual(logicalWireTargets("global_observer_internal_failure", 0), [notify.id]);
assert.deepEqual(logicalWireTargets("global_observer_internal_failure", 1), [persistent.id]);
assert.ok(required("global_observer_test_delivery").props.some(
  (property) => property.p === "_observer_delivery_test" && property.v === "true",
));
const integrationGroup = required("global_observer_integration_group");
assert.equal(integrationGroup.type, "group");
for (const id of [
  "global_observer_integration_architecture",
  "global_observer_integration_tick",
  "global_observer_integration_test_in",
  "global_observer_integration_entries",
  "global_observer_integration_normalize",
  "global_observer_integration_lifecycle",
  "global_observer_integration_alert_out",
]) {
  assert.ok(integrationGroup.nodes.includes(id), `grupo de integrações não contém ${id}`);
}
const integrationTick = required("global_observer_integration_tick");
assert.equal(integrationTick.type, "inject");
assert.equal(integrationTick.repeat, "60");
assert.equal(integrationTick.once, true);
const integrationEntries = required("global_observer_integration_entries");
assert.equal(integrationEntries.type, "ha-api");
assert.equal(integrationEntries.protocol, "websocket");
assert.equal(integrationEntries.data, '{"type":"config_entries/get"}');
assert.deepEqual(integrationEntries.wires, [["global_observer_integration_normalize"]]);
assert.deepEqual(
  required("global_observer_integration_normalize").wires,
  [["global_observer_integration_lifecycle"]],
);
assert.deepEqual(
  required("global_observer_integration_lifecycle").wires,
  [["global_observer_integration_alert_out"]],
);
assert.deepEqual(
  required("global_observer_integration_alert_out").links,
  ["global_observer_alert_to_dispatch_in"],
);
for (const id of [
  "global_observer_test_integration_reset",
  "global_observer_test_integration_failure",
  "global_observer_test_integration_confirm",
  "global_observer_test_integration_recovery",
]) {
  assert.deepEqual(required(id).wires, [["global_observer_integration_test_out"]]);
}
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
