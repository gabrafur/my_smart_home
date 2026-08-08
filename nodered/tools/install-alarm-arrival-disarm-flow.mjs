import fs from "node:fs";

const flowsPath = new URL("../flows.json", import.meta.url);
const flows = JSON.parse(fs.readFileSync(flowsPath, "utf8"));
const byId = new Map(flows.map((node) => [node.id, node]));

const SECURITY_TAB_ID = "2fd40fd570e6f37a";
const ALARM_TAB_ID = "ce258dec9814b96b";
const NEW_TAB_ID = "alarm_arrival_disarm_tab";
const HA_SERVER_ID = "4126427d5e161a03";
const ARRIVAL_DETECTOR_ID = "sec_detect_arriving_source";
const DISARM_SETTER_ID = "alarm_set_desired_disarm";

const managedIds = new Set([
  NEW_TAB_ID,
  "sec_arrival_disarm_out",
  "alarm_arrival_in",
  "alarm_arrival_comment",
  "alarm_arrival_validate",
  "alarm_arrival_read_state",
  "alarm_arrival_is_armed",
  "alarm_arrival_cooldown",
  "alarm_arrival_to_disarm_out",
  "alarm_arrival_disarm_command_in",
]);

function requireNode(id) {
  const node = byId.get(id);
  if (!node) {
    throw new Error(`Node-RED node not found: ${id}`);
  }
  return node;
}

function addWire(node, output, targetId) {
  node.wires ??= [];
  node.wires[output] ??= [];
  if (!node.wires[output].includes(targetId)) {
    node.wires[output].push(targetId);
  }
}

requireNode(SECURITY_TAB_ID);
requireNode(ALARM_TAB_ID);
requireNode(HA_SERVER_ID);
const arrivalDetector = requireNode(ARRIVAL_DETECTOR_ID);
requireNode(DISARM_SETTER_ID);

// The arrival detector already contains the hardened GPS/iCloud/zone logic.
// Publish only its positive output to the isolated automatic-disarm tab.
addWire(arrivalDetector, 0, "sec_arrival_disarm_out");

const keptFlows = flows.filter((node) => !managedIds.has(node.id));

keptFlows.push(
  {
    id: NEW_TAB_ID,
    type: "tab",
    label: "alarme_desarme_chegada",
    disabled: false,
    info: "Desarma o alarme quando Gabriel, Valéria ou o Creta estão chegando em casa.",
    env: [],
  },
  {
    id: "sec_arrival_disarm_out",
    type: "link out",
    z: SECURITY_TAB_ID,
    name: "Chegada real -> desarme automatico",
    mode: "link",
    links: ["alarm_arrival_in"],
    x: 1375,
    y: 360,
    wires: [],
  },
  {
    id: "alarm_arrival_in",
    type: "link in",
    z: NEW_TAB_ID,
    name: "Chegada detectada",
    links: ["sec_arrival_disarm_out"],
    x: 155,
    y: 220,
    wires: [["alarm_arrival_validate"]],
  },
  {
    id: "alarm_arrival_comment",
    type: "comment",
    z: NEW_TAB_ID,
    name: "Gabriel / Valéria / Creta chegando -> se armado, reutiliza o desarme com retry",
    info: "A chegada vem do fluxo iluminacao_seguranca, que valida zona, direção da travessia, distância, precisão do GPS e trackers congelados.",
    x: 420,
    y: 120,
    wires: [],
  },
  {
    id: "alarm_arrival_validate",
    type: "function",
    z: NEW_TAB_ID,
    name: "Validar chegada real",
    func: `const allowedSources = new Set(["gabriel", "valeria", "creta"]);
const allowedStages = new Set(["approach", "home"]);
const source = msg.payload?.source;
const arriving = msg.payload?.arriving;
const stage = msg.payload?.arrival_stage;

// Defesa em profundidade: o link recebe somente a saida positiva do detector,
// mas ainda exige a lista de chegada, a origem conhecida e o estagio valido.
if (
    !allowedSources.has(source) ||
    !allowedStages.has(stage) ||
    !Array.isArray(arriving) ||
    !arriving.includes(source)
) {
    node.status({ fill: "grey", shape: "ring", text: "evento ignorado" });
    return null;
}

msg.arrival_source = source;
msg.arrival_stage = stage;
msg.arrival_detected_at = Date.now();
node.status({ fill: "blue", shape: "dot", text: \`\${source}: \${stage}\` });
return msg;`,
    outputs: 1,
    timeout: 0,
    noerr: 0,
    initialize: "",
    finalize: "",
    libs: [],
    x: 350,
    y: 220,
    wires: [["alarm_arrival_read_state"]],
  },
  {
    id: "alarm_arrival_read_state",
    type: "api-current-state",
    z: NEW_TAB_ID,
    name: "Ler estado atual do alarme",
    server: HA_SERVER_ID,
    version: 3,
    outputs: 1,
    halt_if: "",
    halt_if_type: "str",
    halt_if_compare: "is",
    entity_id: "alarm_control_panel.alarme_moni_mobile",
    state_type: "str",
    blockInputOverrides: true,
    outputProperties: [
      {
        property: "alarm_current_state",
        propertyType: "msg",
        value: "",
        valueType: "entityState",
      },
    ],
    for: "0",
    forType: "num",
    forUnits: "minutes",
    override_topic: false,
    state_location: "alarm_current_state",
    override_payload: "none",
    entity_location: "alarm_entity",
    override_data: "none",
    x: 610,
    y: 220,
    wires: [["alarm_arrival_is_armed"]],
  },
  {
    id: "alarm_arrival_is_armed",
    type: "switch",
    z: NEW_TAB_ID,
    name: "Alarme esta armado?",
    property: "alarm_current_state",
    propertyType: "msg",
    rules: [
      {
        t: "eq",
        v: "armed_away",
        vt: "str",
      },
    ],
    checkall: "true",
    repair: false,
    outputs: 1,
    x: 850,
    y: 220,
    wires: [["alarm_arrival_cooldown"]],
  },
  {
    id: "alarm_arrival_cooldown",
    type: "function",
    z: NEW_TAB_ID,
    name: "Evitar pedidos duplicados (60 s)",
    func: `const COOLDOWN_MS = 60 * 1000;
const LAST_REQUEST_KEY = "alarm_arrival_last_disarm_request_at";
const now = Date.now();
const lastRequest = Number(flow.get(LAST_REQUEST_KEY) || 0);

// Gabriel/Valeria e Creta podem cruzar o anel quase juntos. Um unico pedido
// basta: a cadeia compartilhada continuara tentando ate o alarme confirmar.
if (now - lastRequest < COOLDOWN_MS) {
    node.status({ fill: "grey", shape: "ring", text: "duplicado bloqueado" });
    return null;
}

flow.set(LAST_REQUEST_KEY, now);
msg.alarm_disarm_automatic = true;
msg.alarm_disarm_reason = \`chegada_\${msg.arrival_source}_\${msg.arrival_stage}\`;
node.status({ fill: "green", shape: "dot", text: msg.alarm_disarm_reason });
return msg;`,
    outputs: 1,
    timeout: 0,
    noerr: 0,
    initialize: "",
    finalize: "",
    libs: [],
    x: 1100,
    y: 220,
    wires: [["alarm_arrival_to_disarm_out"]],
  },
  {
    id: "alarm_arrival_to_disarm_out",
    type: "link out",
    z: NEW_TAB_ID,
    name: "Pedir desarme com retry",
    mode: "link",
    links: ["alarm_arrival_disarm_command_in"],
    x: 1325,
    y: 220,
    wires: [],
  },
  {
    id: "alarm_arrival_disarm_command_in",
    type: "link in",
    z: ALARM_TAB_ID,
    name: "Desarme automatico por chegada",
    links: ["alarm_arrival_to_disarm_out"],
    x: 355,
    y: 680,
    wires: [[DISARM_SETTER_ID]],
  },
);

fs.writeFileSync(flowsPath, `${JSON.stringify(keptFlows, null, 4)}\n`);
console.log("Installed automatic alarm disarm-on-arrival flow.");
