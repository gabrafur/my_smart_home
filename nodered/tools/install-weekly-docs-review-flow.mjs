#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const sourcePath = path.resolve(process.argv[2] ?? new URL("../flows.json", import.meta.url).pathname);
const outputPath = path.resolve(process.argv[3] ?? `${sourcePath}.new`);
const flows = JSON.parse(fs.readFileSync(sourcePath, "utf8"));

const TAB = "weekly_docs_review_tab";
const PRODUCTION_GROUP = "weekly_docs_review_production_group";
const TEST_GROUP = "weekly_docs_review_test_group";
const SERVER = "4126427d5e161a03";
const ownedIds = new Set([
  TAB,
  PRODUCTION_GROUP,
  TEST_GROUP,
  "weekly_docs_review_architecture",
  "weekly_docs_review_schedule",
  "weekly_docs_review_schedule_out",
  "weekly_docs_review_schedule_in",
  "weekly_docs_review_manual",
  "weekly_docs_review_mark_manual",
  "weekly_docs_review_status_watch",
  "weekly_docs_review_track_status",
  "weekly_docs_review_test_request_in",
  "weekly_docs_review_prepare",
  "weekly_docs_review_request",
  "weekly_docs_review_result",
  "weekly_docs_review_error",
  "weekly_docs_review_complete",
  "weekly_docs_review_dry_run_out",
  "weekly_docs_review_error_dry_run_out",
  "weekly_docs_review_test_instructions",
  "weekly_docs_review_test_reset",
  "weekly_docs_review_test_reset_state",
  "weekly_docs_review_test_scheduled",
  "weekly_docs_review_test_manual",
  "weekly_docs_review_test_request_out",
  "weekly_docs_review_test_failure",
  "weekly_docs_review_test_failure_out",
  "weekly_docs_review_test_failure_in",
  "weekly_docs_review_dry_run_in",
  "weekly_docs_review_dry_run_terminal",
]);

const functionNode = (id, group, name, func, outputs, x, y, wires) => ({
  id,
  type: "function",
  z: TAB,
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

const markManual = `msg._weekly_docs_source = "manual";
return msg;`;

const prepareRequest = `const TEST_MODE = msg._weekly_docs_test === true;
const source = String(msg._weekly_docs_source ?? "");
if (source !== "manual" && source !== "scheduled") {
    node.error("weekly_docs_review_invalid_source", msg);
    node.status({ fill: "red", shape: "ring", text: "origem inválida" });
    return null;
}
msg._weekly_docs_test = TEST_MODE;
msg.payload = source;
node.status({
    fill: TEST_MODE ? "blue" : "green",
    shape: "dot",
    text: TEST_MODE ? "TESTE preparado: " + source : "solicitando: " + source
});
return TEST_MODE ? [null, msg] : [msg, null];`;

const recordResult = `const text = String(msg.payload ?? "").replace(/[\\r\\n]+/g, " ").trim().slice(0, 300);
const source = text.match(/source=(manual|scheduled)/)?.[1] ?? "unknown";
const pending = /already pending/.test(text);
const accepted = /Documentation review (?:requested|already pending)/.test(text);
if (!accepted) {
    node.error("weekly_docs_review_result_unrecognized", msg);
    node.status({ fill: "red", shape: "ring", text: "resposta não reconhecida" });
    return null;
}
const result = {
    version: 1,
    status: pending ? "coalesced" : "requested",
    source,
    requested_at: Date.now()
};
flow.set("weekly_docs_review_last_request_v1", result, "persistent");
node.status({
    fill: pending ? "yellow" : "green",
    shape: pending ? "ring" : "dot",
    text: pending ? "solicitação agrupada" : "worker solicitado"
});
node.log("weekly_docs_review_request status=" + result.status + " source=" + source);
return null;`;

const recordError = `const TEST_MODE = msg._weekly_docs_test === true;
const detail = String(msg.payload ?? msg.error?.message ?? "erro desconhecido").replace(/[\\r\\n]+/g, " ").slice(0, 240);
node.status({ fill: TEST_MODE ? "yellow" : "red", shape: "ring", text: TEST_MODE ? "TESTE: falha simulada" : "solicitação falhou" });
if (TEST_MODE) {
    msg.payload = { status: "failed", detail, source: "synthetic" };
    return msg;
}
node.error("weekly_docs_review_request_failed detail=" + detail, msg);
return null;`;

const recordCompletion = `const code = Number(msg.payload?.code ?? msg.payload ?? -1);
if (code === 0) node.status({ fill: "green", shape: "dot", text: "ponte finalizada" });
else node.status({ fill: "red", shape: "ring", text: "ponte código " + String(code) });
return null;`;

const trackStatus = `const state = String(msg.payload ?? "indisponível");
const colors = { aguardando: "green", executando: "blue", sucesso: "green", falha: "red", ignorado: "yellow", parado: "grey", indisponível: "red" };
node.status({ fill: colors[state] ?? "grey", shape: state === "falha" || state === "indisponível" ? "ring" : "dot", text: "worker: " + state });
return null;`;

const resetTest = `flow.set("weekly_docs_review_last_dry_run_v1", {
    version: 1,
    reset: true,
    simulated: true,
    dispatched: false,
    completed_at: Date.now()
});
node.status({ fill: "grey", shape: "ring", text: "estado de teste resetado" });
return null;`;

const dryRunTerminal = `const result = {
    version: 1,
    simulated: true,
    dispatched: false,
    external_call_sent: false,
    worker_started: false,
    source: msg._weekly_docs_source ?? msg.payload?.source ?? "unknown",
    status: msg.payload?.status ?? "request_simulated",
    completed_at: Date.now()
};
flow.set("weekly_docs_review_last_dry_run_v1", result);
node.status({ fill: result.status === "failed" ? "yellow" : "green", shape: "dot", text: "TESTE: " + result.status + "; worker bloqueado" });
return null;`;

const productionNodes = [
  "weekly_docs_review_architecture",
  "weekly_docs_review_schedule",
  "weekly_docs_review_schedule_out",
  "weekly_docs_review_schedule_in",
  "weekly_docs_review_manual",
  "weekly_docs_review_mark_manual",
  "weekly_docs_review_status_watch",
  "weekly_docs_review_track_status",
  "weekly_docs_review_test_request_in",
  "weekly_docs_review_prepare",
  "weekly_docs_review_request",
  "weekly_docs_review_result",
  "weekly_docs_review_error",
  "weekly_docs_review_complete",
  "weekly_docs_review_dry_run_out",
  "weekly_docs_review_error_dry_run_out",
  "weekly_docs_review_test_failure_in",
];
const testNodes = [
  "weekly_docs_review_test_instructions",
  "weekly_docs_review_test_reset",
  "weekly_docs_review_test_reset_state",
  "weekly_docs_review_test_scheduled",
  "weekly_docs_review_test_manual",
  "weekly_docs_review_test_request_out",
  "weekly_docs_review_test_failure",
  "weekly_docs_review_test_failure_out",
  "weekly_docs_review_dry_run_in",
  "weekly_docs_review_dry_run_terminal",
];

const nodes = [
  {
    id: TAB,
    type: "tab",
    label: "revisao_documental_semanal",
    disabled: false,
    info: "Node-RED é a fonte única do agendamento e do acionamento manual. O worker isolado conserva Git, Codex, validação e credenciais fora deste container.",
    env: [],
  },
  {
    id: PRODUCTION_GROUP,
    type: "group",
    z: TAB,
    name: "1. Agendamento, painel e ponte para o worker isolado",
    style: { label: true, color: "#4d9a6a" },
    nodes: productionNodes,
    x: 64,
    y: 39,
    w: 1532,
    h: 342,
  },
  {
    id: TEST_GROUP,
    type: "group",
    z: TAB,
    name: "2. Testes manuais completos sem Codex, Git ou push",
    style: { label: true, color: "#7d6ba8" },
    nodes: testNodes,
    x: 64,
    y: 439,
    w: 1532,
    h: 252,
  },
  {
    id: "weekly_docs_review_architecture",
    type: "comment",
    z: TAB,
    g: PRODUCTION_GROUP,
    name: "Segunda 03:00 America/Sao_Paulo (06:00 UTC); Node-RED agenda, worker valida/commita/pusha; dashboard preserva status sanitizado",
    info: "O container Node-RED recebe apenas o diretório de gatilho e um helper allowlisted. Checkout, autenticação Codex, chave SSH e socket Docker não são expostos.",
    x: 760,
    y: 80,
    wires: [],
  },
  {
    id: "weekly_docs_review_schedule",
    type: "inject",
    z: TAB,
    g: PRODUCTION_GROUP,
    name: "Segunda 03:00 (06:00 UTC)",
    props: [
      { p: "payload" },
      { p: "_weekly_docs_source", v: "scheduled", vt: "str" },
    ],
    repeat: "",
    crontab: "00 03 * * 1",
    once: false,
    onceDelay: "0.1",
    topic: "",
    payload: "",
    payloadType: "date",
    x: 220,
    y: 160,
    wires: [["weekly_docs_review_schedule_out"]],
  },
  {
    id: "weekly_docs_review_schedule_out",
    type: "link out",
    z: TAB,
    g: PRODUCTION_GROUP,
    name: "Agendamento → normalização",
    mode: "link",
    links: ["weekly_docs_review_schedule_in"],
    x: 415,
    y: 140,
    wires: [],
  },
  {
    id: "weekly_docs_review_schedule_in",
    type: "link in",
    z: TAB,
    g: PRODUCTION_GROUP,
    name: "Receber agendamento",
    links: ["weekly_docs_review_schedule_out"],
    x: 515,
    y: 120,
    wires: [["weekly_docs_review_prepare"]],
  },
  {
    id: "weekly_docs_review_manual",
    type: "server-state-changed",
    z: TAB,
    g: PRODUCTION_GROUP,
    name: "Rodar pelo painel HA",
    server: SERVER,
    version: 6,
    outputs: 1,
    exposeAsEntityConfig: "",
    entities: { entity: ["input_button.weekly_documentation_review_run"], substring: [], regex: [] },
    outputInitially: false,
    stateType: "str",
    ifState: "",
    ifStateType: "str",
    ifStateOperator: "is",
    outputOnlyOnStateChange: true,
    for: "0",
    forType: "num",
    forUnits: "minutes",
    ignorePrevStateNull: true,
    ignorePrevStateUnknown: true,
    ignorePrevStateUnavailable: true,
    ignoreCurrentStateUnknown: true,
    ignoreCurrentStateUnavailable: true,
    outputProperties: [],
    x: 210,
    y: 230,
    wires: [["weekly_docs_review_mark_manual"]],
  },
  functionNode("weekly_docs_review_mark_manual", PRODUCTION_GROUP, "Marcar origem manual", markManual, 1, 470, 230, [["weekly_docs_review_prepare"]]),
  {
    id: "weekly_docs_review_status_watch",
    type: "server-state-changed",
    z: TAB,
    g: PRODUCTION_GROUP,
    name: "Acompanhar status do worker",
    server: SERVER,
    version: 6,
    outputs: 1,
    exposeAsEntityConfig: "",
    entities: { entity: ["sensor.revisao_semanal_da_documentacao"], substring: [], regex: [] },
    outputInitially: true,
    stateType: "str",
    ifState: "",
    ifStateType: "str",
    ifStateOperator: "is",
    outputOnlyOnStateChange: true,
    for: "0",
    forType: "num",
    forUnits: "minutes",
    ignorePrevStateNull: false,
    ignorePrevStateUnknown: false,
    ignorePrevStateUnavailable: false,
    ignoreCurrentStateUnknown: false,
    ignoreCurrentStateUnavailable: false,
    outputProperties: [{ property: "payload", propertyType: "msg", value: "", valueType: "entityState" }],
    x: 230,
    y: 320,
    wires: [["weekly_docs_review_track_status"]],
  },
  functionNode("weekly_docs_review_track_status", PRODUCTION_GROUP, "Exibir lifecycle do worker", trackStatus, 0, 540, 320, []),
  {
    id: "weekly_docs_review_test_request_in",
    type: "link in",
    z: TAB,
    g: PRODUCTION_GROUP,
    name: "Receber solicitação TESTE",
    links: ["weekly_docs_review_test_request_out"],
    x: 515,
    y: 160,
    wires: [["weekly_docs_review_prepare"]],
  },
  functionNode("weekly_docs_review_prepare", PRODUCTION_GROUP, "Validar origem e separar TESTE", prepareRequest, 2, 750, 190, [["weekly_docs_review_request"], ["weekly_docs_review_dry_run_out"]]),
  {
    id: "weekly_docs_review_request",
    type: "exec",
    z: TAB,
    g: PRODUCTION_GROUP,
    command: "/opt/request-weekly-docs-review.sh",
    addpay: "payload",
    append: "",
    useSpawn: "false",
    timer: "15",
    winHide: false,
    oldrc: false,
    name: "Solicitar worker isolado",
    x: 1020,
    y: 160,
    wires: [["weekly_docs_review_result"], ["weekly_docs_review_error"], ["weekly_docs_review_complete"]],
  },
  functionNode("weekly_docs_review_result", PRODUCTION_GROUP, "Registrar solicitação aceita", recordResult, 0, 1330, 120, []),
  functionNode("weekly_docs_review_error", PRODUCTION_GROUP, "Registrar falha segura", recordError, 1, 1310, 180, [["weekly_docs_review_error_dry_run_out"]]),
  functionNode("weekly_docs_review_complete", PRODUCTION_GROUP, "Registrar código da ponte", recordCompletion, 0, 1310, 240, []),
  {
    id: "weekly_docs_review_dry_run_out",
    type: "link out",
    z: TAB,
    g: PRODUCTION_GROUP,
    name: "TESTE → terminal dry-run",
    mode: "link",
    links: ["weekly_docs_review_dry_run_in"],
    x: 1025,
    y: 250,
    wires: [],
  },
  {
    id: "weekly_docs_review_error_dry_run_out",
    type: "link out",
    z: TAB,
    g: PRODUCTION_GROUP,
    name: "Falha TESTE → terminal dry-run",
    mode: "link",
    links: ["weekly_docs_review_dry_run_in"],
    x: 1515,
    y: 180,
    wires: [],
  },
  {
    id: "weekly_docs_review_test_failure_in",
    type: "link in",
    z: TAB,
    g: PRODUCTION_GROUP,
    name: "Receber falha TESTE",
    links: ["weekly_docs_review_test_failure_out"],
    x: 1075,
    y: 310,
    wires: [["weekly_docs_review_error"]],
  },
  {
    id: "weekly_docs_review_test_instructions",
    type: "comment",
    z: TAB,
    g: TEST_GROUP,
    name: "TESTE: 1) reset 2) agendada/manual/falha 3) confira terminal; nenhum Codex, Git, commit, push ou trigger é executado",
    info: "Os cenários usam a mesma normalização e tratamento de erro da produção. O link final desvia antes do helper externo e registra simulated=true/dispatched=false.",
    x: 760,
    y: 480,
    wires: [],
  },
  {
    id: "weekly_docs_review_test_reset",
    type: "inject",
    z: TAB,
    g: TEST_GROUP,
    name: "TESTE 1: reset",
    props: [{ p: "payload" }],
    repeat: "",
    crontab: "",
    once: false,
    onceDelay: 0.1,
    topic: "",
    payload: "",
    payloadType: "date",
    x: 200,
    y: 540,
    wires: [["weekly_docs_review_test_reset_state"]],
  },
  functionNode("weekly_docs_review_test_reset_state", TEST_GROUP, "Resetar teste", resetTest, 0, 460, 540, []),
  {
    id: "weekly_docs_review_test_scheduled",
    type: "inject",
    z: TAB,
    g: TEST_GROUP,
    name: "TESTE 2A: agendada",
    props: [
      { p: "_weekly_docs_source", v: "scheduled", vt: "str" },
      { p: "_weekly_docs_test", v: "true", vt: "bool" },
    ],
    repeat: "",
    crontab: "",
    once: false,
    onceDelay: 0.1,
    topic: "",
    payload: "",
    payloadType: "date",
    x: 210,
    y: 600,
    wires: [["weekly_docs_review_test_request_out"]],
  },
  {
    id: "weekly_docs_review_test_manual",
    type: "inject",
    z: TAB,
    g: TEST_GROUP,
    name: "TESTE 2B: manual",
    props: [
      { p: "_weekly_docs_source", v: "manual", vt: "str" },
      { p: "_weekly_docs_test", v: "true", vt: "bool" },
    ],
    repeat: "",
    crontab: "",
    once: false,
    onceDelay: 0.1,
    topic: "",
    payload: "",
    payloadType: "date",
    x: 200,
    y: 650,
    wires: [["weekly_docs_review_test_request_out"]],
  },
  {
    id: "weekly_docs_review_test_request_out",
    type: "link out",
    z: TAB,
    g: TEST_GROUP,
    name: "Solicitação TESTE → normalização",
    mode: "link",
    links: ["weekly_docs_review_test_request_in"],
    x: 485,
    y: 625,
    wires: [],
  },
  {
    id: "weekly_docs_review_test_failure",
    type: "inject",
    z: TAB,
    g: TEST_GROUP,
    name: "TESTE 2C: falha da ponte",
    props: [
      { p: "payload", v: "synthetic bridge unavailable", vt: "str" },
      { p: "_weekly_docs_test", v: "true", vt: "bool" },
      { p: "_weekly_docs_source", v: "manual", vt: "str" },
    ],
    repeat: "",
    crontab: "",
    once: false,
    onceDelay: 0.1,
    topic: "",
    payload: "",
    payloadType: "date",
    x: 760,
    y: 620,
    wires: [["weekly_docs_review_test_failure_out"]],
  },
  {
    id: "weekly_docs_review_test_failure_out",
    type: "link out",
    z: TAB,
    g: TEST_GROUP,
    name: "Falha TESTE → handler",
    mode: "link",
    links: ["weekly_docs_review_test_failure_in"],
    x: 1005,
    y: 620,
    wires: [],
  },
  {
    id: "weekly_docs_review_dry_run_in",
    type: "link in",
    z: TAB,
    g: TEST_GROUP,
    name: "Receber terminal TESTE",
    links: ["weekly_docs_review_dry_run_out", "weekly_docs_review_error_dry_run_out"],
    x: 1155,
    y: 560,
    wires: [["weekly_docs_review_dry_run_terminal"]],
  },
  functionNode("weekly_docs_review_dry_run_terminal", TEST_GROUP, "TESTE FINAL: worker bloqueado", dryRunTerminal, 0, 1400, 560, []),
];

const replacements = new Map(nodes.map((node) => [node.id, node]));
const installed = new Set();
const updated = [];
let lastOwnedIndex = -1;
for (const node of flows) {
  if (!ownedIds.has(node.id)) {
    updated.push(node);
    continue;
  }
  const replacement = replacements.get(node.id);
  if (replacement) {
    updated.push(replacement);
    installed.add(node.id);
    lastOwnedIndex = updated.length - 1;
  }
}
const missing = nodes.filter((node) => !installed.has(node.id));
updated.splice(lastOwnedIndex + 1, 0, ...missing);
fs.writeFileSync(outputPath, `${JSON.stringify(updated, null, 4)}\n`);
console.log(`Installed ${nodes.length} weekly documentation review nodes in ${outputPath}`);
