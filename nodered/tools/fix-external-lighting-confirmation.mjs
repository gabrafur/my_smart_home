import fs from "node:fs";

const flowsPath = new URL("../flows.json", import.meta.url);
const flows = JSON.parse(fs.readFileSync(flowsPath, "utf8"));
const byId = new Map(flows.map((node) => [node.id, node]));

const tabId = "ce258dec9814b96b";
const haServerId = "4126427d5e161a03";
const distributorId = "88e6fc3e56fa347c";
const alexaId = "9d81b75a18d482f1";

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

for (const command of commandNodes) {
  const node = requireNode(command.id);
  upsertSetRule(node, "expected_state", command.expectedState);
  upsertSetRule(node, "notify_success", command.successText);
  node.wires = [[distributorId, "ext_wait_confirm"]];
}

const managedIds = new Set([
  "ext_wait_confirm",
  "ext_check_states",
  "ext_build_alexa_message",
]);

const keptFlows = flows.filter((node) => !managedIds.has(node.id));

keptFlows.push(
  {
    id: "ext_wait_confirm",
    type: "delay",
    z: tabId,
    name: "Aguardar confirmação das luzes",
    pauseType: "delay",
    timeout: "5",
    timeoutUnits: "seconds",
    rate: "1",
    nbRateUnits: "1",
    rateUnits: "second",
    randomFirst: "1",
    randomLast: "5",
    randomUnits: "seconds",
    drop: false,
    allowrate: false,
    outputs: 1,
    x: 1140,
    y: 300,
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
    x: 1410,
    y: 300,
    wires: [["ext_build_alexa_message"]],
  },
  {
    id: "ext_build_alexa_message",
    type: "function",
    z: tabId,
    name: "Montar aviso confirmado",
    func: `const expected = msg.expected_state || msg.payload?.expected_state;\nconst labels = {\n    lampada_varanda: 'varanda',\n    lampadas_garagem: 'garagem',\n    refletores_jardim: 'jardim'\n};\nconst states = {\n    lampada_varanda: msg.payload?.lampada_varanda,\n    lampadas_garagem: msg.payload?.lampadas_garagem,\n    refletores_jardim: msg.payload?.refletores_jardim\n};\nconst failed = Object.entries(states)\n    .filter(([, state]) => state !== expected)\n    .map(([entity, state]) => \`\${labels[entity]} \${state || 'desconhecido'}\`);\n\nif (failed.length === 0) {\n    msg.notify_text = msg.notify_success || msg.notify_text;\n    return msg;\n}\n\nconst expectedText = expected === 'on' ? 'ligada' : 'desligada';\nmsg.notify_text = \`Erro ao acionar a iluminação externa. Esperado: \${expectedText}. Estado atual: \${failed.join(', ')}.\`;\nreturn msg;`,
    outputs: 1,
    timeout: "",
    noerr: 0,
    initialize: "",
    finalize: "",
    libs: [],
    x: 1670,
    y: 300,
    wires: [[alexaId]],
  },
);

fs.writeFileSync(flowsPath, `${JSON.stringify(keptFlows, null, 4)}\n`);
console.log("Updated iluminacao_externa confirmation flow.");
