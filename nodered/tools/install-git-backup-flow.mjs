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

const recordResult = `const text = String(msg.payload ?? "").replace(/[\\r\\n]+/g, " ").trim().slice(0, 500);
const status = text.match(/\\bstatus=(success|failed)\\b/)?.[1];
const finishedAt = text.match(/\\bfinished_at=([^ ]+)\\b/)?.[1] ?? null;
if (!status) {
    node.warn("git_backup_result_unrecognized");
    node.status({ fill: "yellow", shape: "ring", text: "resultado não reconhecido" });
    return null;
}
flow.set("git_backup_last_result_v1", { status, finished_at: finishedAt }, "persistent");
node.status({
    fill: status === "success" ? "green" : "red",
    shape: status === "success" ? "dot" : "ring",
    text: status === "success" ? "backup concluído" : "backup falhou"
});
node.log("git_backup_completed status=" + status + (finishedAt ? " finished_at=" + finishedAt : ""));
return null;`;

const recordError = `const detail = String(msg.payload ?? "erro desconhecido").replace(/[\\r\\n]+/g, " ").slice(0, 240);
node.error("git_backup_request_failed detail=" + detail);
node.status({ fill: "red", shape: "ring", text: "solicitação falhou" });
return null;`;

const recordCompletion = `const code = Number(msg.payload?.code ?? msg.payload ?? -1);
if (code === 0) {
    node.status({ fill: "green", shape: "dot", text: "worker finalizado" });
} else {
    node.status({ fill: "red", shape: "ring", text: "worker código " + String(code) });
}
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
    ],
    x: 34,
    y: 39,
    w: 1272,
    h: 262,
  },
  {
    id: "git_backup_architecture",
    type: "comment",
    z: TAB,
    g: GROUP,
    name: "00:30 America/Sao_Paulo preserva o instante do cron antigo (03:30 UTC). A ponte no host mantém Git e SSH fora do Node-RED.",
    info: "A revisão documental semanal usa entidades e status próprios e não é alterada por esta aba.",
    x: 610,
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
    x: 210,
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
    x: 190,
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
    x: 520,
    y: 200,
    wires: [
      ["git_backup_result"],
      ["git_backup_error"],
      ["git_backup_complete"],
    ],
  },
  functionNode("git_backup_result", "Registrar resultado", recordResult, 0, 890, 150, []),
  functionNode("git_backup_error", "Registrar erro seguro", recordError, 0, 890, 210, []),
  functionNode("git_backup_complete", "Registrar código de saída", recordCompletion, 0, 890, 270, []),
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
