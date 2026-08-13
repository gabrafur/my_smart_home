import assert from "node:assert/strict";
import fs from "node:fs";

const flows = JSON.parse(fs.readFileSync(new URL("../flows.json", import.meta.url), "utf8"));
const packageYaml = fs.readFileSync(
  new URL("../../homeassistant/packages/raspberry_pi_system_health.yaml", import.meta.url),
  "utf8",
);
const byId = new Map(flows.map((node) => [node.id, node]));

assert.equal(byId.size, flows.length, "flows.json contem IDs duplicados");

function node(id, type) {
  const value = byId.get(id);
  assert(value, `node ausente: ${id}`);
  assert.equal(value.type, type, `${id} deveria ser ${type}`);
  return value;
}

function firstTarget(id) {
  return node(id, byId.get(id)?.type).wires?.[0]?.[0];
}

function assertAction(id, action, entityId, data = undefined) {
  const value = node(id, "api-call-service");
  assert.equal(value.action, action);
  assert.deepEqual(value.entityId, entityId ? [entityId] : []);
  if (data !== undefined) {
    assert.deepEqual(JSON.parse(value.data), data);
    assert.equal(value.dataType, "json");
  }
}

const tab = node("raspberry_pi_cooling_tab", "tab");
assert.equal(tab.label, "resfriamento_raspberry_pi");

const hot = node("rpi_cooling_hot", "server-state-changed");
assert.deepEqual(hot.entities.entity, ["sensor.raspberry_pi_cpu_temperature"]);
assert.equal(hot.stateType, "num");
assert.equal(hot.ifStateOperator, "gt");
assert.equal(hot.ifState, "81.9");
assert.equal(hot.for, "2");
assert.equal(hot.forUnits, "minutes");
assert.equal(firstTarget(hot.id), "rpi_cooling_mark_active");

const startup = node("rpi_cooling_startup", "inject");
assert.equal(startup.once, true);
assert.equal(firstTarget(startup.id), "rpi_cooling_startup_check");
const startupCheck = node("rpi_cooling_startup_check", "api-current-state");
assert.equal(startupCheck.entity_id, "sensor.raspberry_pi_cpu_temperature");
assert.equal(startupCheck.halt_if_compare, "gt");
assert.equal(startupCheck.halt_if, "81.9");
assert.equal(firstTarget(startupCheck.id), "rpi_cooling_mark_active");

assertAction(
  "rpi_cooling_mark_active",
  "input_boolean.turn_on",
  "input_boolean.raspberry_pi_emergency_cooling",
);
assertAction(
  "rpi_cooling_set_mode",
  "climate.set_hvac_mode",
  "climate.ar_condicionado_escritorio",
  { hvac_mode: "cool" },
);
assertAction(
  "rpi_cooling_set_temperature",
  "climate.set_temperature",
  "climate.ar_condicionado_escritorio",
  { temperature: 16, hvac_mode: "cool" },
);
assertAction(
  "rpi_cooling_set_fan",
  "climate.set_fan_mode",
  "climate.ar_condicionado_escritorio",
  { fan_mode: "high" },
);
assert.deepEqual(
  [
    firstTarget("rpi_cooling_mark_active"),
    firstTarget("rpi_cooling_set_mode"),
    firstTarget("rpi_cooling_set_temperature"),
    firstTarget("rpi_cooling_set_fan"),
  ],
  [
    "rpi_cooling_set_mode",
    "rpi_cooling_set_temperature",
    "rpi_cooling_set_fan",
    "rpi_cooling_notify_started",
  ],
);

const normal = node("rpi_cooling_normal", "server-state-changed");
assert.deepEqual(normal.entities.entity, ["sensor.raspberry_pi_cpu_temperature"]);
assert.equal(normal.stateType, "num");
assert.equal(normal.ifStateOperator, "lt");
assert.equal(normal.ifState, "70");
assert.equal(normal.for, "10");
assert.equal(normal.forUnits, "minutes");

const activeCheck = node("rpi_cooling_active_check", "api-current-state");
assert.equal(activeCheck.entity_id, "input_boolean.raspberry_pi_emergency_cooling");
assert.equal(activeCheck.halt_if, "on");
assert.equal(firstTarget(activeCheck.id), "rpi_cooling_turn_off");
assertAction(
  "rpi_cooling_turn_off",
  "climate.turn_off",
  "climate.ar_condicionado_escritorio",
);
assertAction(
  "rpi_cooling_mark_inactive",
  "input_boolean.turn_off",
  "input_boolean.raspberry_pi_emergency_cooling",
);
assert.deepEqual(
  [
    firstTarget("rpi_cooling_normal"),
    firstTarget("rpi_cooling_turn_off"),
    firstTarget("rpi_cooling_mark_inactive"),
    firstTarget("rpi_cooling_dismiss_started"),
  ],
  [
    "rpi_cooling_active_check",
    "rpi_cooling_mark_inactive",
    "rpi_cooling_dismiss_started",
    "rpi_cooling_notify_recovered",
  ],
);

for (const groupId of [
  "grp_rpi_cooling_triggers",
  "grp_rpi_cooling_start",
  "grp_rpi_cooling_stop",
]) {
  const group = node(groupId, "group");
  for (const memberId of group.nodes) {
    assert.equal(node(memberId, byId.get(memberId)?.type).g, groupId);
  }
}

assert.match(packageYaml, /raspberry_pi_emergency_cooling:/);
assert.doesNotMatch(packageYaml, /id: raspberry_pi_emergency_cooling_(?:start|stop)/);
assert.doesNotMatch(packageYaml, /climate\.ar_condicionado_escritorio/);

console.log("Raspberry Pi emergency cooling flow: OK");
