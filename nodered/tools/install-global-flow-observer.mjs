#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.resolve(process.argv[2] ?? path.resolve(here, "..", "flows.json"));
const outputPath = path.resolve(process.argv[3] ?? sourcePath);
const functionDir = path.join(here, "functions");
const OBSERVER_TAB = "global_flow_observer_tab";
const SERVER = "4126427d5e161a03";
const flows = JSON.parse(fs.readFileSync(sourcePath, "utf8"));

const source = (name) =>
  fs.readFileSync(path.join(functionDir, name), "utf8").trimEnd();
const owned = (id) =>
  id === OBSERVER_TAB ||
  id.startsWith("global_observer_");

let next = flows.filter((node) => !owned(node.id));
for (const node of next) {
  if (Array.isArray(node.nodes)) {
    node.nodes = node.nodes.filter((id) => !owned(id));
  }
  if (Array.isArray(node.scope)) {
    node.scope = node.scope.filter((id) => !owned(id));
  }
  if (Array.isArray(node.wires)) {
    node.wires = node.wires.map((wire) =>
      Array.isArray(wire) ? wire.filter((id) => !owned(id)) : wire,
    );
  }
  if (Array.isArray(node.links)) {
    node.links = node.links.filter((id) => !owned(id));
  }
}

const tabs = next.filter((node) => node.type === "tab" && node.id !== OBSERVER_TAB);
const coverageOutIds = [];
const coverageNodes = [];

for (const tab of tabs) {
  const prefix = `global_observer_coverage__${tab.id}`;
  const groupId = `${prefix}__group`;
  const catchId = `${prefix}__catch`;
  const statusId = `${prefix}__status`;
  const annotateId = `${prefix}__annotate`;
  const outId = `${prefix}__out`;
  const tabNodes = next.filter((node) => node.z === tab.id);
  const rightEdge = Math.max(
    0,
    ...tabNodes.map((node) =>
      node.type === "group"
        ? Number(node.x ?? 0) + Number(node.w ?? 0)
        : Number(node.x ?? 0) + 140,
    ),
  );
  const groupX = Math.ceil((rightEdge + 40) / 20) * 20;
  const groupY = 40;
  coverageOutIds.push(outId);
  coverageNodes.push(
    {
      id: groupId,
      type: "group",
      z: tab.id,
      name: "Observabilidade global: erros e indisponibilidade",
      style: { label: true, color: "#d97b72" },
      nodes: [catchId, statusId, annotateId, outId],
      x: groupX,
      y: groupY,
      w: 720,
      h: 162,
    },
    {
      id: catchId,
      type: "catch",
      z: tab.id,
      g: groupId,
      name: "Capturar erros de toda a aba",
      scope: null,
      uncaught: false,
      x: groupX + 140,
      y: groupY + 60,
      wires: [[annotateId]],
    },
    {
      id: statusId,
      type: "status",
      z: tab.id,
      g: groupId,
      name: "Observar indisponibilidade da aba",
      scope: null,
      x: groupX + 150,
      y: groupY + 120,
      wires: [[annotateId]],
    },
    {
      id: annotateId,
      type: "function",
      z: tab.id,
      g: groupId,
      name: "Identificar fluxo observado",
      func:
        `msg._global_observer = ${JSON.stringify({
          flow_id: tab.id,
          flow_label: tab.label,
        })};\nreturn msg;`,
      outputs: 1,
      timeout: 0,
      noerr: 0,
      initialize: "",
      finalize: "",
      libs: [],
      x: groupX + 420,
      y: groupY + 90,
      wires: [[outId]],
    },
    {
      id: outId,
      type: "link out",
      z: tab.id,
      g: groupId,
      name: "Falha da aba → monitor global",
      mode: "link",
      links: ["global_observer_events_in"],
      x: groupX + 665,
      y: groupY + 90,
      wires: [],
    },
  );
}

const functionNode = (id, group, name, func, outputs, x, y, wires) => ({
  id,
  type: "function",
  z: OBSERVER_TAB,
  g: group,
  name,
  func,
  outputs,
  timeout: 0,
  noerr: 0,
  initialize: "",
  finalize: "",
  libs: [],
  x,
  y,
  wires,
});

const productionGroup = "global_observer_production_group";
const testGroup = "global_observer_test_group";
const resetTest = source("global-flow-observer-reset-test.js");
const observerNodes = [
  {
    id: OBSERVER_TAB,
    type: "tab",
    label: "observabilidade_global",
    disabled: false,
    info:
      "Recebe erros e estados de indisponibilidade de todas as abas, " +
      "deduplica incidentes e notifica resident_primary via Home Assistant.",
    env: [],
  },
  {
    id: productionGroup,
    type: "group",
    z: OBSERVER_TAB,
    name: "Monitor global e entrega central pelo Home Assistant",
    style: { label: true, color: "#d97b72" },
    nodes: [
      "global_observer_architecture",
      "global_observer_events_in",
      "global_observer_test_evaluate_in",
      "global_observer_test_delivery_in",
      "global_observer_ingest",
      "global_observer_tick",
      "global_observer_evaluate",
      "global_observer_dispatch_guard",
      "global_observer_dry_run_out",
      "global_observer_notify_primary",
      "global_observer_notification_ack",
      "global_observer_notification_catch",
      "global_observer_notification_failure",
    ],
    x: 64,
    y: 39,
    w: 1570,
    h: 302,
  },
  {
    id: "global_observer_architecture",
    type: "comment",
    z: OBSERVER_TAB,
    g: productionGroup,
    name:
      "Erros alertam imediatamente; status de falha exige 1 min; incidentes repetidos silenciam por 6 h. HA indisponível usa queue=all.",
    info:
      "Cada aba possui catch/status universais e um link nomeado. O watchdog " +
      "do próprio Node-RED permanece no Home Assistant, fora deste runtime.",
    x: 690,
    y: 80,
    wires: [],
  },
  {
    id: "global_observer_events_in",
    type: "link in",
    z: OBSERVER_TAB,
    g: productionGroup,
    name: "Receber falhas de todas as abas",
    links: [...coverageOutIds, "global_observer_test_event_out"],
    x: 120,
    y: 160,
    wires: [["global_observer_ingest"]],
  },
  functionNode(
    "global_observer_ingest",
    productionGroup,
    "Classificar erro ou status",
    source("global-flow-observer-ingest.js"),
    1,
    410,
    160,
    [["global_observer_dispatch_guard"]],
  ),
  {
    id: "global_observer_tick",
    type: "inject",
    z: OBSERVER_TAB,
    g: productionGroup,
    name: "Confirmar indisponibilidade a cada 30 s",
    props: [{ p: "payload" }],
    repeat: "30",
    crontab: "",
    once: true,
    onceDelay: "10",
    topic: "",
    payload: "",
    payloadType: "date",
    x: 220,
    y: 260,
    wires: [["global_observer_evaluate"]],
  },
  {
    id: "global_observer_test_evaluate_in",
    type: "link in",
    z: OBSERVER_TAB,
    g: productionGroup,
    name: "Receber avaliação TESTE",
    links: ["global_observer_test_evaluate_out"],
    x: 305,
    y: 300,
    wires: [["global_observer_evaluate"]],
  },
  functionNode(
    "global_observer_evaluate",
    productionGroup,
    "Confirmar falhas persistentes",
    source("global-flow-observer-evaluate.js"),
    1,
    570,
    260,
    [["global_observer_dispatch_guard"]],
  ),
  {
    id: "global_observer_test_delivery_in",
    type: "link in",
    z: OBSERVER_TAB,
    g: productionGroup,
    name: "Receber smoke test real",
    links: ["global_observer_test_delivery_out"],
    x: 615,
    y: 120,
    wires: [["global_observer_dispatch_guard"]],
  },
  functionNode(
    "global_observer_dispatch_guard",
    productionGroup,
    "Separar produção, TESTE real e dry-run",
    source("global-flow-observer-dispatch-guard.js"),
    2,
    830,
    180,
    [["global_observer_notify_primary"], ["global_observer_dry_run_out"]],
  ),
  {
    id: "global_observer_dry_run_out",
    type: "link out",
    z: OBSERVER_TAB,
    g: productionGroup,
    name: "TESTE simulado → terminal dry-run",
    mode: "link",
    links: ["global_observer_dry_run_in"],
    x: 1015,
    y: 240,
    wires: [],
  },
  {
    id: "global_observer_notify_primary",
    type: "api-call-service",
    z: OBSERVER_TAB,
    g: productionGroup,
    name: "Avisar resident_primary",
    server: SERVER,
    version: 7,
    debugenabled: false,
    action: "public_bindings.call",
    floorId: [],
    areaId: [],
    deviceId: [],
    entityId: [],
    labelId: [],
    data:
      '{"role":"mobile_primary","action":"notify_3","data":{"title":_observer_delivery_test=true ? "TESTE — Monitor global do Node-RED" : alert.title,"message":_observer_delivery_test=true ? "TESTE de entrega do canal central de falhas do Node-RED via Home Assistant." : alert.message}}',
    dataType: "jsonata",
    mergeContext: "",
    mustacheAltTags: false,
    outputProperties: [],
    queue: "all",
    blockInputOverrides: true,
    domain: "public_bindings",
    service: "call",
    x: 1110,
    y: 160,
    wires: [["global_observer_notification_ack"]],
  },
  functionNode(
    "global_observer_notification_ack",
    productionGroup,
    "Confirmar aceite pelo Home Assistant",
    `const deliveryTest = msg._observer_delivery_test === true;\n` +
      `node.log("NODERED_GLOBAL_NOTIFICATION_ACCEPTED kind=" + ` +
      `String(msg.payload?.observer_kind ?? "unknown") + ` +
      `" delivery_test=" + String(deliveryTest));\nreturn null;`,
    0,
    1410,
    160,
    [],
  ),
  {
    id: "global_observer_notification_catch",
    type: "catch",
    z: OBSERVER_TAB,
    g: productionGroup,
    name: "Capturar falha do canal de notificação",
    scope: ["global_observer_notify_primary"],
    uncaught: false,
    x: 1120,
    y: 280,
    wires: [["global_observer_notification_failure"]],
  },
  functionNode(
    "global_observer_notification_failure",
    productionGroup,
    "Registrar falha sem recursão",
    `node.warn("NODERED_GLOBAL_NOTIFICATION_FAILED source=" + ` +
      `String(msg.error?.source?.type ?? "unknown"));\nreturn null;`,
    0,
    1410,
    280,
    [],
  ),
  {
    id: testGroup,
    type: "group",
    z: OBSERVER_TAB,
    name: "Testes: dry-run completo e smoke test explícito de entrega",
    style: { label: true, color: "#4b93d1" },
    nodes: [
      "global_observer_test_instructions",
      "global_observer_test_reset",
      "global_observer_test_reset_state",
      "global_observer_test_error",
      "global_observer_test_status_failure",
      "global_observer_test_event_out",
      "global_observer_test_evaluate",
      "global_observer_test_evaluate_out",
      "global_observer_test_delivery",
      "global_observer_test_delivery_out",
      "global_observer_dry_run_in",
      "global_observer_dry_run_terminal",
    ],
    x: 64,
    y: 379,
    w: 1570,
    h: 322,
  },
  {
    id: "global_observer_test_instructions",
    type: "comment",
    z: OBSERVER_TAB,
    g: testGroup,
    name:
      "TESTE: 1 reset; 2 erro; 3 status indisponível; 4 avaliar 1 min; 5 opcional: push real identificado como TESTE",
    info:
      "Erro e status atravessam classificação, dedupe e guard até o dry-run. " +
      "Somente o passo 5 chama o Home Assistant; é o smoke test do canal.",
    x: 710,
    y: 420,
    wires: [],
  },
  {
    id: "global_observer_test_reset",
    type: "inject",
    z: OBSERVER_TAB,
    g: testGroup,
    name: "TESTE 1: reset",
    props: [{ p: "payload" }],
    repeat: "",
    crontab: "",
    once: false,
    onceDelay: 0.1,
    topic: "",
    payload: "",
    payloadType: "date",
    x: 180,
    y: 500,
    wires: [["global_observer_test_reset_state"]],
  },
  functionNode(
    "global_observer_test_reset_state",
    testGroup,
    "Resetar estado de teste",
    resetTest,
    0,
    440,
    500,
    [],
  ),
  {
    id: "global_observer_test_error",
    type: "inject",
    z: OBSERVER_TAB,
    g: testGroup,
    name: "TESTE 2: erro de nó",
    props: [
      {
        p: "error",
        v: '{"message":"synthetic failure","source":{"id":"test_node","type":"function","name":"Nó sintético"}}',
        vt: "json",
      },
      {
        p: "_global_observer",
        v: '{"flow_id":"test_flow","flow_label":"Fluxo sintético"}',
        vt: "json",
      },
      { p: "_global_observer_test", v: "true", vt: "bool" },
      { p: "observer_now", v: "100000", vt: "num" },
    ],
    repeat: "",
    crontab: "",
    once: false,
    onceDelay: 0.1,
    topic: "",
    x: 190,
    y: 560,
    wires: [["global_observer_test_event_out"]],
  },
  {
    id: "global_observer_test_status_failure",
    type: "inject",
    z: OBSERVER_TAB,
    g: testGroup,
    name: "TESTE 3: indisponível",
    props: [
      {
        p: "status",
        v: '{"fill":"red","shape":"ring","text":"disconnected","source":{"id":"test_ha_node","type":"api-call-service","name":"HA sintético"}}',
        vt: "json",
      },
      {
        p: "_global_observer",
        v: '{"flow_id":"test_flow","flow_label":"Fluxo sintético"}',
        vt: "json",
      },
      { p: "_global_observer_test", v: "true", vt: "bool" },
      { p: "observer_now", v: "200000", vt: "num" },
    ],
    repeat: "",
    crontab: "",
    once: false,
    onceDelay: 0.1,
    topic: "",
    x: 200,
    y: 620,
    wires: [["global_observer_test_event_out"]],
  },
  {
    id: "global_observer_test_event_out",
    type: "link out",
    z: OBSERVER_TAB,
    g: testGroup,
    name: "Eventos TESTE → classificador",
    mode: "link",
    links: ["global_observer_events_in"],
    x: 465,
    y: 590,
    wires: [],
  },
  {
    id: "global_observer_test_evaluate",
    type: "inject",
    z: OBSERVER_TAB,
    g: testGroup,
    name: "TESTE 4: avaliar após 1 min",
    props: [
      { p: "_global_observer_test", v: "true", vt: "bool" },
      { p: "observer_now", v: "261000", vt: "num" },
    ],
    repeat: "",
    crontab: "",
    once: false,
    onceDelay: 0.1,
    topic: "",
    x: 730,
    y: 620,
    wires: [["global_observer_test_evaluate_out"]],
  },
  {
    id: "global_observer_test_evaluate_out",
    type: "link out",
    z: OBSERVER_TAB,
    g: testGroup,
    name: "Avaliação TESTE → produção",
    mode: "link",
    links: ["global_observer_test_evaluate_in"],
    x: 985,
    y: 620,
    wires: [],
  },
  {
    id: "global_observer_test_delivery",
    type: "inject",
    z: OBSERVER_TAB,
    g: testGroup,
    name: "TESTE 5: enviar push real",
    props: [
      { p: "_global_observer_test", v: "true", vt: "bool" },
      { p: "_observer_delivery_test", v: "true", vt: "bool" },
      { p: "payload.observer_kind", v: "delivery_smoke_test", vt: "str" },
    ],
    repeat: "",
    crontab: "",
    once: false,
    onceDelay: 0.1,
    topic: "",
    x: 740,
    y: 540,
    wires: [["global_observer_test_delivery_out"]],
  },
  {
    id: "global_observer_test_delivery_out",
    type: "link out",
    z: OBSERVER_TAB,
    g: testGroup,
    name: "Smoke test → canal real",
    mode: "link",
    links: ["global_observer_test_delivery_in"],
    x: 985,
    y: 540,
    wires: [],
  },
  {
    id: "global_observer_dry_run_in",
    type: "link in",
    z: OBSERVER_TAB,
    g: testGroup,
    name: "Receber efeito simulado",
    links: ["global_observer_dry_run_out"],
    x: 1160,
    y: 640,
    wires: [["global_observer_dry_run_terminal"]],
  },
  functionNode(
    "global_observer_dry_run_terminal",
    testGroup,
    "TESTE FINAL: notificação simulada",
    source("global-flow-observer-dry-run.js"),
    0,
    1410,
    640,
    [],
  ),
];

next.push(...coverageNodes, ...observerNodes);
fs.writeFileSync(outputPath, `${JSON.stringify(next, null, 4)}\n`);
console.log(
  `Global flow observer installed for ${tabs.length} tabs in ${outputPath}`,
);
