import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const flows = JSON.parse(
  fs.readFileSync(new URL("../flows.json", import.meta.url), "utf8"),
);
const byId = new Map(flows.map((node) => [node.id, node]));

function node(id) {
  const result = byId.get(id);
  assert.ok(result, `missing node: ${id}`);
  return result;
}

function runFunction(id, msg, flowValues = {}) {
  const statuses = [];
  const context = {
    msg,
    node: { status: (status) => statuses.push(status) },
    flow: {
      get: (key) => flowValues[key],
      set: (key, value) => {
        flowValues[key] = value;
      },
    },
    Date,
    Set,
    Array,
    Number,
  };
  const result = vm.runInNewContext(
    `(function () { ${node(id).func}\n})()`,
    context,
  );
  return { result, flowValues, statuses };
}

assert.equal(node("alarm_arrival_disarm_tab").type, "tab");
assert.equal(node("alarm_arrival_disarm_tab").label, "alarme_desarme_chegada");
assert.ok(
  node("sec_detect_arriving_source").wires[0].includes(
    "sec_arrival_disarm_out",
  ),
);
assert.deepEqual(node("sec_arrival_disarm_out").links, ["alarm_arrival_in"]);
assert.deepEqual(node("alarm_arrival_in").links, ["sec_arrival_disarm_out"]);
assert.equal(
  node("alarm_arrival_read_state").entity_id,
  "alarm_control_panel.alarme_moni_mobile",
);
assert.deepEqual(node("alarm_arrival_is_armed").rules, [
  { t: "eq", v: "armed_away", vt: "str" },
]);
assert.deepEqual(node("alarm_arrival_disarm_command_in").wires, [
  ["alarm_set_desired_disarm"],
]);
assert.equal(
  flows.filter(
    (item) =>
      item.z === "alarm_arrival_disarm_tab" &&
      item.type === "api-call-service",
  ).length,
  0,
  "new tab must reuse the existing guarded retry chain",
);

const valid = runFunction("alarm_arrival_validate", {
  payload: {
    source: "valeria",
    arriving: ["valeria"],
    arrival_stage: "approach",
  },
});
assert.equal(valid.result.arrival_source, "valeria");
assert.equal(valid.result.arrival_stage, "approach");

for (const payload of [
  { source: "desconhecido", arriving: ["desconhecido"], arrival_stage: "home" },
  { source: "gabriel", arriving: [], arrival_stage: "home" },
  { source: "creta", arriving: ["creta"], arrival_stage: "away" },
]) {
  assert.equal(
    runFunction("alarm_arrival_validate", { payload }).result,
    null,
  );
}

const now = Date.now();
const first = runFunction(
  "alarm_arrival_cooldown",
  { arrival_source: "gabriel", arrival_stage: "approach" },
  {},
);
assert.equal(first.result.alarm_disarm_automatic, true);
assert.equal(
  first.result.alarm_disarm_reason,
  "chegada_gabriel_approach",
);
assert.ok(first.flowValues.alarm_arrival_last_disarm_request_at >= now);

const duplicate = runFunction(
  "alarm_arrival_cooldown",
  { arrival_source: "creta", arrival_stage: "approach" },
  first.flowValues,
);
assert.equal(duplicate.result, null);

console.log("Automatic alarm disarm-on-arrival flow tests passed.");
