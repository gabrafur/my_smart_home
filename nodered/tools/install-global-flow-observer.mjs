#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { NOTIFICATION_HUBS, installNotificationHubs, refreshNotificationWireRoutes, routeCanvasWires } from "./install-notification-hubs.mjs";
import { reconcileGeneratedFlows } from "./reconcile-generated-flows.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.resolve(process.argv[2] ?? path.resolve(here, "..", "flows.json"));
const outputPath = path.resolve(process.argv[3] ?? sourcePath);
const functionDir = path.join(here, "functions");
const OBSERVER_TAB = "global_flow_observer_tab";
const externalEventOutIds = [
  "local_ai_rtx_alert_out",
  "internet_remote_access_alert_out",
  "weekly_docs_review_alert_out",
  "notification_hub_mobile_observer_out",
  "notification_hub_alexa_observer_out",
  "notification_hub_persistent_observer_out",
];
const parsedFlows = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
const notificationHubTabs = Object.values(NOTIFICATION_HUBS).map(({ tab }) => tab);
const hasNotificationHubs = notificationHubTabs.every((tabId) =>
  parsedFlows.some((node) => node.id === tabId && node.type === "tab")
);
const flows = hasNotificationHubs
  ? structuredClone(parsedFlows)
  : installNotificationHubs(structuredClone(parsedFlows));

const source = (name) =>
  fs.readFileSync(path.join(functionDir, name), "utf8").trimEnd();
const isCoverageId = (id) =>
  typeof id === "string" && id.startsWith("global_observer_coverage__");
const isGeneratedWireRoute = (node) =>
  node?.z === OBSERVER_TAB &&
  /^notification_hub_wire_(?:out|in)_[a-f0-9]{12}$/.test(node.id ?? "");
const owned = (id) =>
  id === OBSERVER_TAB ||
  (id.startsWith("global_observer_") && !isCoverageId(id));
const observerManaged = (node) =>
  owned(node.id) || isCoverageId(node.id) || isGeneratedWireRoute(node);

// Short visual routes are derived from the observer's generated wires. Remove
// the old copies together with their source nodes so the refreshed topology
// recreates each pair exactly once.
let next = flows.filter((node) => !owned(node.id) && !isGeneratedWireRoute(node));
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
    node.links = node.links.filter((id) =>
      !owned(id) ||
      (
        externalEventOutIds.includes(node.id) &&
        ["global_observer_events_in", "global_observer_alert_to_dispatch_in"].includes(id)
      ),
    );
  }
}

const tabs = next.filter((node) => node.type === "tab" && node.id !== OBSERVER_TAB);
const homeAssistantServers = next.filter((node) => node.type === "server");
if (homeAssistantServers.length !== 1) {
  throw new Error(
    `Expected exactly one Home Assistant server, found ${homeAssistantServers.length}`,
  );
}
const HOME_ASSISTANT_SERVER = homeAssistantServers[0].id;
const coverageOutIds = [];
const coverageNodes = [];
const coverageLayoutOverrides = new Map([
  ["resident_notifications_tab", {
    group: { x: 11720, y: 40, w: 720, h: 162 },
    catch: { x: 11860, y: 100 },
    status: { x: 11870, y: 160 },
    annotate: { x: 12140, y: 130 },
    out: { x: 12385, y: 130 },
  }],
  ["weekly_docs_review_tab", {
    group: { x: 2600, y: 59, w: 752, h: 142 },
    catch: { x: 2786, y: 100 },
    status: { x: 2766, y: 160 },
    annotate: { x: 3066, y: 130 },
    out: { x: 3311, y: 130 },
  }],
  ["monitoramento_internet_tab", {
    group: { x: 6900, y: 59, w: 722, h: 142 },
    catch: { x: 7056, y: 100 },
    status: { x: 7066, y: 160 },
    annotate: { x: 7336, y: 130 },
    out: { x: 7581, y: 130 },
  }],
  ["monitoramento_zigbee_tab", {
    group: { x: 7040, y: 59, w: 722, h: 142 },
    catch: { x: 7196, y: 100 },
    status: { x: 7206, y: 160 },
    annotate: { x: 7476, y: 130 },
    out: { x: 7721, y: 130 },
  }],
  ["monitoramento_tuya_tab", {
    group: { x: 7180, y: 59, w: 722, h: 142 },
    catch: { x: 7336, y: 100 },
    status: { x: 7346, y: 160 },
    annotate: { x: 7616, y: 130 },
    out: { x: 7861, y: 130 },
  }],
  ["62bb822e033d1623", {
    group: { x: 7180, y: 59, w: 722, h: 142 },
    catch: { x: 7336, y: 100 },
    status: { x: 7346, y: 160 },
    annotate: { x: 7616, y: 130 },
    out: { x: 7861, y: 130 },
  }],
  ["ea0a6aa0d24ff863", {
    group: { x: 3400, y: 59, w: 722, h: 142 },
    catch: { x: 3556, y: 100 },
    status: { x: 3566, y: 160 },
    annotate: { x: 3836, y: 130 },
    out: { x: 4081, y: 130 },
  }],
  ["c22d8b12055e87f7", {
    group: { x: 4350, y: 40, w: 720, h: 162 },
    catch: { x: 4490, y: 100 },
    status: { x: 4500, y: 160 },
    annotate: { x: 4770, y: 130 },
    out: { x: 5015, y: 130 },
  }],
  ["6b7552efb85343f4", {
    group: { x: 3740, y: 40, w: 720, h: 162 },
    catch: { x: 3880, y: 100 },
    status: { x: 3890, y: 160 },
    annotate: { x: 4160, y: 130 },
    out: { x: 4405, y: 130 },
  }],
]);

for (const tab of tabs) {
  const prefix = `global_observer_coverage__${tab.id}`;
  const groupId = `${prefix}__group`;
  const catchId = `${prefix}__catch`;
  const statusId = `${prefix}__status`;
  const annotateId = `${prefix}__annotate`;
  const outId = `${prefix}__out`;
  const tabNodes = next.filter(
    (node) => node.z === tab.id && !isCoverageId(node.id),
  );
  const rightEdge = Math.max(
    0,
    ...tabNodes.map((node) =>
      node.type === "group"
        ? Number(node.x ?? 0) + Number(node.w ?? 0)
        : Number(node.x ?? 0) + 140,
    ),
  );
  const layoutOverride = tabNodes.some((node) => node.type === "group" && node.notification_hub_layout_version === 1)
    ? undefined
    : coverageLayoutOverrides.get(tab.id);
  const groupX = layoutOverride?.group?.x ?? Math.ceil((rightEdge + 40) / 20) * 20;
  const groupY = layoutOverride?.group?.y ?? 40;
  coverageOutIds.push(outId);
  const desiredCoverageNodes = [
    {
      id: groupId,
      type: "group",
      z: tab.id,
      name: "Observabilidade global: erros e indisponibilidade",
      style: { label: true, color: "#d97b72" },
      nodes: [catchId, statusId, annotateId, outId],
      x: groupX,
      y: groupY,
      w: layoutOverride?.group?.w ?? 720,
      h: layoutOverride?.group?.h ?? 162,
    },
    {
      id: catchId,
      type: "catch",
      z: tab.id,
      g: groupId,
      name: "Capturar erros de toda a aba",
      scope: null,
      uncaught: false,
      x: layoutOverride?.catch?.x ?? groupX + 140,
      y: layoutOverride?.catch?.y ?? groupY + 60,
      wires: [[annotateId]],
    },
    {
      id: statusId,
      type: "status",
      z: tab.id,
      g: groupId,
      name: "Observar indisponibilidade da aba",
      scope: null,
      x: layoutOverride?.status?.x ?? groupX + 150,
      y: layoutOverride?.status?.y ?? groupY + 120,
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
      x: layoutOverride?.annotate?.x ?? groupX + 420,
      y: layoutOverride?.annotate?.y ?? groupY + 90,
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
      x: layoutOverride?.out?.x ?? groupX + 665,
      y: layoutOverride?.out?.y ?? groupY + 90,
      wires: [],
    },
  ];
  for (const desired of desiredCoverageNodes) {
    const existing = next.find((node) => node.id === desired.id);
    if (!existing) {
      coverageNodes.push(desired);
      continue;
    }
    const preservedLayout = Object.fromEntries(
      ["x", "y", "w", "h"]
        .filter((property) => Object.hasOwn(existing, property))
        .map((property) => [property, existing[property]]),
    );
    Object.assign(existing, desired, preservedLayout);
  }
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

const switchNode = (id, group, name, property, rules, x, y, wires) => ({
  id,
  type: "switch",
  z: OBSERVER_TAB,
  g: group,
  name,
  property,
  propertyType: "msg",
  rules,
  checkall: "true",
  repair: false,
  outputs: rules.length,
  x,
  y,
  wires,
});

const productionGroup = "global_observer_production_group";
const policyGroup = "global_observer_policy_group";
const integrationGroup = "global_observer_integration_group";
const testGroup = "global_observer_test_group";
const resetTest = source("global-flow-observer-reset-test.js");
const observerNodes = [
  {
    id: OBSERVER_TAB,
    type: "tab",
    label: "observabilidade_global",
    disabled: false,
    info:
      "Recebe erros e estados de indisponibilidade de todas as abas, monitora " +
      "os estados das entradas de integração do Home Assistant, " +
      "deduplica incidentes, notifica resident_primary e cria uma notificação " +
      "persistente no Home Assistant.",
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
      "global_observer_event_kind",
      "global_observer_error_accepted_gate",
      "global_observer_error_accepted_save",
      "global_observer_error_connection_gate",
      "global_observer_error_connection_save",
      "global_observer_error_mutate",
      "global_observer_error_notification_gate",
      "global_observer_error_alert",
      "global_observer_status_monitored_gate",
      "global_observer_status_unmonitored",
      "global_observer_status_failure_gate",
      "global_observer_status_failure",
      "global_observer_status_recovery",
      "global_observer_unknown_ignore",
      "global_observer_tick",
      "global_observer_evaluate",
      "global_observer_evaluate_corroboration_gate",
      "global_observer_evaluate_clear_uncorroborated",
      "global_observer_uncorroborated_recovery_out",
      "global_observer_evaluate_duration_gate",
      "global_observer_evaluate_clear_transient",
      "global_observer_transient_recovery_out",
      "global_observer_evaluate_confirm",
      "global_observer_evaluate_notification_gate",
      "global_observer_evaluate_alert",
      "global_observer_alert_to_dispatch_out",
      "global_observer_alert_to_dispatch_in",
      "global_observer_dispatch_guard",
      "global_observer_dry_run_out",
      "global_observer_notify_primary",
      "global_observer_notify_primary__hub_call",
      "global_observer_notify_primary__hub_result",
      "global_observer_notify_persistent",
      "global_observer_notify_persistent__hub_call",
      "global_observer_notify_persistent__hub_result",
      "global_observer_notification_ack",
      "global_observer_notification_catch",
      "global_observer_notification_failure",
      "global_observer_internal_catch",
      "global_observer_internal_failure",
    ],
    x: 64,
    y: 39,
    w: 3900,
    h: 522,
  },
  {
    id: "global_observer_architecture",
    type: "comment",
    z: OBSERVER_TAB,
    g: productionGroup,
    name:
      "Normalização estrutural → decisões visuais → estado/dedupe → entrega central; parâmetros vêm exclusivamente do grupo Política visual.",
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
    links: [...coverageOutIds.sort(), "global_observer_test_event_out"],
    x: 120,
    y: 160,
    wires: [["global_observer_ingest"]],
  },
  functionNode(
    "global_observer_ingest",
    productionGroup,
    "Classificar erro ou status",
    source("global-flow-observer-normalize.js"),
    1,
    410,
    160,
    [["global_observer_event_kind"]],
  ),
  switchNode(
    "global_observer_event_kind", productionGroup, "Qual tipo de evento?",
    "_observer_event.kind",
    [{ t: "eq", v: "error", vt: "str" }, { t: "eq", v: "status", vt: "str" }, { t: "else" }],
    600, 220,
    [["global_observer_error_accepted_gate"], ["global_observer_status_monitored_gate"], ["global_observer_unknown_ignore"]],
  ),
  switchNode(
    "global_observer_error_accepted_gate", productionGroup, "Wake aceito e pendente?",
    "_observer_event.accepted_wake_pending",
    [{ t: "true" }, { t: "else" }], 850, 140,
    [["global_observer_error_accepted_save"], ["global_observer_error_connection_gate"]],
  ),
  functionNode(
    "global_observer_error_accepted_save", productionGroup,
    "Encerrar wake aceito sem incidente", source("global-flow-observer-state-save.js"),
    0, 1090, 100, [],
  ),
  switchNode(
    "global_observer_error_connection_gate", productionGroup, "Cascata de reconexão ativa?",
    "_observer_event.connection_suppressed",
    [{ t: "true" }, { t: "else" }], 1090, 180,
    [["global_observer_error_connection_save"], ["global_observer_error_mutate"]],
  ),
  functionNode(
    "global_observer_error_connection_save", productionGroup,
    "Encerrar erro coberto pela carência", source("global-flow-observer-state-save.js"),
    0, 1340, 140, [],
  ),
  functionNode(
    "global_observer_error_mutate", productionGroup,
    "Atualizar dedupe do erro", source("global-flow-observer-error-mutate.js"),
    1, 1340, 220, [["global_observer_error_notification_gate"]],
  ),
  switchNode(
    "global_observer_error_notification_gate", productionGroup, "Lembrete do erro venceu?",
    "_observer_event.notification_due",
    [{ t: "true" }, { t: "else" }], 1580, 220,
    [["global_observer_error_alert"], []],
  ),
  functionNode(
    "global_observer_error_alert", productionGroup,
    "Montar alerta de erro", source("global-flow-observer-error-alert.js"),
    1, 1820, 220, [["global_observer_alert_to_dispatch_out"]],
  ),
  switchNode(
    "global_observer_status_monitored_gate", productionGroup, "Fonte de status monitorada?",
    "_observer_event.monitored",
    [{ t: "true" }, { t: "else" }], 850, 300,
    [["global_observer_status_failure_gate"], ["global_observer_status_unmonitored"]],
  ),
  functionNode(
    "global_observer_status_unmonitored", productionGroup,
    "Remover status fora do contrato", source("global-flow-observer-status-unmonitored.js"),
    0, 1060, 380, [],
  ),
  switchNode(
    "global_observer_status_failure_gate", productionGroup, "Status indica falha real?",
    "_observer_event.failing",
    [{ t: "true" }, { t: "else" }], 1090, 280,
    [["global_observer_status_failure"], ["global_observer_status_recovery"]],
  ),
  functionNode(
    "global_observer_status_failure", productionGroup,
    "Registrar fonte indisponível", source("global-flow-observer-status-failure.js"),
    0, 1340, 280, [],
  ),
  functionNode(
    "global_observer_status_recovery", productionGroup,
    "Registrar recuperação da fonte", source("global-flow-observer-status-recovery.js"),
    0, 1390, 340, [],
  ),
  functionNode(
    "global_observer_unknown_ignore", productionGroup,
    "Ignorar evento sem erro ou status", source("global-flow-observer-state-save.js"),
    0, 760, 400, [],
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
    source("global-flow-observer-evaluate-expand.js"),
    1,
    570,
    260,
    [["global_observer_evaluate_corroboration_gate"]],
  ),
  switchNode(
    "global_observer_evaluate_corroboration_gate", productionGroup,
    "Incidente ativo e corroborado?", "_observer_evaluation.corroborated",
    [{ t: "true" }, { t: "else" }], 830, 460,
    [["global_observer_evaluate_duration_gate"], ["global_observer_evaluate_clear_uncorroborated"]],
  ),
  functionNode(
    "global_observer_evaluate_clear_uncorroborated", productionGroup,
    "Limpar incidente sem corroboração", source("global-flow-observer-evaluate-clear.js"),
    1, 1090, 520, [["global_observer_uncorroborated_recovery_out"]],
  ),
  {
    id: "global_observer_uncorroborated_recovery_out", type: "link out",
    z: OBSERVER_TAB, g: productionGroup,
    name: "Recuperação sem corroboração → entrega", mode: "link",
    links: ["global_observer_alert_to_dispatch_in"],
    x: 1500, y: 480, wires: [],
  },
  switchNode(
    "global_observer_evaluate_duration_gate", productionGroup,
    "Tempo de confirmação atingido?", "_observer_evaluation.duration_met",
    [{ t: "true" }, { t: "else" }], 1090, 440,
    [["global_observer_evaluate_confirm"], ["global_observer_evaluate_clear_transient"]],
  ),
  functionNode(
    "global_observer_evaluate_clear_transient", productionGroup,
    "Limpar incidente ainda transitório", source("global-flow-observer-evaluate-clear.js"),
    1, 1400, 520, [["global_observer_transient_recovery_out"]],
  ),
  {
    id: "global_observer_transient_recovery_out", type: "link out",
    z: OBSERVER_TAB, g: productionGroup,
    name: "Recuperação transitória → entrega", mode: "link",
    links: ["global_observer_alert_to_dispatch_in"],
    x: 1810, y: 480, wires: [],
  },
  functionNode(
    "global_observer_evaluate_confirm", productionGroup,
    "Confirmar e atualizar incidente", source("global-flow-observer-evaluate-confirm.js"),
    1, 1340, 420, [["global_observer_evaluate_notification_gate"]],
  ),
  switchNode(
    "global_observer_evaluate_notification_gate", productionGroup,
    "Lembrete do status venceu?", "_observer_evaluation.notification_due",
    [{ t: "true" }, { t: "else" }], 1580, 420,
    [["global_observer_evaluate_alert"], []],
  ),
  functionNode(
    "global_observer_evaluate_alert", productionGroup,
    "Montar alerta de indisponibilidade", source("global-flow-observer-evaluate-alert.js"),
    1, 1820, 420, [["global_observer_alert_to_dispatch_out"]],
  ),
  {
    id: "global_observer_alert_to_dispatch_out", type: "link out", z: OBSERVER_TAB,
    g: productionGroup, name: "Alertas confirmados → entrega", mode: "link",
    links: ["global_observer_alert_to_dispatch_in"], x: 2050, y: 320, wires: [],
  },
  {
    id: "global_observer_alert_to_dispatch_in", type: "link in", z: OBSERVER_TAB,
    g: productionGroup, name: "Receber alertas, encerramentos ou eventos de domínio",
    links: [
      "global_observer_alert_to_dispatch_out",
      "global_observer_uncorroborated_recovery_out",
      "global_observer_transient_recovery_out",
      "global_observer_integration_alert_out",
      ...externalEventOutIds,
    ],
    x: 2280, y: 300, wires: [["global_observer_dispatch_guard"]],
  },
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
    3,
    830,
    180,
    [
      ["global_observer_notify_primary"],
      ["global_observer_notify_persistent"],
      ["global_observer_dry_run_out"],
    ],
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
    y: 260,
    wires: [],
  },
  {
    id: "global_observer_notify_primary",
    type: "change",
    z: OBSERVER_TAB,
    g: productionGroup,
    name: "Preparar alerta móvel para resident_primary",
    rules: [
      { t: "set", p: "_notification_hub_context", pt: "msg", to: '{"payload":payload,"notification":notification,"had_notification":$exists(notification)}', tot: "jsonata" },
      { t: "set", p: "_observer_notification_channel", pt: "msg", to: "mobile_primary", tot: "str" },
      { t: "set", p: "notification", pt: "msg", to: '{"source":"observabilidade_global","recipients":["resident_primary"],"profile":"simple","title":_observer_delivery_test=true ? "TESTE — Monitor global do Node-RED" : alert.title,"test_mode":_observer_delivery_test=true,"delivery_under_test":_observer_delivery_test=true}', tot: "jsonata" },
      { t: "set", p: "payload", pt: "msg", to: '_observer_delivery_test=true ? "TESTE de entrega do canal central de falhas do Node-RED via Home Assistant." : alert.message', tot: "jsonata" },
    ],
    action: "", property: "", from: "", to: "", reg: false,
    x: 1110,
    y: 140,
    wires: [["global_observer_notify_primary__hub_call"]],
  },
  {
    id: "global_observer_notify_primary__hub_call",
    type: "link call", z: OBSERVER_TAB, g: productionGroup,
    name: "Hub móvel → resident_primary", links: [NOTIFICATION_HUBS.mobile.input],
    linkType: "static", timeout: "30", x: 1330, y: 140,
    wires: [["global_observer_notify_primary__hub_result"]],
  },
  {
    id: "global_observer_notify_primary__hub_result",
    type: "switch", z: OBSERVER_TAB, g: productionGroup,
    name: "Hub móvel aceitou?", property: "notification_delivery.status", propertyType: "msg",
    rules: [{ t: "eq", v: "accepted", vt: "str" }, { t: "else" }], checkall: "true", repair: false,
    outputs: 2, x: 1550, y: 140,
    wires: [["global_observer_notification_ack"], ["global_observer_notification_failure"]],
  },
  {
    id: "global_observer_notify_persistent",
    type: "change",
    z: OBSERVER_TAB,
    g: productionGroup,
    name: "Preparar notificação persistente",
    rules: [
      { t: "set", p: "_notification_hub_context", pt: "msg", to: '{"payload":payload,"notification":notification,"had_notification":$exists(notification)}', tot: "jsonata" },
      { t: "set", p: "_observer_notification_channel", pt: "msg", to: "persistent_notification", tot: "str" },
      { t: "set", p: "notification", pt: "msg", to: '{"source":"observabilidade_global","operation":payload.persistent_notification_operation="dismiss" ? "dismiss" : "create","delivery":"queued","notification_id":_observer_persistent_notification_id,"title":alert.title}', tot: "jsonata" },
      { t: "set", p: "payload", pt: "msg", to: "alert.message", tot: "jsonata" },
    ],
    action: "", property: "", from: "", to: "", reg: false,
    x: 1140,
    y: 200,
    wires: [["global_observer_notify_persistent__hub_call"]],
  },
  {
    id: "global_observer_notify_persistent__hub_call",
    type: "link call", z: OBSERVER_TAB, g: productionGroup,
    name: "Hub HA → criar/atualizar", links: [NOTIFICATION_HUBS.persistent.input],
    linkType: "static", timeout: "30", x: 1350, y: 200,
    wires: [["global_observer_notify_persistent__hub_result"]],
  },
  {
    id: "global_observer_notify_persistent__hub_result",
    type: "switch", z: OBSERVER_TAB, g: productionGroup,
    name: "Hub persistente aceitou?", property: "notification_delivery.status", propertyType: "msg",
    rules: [{ t: "eq", v: "accepted", vt: "str" }, { t: "else" }], checkall: "true", repair: false,
    outputs: 2, x: 1570, y: 200,
    wires: [["global_observer_notification_ack"], ["global_observer_notification_failure"]],
  },
  functionNode(
    "global_observer_notification_ack",
    productionGroup,
    "Confirmar aceite pelo Home Assistant",
    `const deliveryTest = msg._observer_delivery_test === true;\n` +
      `node.log("NODERED_GLOBAL_NOTIFICATION_ACCEPTED kind=" + ` +
      `String(msg.payload?.observer_kind ?? "unknown") + ` +
      `" channel=" + String(msg._observer_notification_channel ?? "unknown") + ` +
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
    scope: [
      "global_observer_notify_primary__hub_call",
      "global_observer_notify_persistent__hub_call",
    ],
    uncaught: false,
    x: 1240,
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
    1510,
    280,
    [],
  ),
  {
    id: "global_observer_internal_catch",
    type: "catch",
    z: OBSERVER_TAB,
    g: productionGroup,
    name: "Capturar falha interna do monitor",
    scope: [
      "global_observer_ingest",
      "global_observer_error_accepted_save",
      "global_observer_error_connection_save",
      "global_observer_error_mutate",
      "global_observer_error_alert",
      "global_observer_status_unmonitored",
      "global_observer_status_failure",
      "global_observer_status_recovery",
      "global_observer_unknown_ignore",
      "global_observer_evaluate",
      "global_observer_evaluate_clear_uncorroborated",
      "global_observer_evaluate_clear_transient",
      "global_observer_evaluate_confirm",
      "global_observer_evaluate_alert",
      "global_observer_dispatch_guard",
      "global_observer_integration_entries",
      "global_observer_integration_normalize",
      "global_observer_integration_lifecycle",
    ],
    uncaught: false,
    x: 600,
    y: 320,
    wires: [["global_observer_internal_failure"]],
  },
  functionNode(
    "global_observer_internal_failure",
    productionGroup,
    "Notificar falha interna sem recursão",
    source("global-flow-observer-internal-failure.js"),
    2,
    880,
    320,
    [
      ["global_observer_notify_primary"],
      ["global_observer_notify_persistent"],
    ],
  ),
  {
    id: policyGroup,
    type: "group",
    z: OBSERVER_TAB,
    name: "Política visual — confirmação, dedupe e retenção",
    style: { label: true, color: "#d9b300" },
    nodes: [
      "global_observer_policy_comment",
      "global_observer_policy_default_grace",
      "global_observer_policy_default_confirm",
      "global_observer_policy_default_reminder",
      "global_observer_policy_default_retention",
      "global_observer_policy_default_corroboration",
      "global_observer_policy_validate",
      "global_observer_policy_store",
      "global_observer_policy_reject",
    ],
    x: 64,
    y: 579,
    w: 2100,
    h: 342,
  },
  {
    id: "global_observer_policy_comment",
    type: "comment",
    z: OBSERVER_TAB,
    g: policyGroup,
    name: "Cada parâmetro mostra unidade, padrão e limites. Valor inválido preserva a última política válida.",
    info:
      "Carência de reconexão: 90 s [10..600]; confirmação: 60 s [10..600]; " +
      "lembrete: 6 h [1..48]; retenção de erros: 7 dias [1..30]; " +
      "corroboração HA: 2 fontes [2..10]. Valores inteiros.",
    x: 1500,
    y: 620,
    wires: [],
  },
  {
    id: "global_observer_policy_default_grace",
    type: "inject", z: OBSERVER_TAB, g: policyGroup,
    name: "Carência reconexão = 90 s [10..600]",
    props: [{ p: "payload" }, { p: "topic", vt: "str" }], repeat: "", crontab: "",
    once: true, onceDelay: 0.1, topic: "connection_recovery_grace_seconds",
    payload: "90", payloadType: "num", x: 360, y: 660,
    wires: [["global_observer_policy_validate"]],
  },
  {
    id: "global_observer_policy_default_confirm",
    type: "inject", z: OBSERVER_TAB, g: policyGroup,
    name: "Confirmar falha = 60 s [10..600]",
    props: [{ p: "payload" }, { p: "topic", vt: "str" }], repeat: "", crontab: "",
    once: false, onceDelay: 0.1, topic: "status_confirm_seconds",
    payload: "60", payloadType: "num", x: 350, y: 710,
    wires: [["global_observer_policy_validate"]],
  },
  {
    id: "global_observer_policy_default_reminder",
    type: "inject", z: OBSERVER_TAB, g: policyGroup,
    name: "Lembrete = 6 h [1..48]",
    props: [{ p: "payload" }, { p: "topic", vt: "str" }], repeat: "", crontab: "",
    once: false, onceDelay: 0.1, topic: "reminder_hours",
    payload: "6", payloadType: "num", x: 320, y: 760,
    wires: [["global_observer_policy_validate"]],
  },
  {
    id: "global_observer_policy_default_retention",
    type: "inject", z: OBSERVER_TAB, g: policyGroup,
    name: "Retenção de erros = 7 dias [1..30]",
    props: [{ p: "payload" }, { p: "topic", vt: "str" }], repeat: "", crontab: "",
    once: false, onceDelay: 0.1, topic: "error_retention_days",
    payload: "7", payloadType: "num", x: 350, y: 810,
    wires: [["global_observer_policy_validate"]],
  },
  {
    id: "global_observer_policy_default_corroboration",
    type: "inject", z: OBSERVER_TAB, g: policyGroup,
    name: "Corroborar HA = 2 fontes [2..10]",
    props: [{ p: "payload" }, { p: "topic", vt: "str" }], repeat: "", crontab: "",
    once: false, onceDelay: 0.1, topic: "ha_corroboration_sources",
    payload: "2", payloadType: "num", x: 350, y: 860,
    wires: [["global_observer_policy_validate"]],
  },
  functionNode(
    "global_observer_policy_validate", policyGroup,
    "Validar parâmetro e preservar último válido",
    source("global-flow-observer-policy-validate.js"), 2, 780, 760,
    [["global_observer_policy_store"], ["global_observer_policy_reject"]],
  ),
  functionNode(
    "global_observer_policy_store", policyGroup,
    "Publicar política canônica persistente",
    source("global-flow-observer-policy-store.js"), 0, 1110, 720, [],
  ),
  functionNode(
    "global_observer_policy_reject", policyGroup,
    "Rejeitar sem alterar política válida",
    source("global-flow-observer-policy-reject.js"), 0, 1100, 800, [],
  ),
  {
    id: integrationGroup,
    type: "group",
    z: OBSERVER_TAB,
    name: "Integrações do Home Assistant — estado, confirmação e recuperação",
    style: { label: true, color: "#c2410c" },
    nodes: [
      "global_observer_integration_architecture",
      "global_observer_integration_tick",
      "global_observer_integration_test_in",
      "global_observer_integration_entries",
      "global_observer_integration_normalize",
      "global_observer_integration_lifecycle",
      "global_observer_integration_alert_out",
    ],
    x: 2200,
    y: 579,
    w: 1960,
    h: 342,
  },
  {
    id: "global_observer_integration_architecture",
    type: "comment",
    z: OBSERVER_TAB,
    g: integrationGroup,
    name: "HA produz config_entries → Node-RED confirma falha → dedupe persistente → push + alerta no HA",
    info:
      "setup_error, setup_retry, migration_error e failed_unload são falhas. " +
      "loaded encerra o incidente; entradas desativadas são silenciosas. " +
      "Confirmação e lembrete usam os parâmetros visuais do observador.",
    x: 3150,
    y: 620,
    wires: [],
  },
  {
    id: "global_observer_integration_tick",
    type: "inject",
    z: OBSERVER_TAB,
    g: integrationGroup,
    name: "Ler integrações a cada 60 s",
    props: [{ p: "payload" }],
    repeat: "60",
    crontab: "",
    once: true,
    onceDelay: "20",
    topic: "",
    payload: "",
    payloadType: "date",
    x: 2340,
    y: 720,
    wires: [["global_observer_integration_entries"]],
  },
  {
    id: "global_observer_integration_test_in",
    type: "link in",
    z: OBSERVER_TAB,
    g: integrationGroup,
    name: "Receber cenários TESTE",
    links: ["global_observer_integration_test_out"],
    x: 2480,
    y: 820,
    wires: [["global_observer_integration_normalize"]],
  },
  {
    id: "global_observer_integration_entries",
    type: "ha-api",
    z: OBSERVER_TAB,
    g: integrationGroup,
    name: "FONTE: entradas do Home Assistant",
    server: HOME_ASSISTANT_SERVER,
    version: 1,
    debugenabled: false,
    protocol: "websocket",
    method: "get",
    path: "",
    data: '{"type":"config_entries/get"}',
    dataType: "json",
    responseType: "json",
    outputProperties: [
      {
        property: "config_entries",
        propertyType: "msg",
        value: "",
        valueType: "results",
      },
    ],
    x: 2650,
    y: 720,
    wires: [["global_observer_integration_normalize"]],
  },
  functionNode(
    "global_observer_integration_normalize",
    integrationGroup,
    "Sanitizar snapshot de integrações",
    source("global-flow-observer-integration-normalize.js"),
    1,
    2950,
    720,
    [["global_observer_integration_lifecycle"]],
  ),
  functionNode(
    "global_observer_integration_lifecycle",
    integrationGroup,
    "Confirmar, deduplicar e encerrar",
    source("global-flow-observer-integration-lifecycle.js"),
    1,
    3260,
    720,
    [["global_observer_integration_alert_out"]],
  ),
  {
    id: "global_observer_integration_alert_out",
    type: "link out",
    z: OBSERVER_TAB,
    g: integrationGroup,
    name: "Integração falhou/recuperou → entrega",
    mode: "link",
    links: ["global_observer_alert_to_dispatch_in"],
    x: 3580,
    y: 720,
    wires: [],
  },
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
      "global_observer_test_integration_reset",
      "global_observer_test_integration_failure",
      "global_observer_test_integration_confirm",
      "global_observer_test_integration_recovery",
      "global_observer_integration_test_out",
      "global_observer_dry_run_in",
      "global_observer_dry_run_terminal",
    ],
    x: 64,
    y: 379,
    w: 2320,
    h: 322,
  },
  {
    id: "global_observer_test_instructions",
    type: "comment",
    z: OBSERVER_TAB,
    g: testGroup,
    name:
      "TESTE: 1–4 erro/status; 5 push real opcional; 6–9 integração falha, confirma e recupera",
    info:
      "Erro e status atravessam classificação, dedupe e guard até o dry-run. " +
      "Os passos 6–9 usam um snapshot sintético de config_entries. Somente o " +
      "passo 5 chama o Home Assistant; ele é o smoke test explícito do canal.",
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
    id: "global_observer_test_integration_reset",
    type: "inject",
    z: OBSERVER_TAB,
    g: testGroup,
    name: "TESTE 6: reset integrações",
    props: [
      { p: "_global_observer_test", v: "true", vt: "bool" },
      { p: "_global_observer_integration_test", v: "true", vt: "bool" },
      { p: "_global_observer_integration_reset", v: "true", vt: "bool" },
    ],
    repeat: "",
    crontab: "",
    once: false,
    onceDelay: 0.1,
    topic: "",
    x: 1770,
    y: 500,
    wires: [["global_observer_integration_test_out"]],
  },
  {
    id: "global_observer_test_integration_failure",
    type: "inject",
    z: OBSERVER_TAB,
    g: testGroup,
    name: "TESTE 7: integração falhou",
    props: [
      {
        p: "config_entries",
        v: '[{"entry_id":"test_icloud","domain":"icloud","state":"setup_error","disabled_by":null}]',
        vt: "json",
      },
      { p: "_global_observer_test", v: "true", vt: "bool" },
      { p: "observer_now", v: "1000000", vt: "num" },
    ],
    repeat: "",
    crontab: "",
    once: false,
    onceDelay: 0.1,
    topic: "",
    x: 1780,
    y: 560,
    wires: [["global_observer_integration_test_out"]],
  },
  {
    id: "global_observer_test_integration_confirm",
    type: "inject",
    z: OBSERVER_TAB,
    g: testGroup,
    name: "TESTE 8: confirmar após 1 min",
    props: [
      {
        p: "config_entries",
        v: '[{"entry_id":"test_icloud","domain":"icloud","state":"setup_error","disabled_by":null}]',
        vt: "json",
      },
      { p: "_global_observer_test", v: "true", vt: "bool" },
      { p: "observer_now", v: "1061000", vt: "num" },
    ],
    repeat: "",
    crontab: "",
    once: false,
    onceDelay: 0.1,
    topic: "",
    x: 1800,
    y: 620,
    wires: [["global_observer_integration_test_out"]],
  },
  {
    id: "global_observer_test_integration_recovery",
    type: "inject",
    z: OBSERVER_TAB,
    g: testGroup,
    name: "TESTE 9: integração recuperou",
    props: [
      {
        p: "config_entries",
        v: '[{"entry_id":"test_icloud","domain":"icloud","state":"loaded","disabled_by":null}]',
        vt: "json",
      },
      { p: "_global_observer_test", v: "true", vt: "bool" },
      { p: "observer_now", v: "1062000", vt: "num" },
    ],
    repeat: "",
    crontab: "",
    once: false,
    onceDelay: 0.1,
    topic: "",
    x: 1800,
    y: 680,
    wires: [["global_observer_integration_test_out"]],
  },
  {
    id: "global_observer_integration_test_out",
    type: "link out",
    z: OBSERVER_TAB,
    g: testGroup,
    name: "Cenários de integração → monitor real",
    mode: "link",
    links: ["global_observer_integration_test_in"],
    x: 2110,
    y: 590,
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

const productionLayout = new Map([
  ["global_observer_architecture", [1740, 80]],
  ["global_observer_events_in", [120, 220]],
  ["global_observer_ingest", [350, 220]],
  ["global_observer_tick", [220, 460]],
  ["global_observer_test_evaluate_in", [300, 510]],
  ["global_observer_evaluate", [570, 460]],
  ["global_observer_test_delivery_in", [2280, 160]],
  ["global_observer_dispatch_guard", [2530, 240]],
  ["global_observer_dry_run_out", [2760, 360]],
  ["global_observer_notify_primary", [3020, 180]],
  ["global_observer_notify_primary__hub_call", [3300, 180]],
  ["global_observer_notify_primary__hub_result", [3550, 180]],
  ["global_observer_notify_persistent", [3020, 300]],
  ["global_observer_notify_persistent__hub_call", [3300, 300]],
  ["global_observer_notify_persistent__hub_result", [3550, 300]],
  ["global_observer_notification_ack", [3590, 230]],
  ["global_observer_notification_catch", [3200, 400]],
  ["global_observer_notification_failure", [3680, 380]],
  ["global_observer_internal_catch", [2230, 480]],
  ["global_observer_internal_failure", [2520, 480]],
]);
for (const node of observerNodes) {
  const position = productionLayout.get(node.id);
  if (position) [node.x, node.y] = position;
  if (node.id === testGroup || node.g === testGroup) node.y += 580;
}

next.push(...coverageNodes, ...observerNodes);
// Rebuild the generated visual routes after replacing the observer nodes.
// Existing hubs do not imply that their old routes still belong to the newly
// generated groups; keeping them would leave `g` and `group.nodes` divergent.
const finalizedUnordered = refreshNotificationWireRoutes(next);
const finalized = reconcileGeneratedFlows(parsedFlows, finalizedUnordered, {
  isOwned: observerManaged,
  shouldUpdate: (node) => observerManaged(node) || externalEventOutIds.includes(node.id),
});
const residentCoverage = coverageLayoutOverrides.get("resident_notifications_tab");
for (const [suffix, position] of [
  ["__group", residentCoverage.group],
  ["__catch", residentCoverage.catch],
  ["__status", residentCoverage.status],
  ["__annotate", residentCoverage.annotate],
  ["__out", residentCoverage.out],
]) {
  Object.assign(
    finalized.find((node) =>
      node.id === `global_observer_coverage__resident_notifications_tab${suffix}`),
    position,
  );
}
if (process.env.NODE_RED_NOTIFICATION_ROUTE_WIRES !== "0") {
  routeCanvasWires(finalized, finalized.filter((node) => node.type === "tab").map((node) => node.id));
}
fs.writeFileSync(outputPath, `${JSON.stringify(finalized, null, 4)}\n`);
console.log(
  `Global flow observer installed for ${tabs.length} tabs in ${outputPath}`,
);
