#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";

const FLOWS = new URL("../flows.json", import.meta.url).pathname;
const OUT = process.argv[2] || `${FLOWS}.new`;
const TAB = "29d64664bf8cbde8";
const BROKER = "721c47f31046b8bc";
const HA_SERVER = "4126427d5e161a03";
const COOLDOWN_MS = 1000;
const PULSE_MS = 700;

const flows = JSON.parse(readFileSync(FLOWS, "utf8"));

function required(id) {
  const node = flows.find((candidate) => candidate.id === id);
  if (!node) throw new Error(`nó obrigatório ausente: ${id}`);
  return node;
}

function upsert(node) {
  const index = flows.findIndex((candidate) => candidate.id === node.id);
  if (index === -1) flows.push(node);
  else flows[index] = node;
}

const tab = required(TAB);
tab.info = "Um único controlador recebe o botão Zigbee e o botão do dashboard. Aplica dedupe de 900 ms, cooldown de 1 s e publica um pulso de 700 ms no relé, sem retry de ON.";

const jsonInput = required("45296e246a57590d");
Object.assign(jsonInput, { g: "gar_group_pulse", x: 260, y: 100, wires: [["gar_portao_normalizar_click"]] });
const actionInput = required("gar_portao_action_topic_in");
Object.assign(actionInput, { g: "gar_group_pulse", x: 260, y: 160, wires: [["gar_portao_normalizar_click"]] });

upsert({
  id: "gar_dashboard_request_in",
  type: "server-events",
  z: TAB,
  g: "gar_group_pulse",
  name: "botão do dashboard",
  server: HA_SERVER,
  version: 3,
  exposeAsEntityConfig: "",
  eventType: "portao_garagem_pulso_solicitado",
  eventData: "",
  waitForRunning: true,
  outputProperties: [{ property: "payload", propertyType: "msg", value: "", valueType: "eventData" }],
  x: 260,
  y: 220,
  wires: [["gar_portao_normalizar_click"]],
});

upsert({
  ...required("gar_portao_normalizar_click"),
  g: "gar_group_pulse",
  name: "validar pedido (dedupe + cooldown 1 s)",
  func: `// Um unico gate protege os pedidos do botao Zigbee e do dashboard.
const now = Date.now();
const dedupeMs = 900;
const cooldownMs = ${COOLDOWN_MS};
let action;
let origem;

if (typeof msg.payload === "string") {
    action = msg.payload;
} else if (msg.payload && typeof msg.payload === "object") {
    // server-events entrega o evento customizado no envelope payload.event;
    // as entradas MQTT continuam usando o objeto diretamente.
    const request = msg.payload.event && typeof msg.payload.event === "object"
        ? msg.payload.event
        : msg.payload;
    action = request.action;
    origem = request.origem;
}

if (action === "probe") {
    node.status({ fill: "blue", shape: "ring", text: "evento do dashboard recebido" });
    node.log("portao: evento de diagnóstico recebido — nenhum comando enviado");
    return null;
}
if (action !== "single") return null;

const lastAccepted = Number(flow.get("portao_garagem_last_click_ms") || 0);
if (now - lastAccepted < dedupeMs) return null;

const lastPulse = Number(flow.get("portao_garagem_last_pulse_ms") || 0);
if (now - lastPulse < cooldownMs) {
    node.status({ fill: "yellow", shape: "ring", text: "ignorado: cooldown 1 s" });
    node.warn("portao: pedido ignorado — pulso ha " + (now - lastPulse) + "ms");
    return null;
}

if (flow.get("portao_garagem_relay_state") === "ON") {
    node.status({ fill: "red", shape: "ring", text: "relé já estava ON" });
    node.warn("portao: relé já estava ON; enviado somente OFF");
    msg.payload = { origem: origem || "desconhecida" };
    return [null, msg];
}

// Carimba antes de publicar para fechar a corrida entre duas entradas.
flow.set("portao_garagem_last_click_ms", now);
flow.set("portao_garagem_last_pulse_ms", now);
node.status({ fill: "green", shape: "dot", text: "pulso " + new Date(now).toLocaleTimeString() });
msg.payload = {
    action,
    origem: origem || (msg.topic ? "botao_zigbee" : "desconhecida"),
    received_at: new Date(now).toISOString()
};
return msg;`,
  outputs: 2,
  x: 610,
  y: 140,
  wires: [["gar_relay_pulse_on", "gar_log_pulse_started"], ["gar_relay_pulse_off", "gar_notify_relay_on"]],
});

const on = required("gar_relay_pulse_on");
Object.assign(on, { g: "gar_group_pulse", x: 980, y: 140, wires: [["gar_relay_mqtt_out", "gar_relay_safety_delay"]] });
const delay = required("gar_relay_safety_delay");
Object.assign(delay, { g: "gar_group_pulse", timeout: String(PULSE_MS), timeoutUnits: "milliseconds", x: 1300, y: 140, wires: [["gar_relay_pulse_off"]] });
const off = required("gar_relay_pulse_off");
Object.assign(off, { g: "gar_group_pulse", x: 1610, y: 140, wires: [["gar_relay_mqtt_out"]] });
const mqttOut = required("gar_relay_mqtt_out");
Object.assign(mqttOut, { g: "gar_group_pulse", x: 1930, y: 140 });

upsert({
  id: "gar_log_pulse_started",
  type: "api-call-service",
  z: TAB,
  g: "gar_group_pulse",
  name: "registrar pulso no Logbook",
  server: HA_SERVER,
  version: 7,
  debugenabled: false,
  action: "logbook.log",
  floorId: [], areaId: [], deviceId: [], entityId: [], labelId: [],
  data: '{"name":"Portão garagem","message":"pulso ÚNICO iniciado (origem: " & payload.origem & ") — largura 700 ms, cooldown 1 s."}',
  dataType: "jsonata",
  mergeContext: "",
  mustacheAltTags: false,
  outputProperties: [],
  queue: "none",
  blockInputOverrides: true,
  domain: "logbook",
  service: "log",
  x: 980,
  y: 220,
  wires: [[]],
});

upsert({
  id: "gar_notify_relay_on",
  type: "api-call-service",
  z: TAB,
  g: "gar_group_pulse",
  name: "alertar relé já ligado",
  server: HA_SERVER,
  version: 7,
  debugenabled: false,
  action: "persistent_notification.create",
  floorId: [], areaId: [], deviceId: [], entityId: [], labelId: [],
  data: '{"notification_id":"portao_garagem_rele_preso","title":"Portão da garagem - relé estava ligado","message":"O relé já estava ON. O Node-RED enviou somente OFF e recusou um novo pulso."}',
  dataType: "jsonata",
  mergeContext: "",
  mustacheAltTags: false,
  outputProperties: [],
  queue: "none",
  blockInputOverrides: true,
  domain: "persistent_notification",
  service: "create",
  x: 1300,
  y: 220,
  wires: [[]],
});

const watchSet = required("gar_pulse_watch_set_in");
Object.assign(watchSet, { g: "gar_group_observer", x: 280, y: 400, wires: [["gar_pulse_watch_stamp"]] });
const watchState = required("gar_pulse_watch_state_in");
Object.assign(watchState, { g: "gar_group_observer", x: 280, y: 460, wires: [["gar_pulse_watch_stamp"]] });
upsert({
  ...required("gar_pulse_watch_stamp"),
  g: "gar_group_observer",
  name: "observar pulso e estado do relé",
  func: `const now = Date.now();
const samePulseMs = 500;
const stateTopic = global.get("publicBindings")?.roles?.garage_gate?.topics?.state;
let state;
if (typeof msg.payload === "string") state = msg.payload;
else if (msg.payload && typeof msg.payload === "object") state = msg.payload.state;
state = String(state || "").toUpperCase();
if (!['ON', 'OFF'].includes(state)) return null;

// Somente o tópico reportado representa o estado observado do dispositivo.
if (stateTopic && msg.topic === stateTopic) {
    flow.set("portao_garagem_relay_state", state);
    flow.set("portao_garagem_relay_state_at", now);
}
if (state === "ON") {
    const lastPulse = Number(flow.get("portao_garagem_last_pulse_ms") || 0);
    if (now - lastPulse >= samePulseMs) flow.set("portao_garagem_last_pulse_ms", now);
}
node.status({ fill: state === "ON" ? "blue" : "grey", shape: "dot", text: state + " " + new Date(now).toLocaleTimeString() });
return null;`,
  outputs: 0,
  x: 650,
  y: 430,
  wires: [],
});

upsert({
  ...required("gar_pulse_watch_note"),
  g: "gar_group_observer",
  name: "Observação independente do relé",
  info: "Os tópicos de comando e estado carimbam todo ON, inclusive comandos manuais. O estado reportado também impede um novo ON quando o relé ainda estiver ligado. O cooldown único é de 1 s.",
  x: 300,
  y: 340,
});

upsert({
  id: "gar_group_pulse",
  type: "group",
  z: TAB,
  name: "1. Entradas e pulso único — cooldown 1 s",
  style: { label: true, stroke: "#5b8ff9", color: "#a4a4a4" },
  nodes: ["45296e246a57590d", "gar_portao_action_topic_in", "gar_dashboard_request_in", "gar_portao_normalizar_click", "gar_relay_pulse_on", "gar_relay_safety_delay", "gar_relay_pulse_off", "gar_relay_mqtt_out", "gar_log_pulse_started", "gar_notify_relay_on"],
  x: 120, y: 60, w: 1930, h: 200,
});
upsert({
  id: "gar_group_observer",
  type: "group",
  z: TAB,
  name: "2. Estado e proteção contra pulsos externos",
  style: { label: true, stroke: "#7aa36f", color: "#a4a4a4" },
  nodes: ["gar_pulse_watch_note", "gar_pulse_watch_set_in", "gar_pulse_watch_state_in", "gar_pulse_watch_stamp"],
  x: 120, y: 300, w: 700, h: 200,
});

writeFileSync(OUT, JSON.stringify(flows, null, 4) + "\n");
console.log(`Fluxo garagem escrito em ${OUT}: cooldown ${COOLDOWN_MS} ms, pulso ${PULSE_MS} ms.`);
