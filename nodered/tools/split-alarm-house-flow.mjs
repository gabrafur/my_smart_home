import fs from "node:fs";

const flowsPath = new URL("../flows.json", import.meta.url);
const flows = JSON.parse(fs.readFileSync(flowsPath, "utf8"));
const byId = new Map(flows.map((node) => [node.id, node]));

const LIGHT_TAB_ID = "ce258dec9814b96b";
const ALARM_TAB_ID = "alarm_house_tab";
const SHARED_TAB_ID = "shared_integrations_tab";
const SHARED_HUB_ID = "70e147e6b7df9826";
const LIGHT_DEVICE_ID = "2dd5071569184cb4";
const ALARM_DEVICE_ID = "de18d31309e8a0ca";
const LIGHT_ALEXA_NOTIFY_ID = "9d81b75a18d482f1";
const ALARM_ALEXA_NOTIFY_ID = "alarm_notify_alexa";

const managedIds = new Set([
  SHARED_TAB_ID,
  ALARM_TAB_ID,
  ALARM_ALEXA_NOTIFY_ID,
  "alarm_dulo_hub_link_out",
  "alarm_dulo_hub_link_in",
  "alarm_armed_lighting_out",
  "ext_alarm_armed_lighting_in",
  "ext_alarm_armed_off",
  "alarm_real_change_filter",
  "e380ce19c7f96420",
  "light_dulo_hub_link_out",
  "light_dulo_hub_link_in",
]);

const alarmNodeIds = [
  "moni_mobile_arm_event",
  ALARM_DEVICE_ID,
  "922ddf470a08d43f",
  "70eb073f8191e69e",
  "8261c7cfb6756ca8",
  "arm_alarm_catch",
  "arm_alarm_retry_decision",
  "arm_alarm_retry_delay",
  "arm_alarm_notify_success",
  "moni_mobile_update_after_arm",
  "disarm_alarm_notify_success",
  "disarm_alarm_catch",
  "disarm_alarm_retry_decision",
  "disarm_alarm_retry_delay",
  "4043829dac0a9fee",
  "0543222ad4ed094d",
  "alarm_set_desired_arm",
  "alarm_set_desired_disarm",
  "alarm_guard_arm",
  "alarm_guard_disarm",
  "alarm_arrival_disarm_command_in",
];

const positions = {
  alarm_dulo_hub_link_in: [120, 100],
  [ALARM_DEVICE_ID]: [320, 100],
  "922ddf470a08d43f": [560, 100],
  moni_mobile_arm_event: [330, 220],
  alarm_set_desired_arm: [650, 200],
  "70eb073f8191e69e": [910, 200],
  arm_alarm_notify_success: [1160, 200],
  moni_mobile_update_after_arm: [1450, 200],
  arm_alarm_catch: [650, 300],
  arm_alarm_retry_decision: [940, 300],
  arm_alarm_retry_delay: [1190, 400],
  alarm_guard_arm: [1460, 340],
  alarm_arrival_disarm_command_in: [130, 500],
  alarm_set_desired_disarm: [430, 500],
  "8261c7cfb6756ca8": [700, 500],
  disarm_alarm_notify_success: [960, 500],
  disarm_alarm_catch: [430, 600],
  disarm_alarm_retry_decision: [720, 600],
  disarm_alarm_retry_delay: [990, 660],
  alarm_guard_disarm: [1260, 660],
  [ALARM_ALEXA_NOTIFY_ID]: [1770, 360],
  "4043829dac0a9fee": [330, 280],
  "0543222ad4ed094d": [130, 560],
};

function requireNode(id) {
  const node = byId.get(id);
  if (!node) throw new Error(`Node-RED node not found: ${id}`);
  return node;
}

function setPosition(node) {
  const position = positions[node.id];
  if (position) [node.x, node.y] = position;
}

function orderFlowsForNodeRed(items) {
  const preferredTabs = [
    "29d64664bf8cbde8",
    SHARED_TAB_ID,
    LIGHT_TAB_ID,
    "2fd40fd570e6f37a",
    ALARM_TAB_ID,
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

const lightTab = requireNode(LIGHT_TAB_ID);
lightTab.label = "iluminacao_externa";
lightTab.info = "Controla a iluminação externa por comando manual e pôr do sol, sem depender do fluxo Moni Mobile.";

for (const id of alarmNodeIds) {
  const node = requireNode(id);
  node.z = ALARM_TAB_ID;
  setPosition(node);
}

const hub = requireNode(SHARED_HUB_ID);
hub.z = SHARED_TAB_ID;
hub.x = 250;
hub.y = 120;
hub.wires = [["light_dulo_hub_link_out", "alarm_dulo_hub_link_out"]];

const updateMoniMobile = requireNode("moni_mobile_update_after_arm");
updateMoniMobile.entityId = [];
updateMoniMobile.data = JSON.stringify({
  entity_id: ["alarm_control_panel.security_panel"],
});
updateMoniMobile.dataType = "json";

for (const id of [
  "arm_alarm_retry_decision",
  "moni_mobile_update_after_arm",
  "disarm_alarm_notify_success",
  "disarm_alarm_retry_decision",
]) {
  const node = requireNode(id);
  node.wires = (node.wires || []).map((output) =>
    output.map((target) =>
      target === LIGHT_ALEXA_NOTIFY_ID ? ALARM_ALEXA_NOTIFY_ID : target,
    ),
  );
}

const lightAlexaNotify = requireNode(LIGHT_ALEXA_NOTIFY_ID);
const alarmAlexaNotify = {
  ...lightAlexaNotify,
  id: ALARM_ALEXA_NOTIFY_ID,
  z: ALARM_TAB_ID,
  name: "Avisar Alexa - alarme",
  x: positions[ALARM_ALEXA_NOTIFY_ID][0],
  y: positions[ALARM_ALEXA_NOTIFY_ID][1],
  wires: [[]],
};

const keptFlows = flows.filter((node) => !managedIds.has(node.id));
keptFlows.push(
  {
    id: SHARED_TAB_ID,
    type: "tab",
    label: "integracoes_compartilhadas",
    disabled: false,
    info: "Hospeda hubs e integrações reutilizados por vários flows. Os consumidores devem ser conectados por link out/link in.",
    env: [],
  },
  {
    id: ALARM_TAB_ID,
    type: "tab",
    label: "alarme_casa",
    disabled: false,
    info: "Arma/desarma o alarme Moni Mobile, controla retries e publica o evento de alarme armado para outros flows.",
    env: [],
  },
  {
    id: "alarm_dulo_hub_link_out",
    type: "link out",
    z: SHARED_TAB_ID,
    name: "Hub Dulo -> Alarme Casa",
    mode: "link",
    links: ["alarm_dulo_hub_link_in"],
    x: 555,
    y: 160,
    wires: [],
  },
  {
    id: "light_dulo_hub_link_out",
    type: "link out",
    z: SHARED_TAB_ID,
    name: "Hub Dulo -> Iluminação Externa",
    mode: "link",
    links: ["light_dulo_hub_link_in"],
    x: 555,
    y: 100,
    wires: [],
  },
  {
    id: "light_dulo_hub_link_in",
    type: "link in",
    z: LIGHT_TAB_ID,
    name: "Hub Dulo compartilhado",
    links: ["light_dulo_hub_link_out"],
    x: 155,
    y: 100,
    wires: [[LIGHT_DEVICE_ID]],
  },
  {
    id: "alarm_dulo_hub_link_in",
    type: "link in",
    z: ALARM_TAB_ID,
    name: "Hub Dulo compartilhado",
    links: ["alarm_dulo_hub_link_out"],
    x: positions.alarm_dulo_hub_link_in[0],
    y: positions.alarm_dulo_hub_link_in[1],
    wires: [[ALARM_DEVICE_ID]],
  },
  alarmAlexaNotify,
);

fs.writeFileSync(flowsPath, JSON.stringify(orderFlowsForNodeRed(keptFlows), null, 4));
console.log("Separated alarme_casa from iluminacao_externa.");
