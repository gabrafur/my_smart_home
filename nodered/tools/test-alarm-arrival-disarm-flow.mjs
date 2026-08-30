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
  const warnings = [];
  const globalValues = {};
  const context = {
    msg,
    node: {
      status: (status) => statuses.push(status),
      warn: (warning) => warnings.push(warning),
    },
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
  return { result, flowValues, statuses, warnings };
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
const notificationAck = "alarm_arrival_notification_ack_v1";
const notificationFailure = "alarm_arrival_notification_failure_v1";
const confirmationEvent = "9d0d42f03aa9013d";
const validateConfirmation = "815c14ef3c054b25";
const disarmOut = "dcd87a69ec3c6008";
const prepareTest = "99644e301cd49e45";
const routeTestOut = "alarm_arrival_test_route_out_v1";
const routeTestIn = "alarm_arrival_test_route_in_v1";
const simulateConfirmation = "alarm_arrival_test_simulate_confirmation_v1";
const confirmationOut = "alarm_arrival_test_confirmation_out_v1";
const confirmationIn = "alarm_arrival_test_confirmation_in_v1";
const dryRunTerminal = "alarm_arrival_test_dry_run_terminal_v1";

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
  assert.match(action.data, /"action":"notify_actionable"/);
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
assert.deepEqual(node(primaryNotification).wires, [[notificationAck]]);
assert.deepEqual(node(secondaryNotification).wires, [[notificationAck]]);
assert.equal(node(primaryNotification).queue, "all");
assert.equal(node(secondaryNotification).queue, "all");
assert.deepEqual(node("7a19b058661ba5f8").wires, [[notificationFailure]]);
assert.deepEqual(node(validateConfirmation).wires[0], [disarmOut]);
assert.deepEqual(node(validateArrival).wires[1], [routeTestOut]);
assert.deepEqual(node(routeTestOut).links, [routeTestIn]);
assert.deepEqual(node(routeTestIn).wires, [[prepareTest]]);
assert.deepEqual(node(prepareTest).wires, [[simulateConfirmation]]);
assert.deepEqual(node(simulateConfirmation).wires, [[confirmationOut]]);
assert.deepEqual(node(confirmationOut).links, [confirmationIn]);
assert.deepEqual(node(confirmationIn).wires, [[validateConfirmation]]);
assert.deepEqual(node(validateConfirmation).wires[1], [dryRunTerminal]);
assert.equal(node(dryRunTerminal).outputs, 0);
assert.equal((node(dryRunTerminal).wires ?? []).flat().length, 0);
assert.equal(byId.has("40ab3b2f97adac58"), false);
assert.equal(byId.has("b502fda3391bb41f"), false);

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
assert.equal(first.flowValues.alarm_arrival_last_confirmation_at, undefined, "cooldown must wait for HA acceptance");
assert.equal(first.flowValues.alarm_arrival_pending_confirmation, undefined, "pending action must wait for HA acceptance");
assert.equal(
  first.flowValues.alarm_arrival_confirmation_inflight.deliveryId,
  first.result.alarmConfirmationCandidate.deliveryId,
);

const duplicate = runFunction(
  cooldown,
  { arrival_source: "vehicle_primary", arrival_stage: "approach" },
  first.flowValues,
);
assert.equal(duplicate.result, null);

runFunction(notificationAck, first.result, first.flowValues);
assert.ok(first.flowValues.alarm_arrival_last_confirmation_at >= now);
assert.equal(
  first.flowValues.alarm_arrival_pending_confirmation.confirmAction,
  first.result.confirm_action,
);
assert.ok(
  first.flowValues.alarm_arrival_pending_confirmation.expiresAt >=
    now + 5 * 60 * 1000 - 100,
);
assert.equal(first.flowValues.alarm_arrival_confirmation_inflight, null);

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

const testPrepared = runFunction(prepareTest, {
  _location_test: true,
  _location_test_case: "vehicle_primary_approach",
  arrival_source: "vehicle_primary",
  arrival_stage: "approach",
  payload: {
    test_mode: true,
    source: "vehicle_primary",
    arrival_stage: "approach",
  },
});
assert.match(testPrepared.result.confirm_action, /^ALARME_TESTE_CONFIRMAR_/);
assert.ok(testPrepared.flowValues.alarm_arrival_test_pending_confirmation);

const testSimulated = runFunction(
  simulateConfirmation,
  testPrepared.result,
  testPrepared.flowValues,
);
assert.equal(testSimulated.result.payload.simulated, true);
assert.equal(testSimulated.result.payload.dispatched, false);

const testValidated = runFunction(
  validateConfirmation,
  testSimulated.result,
  testPrepared.flowValues,
);
assert.equal(testValidated.result[0], null, "TESTE nunca pode alcançar o desarme");
assert.equal(testValidated.result[1].alarm_arrival_test_result, "confirmado");

const testFinished = runFunction(
  dryRunTerminal,
  testValidated.result[1],
  testPrepared.flowValues,
);
assert.equal(testFinished.result, null);
assert.equal(testFinished.flowValues.alarm_arrival_last_dry_run_v1.simulated, true);
assert.equal(testFinished.flowValues.alarm_arrival_last_dry_run_v1.dispatched, false);
assert.equal(testFinished.flowValues.alarm_arrival_last_dry_run_v1.actions.length, 4);
assert.match(testFinished.warnings.at(-1), /dispatched=false/);

console.log("Fluxo real e dry-run completo do alarme passaram sem efeitos em dispositivos.");
