#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.resolve(process.argv[2] ?? path.resolve(here, "..", "flows.json"));
const outputPath = path.resolve(process.argv[3] ?? `${sourcePath}.new`);
const flows = JSON.parse(fs.readFileSync(sourcePath, "utf8"));

const TAB = "git_backup_tab";
const GROUP = "git_backup_group";
const ownedIds = new Set([
  TAB,
  GROUP,
  "git_backup_architecture",
  "git_backup_schedule",
  "git_backup_manual",
  "git_backup_request",
  "git_backup_result",
  "git_backup_error",
  "git_backup_complete",
  "git_backup_notify_primary",
  "git_backup_test_instructions",
  "git_backup_test_success",
  "git_backup_test_failure",
  "git_backup_test_result_out",
  "git_backup_test_result_in",
  "git_backup_test_reset",
  "git_backup_test_reset_state",
  "git_backup_dry_run_terminal",
]);

const functionNode = (id, name, func, outputs, x, y, wires) => ({
  id,
  type: "function",
  z: TAB,
  g: GROUP,
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

const recordResult = `const TEST_MODE = msg._git_backup_test === true;
const text = String(msg.payload ?? "").replace(/[\\r\\n]+/g, " ").trim().slice(0, 500);
const status = text.match(/\\bstatus=(success|failed)\\b/)?.[1];
const finishedAt = text.match(/\\bfinished_at=([^ ]+)\\b/)?.[1] ?? null;
if (!status) {
    node.warn("git_backup_result_unrecognized");
    node.status({ fill: "yellow", shape: "ring", text: "resultado não reconhecido" });
    return [null, TEST_MODE ? msg : null];
}
const result = { status, finished_at: finishedAt };
if (TEST_MODE) flow.set("git_backup_last_result_v1__test", result);
else flow.set("git_backup_last_result_v1", result, "persistent");
node.status({
    fill: status === "success" ? "green" : "red",
    shape: status === "success" ? "dot" : "ring",
    text: status === "success" ? "backup concluído" : "backup falhou"
});
node.log("git_backup_completed status=" + status + (finishedAt ? " finished_at=" + finishedAt : ""));
if (TEST_MODE) {
    msg.payload = { ...result, test_mode: true };
    return [null, msg];
}
if (status !== "failed") return [null, null];
msg.alert = {
    title: "Falha no backup Git",
    message: "O backup do sistema não conseguiu concluir o push. A tentativa automática foi encerrada; verifique o fluxo backup_git e o log seguro do host."
};
return [msg, null];`;

const recordError = `const detail = String(msg.payload ?? "erro desconhecido").replace(/[\\r\\n]+/g, " ").slice(0, 240);
node.error("git_backup_request_failed detail=" + detail);
node.status({ fill: "red", shape: "ring", text: "solicitação falhou" });
msg.alert = {
    title: "Falha no backup Git",
    message: "A solicitação de backup não terminou no prazo ou o worker do host ficou indisponível. Verifique o fluxo backup_git e o log seguro do host."
};
return msg;`;

const recordCompletion = `const code = Number(msg.payload?.code ?? msg.payload ?? -1);
if (code === 0) {
    node.status({ fill: "green", shape: "dot", text: "worker finalizado" });
} else {
    node.status({ fill: "red", shape: "ring", text: "worker código " + String(code) });
}
return null;`;

const resetTestState = `flow.set("git_backup_last_result_v1__test", undefined);
flow.set("git_backup_last_dry_run_v1", {
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
    notification_sent: false,
    status: msg.payload?.status ?? "unknown",
    completed_at: Date.now()
};
flow.set("git_backup_last_dry_run_v1", result);
node.status({
    fill: result.status === "failed" ? "yellow" : "green",
    shape: "dot",
    text: "TESTE: " + result.status + "; push e aviso bloqueados"
});
return null;`;

const nodes = [
  {
    id: TAB,
    type: "tab",
    label: "backup_git",
    disabled: false,
    info: "Agenda o backup Git no Node-RED e usa uma ponte de solicitação para o host, sem expor repositório, chave SSH ou socket Docker ao container.",
    env: [],
  },
  {
    id: GROUP,
    type: "group",
    z: TAB,
    name: "Backup Git agendado e execução isolada no host",
    style: { label: true, color: "#4d9a6a" },
    nodes: [
      "git_backup_architecture",
      "git_backup_schedule",
      "git_backup_manual",
      "git_backup_request",
      "git_backup_result",
      "git_backup_error",
      "git_backup_complete",
      "git_backup_notify_primary",
      "git_backup_test_instructions",
      "git_backup_test_success",
      "git_backup_test_failure",
      "git_backup_test_result_out",
      "git_backup_test_result_in",
      "git_backup_test_reset",
      "git_backup_test_reset_state",
      "git_backup_dry_run_terminal",
    ],
    x: 64,
    y: 39,
    w: 1572,
    h: 552,
  },
  {
    id: "git_backup_architecture",
    type: "comment",
    z: TAB,
    g: GROUP,
    name: "00:30 America/Sao_Paulo preserva o instante do cron antigo (03:30 UTC). A ponte no host mantém Git e SSH fora do Node-RED.",
    info: "A revisão documental semanal usa entidades e status próprios e não é alterada por esta aba.",
    x: 640,
    y: 80,
    wires: [],
  },
  {
    id: "git_backup_schedule",
    type: "inject",
    z: TAB,
    g: GROUP,
    name: "Diariamente 00:30 (03:30 UTC)",
    props: [
      { p: "payload" },
      { p: "topic", v: "scheduled", vt: "str" },
    ],
    repeat: "",
    crontab: "30 00 * * *",
    once: false,
    onceDelay: "0.1",
    topic: "scheduled",
    payload: "",
    payloadType: "date",
    x: 240,
    y: 160,
    wires: [["git_backup_request"]],
  },
  {
    id: "git_backup_manual",
    type: "inject",
    z: TAB,
    g: GROUP,
    name: "Executar backup agora",
    props: [
      { p: "payload" },
      { p: "topic", v: "manual", vt: "str" },
    ],
    repeat: "",
    crontab: "",
    once: false,
    onceDelay: "0.1",
    topic: "manual",
    payload: "",
    payloadType: "date",
    x: 220,
    y: 240,
    wires: [["git_backup_request"]],
  },
  {
    id: "git_backup_request",
    type: "exec",
    z: TAB,
    g: GROUP,
    command: "/opt/request-host-git-backup.sh",
    addpay: "",
    append: "",
    useSpawn: "false",
    timer: "240",
    winHide: false,
    oldrc: false,
    name: "Solicitar backup ao host",
    x: 550,
    y: 200,
    wires: [
      ["git_backup_result"],
      ["git_backup_error"],
      ["git_backup_complete"],
    ],
  },
  functionNode("git_backup_result", "Registrar resultado", recordResult, 2, 880, 150, [["git_backup_notify_primary"], ["git_backup_dry_run_terminal"]]),
  functionNode("git_backup_error", "Registrar erro seguro", recordError, 1, 880, 210, [["git_backup_notify_primary"]]),
  functionNode("git_backup_complete", "Registrar código de saída", recordCompletion, 0, 920, 270, []),
  {
    id: "git_backup_notify_primary",
    type: "api-call-service",
    z: TAB,
    g: GROUP,
    name: "Avisar resident_primary",
    server: "4126427d5e161a03",
    version: 7,
    debugenabled: false,
    action: "public_bindings.call",
    floorId: [],
    areaId: [],
    deviceId: [],
    entityId: [],
    labelId: [],
    data: '{"role":"mobile_primary","action":"notify_3","data":{"title":alert.title,"message":alert.message}}',
    dataType: "jsonata",
    mergeContext: "",
    mustacheAltTags: false,
    outputProperties: [],
    queue: "all",
    blockInputOverrides: true,
    domain: "public_bindings",
    service: "call",
    x: 1240,
    y: 180,
    wires: [[]],
  },
  {
    id: "git_backup_test_instructions",
    type: "comment",
    z: TAB,
    g: GROUP,
    name: "TESTE: 1) reset 2) sucesso ou falha 3) confira terminal dry-run; nenhum push ou aviso é enviado",
    info: "Os cenários sintéticos entram no mesmo parser de resultado. A fronteira final bloqueia Git, SSH e a notificação mobile.",
    x: 630,
    y: 350,
    wires: [],
  },
  {
    id: "git_backup_test_reset",
    type: "inject",
    z: TAB,
    g: GROUP,
    name: "TESTE 1: reset",
    props: [{ p: "payload" }],
    repeat: "",
    crontab: "",
    once: false,
    onceDelay: 0.1,
    topic: "",
    payload: "",
    payloadType: "date",
    x: 210,
    y: 410,
    wires: [["git_backup_test_reset_state"]],
  },
  functionNode("git_backup_test_reset_state", "Resetar teste", resetTestState, 0, 480, 410, []),
  {
    id: "git_backup_test_success",
    type: "inject",
    z: TAB,
    g: GROUP,
    name: "TESTE 2A: sucesso",
    props: [
      { p: "payload", v: "git-backup status=success request_id=test finished_at=synthetic", vt: "str" },
      { p: "_git_backup_test", v: "true", vt: "bool" },
    ],
    repeat: "",
    crontab: "",
    once: false,
    onceDelay: 0.1,
    topic: "",
    payload: "",
    payloadType: "date",
    x: 220,
    y: 470,
    wires: [["git_backup_test_result_out"]],
  },
  {
    id: "git_backup_test_failure",
    type: "inject",
    z: TAB,
    g: GROUP,
    name: "TESTE 2B: falha",
    props: [
      { p: "payload", v: "git-backup status=failed request_id=test finished_at=synthetic", vt: "str" },
      { p: "_git_backup_test", v: "true", vt: "bool" },
    ],
    repeat: "",
    crontab: "",
    once: false,
    onceDelay: 0.1,
    topic: "",
    payload: "",
    payloadType: "date",
    x: 220,
    y: 530,
    wires: [["git_backup_test_result_out"]],
  },
  {
    id: "git_backup_test_result_out",
    type: "link out",
    z: TAB,
    g: GROUP,
    name: "Resultado TESTE → parser",
    mode: "link",
    links: ["git_backup_test_result_in"],
    x: 445,
    y: 500,
    wires: [],
  },
  {
    id: "git_backup_test_result_in",
    type: "link in",
    z: TAB,
    g: GROUP,
    name: "Receber resultado TESTE",
    links: ["git_backup_test_result_out"],
    x: 715,
    y: 150,
    wires: [["git_backup_result"]],
  },
  functionNode("git_backup_dry_run_terminal", "TESTE FINAL: push e aviso simulados", dryRunTerminal, 0, 1240, 470, []),
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
console.log(`Installed ${nodes.length} Git backup nodes in ${outputPath}`);
