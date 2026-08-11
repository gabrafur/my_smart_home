import fs from "node:fs";

const flowsPath = new URL("../flows.json", import.meta.url);
const flows = JSON.parse(fs.readFileSync(flowsPath, "utf8"));
const byId = new Map(flows.map((node) => [node.id, node]));

const SECURITY_TAB_ID = "2fd40fd570e6f37a";
const SHARED_TAB_ID = "shared_integrations_tab";
const ALARM_TAB_ID = "alarm_house_tab";
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
  "alarm_arrival_notify_confirmation",
  "alarm_arrival_confirmation_event",
  "alarm_arrival_validate_confirmation",
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

function orderFlowsForNodeRed(items) {
  const preferredTabs = [
    "29d64664bf8cbde8",
    SHARED_TAB_ID,
    "ce258dec9814b96b",
    SECURITY_TAB_ID,
    ALARM_TAB_ID,
    NEW_TAB_ID,
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
    info: "Solicita confirmação por notificação acionável antes de desarmar o alarme quando Gabriel, Valéria ou o Creta estão chegando.",
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
    name: "Chegada real -> notificação -> confirmação -> desarme com retry",
    info: "A chegada vem do fluxo iluminacao_seguranca, que valida zona, direção da travessia, distância, precisão do GPS e trackers congelados. O desarme só é solicitado depois de uma ação válida na notificação do Home Assistant.",
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
    x: 860,
    y: 220,
    wires: [["alarm_arrival_cooldown"]],
  },
  {
    id: "alarm_arrival_cooldown",
    type: "function",
    z: NEW_TAB_ID,
    name: "Preparar confirmação (5 min)",
    func: `const COOLDOWN_MS = 60 * 1000;
const CONFIRMATION_TTL_MS = 5 * 60 * 1000;
const LAST_REQUEST_KEY = "alarm_arrival_last_confirmation_at";
const PENDING_KEY = "alarm_arrival_pending_confirmation";
const now = Date.now();
const lastRequest = Number(flow.get(LAST_REQUEST_KEY) || 0);
const pending = flow.get(PENDING_KEY);

// Gabriel/Valeria e Creta podem cruzar o anel quase juntos. Um unico pedido
// de confirmação basta. A primeira resposta válida encerra a solicitação.
if (pending?.expiresAt > now || now - lastRequest < COOLDOWN_MS) {
    node.status({ fill: "grey", shape: "ring", text: "confirmação já pendente" });
    return null;
}

if (pending) {
    flow.set(PENDING_KEY, null);
}

const token = (now.toString(36) + "_" + Math.random().toString(36).slice(2, 10)).toUpperCase();
const confirmAction = "ALARME_DESARMAR_" + token;
const cancelAction = "ALARME_MANTER_ARMADO_" + token;
const labels = { gabriel: "Gabriel", valeria: "Valéria", creta: "Creta" };

flow.set(PENDING_KEY, {
    confirmAction,
    cancelAction,
    expiresAt: now + CONFIRMATION_TTL_MS,
    source: msg.arrival_source,
    stage: msg.arrival_stage
});
flow.set(LAST_REQUEST_KEY, now);
msg.confirm_action = confirmAction;
msg.cancel_action = cancelAction;
msg.notification_title = "Confirmar desarme do alarme";
msg.notification_message = (labels[msg.arrival_source] || msg.arrival_source) + " está chegando. Deseja desarmar o alarme da casa?";
node.status({ fill: "yellow", shape: "dot", text: "aguardando confirmação" });
return msg;`,
    outputs: 1,
    timeout: 0,
    noerr: 0,
    initialize: "",
    finalize: "",
    libs: [],
    x: 1120,
    y: 220,
    wires: [["alarm_arrival_notify_confirmation"]],
  },
  {
    id: "alarm_arrival_notify_confirmation",
    type: "api-call-service",
    z: NEW_TAB_ID,
    name: "Pedir confirmação no Home Assistant",
    server: HA_SERVER_ID,
    version: 7,
    debugenabled: false,
    action: "notify.send_message",
    floorId: [],
    areaId: [],
    deviceId: [],
    entityId: [
      "notify.iphone_de_gabriel_furlan",
      "notify.iphone_de_valeria",
    ],
    labelId: [],
    data: `{"title": notification_title, "message": notification_message, "data": {"tag": "alarm_arrival_confirmation", "actions": [{"action": confirm_action, "title": "Desarmar"}, {"action": cancel_action, "title": "Manter armado"}]}}`,
    dataType: "jsonata",
    mergeContext: "",
    mustacheAltTags: false,
    outputProperties: [],
    queue: "none",
    blockInputOverrides: true,
    domain: "notify",
    service: "send_message",
    x: 1450,
    y: 220,
    wires: [[]],
  },
  {
    id: "alarm_arrival_confirmation_event",
    type: "server-events",
    z: NEW_TAB_ID,
    name: "Resposta da notificação",
    server: HA_SERVER_ID,
    version: 3,
    exposeAsEntityConfig: "",
    eventType: "mobile_app_notification_action",
    eventData: "",
    waitForRunning: true,
    outputProperties: [
      {
        property: "payload",
        propertyType: "msg",
        value: "",
        valueType: "eventData",
      },
    ],
    x: 250,
    y: 420,
    wires: [["alarm_arrival_validate_confirmation"]],
  },
  {
    id: "alarm_arrival_validate_confirmation",
    type: "function",
    z: NEW_TAB_ID,
    name: "Validar confirmação pendente",
    func: `const PENDING_KEY = "alarm_arrival_pending_confirmation";
const pending = flow.get(PENDING_KEY);
const candidates = [
    msg.payload?.event?.data,
    msg.payload?.data,
    msg.payload,
    msg.data?.event?.data,
    msg.data?.data,
    msg.data
];
const eventData = candidates.find(value => value && typeof value === "object" && value.action);
const action = eventData?.action;

if (!pending || !action) {
    return null;
}

if (Date.now() > Number(pending.expiresAt || 0)) {
    flow.set(PENDING_KEY, null);
    node.status({ fill: "grey", shape: "ring", text: "confirmação expirada" });
    return null;
}

if (action === pending.cancelAction) {
    flow.set(PENDING_KEY, null);
    node.status({ fill: "blue", shape: "ring", text: "alarme mantido armado" });
    return null;
}

if (action !== pending.confirmAction) {
    return null;
}

flow.set(PENDING_KEY, null);
msg.arrival_source = pending.source;
msg.arrival_stage = pending.stage;
msg.alarm_disarm_automatic = true;
msg.alarm_disarm_confirmed = true;
msg.alarm_disarm_reason = "chegada_confirmada_" + pending.source + "_" + pending.stage;
msg.alarm_disarm_confirmed_by = eventData.device_id || "home_assistant";
node.status({ fill: "green", shape: "dot", text: "desarme confirmado" });
return msg;`,
    outputs: 1,
    timeout: 0,
    noerr: 0,
    initialize: "",
    finalize: "",
    libs: [],
    x: 520,
    y: 420,
    wires: [["alarm_arrival_to_disarm_out"]],
  },
  {
    id: "alarm_arrival_to_disarm_out",
    type: "link out",
    z: NEW_TAB_ID,
    name: "Desarmar após confirmação",
    mode: "link",
    links: ["alarm_arrival_disarm_command_in"],
    x: 785,
    y: 420,
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

fs.writeFileSync(flowsPath, JSON.stringify(orderFlowsForNodeRed(keptFlows), null, 4));
console.log("Installed automatic alarm disarm-on-arrival flow.");
