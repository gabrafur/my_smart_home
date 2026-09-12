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
  "weekly_docs_review_source_switch",
  "weekly_docs_review_set_payload",
  "weekly_docs_review_invalid_source",
  "weekly_docs_review_test_mode_switch",
  "weekly_docs_review_status_watch",
  "weekly_docs_review_track_status",
  "weekly_docs_review_test_request_in",
  "weekly_docs_review_prepare",
  "weekly_docs_review_request",
  "weekly_docs_review_result",
  "weekly_docs_review_result_switch",
  "weekly_docs_review_result_state",
  "weekly_docs_review_invalid_result",
  "weekly_docs_review_error",
  "weekly_docs_review_error_switch",
  "weekly_docs_review_error_test",
  "weekly_docs_review_complete_switch",
  "weekly_docs_review_complete_ok",
  "weekly_docs_review_complete_failed",
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

const invalidSource = `node.status({ fill: "red", shape: "ring", text: "origem inválida" });
node.error("weekly_docs_review_invalid_source", msg);
return null;`;

const recordResult = `const text = String(msg.payload ?? "").replace(/[\\r\\n]+/g, " ").trim().slice(0, 300);
const source = text.match(/source=(manual|scheduled)/)?.[1] ?? "unknown";
const pending = /already pending/.test(text);
const accepted = /Documentation review (?:requested|already pending)/.test(text);
msg.weekly_docs_outcome = accepted ? (pending ? "coalesced" : "requested") : "invalid";
msg.weekly_docs_result = {
    version: 1,
    status: msg.weekly_docs_outcome,
    source,
    requested_at: Date.now()
};
return msg;`;

const recordAcceptedResult = `const result = msg.weekly_docs_result;
flow.set("weekly_docs_review_last_request_v1", result, "persistent");
node.status({ fill: result.status === "coalesced" ? "yellow" : "green", shape: result.status === "coalesced" ? "ring" : "dot", text: result.status === "coalesced" ? "solicitação agrupada" : "worker solicitado" });
node.log("weekly_docs_review_request status=" + result.status + " source=" + result.source);
return null;`;

const invalidResult = `node.status({ fill: "red", shape: "ring", text: "resposta não reconhecida" });
node.error("weekly_docs_review_result_unrecognized", msg);
return null;`;

const recordError = `const detail = String(msg.payload ?? msg.error?.message ?? "erro desconhecido").replace(/[\\r\\n]+/g, " ").slice(0, 240);
node.status({ fill: "red", shape: "ring", text: "solicitação falhou" });
node.error("weekly_docs_review_request_failed detail=" + detail, msg);
return null;`;

const recordCompletionOk = `node.status({ fill: "green", shape: "dot", text: "ponte finalizada" });
return null;`;

const recordCompletionFailed = `node.status({ fill: "red", shape: "ring", text: "ponte código " + String(msg.payload?.code ?? msg.payload ?? -1) });
return null;`;

const trackStatus = `const state = String(msg.payload ?? "indisponível");
const colors = { aguardando: "green", executando: "blue", sucesso: "green", falha: "red", ignorado: "yellow", parado: "grey", indisponível: "red" };
node.status({ fill: colors[state] ?? "grey", shape: state === "falha" || state === "indisponível" ? "ring" : "dot", text: "worker: " + state });
const key = "weekly_docs_review_worker_failure_v1";
if (["falha", "indisponível"].includes(state)) {
    const previous = flow.get(key, "persistent");
    if (previous?.state !== state) {
        flow.set(key, { state, observed_at: Date.now() }, "persistent");
        node.error("weekly_docs_review_worker_failed state=" + state, msg);
    }
} else {
    flow.set(key, undefined, "persistent");
}
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
  "weekly_docs_review_source_switch",
  "weekly_docs_review_set_payload",
  "weekly_docs_review_invalid_source",
  "weekly_docs_review_test_mode_switch",
  "weekly_docs_review_status_watch",
  "weekly_docs_review_track_status",
  "weekly_docs_review_test_request_in",
  "weekly_docs_review_request",
  "weekly_docs_review_result",
  "weekly_docs_review_result_switch",
  "weekly_docs_review_result_state",
  "weekly_docs_review_invalid_result",
  "weekly_docs_review_error",
  "weekly_docs_review_error_switch",
  "weekly_docs_review_error_test",
  "weekly_docs_review_complete",
  "weekly_docs_review_complete_switch",
  "weekly_docs_review_complete_ok",
  "weekly_docs_review_complete_failed",
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
    w: 2420,
    h: 392,
  },
  {
    id: TEST_GROUP,
    type: "group",
    z: TAB,
    name: "2. Testes manuais completos sem Codex, Git ou push",
    style: { label: true, color: "#7d6ba8" },
    nodes: testNodes,
    x: 84,
    y: 439,
    w: 2132,
    h: 252,
  },
  {
    id: "weekly_docs_review_architecture",
    type: "comment",
    z: TAB,
    g: PRODUCTION_GROUP,
    name: "Segunda 03:00 America/Sao_Paulo (06:00 UTC); Node-RED agenda, worker valida/commita/pusha; dashboard preserva status sanitizado",
    info: "O container Node-RED recebe apenas o diretório de gatilho e um helper allowlisted. Checkout, autenticação Codex, chave SSH e socket Docker não são expostos.",
    x: 780,
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
    x: 240,
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
    x: 435,
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
    x: 535,
    y: 120,
    wires: [["weekly_docs_review_source_switch"]],
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
    ignorePrevStateNull: false,
    ignorePrevStateUnknown: false,
    ignorePrevStateUnavailable: false,
    ignoreCurrentStateUnknown: true,
    ignoreCurrentStateUnavailable: true,
    outputProperties: [],
    x: 230,
    y: 230,
    wires: [["weekly_docs_review_mark_manual"]],
  },
  {
    id: "weekly_docs_review_mark_manual",
    type: "change",
    z: TAB,
    g: PRODUCTION_GROUP,
    name: "Origem: solicitação manual",
    rules: [{ t: "set", p: "_weekly_docs_source", pt: "msg", to: "manual", tot: "str" }],
    action: "",
    property: "",
    from: "",
    to: "",
    reg: false,
    x: 490,
    y: 230,
    wires: [["weekly_docs_review_source_switch"]],
  },
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
    x: 250,
    y: 320,
    wires: [["weekly_docs_review_track_status"]],
  },
  functionNode("weekly_docs_review_track_status", PRODUCTION_GROUP, "Exibir lifecycle do worker", trackStatus, 0, 560, 320, []),
  {
    id: "weekly_docs_review_test_request_in",
    type: "link in",
    z: TAB,
    g: PRODUCTION_GROUP,
    name: "Receber solicitação TESTE",
    links: ["weekly_docs_review_test_request_out"],
    x: 535,
    y: 160,
    wires: [["weekly_docs_review_source_switch"]],
  },
  {
    id: "weekly_docs_review_source_switch",
    type: "switch",
    z: TAB,
    g: PRODUCTION_GROUP,
    name: "Origem é manual ou agendada?",
    property: "_weekly_docs_source",
    propertyType: "msg",
    rules: [
      { t: "eq", v: "manual", vt: "str" },
      { t: "eq", v: "scheduled", vt: "str" },
      { t: "else" },
    ],
    checkall: "true",
    repair: false,
    outputs: 3,
    x: 760,
    y: 180,
    wires: [["weekly_docs_review_set_payload"], ["weekly_docs_review_set_payload"], ["weekly_docs_review_invalid_source"]],
  },
  {
    id: "weekly_docs_review_set_payload",
    type: "change",
    z: TAB,
    g: PRODUCTION_GROUP,
    name: "Contrato do helper: payload = origem",
    rules: [{ t: "set", p: "payload", pt: "msg", to: "_weekly_docs_source", tot: "msg" }],
    action: "",
    property: "",
    from: "",
    to: "",
    reg: false,
    x: 1050,
    y: 160,
    wires: [["weekly_docs_review_test_mode_switch"]],
  },
  functionNode("weekly_docs_review_invalid_source", PRODUCTION_GROUP, "Rejeitar origem inválida", invalidSource, 0, 1040, 230, []),
  {
    id: "weekly_docs_review_test_mode_switch",
    type: "switch",
    z: TAB,
    g: PRODUCTION_GROUP,
    name: "Solicitação é TESTE?",
    property: "_weekly_docs_test",
    propertyType: "msg",
    rules: [{ t: "true" }, { t: "else" }],
    checkall: "true",
    repair: false,
    outputs: 2,
    x: 1320,
    y: 160,
    wires: [["weekly_docs_review_dry_run_out"], ["weekly_docs_review_request"]],
  },
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
    x: 1580,
    y: 160,
    wires: [["weekly_docs_review_result"], ["weekly_docs_review_error_switch"], ["weekly_docs_review_complete_switch"]],
  },
  functionNode("weekly_docs_review_result", PRODUCTION_GROUP, "Normalizar resposta textual do helper", recordResult, 1, 1770, 100, [["weekly_docs_review_result_switch"]]),
  {
    id: "weekly_docs_review_result_switch",
    type: "switch",
    z: TAB,
    g: PRODUCTION_GROUP,
    name: "Helper aceitou, agrupou ou rejeitou?",
    property: "weekly_docs_outcome",
    propertyType: "msg",
    rules: [{ t: "eq", v: "requested", vt: "str" }, { t: "eq", v: "coalesced", vt: "str" }, { t: "else" }],
    checkall: "true",
    repair: false,
    outputs: 3,
    x: 2080,
    y: 100,
    wires: [["weekly_docs_review_result_state"], ["weekly_docs_review_result_state"], ["weekly_docs_review_invalid_result"]],
  },
  functionNode("weekly_docs_review_result_state", PRODUCTION_GROUP, "Persistir solicitação aceita", recordAcceptedResult, 0, 2340, 70, []),
  functionNode("weekly_docs_review_invalid_result", PRODUCTION_GROUP, "Rejeitar resposta desconhecida", invalidResult, 0, 2340, 130, []),
  {
    id: "weekly_docs_review_error_switch",
    type: "switch",
    z: TAB,
    g: PRODUCTION_GROUP,
    name: "Falha pertence a TESTE?",
    property: "_weekly_docs_test",
    propertyType: "msg",
    rules: [{ t: "true" }, { t: "else" }],
    checkall: "true",
    repair: false,
    outputs: 2,
    x: 1810,
    y: 190,
    wires: [["weekly_docs_review_error_test"], ["weekly_docs_review_error"]],
  },
  {
    id: "weekly_docs_review_error_test",
    type: "change",
    z: TAB,
    g: PRODUCTION_GROUP,
    name: "Marcar falha sintética",
    rules: [
      { t: "set", p: "payload", pt: "msg", to: '{"status":"failed","detail":"synthetic bridge unavailable","source":"synthetic"}', tot: "json" },
    ],
    action: "",
    property: "",
    from: "",
    to: "",
    reg: false,
    x: 2070,
    y: 180,
    wires: [["weekly_docs_review_error_dry_run_out"]],
  },
  functionNode("weekly_docs_review_error", PRODUCTION_GROUP, "Registrar falha real", recordError, 0, 2070, 230, []),
  {
    id: "weekly_docs_review_complete_switch",
    type: "switch",
    z: TAB,
    g: PRODUCTION_GROUP,
    name: "Código da ponte é zero?",
    property: "$number(payload.code ? payload.code : payload)",
    propertyType: "jsonata",
    rules: [{ t: "eq", v: "0", vt: "num" }, { t: "else" }],
    checkall: "true",
    repair: false,
    outputs: 2,
    x: 1810,
    y: 300,
    wires: [["weekly_docs_review_complete_ok"], ["weekly_docs_review_complete_failed"]],
  },
  functionNode("weekly_docs_review_complete_ok", PRODUCTION_GROUP, "Ponte finalizada", recordCompletionOk, 0, 2070, 280, []),
  functionNode("weekly_docs_review_complete_failed", PRODUCTION_GROUP, "Ponte terminou com falha", recordCompletionFailed, 0, 2070, 340, []),
  {
    id: "weekly_docs_review_dry_run_out",
    type: "link out",
    z: TAB,
    g: PRODUCTION_GROUP,
    name: "TESTE → terminal dry-run",
    mode: "link",
    links: ["weekly_docs_review_dry_run_in"],
    x: 1535,
    y: 230,
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
    x: 2345,
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
    x: 1550,
    y: 360,
    wires: [["weekly_docs_review_error_switch"]],
  },
  {
    id: "weekly_docs_review_test_instructions",
    type: "comment",
    z: TAB,
    g: TEST_GROUP,
    name: "TESTE: 1) reset 2) agendada/manual/falha 3) confira terminal; nenhum Codex, Git, commit, push ou trigger é executado",
    info: "Os cenários usam a mesma normalização e tratamento de erro da produção. O link final desvia antes do helper externo e registra simulated=true/dispatched=false.",
    x: 780,
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
    x: 220,
    y: 540,
    wires: [["weekly_docs_review_test_reset_state"]],
  },
  functionNode("weekly_docs_review_test_reset_state", TEST_GROUP, "Resetar teste", resetTest, 0, 480, 540, []),
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
    x: 230,
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
    x: 220,
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
    x: 505,
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
    x: 780,
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
    x: 1025,
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
    x: 1175,
    y: 560,
    wires: [["weekly_docs_review_dry_run_terminal"]],
  },
  functionNode("weekly_docs_review_dry_run_terminal", TEST_GROUP, "TESTE FINAL: worker bloqueado", dryRunTerminal, 0, 1420, 560, []),
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
