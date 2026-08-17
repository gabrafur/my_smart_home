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
  const globalValues = {};
  const context = {
    msg,
    node: { status: (status) => statuses.push(status) },
    flow: {
      get: (key) => flowValues[key],
      set: (key, value) => {
        flowValues[key] = value;
      },
    },
    global: {
      get: (key) => globalValues[key],
      set: (key, value) => {
        globalValues[key] = value;
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

const arrivalTab = "1f468eaeef0733dd";
const peopleArrivalOut = "397c6032b3dad342";
const vehicleArrivalOut = "2aa1b0c2907d4017";
const arrivalIn = "6481cb991b3732f5";
const validateArrival = "20b07bd3484da8f9";
const readAlarm = "af0496cef18e47ca";
const isArmed = "a305a1379c919215";
const cooldown = "88bf3513a44e58e6";
const primaryNotification = "3b95712a74512929";
const secondaryNotification = "370622ddaaf3fcab";
const confirmationEvent = "9d0d42f03aa9013d";
const validateConfirmation = "815c14ef3c054b25";
const disarmOut = "dcd87a69ec3c6008";

assert.equal(node(arrivalTab).type, "tab");
assert.equal(node(arrivalTab).label, "alarme_desarme_chegada");
assert.ok(node(peopleArrivalOut).links.includes(arrivalIn));
assert.ok(node(vehicleArrivalOut).links.includes(arrivalIn));
assert.deepEqual(node(arrivalIn).links.sort(), [peopleArrivalOut, vehicleArrivalOut].sort());
assert.equal(
  node(readAlarm).entity_id,
  "alarm_control_panel.security_panel",
);
assert.deepEqual(node(isArmed).rules, [
  { t: "eq", v: "armed_away", vt: "str" },
]);
assert.deepEqual(node("alarm_arrival_disarm_command_in").wires, [
  ["alarm_set_desired_disarm"],
]);
const arrivalActions = flows.filter(
  (item) =>
    item.z === arrivalTab &&
    item.type === "api-call-service",
);
for (const action of arrivalActions) {
  assert.equal(action.action, "public_bindings.call");
  assert.match(action.data, /"role":"mobile_(?:primary|secondary)"/);
}
const confirmationActions = arrivalActions.filter((action) =>
  [primaryNotification, secondaryNotification].includes(action.id));
assert.equal(confirmationActions.length, 2);
for (const action of confirmationActions) {
  assert.match(action.data, /confirm_action/);
  assert.match(action.data, /cancel_action/);
}
assert.equal(
  node(confirmationEvent).eventType,
  "mobile_app_notification_action",
);
assert.deepEqual(node(cooldown).wires, [
  [primaryNotification, secondaryNotification],
]);
assert.deepEqual(node(validateConfirmation).wires[0], [disarmOut]);

const valid = runFunction(validateArrival, {
  payload: {
    contract: "security.arrival.v1",
    kind: "arrival",
    source: "resident_secondary",
    arriving: ["resident_secondary"],
    arrival_stage: "approach",
  },
});
assert.equal(valid.result[0].arrival_source, "resident_secondary");
assert.equal(valid.result[0].arrival_stage, "approach");

for (const payload of [
  { contract: "security.arrival.v1", kind: "arrival", source: "desconhecido", arriving: ["desconhecido"], arrival_stage: "home" },
  { contract: "security.arrival.v1", kind: "arrival", source: "resident_primary", arriving: [], arrival_stage: "home" },
  { contract: "security.arrival.v1", kind: "arrival", source: "vehicle_primary", arriving: ["vehicle_primary"], arrival_stage: "away" },
]) {
  assert.deepEqual(Array.from(runFunction(validateArrival, { payload }).result), [null, null]);
}

const now = Date.now();
const first = runFunction(
  cooldown,
  { arrival_source: "resident_primary", arrival_stage: "approach" },
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
  cooldown,
  { arrival_source: "vehicle_primary", arrival_stage: "approach" },
  first.flowValues,
);
assert.equal(duplicate.result, null);

const unrelated = runFunction(
  validateConfirmation,
  { payload: { action: "OUTRA_ACAO" } },
  first.flowValues,
);
assert.deepEqual(Array.from(unrelated.result), [null, null]);
assert.ok(unrelated.flowValues.alarm_arrival_pending_confirmation);

const confirmed = runFunction(
  validateConfirmation,
  {
    payload: {
      action: first.result.confirm_action,
      context: { user_id: "synthetic_user" },
    },
  },
  first.flowValues,
);
assert.equal(confirmed.result[0].alarm_disarm_automatic, true);
assert.equal(confirmed.result[0].alarm_disarm_confirmed, true);
assert.equal(
  confirmed.result[0].alarm_disarm_reason,
  "chegada_confirmada_resident_primary_approach",
);
assert.equal(confirmed.result[0].alarm_disarm_confirmed_by, "synthetic_user");
assert.equal(confirmed.flowValues.alarm_arrival_pending_confirmation, null);

const cancelledValues = {
  alarm_arrival_pending_confirmation: {
    confirmAction: "CONFIRMAR_TESTE",
    cancelAction: "CANCELAR_TESTE",
    expiresAt: Date.now() + 60_000,
    source: "resident_secondary",
    stage: "home",
  },
};
const cancelled = runFunction(
  validateConfirmation,
  { payload: { action: "CANCELAR_TESTE" } },
  cancelledValues,
);
assert.deepEqual(Array.from(cancelled.result), [null, null]);
assert.equal(cancelled.flowValues.alarm_arrival_pending_confirmation, null);

const expiredValues = {
  alarm_arrival_pending_confirmation: {
    confirmAction: "CONFIRMACAO_EXPIRADA",
    cancelAction: "CANCELAMENTO_EXPIRADO",
    expiresAt: Date.now() - 1,
    source: "vehicle_primary",
    stage: "approach",
  },
};
const expired = runFunction(
  validateConfirmation,
  { payload: { action: "CONFIRMACAO_EXPIRADA" } },
  expiredValues,
);
assert.deepEqual(Array.from(expired.result), [null, null]);
assert.equal(expired.flowValues.alarm_arrival_pending_confirmation, null);

console.log("Confirmed alarm disarm-on-arrival flow tests passed.");
