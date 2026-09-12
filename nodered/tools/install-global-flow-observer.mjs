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
    node.links = node.links.filter((id) =>
      !owned(id) ||
      (node.id === "local_ai_rtx_alert_out" && id === "global_observer_events_in"),
    );
  }
}

const tabs = next.filter((node) => node.type === "tab" && node.id !== OBSERVER_TAB);
const coverageOutIds = [];
const externalEventOutIds = ["local_ai_rtx_alert_out"];
const coverageNodes = [];
const coverageLayoutOverrides = new Map([
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
  const tabNodes = next.filter((node) => node.z === tab.id);
  const rightEdge = Math.max(
    0,
    ...tabNodes.map((node) =>
      node.type === "group"
        ? Number(node.x ?? 0) + Number(node.w ?? 0)
        : Number(node.x ?? 0) + 140,
    ),
  );
  const layoutOverride = coverageLayoutOverrides.get(tab.id);
  const groupX = layoutOverride?.group?.x ?? Math.ceil((rightEdge + 40) / 20) * 20;
  const groupY = layoutOverride?.group?.y ?? 40;
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
      "global_observer_evaluate_duration_gate",
      "global_observer_evaluate_clear_transient",
      "global_observer_evaluate_confirm",
      "global_observer_evaluate_notification_gate",
      "global_observer_evaluate_alert",
      "global_observer_alert_to_dispatch_out",
      "global_observer_alert_to_dispatch_in",
      "global_observer_dispatch_guard",
      "global_observer_dry_run_out",
      "global_observer_notify_primary",
      "global_observer_notify_persistent",
      "global_observer_notification_ack",
      "global_observer_notification_catch",
      "global_observer_notification_failure",
      "global_observer_internal_catch",
      "global_observer_internal_failure",
    ],
    x: 64,
    y: 39,
    w: 3650,
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
    links: [...coverageOutIds.sort(), ...externalEventOutIds, "global_observer_test_event_out"],
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
    0, 1090, 520, [],
  ),
  switchNode(
    "global_observer_evaluate_duration_gate", productionGroup,
    "Tempo de confirmação atingido?", "_observer_evaluation.duration_met",
    [{ t: "true" }, { t: "else" }], 1090, 440,
    [["global_observer_evaluate_confirm"], ["global_observer_evaluate_clear_transient"]],
  ),
  functionNode(
    "global_observer_evaluate_clear_transient", productionGroup,
    "Limpar incidente ainda transitório", source("global-flow-observer-evaluate-clear.js"),
    0, 1400, 520, [],
  ),
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
    links: ["global_observer_alert_to_dispatch_in"], x: 2070, y: 320, wires: [],
  },
  {
    id: "global_observer_alert_to_dispatch_in", type: "link in", z: OBSERVER_TAB,
    g: productionGroup, name: "Receber alertas confirmados", links: ["global_observer_alert_to_dispatch_out"],
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
    y: 140,
    wires: [["global_observer_notification_ack"]],
    outputProperties: [
      {
        property: "_observer_notification_channel",
        propertyType: "msg",
        value: "mobile_primary",
        valueType: "str",
      },
    ],
  },
  {
    id: "global_observer_notify_persistent",
    type: "api-call-service",
    z: OBSERVER_TAB,
    g: productionGroup,
    name: "Notificação persistente no Home Assistant",
    server: SERVER,
    version: 7,
    debugenabled: false,
    action: "persistent_notification.create",
    floorId: [],
    areaId: [],
    deviceId: [],
    entityId: [],
    labelId: [],
    data:
      '{"title":alert.title,"message":alert.message,"notification_id":_observer_persistent_notification_id}',
    dataType: "jsonata",
    mergeContext: "",
    mustacheAltTags: false,
    outputProperties: [
      {
        property: "_observer_notification_channel",
        propertyType: "msg",
        value: "persistent_notification",
        valueType: "str",
      },
    ],
    queue: "all",
    blockInputOverrides: true,
    domain: "persistent_notification",
    service: "create",
    x: 1140,
    y: 200,
    wires: [["global_observer_notification_ack"]],
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
      "global_observer_notify_primary",
      "global_observer_notify_persistent",
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
  ["global_observer_notify_primary", [2880, 200]],
  ["global_observer_notify_persistent", [2920, 260]],
  ["global_observer_notification_ack", [3330, 220]],
  ["global_observer_notification_catch", [3050, 400]],
  ["global_observer_notification_failure", [3350, 400]],
  ["global_observer_internal_catch", [2230, 480]],
  ["global_observer_internal_failure", [2520, 480]],
]);
for (const node of observerNodes) {
  const position = productionLayout.get(node.id);
  if (position) [node.x, node.y] = position;
  if (node.id === testGroup || node.g === testGroup) node.y += 580;
}

next.push(...coverageNodes, ...observerNodes);
fs.writeFileSync(outputPath, `${JSON.stringify(next, null, 4)}\n`);
console.log(
  `Global flow observer installed for ${tabs.length} tabs in ${outputPath}`,
);
