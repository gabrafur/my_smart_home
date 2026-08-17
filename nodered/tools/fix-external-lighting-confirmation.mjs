import fs from "node:fs";

const flowsPath = new URL("../flows.json", import.meta.url);
const flows = JSON.parse(fs.readFileSync(flowsPath, "utf8"));
const byId = new Map(flows.map((node) => [node.id, node]));

const tabId = "ce258dec9814b96b";
const haServerId = "4126427d5e161a03";
const mqttBrokerId = "721c47f31046b8bc";
const distributorId = "88e6fc3e56fa347c";
const alexaId = "9d81b75a18d482f1";
const sharedTabId = "shared_integrations_tab";

const commandNodes = [
  {
    id: "d940e2132bca7ecc",
    expectedState: "on",
    successText: "A iluminação externa foi ligada",
  },
  {
    id: "c7fe1a52ffe5091d",
    expectedState: "off",
    successText: "A iluminação externa foi desligada",
  },
  {
    id: "943c87e6b17f0d68",
    expectedState: "on",
    successText: "Pôr do sol. A iluminação externa foi ligada",
  },
  {
    id: "ext_alarm_armed_off",
    expectedState: "off",
    successText: "Alarme armado. A iluminação externa foi desligada",
  },
];

function requireNode(id) {
  const node = byId.get(id);
  if (!node) {
    throw new Error(`Node-RED node not found: ${id}`);
  }
  return node;
}

function upsertSetRule(node, property, value, valueType = "str") {
  node.rules = (node.rules || []).filter(
    (rule) => !(rule.t === "set" && rule.pt === "msg" && rule.p === property),
  );
  node.rules.push({
    t: "set",
    p: property,
    pt: "msg",
    to: value,
    tot: valueType,
  });
}

function orderFlowsForNodeRed(items) {
  const preferredTabs = [
    "29d64664bf8cbde8",
    sharedTabId,
    tabId,
    "2fd40fd570e6f37a",
    "alarm_house_tab",
    "alarm_arrival_disarm_tab",
  ];
  const tabRank = new Map(preferredTabs.map((id, index) => [id, index]));
  const tabs = items
    .filter((item) => item.type === "tab")
    .sort(
      (left, right) =>
        (tabRank.get(left.id) ?? Number.MAX_SAFE_INTEGER) -
        (tabRank.get(right.id) ?? Number.MAX_SAFE_INTEGER),
    );
  const groups = items.filter((item) => item.type === "group");
  const configs = items.filter(
    (item) => !item.z && item.type !== "tab" && item.type !== "group",
  );
  const tabNodes = tabs.flatMap((tab) =>
    items.filter((item) => item.z === tab.id && item.type !== "group"),
  );
  const included = new Set([...tabs, ...groups, ...configs, ...tabNodes]);
  return [
    ...tabs,
    ...groups,
    ...configs,
    ...tabNodes,
    ...items.filter((item) => !included.has(item)),
  ];
}

for (const command of commandNodes) {
  const node = requireNode(command.id);
  upsertSetRule(node, "expected_state", command.expectedState);
  upsertSetRule(node, "notify_success", command.successText);
  node.wires = [["ext_zigbee_command_gate"]];
}

Object.assign(requireNode("24743bc9f254d1c1"), {
  outputInitially: true,
  wires: [["ext_sunset_alarm_check"], []],
});

const managedIds = new Set([
  "ext_zigbee_bridge_state_in",
  "ext_zigbee_bridge_state_store",
  "ext_zigbee_broker_status",
  "ext_zigbee_command_gate",
  "ext_sunset_alarm_check",
  "ext_wait_confirm",
  "ext_check_states",
  "ext_build_alexa_message",
]);

const keptFlows = flows.filter((node) => !managedIds.has(node.id));

keptFlows.push(
  {
    id: "ext_zigbee_bridge_state_in",
    type: "mqtt in",
    z: tabId,
    name: "Estado da rede Zigbee",
    topic: "zigbee2mqtt/bridge/state",
    qos: "2",
    datatype: "auto-detect",
    broker: mqttBrokerId,
    nl: false,
    rap: true,
    rh: 0,
    inputs: 0,
    x: 190,
    y: 200,
    wires: [["ext_zigbee_bridge_state_store"]],
  },
  {
    id: "ext_zigbee_bridge_state_store",
    type: "function",
    z: tabId,
    name: "Guardar disponibilidade Zigbee",
    func: `let state;

if (msg.status) {
    const statusText = String(msg.status.text || '').toLowerCase();
    if (msg.status.fill === 'red' || /disconnected|offline|error/.test(statusText)) {
        state = 'offline';
    } else {
        // Uma conexão MQTT restaurada não garante que a bridge Zigbee voltou.
        // O tópico bridge/state será responsável por marcar 'online'.
        return null;
    }
} else {
    let value = msg.payload;
    if (Buffer.isBuffer(value)) {
        value = value.toString('utf8');
    }
    if (typeof value === 'string') {
        try {
            const parsed = JSON.parse(value);
            value = parsed?.state ?? parsed;
        } catch {
            // Versões antigas do Zigbee2MQTT publicam apenas 'online'/'offline'.
        }
    }
    if (value && typeof value === 'object') {
        value = value.state;
    }
    state = String(value || '').toLowerCase();
}

if (state !== 'online' && state !== 'offline') {
    node.status({ fill: 'grey', shape: 'ring', text: 'estado Zigbee desconhecido' });
    return null;
}

flow.set('external_lighting_zigbee_state', state);
node.status({
    fill: state === 'online' ? 'green' : 'red',
    shape: state === 'online' ? 'dot' : 'ring',
    text: \`Zigbee \${state}\`
});
return null;`,
    outputs: 0,
    timeout: 0,
    noerr: 0,
    initialize: "",
    finalize: "",
    libs: [],
    x: 450,
    y: 200,
    wires: [],
  },
  {
    id: "ext_zigbee_broker_status",
    type: "status",
    z: tabId,
    name: "Conexão com broker Zigbee",
    scope: ["ext_zigbee_bridge_state_in"],
    x: 190,
    y: 240,
    wires: [["ext_zigbee_bridge_state_store"]],
  },
  {
    id: "ext_sunset_alarm_check",
    type: "api-current-state",
    z: tabId,
    name: "Ligar somente com alarme desarmado",
    server: haServerId,
    version: 3,
    outputs: 2,
    halt_if: "disarmed",
    halt_if_type: "str",
    halt_if_compare: "is",
    entity_id: "alarm_control_panel.security_panel",
    state_type: "str",
    blockInputOverrides: true,
    outputProperties: [],
    for: "0",
    forType: "num",
    forUnits: "minutes",
    override_topic: false,
    state_location: "payload",
    override_payload: "msg",
    entity_location: "data",
    override_data: "msg",
    x: 850,
    y: 220,
    wires: [["943c87e6b17f0d68"], []],
  },
  {
    id: "ext_zigbee_command_gate",
    type: "function",
    z: tabId,
    name: "Bloquear se rede Zigbee offline",
    func: `const zigbeeState = flow.get('external_lighting_zigbee_state');

if (zigbeeState === 'offline') {
    msg.zigbee_error = true;
    msg.cancel_confirmation = true;
    msg.notify_text = 'Erro na rede Zigbee. A iluminação externa não foi acionada e o comando não será repetido.';
    node.status({ fill: 'red', shape: 'ring', text: 'comando bloqueado: Zigbee offline' });
    return [null, msg];
}

node.status({});
return [msg, null];`,
    outputs: 2,
    timeout: 0,
    noerr: 0,
    initialize: "",
    finalize: "",
    libs: [],
    x: 1130,
    y: 160,
    wires: [
      [distributorId, "ext_wait_confirm"],
      ["ext_wait_confirm", alexaId],
    ],
  },
  {
    id: "ext_wait_confirm",
    type: "function",
    z: tabId,
    name: "Confirmar somente o comando mais recente",
    func: `const previousTimer = context.get('confirmationTimer');
if (previousTimer) {
    clearTimeout(previousTimer);
}

if (msg.cancel_confirmation) {
    context.set('confirmationTimer', null);
    node.status({});
    return null;
}

const timer = setTimeout(() => {
    context.set('confirmationTimer', null);
    node.status({});
    node.send(msg);
}, 5000);

context.set('confirmationTimer', timer);
node.status({ fill: 'yellow', shape: 'ring', text: 'aguardando confirmação' });
return null;`,
    outputs: 1,
    timeout: 0,
    noerr: 0,
    initialize: "",
    finalize: `const timer = context.get('confirmationTimer');
if (timer) {
    clearTimeout(timer);
}
context.set('confirmationTimer', null);`,
    libs: [],
    x: 1230,
    y: 260,
    wires: [["ext_check_states"]],
  },
  {
    id: "ext_check_states",
    type: "api-current-state",
    z: tabId,
    name: "Confirmar estados no Home Assistant",
    server: haServerId,
    version: 3,
    outputs: 1,
    halt_if: "",
    halt_if_type: "str",
    halt_if_compare: "is",
    entity_id: "switch.lampada_varanda",
    state_type: "str",
    blockInputOverrides: false,
    outputProperties: [
      {
        property: "payload",
        propertyType: "msg",
        value:
          '{"expected_state": expected_state, "notify_success": notify_success, "lampada_varanda": $entities("switch.lampada_varanda").state, "lampadas_garagem": $entities("switch.lampadas_garagem").state, "refletores_jardim": $entities("switch.refletores_jardim").state}',
        valueType: "jsonata",
      },
    ],
    for: "0",
    forType: "num",
    forUnits: "minutes",
    override_topic: false,
    state_location: "payload",
    override_payload: "msg",
    entity_location: "data",
    override_data: "msg",
    x: 1530,
    y: 260,
    wires: [["ext_build_alexa_message"]],
  },
  {
    id: "ext_build_alexa_message",
    type: "function",
    z: tabId,
    name: "Montar aviso confirmado",
    func: `const expected = msg.expected_state || msg.payload?.expected_state;
const labels = {
    lampada_varanda: 'varanda',
    lampadas_garagem: 'garagem',
    refletores_jardim: 'jardim'
};
const states = {
    lampada_varanda: msg.payload?.lampada_varanda,
    lampadas_garagem: msg.payload?.lampadas_garagem,
    refletores_jardim: msg.payload?.refletores_jardim
};
const networkFailureStates = new Set([undefined, null, '', 'unknown', 'unavailable']);
const unavailable = Object.entries(states)
    .filter(([, state]) => networkFailureStates.has(state))
    .map(([entity]) => labels[entity]);

if (flow.get('external_lighting_zigbee_state') === 'offline' || unavailable.length > 0) {
    msg.zigbee_error = true;
    const affected = unavailable.length > 0 ? \` Sem comunicação com: \${unavailable.join(', ')}.\` : '';
    msg.notify_text = \`Erro na rede Zigbee.\${affected} O comando da iluminação externa não será repetido.\`;
    return msg;
}

const failed = Object.entries(states)
    .filter(([, state]) => state !== expected)
    .map(([entity, state]) => \`\${labels[entity]} \${state}\`);

if (failed.length === 0) {
    msg.notify_text = msg.notify_success || msg.notify_text;
    return msg;
}

const expectedText = expected === 'on' ? 'ligada' : 'desligada';
msg.notify_text = \`Erro ao acionar a iluminação externa. Esperado: \${expectedText}. Estado atual: \${failed.join(', ')}. O comando não será repetido.\`;
return msg;`,
    outputs: 1,
    timeout: "",
    noerr: 0,
    initialize: "",
    finalize: "",
    libs: [],
    x: 1810,
    y: 260,
    wires: [[alexaId]],
  },
);

fs.writeFileSync(flowsPath, JSON.stringify(orderFlowsForNodeRed(keptFlows), null, 4));
console.log("Updated iluminacao_externa confirmation flow.");
