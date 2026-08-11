import assert from "node:assert/strict";
import fs from "node:fs";

const flows = JSON.parse(
  fs.readFileSync(new URL("../flows.json", import.meta.url), "utf8"),
);
const byId = new Map(flows.map((node) => [node.id, node]));
const LIGHT_TAB_ID = "ce258dec9814b96b";
const ALARM_TAB_ID = "alarm_house_tab";

function node(id) {
  const result = byId.get(id);
  assert.ok(result, `missing node: ${id}`);
  return result;
}

assert.equal(new Set(flows.map((item) => item.id)).size, flows.length);
assert.equal(node(LIGHT_TAB_ID).label, "iluminacao_externa");
assert.equal(node(ALARM_TAB_ID).type, "tab");
assert.equal(node(ALARM_TAB_ID).label, "alarme_casa");

const alarmNodeIds = [
  "moni_mobile_arm_event",
  "de18d31309e8a0ca",
  "922ddf470a08d43f",
  "70eb073f8191e69e",
  "8261c7cfb6756ca8",
  "arm_alarm_catch",
  "arm_alarm_retry_decision",
  "arm_alarm_retry_delay",
  "e380ce19c7f96420",
  "alarm_real_change_filter",
  "arm_alarm_notify_success",
  "moni_mobile_update_after_arm",
  "disarm_alarm_notify_success",
  "disarm_alarm_catch",
  "disarm_alarm_retry_decision",
  "disarm_alarm_retry_delay",
  "alarm_set_desired_arm",
  "alarm_set_desired_disarm",
  "alarm_guard_arm",
  "alarm_guard_disarm",
  "alarm_arrival_disarm_command_in",
  "alarm_notify_alexa",
];

for (const id of alarmNodeIds) {
  assert.equal(node(id).z, ALARM_TAB_ID, `${id} ficou fora da aba do alarme`);
}

for (const id of [
  "2dd5071569184cb4",
  "ext_zigbee_command_gate",
  "ext_alarm_armed_off",
  "ext_build_alexa_message",
  "9d81b75a18d482f1",
]) {
  assert.equal(node(id).z, LIGHT_TAB_ID, `${id} ficou fora da aba de iluminação`);
}

assert.deepEqual(node("70e147e6b7df9826").wires, [
  ["2dd5071569184cb4", "alarm_dulo_hub_link_out"],
]);
assert.deepEqual(node("alarm_dulo_hub_link_out").links, [
  "alarm_dulo_hub_link_in",
]);
assert.deepEqual(node("alarm_dulo_hub_link_in").links, [
  "alarm_dulo_hub_link_out",
]);
assert.deepEqual(node("alarm_dulo_hub_link_in").wires, [
  ["de18d31309e8a0ca"],
]);

assert.deepEqual(node("alarm_real_change_filter").wires, [
  ["alarm_armed_lighting_out"],
]);
assert.deepEqual(node("alarm_armed_lighting_out").links, [
  "ext_alarm_armed_lighting_in",
]);
assert.deepEqual(node("ext_alarm_armed_lighting_in").links, [
  "alarm_armed_lighting_out",
]);
assert.deepEqual(node("ext_alarm_armed_lighting_in").wires, [
  ["ext_alarm_armed_off"],
]);

for (const id of [
  "arm_alarm_retry_decision",
  "moni_mobile_update_after_arm",
  "disarm_alarm_notify_success",
  "disarm_alarm_retry_decision",
]) {
  assert.ok(
    node(id).wires.flat().includes("alarm_notify_alexa"),
    `${id} não usa o aviso Alexa da aba do alarme`,
  );
  assert.ok(!node(id).wires.flat().includes("9d81b75a18d482f1"));
}

const updateMoniMobile = node("moni_mobile_update_after_arm");
assert.equal(updateMoniMobile.action, "homeassistant.update_entity");
assert.deepEqual(updateMoniMobile.entityId, []);
assert.deepEqual(JSON.parse(updateMoniMobile.data), {
  entity_id: ["alarm_control_panel.alarme_moni_mobile"],
});

for (const item of flows.filter((candidate) => candidate.type === "function")) {
  new Function(
    "msg",
    "node",
    "context",
    "flow",
    "global",
    "env",
    "setTimeout",
    "clearTimeout",
    item.func,
  );
}

for (const item of flows.filter((candidate) => candidate.z)) {
  for (const targetId of (item.wires || []).flat()) {
    const target = node(targetId);
    assert.equal(
      target.z,
      item.z,
      `wire direto entre abas: ${item.id} -> ${targetId}`,
    );
  }
}

console.log("Alarm-house flow separation tests passed.");
