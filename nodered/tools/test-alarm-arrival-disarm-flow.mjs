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
    Math,
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
assert.deepEqual(node("people_arrival_out").links, ["light_arrival_in", "alarm_arrival_in"]);
assert.deepEqual(node("creta_arrival_out").links, ["light_arrival_in", "alarm_arrival_in"]);
assert.deepEqual(node("alarm_arrival_in").links, ["people_arrival_out", "creta_arrival_out"]);
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
const arrivalActions = flows.filter(
  (item) =>
    item.z === "alarm_arrival_disarm_tab" &&
    item.type === "api-call-service",
);
assert.deepEqual(
  arrivalActions.map((item) => item.id),
  ["alarm_arrival_notify_confirmation"],
);
assert.equal(arrivalActions[0].action, "notify.send_message");
assert.deepEqual(arrivalActions[0].entityId, [
  "notify.iphone_de_gabriel_furlan",
  "notify.iphone_de_valeria",
]);
assert.match(arrivalActions[0].data, /confirm_action/);
assert.match(arrivalActions[0].data, /cancel_action/);
assert.equal(
  node("alarm_arrival_confirmation_event").eventType,
  "mobile_app_notification_action",
);
assert.deepEqual(node("alarm_arrival_cooldown").wires, [
  ["alarm_arrival_notify_confirmation"],
]);
assert.deepEqual(node("alarm_arrival_validate_confirmation").wires, [
  ["alarm_arrival_to_disarm_out"],
]);

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
assert.equal(first.result.alarm_disarm_automatic, undefined);
assert.match(first.result.confirm_action, /^ALARME_DESARMAR_/);
assert.match(first.result.cancel_action, /^ALARME_MANTER_ARMADO_/);
assert.ok(first.flowValues.alarm_arrival_last_confirmation_at >= now);
assert.equal(
  first.flowValues.alarm_arrival_pending_confirmation.confirmAction,
  first.result.confirm_action,
);
assert.ok(
  first.flowValues.alarm_arrival_pending_confirmation.expiresAt >=
    now + 5 * 60 * 1000 - 100,
);

const duplicate = runFunction(
  "alarm_arrival_cooldown",
  { arrival_source: "creta", arrival_stage: "approach" },
  first.flowValues,
);
assert.equal(duplicate.result, null);

const unrelated = runFunction(
  "alarm_arrival_validate_confirmation",
  { payload: { action: "OUTRA_ACAO" } },
  first.flowValues,
);
assert.equal(unrelated.result, null);
assert.ok(unrelated.flowValues.alarm_arrival_pending_confirmation);

const confirmed = runFunction(
  "alarm_arrival_validate_confirmation",
  {
    payload: {
      action: first.result.confirm_action,
      device_id: "telefone_teste",
    },
  },
  first.flowValues,
);
assert.equal(confirmed.result.alarm_disarm_automatic, true);
assert.equal(confirmed.result.alarm_disarm_confirmed, true);
assert.equal(
  confirmed.result.alarm_disarm_reason,
  "chegada_confirmada_gabriel_approach",
);
assert.equal(confirmed.result.alarm_disarm_confirmed_by, "telefone_teste");
assert.equal(confirmed.flowValues.alarm_arrival_pending_confirmation, null);

const cancelledValues = {
  alarm_arrival_pending_confirmation: {
    confirmAction: "CONFIRMAR_TESTE",
    cancelAction: "CANCELAR_TESTE",
    expiresAt: Date.now() + 60_000,
    source: "valeria",
    stage: "home",
  },
};
const cancelled = runFunction(
  "alarm_arrival_validate_confirmation",
  { payload: { data: { action: "CANCELAR_TESTE" } } },
  cancelledValues,
);
assert.equal(cancelled.result, null);
assert.equal(cancelled.flowValues.alarm_arrival_pending_confirmation, null);

const expiredValues = {
  alarm_arrival_pending_confirmation: {
    confirmAction: "CONFIRMACAO_EXPIRADA",
    cancelAction: "CANCELAMENTO_EXPIRADO",
    expiresAt: Date.now() - 1,
    source: "creta",
    stage: "approach",
  },
};
const expired = runFunction(
  "alarm_arrival_validate_confirmation",
  { payload: { action: "CONFIRMACAO_EXPIRADA" } },
  expiredValues,
);
assert.equal(expired.result, null);
assert.equal(expired.flowValues.alarm_arrival_pending_confirmation, null);

console.log("Confirmed alarm disarm-on-arrival flow tests passed.");
