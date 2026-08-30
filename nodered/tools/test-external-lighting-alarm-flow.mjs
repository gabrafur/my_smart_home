import assert from "node:assert/strict";
import fs from "node:fs";

const flowsPath = new URL("../flows.json", import.meta.url);
const flows = JSON.parse(fs.readFileSync(flowsPath, "utf8"));
const byId = new Map(flows.map((node) => [node.id, node]));
const tabId = "ce258dec9814b96b";

function getNode(id) {
  const node = byId.get(id);
  assert.ok(node, `Node ausente: ${id}`);
  return node;
}

function compileFunction(node) {
  assert.equal(node.type, "function", `${node.id} deveria ser function`);
  return new Function(
    "msg",
    "node",
    "context",
    "flow",
    "global",
    "env",
    "setTimeout",
    "clearTimeout",
    node.func,
  );
}

for (const node of flows.filter(
  (candidate) => candidate.z === tabId && candidate.type === "function",
)) {
  compileFunction(node);
  if (node.finalize) {
    new Function("node", "context", "clearTimeout", node.finalize);
  }
}

const allIds = new Set(flows.map((node) => node.id));
for (const node of flows.filter((candidate) => candidate.z === tabId)) {
  for (const target of (node.wires || []).flat()) {
    assert.ok(allIds.has(target), `${node.id} aponta para node inexistente: ${target}`);
  }
}

const sunset = getNode("24743bc9f254d1c1");
assert.equal(
  sunset.outputInitially,
  false,
  "um restart depois do pôr do sol não pode ligar as cargas automaticamente",
);
assert.deepEqual(sunset.wires, [["943c87e6b17f0d68"], []]);

for (const removedId of [
  "ext_sunset_alarm_check",
  "ext_alarm_armed_off",
  "ext_alarm_armed_lighting_in",
  "alarm_armed_lighting_out",
]) {
  assert.equal(byId.has(removedId), false, `${removedId} ainda acopla alarme e iluminação`);
}
for (const candidate of flows.filter((node) => node.z === tabId && node.type !== "tab")) {
  assert.doesNotMatch(
    JSON.stringify(candidate),
    /alarm_control_panel\.security_panel|moni_mobile/i,
    `${candidate.id} ainda depende do Moni Mobile`,
  );
}

const recoveryBoot = getNode("ext_sunset_recovery_boot");
assert.equal(recoveryBoot.type, "inject");
assert.equal(recoveryBoot.once, true);
assert.deepEqual(recoveryBoot.wires, [["ext_sunset_recovery_sun_check"]]);

const recoverySunCheck = getNode("ext_sunset_recovery_sun_check");
assert.equal(recoverySunCheck.entity_id, "sun.sun");
assert.equal(recoverySunCheck.halt_if, "below_horizon");
assert.deepEqual(recoverySunCheck.wires, [["ext_prepare_recovery_confirmation"], []]);

const mobileQuestion = getNode("ext_send_recovery_mobile");
assert.equal(mobileQuestion.action, "public_bindings.call");
assert.match(mobileQuestion.data, /"role":"mobile_primary"/);
assert.match(mobileQuestion.data, /"action":"notify_actionable"/);
assert.match(mobileQuestion.data, /confirm_action/);
assert.match(mobileQuestion.data, /cancel_action/);
assert.deepEqual(mobileQuestion.wires, [["ext_commit_recovery_confirmation"]]);

const recoveryResponse = getNode("ext_recovery_notification_action");
assert.equal(recoveryResponse.eventType, "mobile_app_notification_action");
assert.deepEqual(recoveryResponse.wires, [["ext_validate_recovery_confirmation"]]);

const confirmSunCheck = getNode("ext_confirm_recovery_sun_check");
assert.equal(confirmSunCheck.entity_id, "sun.sun");
assert.equal(confirmSunCheck.halt_if, "below_horizon");
assert.deepEqual(confirmSunCheck.wires, [["943c87e6b17f0d68"], []]);

const recoveryValues = new Map();
const recoveryFlow = {
  get: (key) => recoveryValues.get(key),
  set: (key, value) => recoveryValues.set(key, value),
};
const recoveryEnv = { get: (key) => key === "TZ" ? "America/Sao_Paulo" : undefined };
const prepareRecovery = compileFunction(getNode("ext_prepare_recovery_confirmation"));
const recoveryMessage = prepareRecovery(
  { sun_last_changed: new Date().toISOString() },
  { status: () => {} },
  {},
  recoveryFlow,
  {},
  recoveryEnv,
  setTimeout,
  clearTimeout,
);
assert.ok(recoveryMessage?.external_lighting_recovery_candidate);
assert.match(recoveryMessage.confirm_action, /^ILUMINACAO_EXTERNA_LIGAR_/);
assert.match(recoveryMessage.cancel_action, /^ILUMINACAO_EXTERNA_NAO_LIGAR_/);

const commitRecovery = compileFunction(getNode("ext_commit_recovery_confirmation"));
commitRecovery(
  recoveryMessage,
  { status: () => {} },
  {},
  recoveryFlow,
  {},
  recoveryEnv,
  setTimeout,
  clearTimeout,
);
const pendingRecovery = recoveryValues.get("external_lighting_recovery_pending_v1");
assert.equal(pendingRecovery.confirmAction, recoveryMessage.confirm_action);
assert.equal(
  recoveryValues.get("external_lighting_recovery_prompted_date_v1"),
  pendingRecovery.localDate,
);
assert.equal(
  prepareRecovery(
    { sun_last_changed: new Date().toISOString() },
    { status: () => {} },
    {},
    recoveryFlow,
    {},
    recoveryEnv,
    setTimeout,
    clearTimeout,
  ),
  null,
  "a pergunta não deve ser repetida no mesmo dia",
);

const validateRecovery = compileFunction(getNode("ext_validate_recovery_confirmation"));
const confirmedRecovery = validateRecovery(
  { payload: { event: { action: pendingRecovery.confirmAction } } },
  { status: () => {} },
  {},
  recoveryFlow,
  {},
  recoveryEnv,
  setTimeout,
  clearTimeout,
);
assert.equal(confirmedRecovery.external_lighting_recovery_confirmed, true);
assert.equal(recoveryValues.get("external_lighting_recovery_pending_v1"), null);

const bridgeStateInput = getNode("ext_zigbee_bridge_state_in");
assert.equal(bridgeStateInput.type, "mqtt in");
assert.equal(bridgeStateInput.topic, "zigbee2mqtt/bridge/state");
assert.deepEqual(bridgeStateInput.wires, [["ext_zigbee_bridge_state_store"]]);
const brokerStatus = getNode("ext_zigbee_broker_status");
assert.equal(brokerStatus.type, "status");
assert.deepEqual(brokerStatus.scope, ["ext_zigbee_bridge_state_in"]);
assert.deepEqual(brokerStatus.wires, [["ext_zigbee_bridge_state_store"]]);

const zigbeeStateValues = new Map();
const zigbeeFlow = {
  get: (key) => zigbeeStateValues.get(key),
  set: (key, value) => zigbeeStateValues.set(key, value),
};
const statusNode = { status: () => {} };
const storeBridgeState = compileFunction(getNode("ext_zigbee_bridge_state_store"));
storeBridgeState(
  { payload: { state: "online" } },
  statusNode,
  {},
  zigbeeFlow,
  {},
  {},
  setTimeout,
  clearTimeout,
);
assert.equal(zigbeeFlow.get("external_lighting_zigbee_state"), "online");
storeBridgeState(
  { status: { fill: "red", text: "disconnected" } },
  statusNode,
  {},
  zigbeeFlow,
  {},
  {},
  setTimeout,
  clearTimeout,
);
assert.equal(zigbeeFlow.get("external_lighting_zigbee_state"), "offline");

const zigbeeGateNode = getNode("ext_zigbee_command_gate");
assert.deepEqual(zigbeeGateNode.wires, [
  ["88e6fc3e56fa347c", "ext_wait_confirm"],
  ["ext_wait_confirm", "9d81b75a18d482f1"],
]);
const zigbeeGate = compileFunction(zigbeeGateNode);
const blocked = zigbeeGate(
  { expected_state: "on" },
  statusNode,
  {},
  zigbeeFlow,
  {},
  {},
  setTimeout,
  clearTimeout,
);
assert.equal(blocked[0], null);
assert.equal(blocked[1].zigbee_error, true);
assert.equal(blocked[1].cancel_confirmation, true);
assert.match(blocked[1].notify_text, /não será repetido/);

zigbeeFlow.set("external_lighting_zigbee_state", "online");
const allowedMessage = { expected_state: "off" };
const allowed = zigbeeGate(
  allowedMessage,
  statusNode,
  {},
  zigbeeFlow,
  {},
  {},
  setTimeout,
  clearTimeout,
);
assert.equal(allowed[0], allowedMessage);
assert.equal(allowed[1], null);

const commandNodes = [
  ["d940e2132bca7ecc", "on"],
  ["c7fe1a52ffe5091d", "off"],
  ["943c87e6b17f0d68", "on"],
];

for (const [id, expectedState] of commandNodes) {
  const command = getNode(id);
  const expectedRule = command.rules.find(
    (rule) => rule.t === "set" && rule.pt === "msg" && rule.p === "expected_state",
  );
  assert.equal(expectedRule?.to, expectedState, `${id}: expected_state incorreto`);
  assert.ok(
    command.rules.some(
      (rule) => rule.t === "set" && rule.pt === "msg" && rule.p === "notify_success",
    ),
    `${id}: notify_success ausente`,
  );
  assert.deepEqual(command.wires, [["ext_zigbee_command_gate"]]);
}

const distributor = compileFunction(getNode("88e6fc3e56fa347c"));
const exteriorTopics = [
  { topic: "zigbee2mqtt/example_exterior_light_1/set", payload_on: "ON", payload_off: "OFF" },
  { topic: "zigbee2mqtt/example_exterior_light_2/set", payload_on: "ON", payload_off: "OFF" },
  { topic: "zigbee2mqtt/example_exterior_light_3/set", payload_on: "ON", payload_off: "OFF" },
];
const bindingGlobal = {
  get: (key) => key === "publicBindings"
    ? { roles: { exterior_light: { mqtt_topics: exteriorTopics } } }
    : undefined,
};
const distributed = distributor(
  { payload: { state: "ON" } },
  statusNode,
  {},
  {},
  bindingGlobal,
  {},
  setTimeout,
  clearTimeout,
);
assert.deepEqual(
  distributed.map((message) => message.topic),
  exteriorTopics.map((binding) => binding.topic),
);
assert.equal(distributor(
  { payload: { state: "ON" } },
  statusNode,
  {},
  {},
  { get: () => undefined },
  {},
  setTimeout,
  clearTimeout,
), null);

const confirmation = compileFunction(getNode("ext_wait_confirm"));
const contextValues = new Map();
const context = {
  get: (key) => contextValues.get(key),
  set: (key, value) => contextValues.set(key, value),
};
const pendingTimers = new Map();
let nextTimerId = 1;
const fakeSetTimeout = (callback, delay) => {
  assert.equal(delay, 5000);
  const id = nextTimerId++;
  pendingTimers.set(id, () => {
    pendingTimers.delete(id);
    callback();
  });
  return id;
};
const fakeClearTimeout = (id) => pendingTimers.delete(id);
const sent = [];
const fakeNode = {
  send: (message) => sent.push(message),
  status: () => {},
};

confirmation(
  { expected_state: "on" },
  fakeNode,
  context,
  {},
  {},
  {},
  fakeSetTimeout,
  fakeClearTimeout,
);
confirmation(
  { expected_state: "off" },
  fakeNode,
  context,
  {},
  {},
  {},
  fakeSetTimeout,
  fakeClearTimeout,
);
assert.equal(pendingTimers.size, 1, "confirmação antiga não foi cancelada");
pendingTimers.values().next().value();
assert.deepEqual(sent, [{ expected_state: "off" }]);

confirmation(
  { expected_state: "on" },
  fakeNode,
  context,
  {},
  {},
  {},
  fakeSetTimeout,
  fakeClearTimeout,
);
confirmation(
  { cancel_confirmation: true },
  fakeNode,
  context,
  {},
  {},
  {},
  fakeSetTimeout,
  fakeClearTimeout,
);
assert.equal(pendingTimers.size, 0, "erro Zigbee não cancelou confirmação pendente");

const buildMessage = compileFunction(getNode("ext_build_alexa_message"));
const success = buildMessage(
  {
    expected_state: "on",
    notify_success: "ok",
    payload: {
      lampada_varanda: "on",
      lampadas_garagem: "on",
      refletores_jardim: "on",
    },
  },
  {},
  {},
  zigbeeFlow,
  {},
  {},
  setTimeout,
  clearTimeout,
);
assert.equal(success.notify_text, "ok");

const failure = buildMessage(
  {
    expected_state: "off",
    payload: {
      lampada_varanda: "off",
      lampadas_garagem: "on",
      refletores_jardim: "off",
    },
  },
  {},
  {},
  zigbeeFlow,
  {},
  {},
  setTimeout,
  clearTimeout,
);
assert.match(failure.notify_text, /garagem on/);
assert.match(failure.notify_text, /não será repetido/);

const networkFailure = buildMessage(
  {
    expected_state: "off",
    payload: {
      lampada_varanda: "off",
      lampadas_garagem: "unknown",
      refletores_jardim: "unavailable",
    },
  },
  {},
  {},
  zigbeeFlow,
  {},
  {},
  setTimeout,
  clearTimeout,
);
assert.equal(networkFailure.zigbee_error, true);
assert.match(networkFailure.notify_text, /Erro na rede Zigbee/);
assert.match(networkFailure.notify_text, /garagem, jardim/);
assert.match(networkFailure.notify_text, /não será repetido/);

console.log("External-lighting independent flow tests passed.");
