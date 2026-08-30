#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.resolve(process.argv[2] ?? path.resolve(here, "..", "flows.json"));
const outputPath = path.resolve(process.argv[3] ?? sourcePath);
const flows = JSON.parse(fs.readFileSync(sourcePath, "utf8"));

const TAB = "daily_host_updates_tab";
const owned = (id) => id === TAB || id.startsWith("daily_update_");
const functionNode = (id, group, name, func, outputs, x, y, wires) => ({
  id, type: "function", z: TAB, g: group, name, func, outputs,
  timeout: 0, noerr: 0, initialize: "", finalize: "", libs: [], x, y, wires,
});

const prepareRequest = `const TEST_MODE = msg._daily_update_test === true || msg.payload?.test_mode === true;
const event = msg.payload?.event ?? "git_backup_completed";
if (!TEST_MODE && (event !== "git_backup_completed" || msg.payload?.status !== "success")) {
    node.warn("daily_update_ignored_without_successful_backup");
    return null;
}
msg._daily_update_test = TEST_MODE;
msg.payload = {
    version: 1,
    event: "daily_update_requested",
    source: TEST_MODE ? "manual_test" : "git_backup",
    backup_finished_at: msg.payload?.finished_at ?? null,
    test_mode: TEST_MODE
};
node.status({ fill: TEST_MODE ? "blue" : "green", shape: "dot", text: TEST_MODE ? "TESTE preparado" : "backup concluído; solicitando" });
return msg;`;

const recordRequest = `const text = String(msg.payload ?? "").replace(/[\\r\\n]+/g, " ").trim().slice(0, 400);
const status = text.match(/\\bstatus=(accepted|coalesced)\\b/)?.[1];
if (!status) {
    node.error("daily_update_request_unrecognized");
    node.status({ fill: "red", shape: "ring", text: "resposta inválida" });
    return null;
}
node.status({ fill: status === "accepted" ? "green" : "yellow", shape: "dot", text: status === "accepted" ? "solicitação aceita" : "solicitação coalescida" });
return null;`;

const recordExecError = `const detail = String(msg.payload ?? "indisponível").replace(/[\\r\\n]+/g, " ").slice(0, 240);
node.status({ fill: "red", shape: "ring", text: "ponte indisponível" });
node.error("daily_update_bridge_unavailable detail=" + detail);
return null;`;

const recordCompletion = `const code = Number(msg.payload?.code ?? msg.payload ?? -1);
if (code !== 0) node.status({ fill: "red", shape: "ring", text: "ponte código " + String(code) });
return null;`;

const parseResult = `const TEST_MODE = msg._daily_update_test === true || msg.payload?.test_mode === true;
const text = String(msg.payload ?? "").replace(/[\\r\\n]+/g, " ").trim().slice(0, 600);
if (!text) return null;
const status = text.match(/\\bstatus=(running|success|failed|deferred|unavailable)\\b/)?.[1];
const requestId = text.match(/\\brequest_id=([^ ]+)\\b/)?.[1] ?? "unknown";
const dietpiExit = Number(text.match(/\\bdietpi_exit=(\\d+)\\b/)?.[1] ?? NaN);
const dietpiStage = text.match(/\\bdietpi_stage=([A-Za-z0-9_.-]+)\\b/)?.[1] ?? null;
const containersExit = Number(text.match(/\\bcontainers_exit=(\\d+)\\b/)?.[1] ?? NaN);
if (!status) {
    if (!TEST_MODE) node.error("daily_update_result_unrecognized");
    return null;
}
const signature = requestId + ":" + status;
const key = TEST_MODE ? "daily_update_last_result_v1__test" : "daily_update_last_result_v1";
const previous = TEST_MODE ? flow.get(key) : flow.get(key, "persistent");
if (!TEST_MODE && previous?.signature === signature) return null;
const result = {
    version: 1, signature, request_id: requestId, status,
    dietpi_exit: Number.isFinite(dietpiExit) ? dietpiExit : null,
    dietpi_stage: dietpiStage,
    containers_exit: Number.isFinite(containersExit) ? containersExit : null,
    test_mode: TEST_MODE,
    observed_at: Date.now()
};
if (TEST_MODE) flow.set(key, result);
else flow.set(key, result, "persistent");
const failed = ["failed", "unavailable"].includes(status);
node.status({
    fill: failed ? "red" : status === "success" ? "green" : "yellow",
    shape: failed ? "ring" : "dot",
    text: status === "success" ? "DietPi e containers atualizados" : status
});
if (TEST_MODE) {
    msg.payload = result;
    return msg;
}
if (failed) {
    node.error("daily_update_failed request_id=" + requestId + " dietpi_stage=" + String(result.dietpi_stage) + " dietpi_exit=" + String(result.dietpi_exit) + " containers_exit=" + String(result.containers_exit));
}
return null;`;

const resetTest = `flow.set("daily_update_last_result_v1__test", undefined);
flow.set("daily_update_last_dry_run_v1", {
    version: 1, reset: true, simulated: true, dispatched: false,
    completed_at: Date.now()
});
node.status({ fill: "grey", shape: "ring", text: "estado de teste resetado" });
return null;`;

const dryRunTerminal = `const result = {
    version: 1,
    simulated: true,
    dispatched: false,
    host_request_sent: false,
    apt_commands_sent: false,
    docker_update_sent: false,
    status: msg.payload?.status ?? msg.payload?.event ?? "request_prepared",
    completed_at: Date.now()
};
flow.set("daily_update_last_dry_run_v1", result);
node.status({ fill: "blue", shape: "dot", text: "TESTE: " + result.status + "; host bloqueado" });
return null;`;

const productionGroup = "daily_update_production_group";
const resultGroup = "daily_update_result_group";
const testGroup = "daily_update_test_group";
const nodes = [
  {
    id: TAB, type: "tab", label: "atualizacoes_diarias", disabled: false,
    info: "Depois do backup Git diário concluído, solicita ao host a atualização serial do DietPi e dos provedores de imagens dos containers. O Node-RED não recebe sudo nem socket Docker.",
    env: [],
  },
  {
    id: productionGroup, type: "group", z: TAB,
    name: "1. Depois do backup: solicitar atualização isolada no host",
    style: { label: true, color: "#4d9a6a" },
    nodes: [
      "daily_update_architecture", "daily_update_after_backup_in", "daily_update_test_request_in",
      "daily_update_prepare_request", "daily_update_route_test", "daily_update_request_host",
      "daily_update_request_ack", "daily_update_request_error", "daily_update_request_complete",
      "daily_update_request_test_out",
    ],
    x: 64, y: 39, w: 1252, h: 302,
  },
  {
    id: "daily_update_architecture", type: "comment", z: TAB, g: productionGroup,
    name: "Executa somente após sucesso do backup diário; DietPi primeiro, containers depois; sem reboot automático",
    info: "A ponte coalesce solicitações. O helper root-owned limita sudo ao apt-get update/upgrade e o worker atual preserva o isolamento do Docker.",
    x: 650, y: 80, wires: [],
  },
  {
    id: "daily_update_after_backup_in", type: "link in", z: TAB, g: productionGroup,
    name: "Receber backup diário concluído", links: ["git_backup_daily_update_out"],
    x: 145, y: 160, wires: [["daily_update_prepare_request"]],
  },
  {
    id: "daily_update_test_request_in", type: "link in", z: TAB, g: productionGroup,
    name: "Receber solicitação TESTE", links: ["daily_update_test_request_out"],
    x: 145, y: 220, wires: [["daily_update_prepare_request"]],
  },
  functionNode("daily_update_prepare_request", productionGroup, "Validar backup e preparar ciclo", prepareRequest, 1, 410, 190, [["daily_update_route_test"]]),
  {
    id: "daily_update_route_test", type: "switch", z: TAB, g: productionGroup,
    name: "Produção ou TESTE?", property: "_daily_update_test", propertyType: "msg",
    rules: [{ t: "true" }, { t: "else" }], checkall: "true", repair: false, outputs: 2,
    x: 660, y: 190, wires: [["daily_update_request_test_out"], ["daily_update_request_host"]],
  },
  {
    id: "daily_update_request_host", type: "exec", z: TAB, g: productionGroup,
    command: "/opt/request-host-daily-update.sh", addpay: "", append: "", useSpawn: "false",
    timer: "30", winHide: false, oldrc: false, name: "Solicitar ciclo ao host",
    x: 920, y: 160,
    wires: [["daily_update_request_ack"], ["daily_update_request_error"], ["daily_update_request_complete"]],
  },
  functionNode("daily_update_request_ack", productionGroup, "Registrar solicitação", recordRequest, 0, 1180, 120, []),
  functionNode("daily_update_request_error", productionGroup, "Falha segura da ponte", recordExecError, 0, 1180, 180, []),
  functionNode("daily_update_request_complete", productionGroup, "Registrar código da ponte", recordCompletion, 0, 1180, 240, []),
  {
    id: "daily_update_request_test_out", type: "link out", z: TAB, g: productionGroup,
    name: "Solicitação TESTE → dry-run", mode: "link", links: ["daily_update_dry_run_in"],
    x: 905, y: 240, wires: [],
  },
  {
    id: resultGroup, type: "group", z: TAB,
    name: "2. Acompanhar resultado do worker do host",
    style: { label: true, color: "#3f7cb5" },
    nodes: [
      "daily_update_result_startup", "daily_update_result_poll", "daily_update_read_result",
      "daily_update_read_error", "daily_update_read_complete", "daily_update_test_result_in",
      "daily_update_parse_result", "daily_update_result_test_out",
    ],
    x: 64, y: 379, w: 1252, h: 242,
  },
  {
    id: "daily_update_result_startup", type: "inject", z: TAB, g: resultGroup,
    name: "Ler resultado ao subir", props: [{ p: "payload" }], repeat: "", crontab: "",
    once: true, onceDelay: "15", topic: "", payload: "", payloadType: "date",
    x: 200, y: 440, wires: [["daily_update_read_result"]],
  },
  {
    id: "daily_update_result_poll", type: "inject", z: TAB, g: resultGroup,
    name: "A cada 5 min", props: [{ p: "payload" }], repeat: "300", crontab: "",
    once: false, onceDelay: "0.1", topic: "", payload: "", payloadType: "date",
    x: 180, y: 500, wires: [["daily_update_read_result"]],
  },
  {
    id: "daily_update_read_result", type: "exec", z: TAB, g: resultGroup,
    command: "/opt/read-host-daily-update-result.sh", addpay: "", append: "", useSpawn: "false",
    timer: "15", winHide: false, oldrc: false, name: "Ler resultado seguro",
    x: 470, y: 470,
    wires: [["daily_update_parse_result"], ["daily_update_read_error"], ["daily_update_read_complete"]],
  },
  functionNode("daily_update_read_error", resultGroup, "Falha ao ler resultado", recordExecError, 0, 760, 550, []),
  functionNode("daily_update_read_complete", resultGroup, "Código da leitura", recordCompletion, 0, 940, 550, []),
  {
    id: "daily_update_test_result_in", type: "link in", z: TAB, g: resultGroup,
    name: "Receber resultado TESTE", links: ["daily_update_test_result_out"],
    x: 455, y: 550, wires: [["daily_update_parse_result"]],
  },
  functionNode("daily_update_parse_result", resultGroup, "Normalizar, deduplicar e observar", parseResult, 1, 800, 470, [["daily_update_result_test_out"]]),
  {
    id: "daily_update_result_test_out", type: "link out", z: TAB, g: resultGroup,
    name: "Resultado TESTE → dry-run", mode: "link", links: ["daily_update_dry_run_in"],
    x: 1085, y: 470, wires: [],
  },
  {
    id: testGroup, type: "group", z: TAB,
    name: "3. TESTES manuais completos sem sudo, apt, Docker ou reboot",
    style: { label: true, color: "#7d6ba8" },
    nodes: [
      "daily_update_test_instructions", "daily_update_test_reset", "daily_update_test_reset_state",
      "daily_update_test_request", "daily_update_test_failure", "daily_update_test_unavailable",
      "daily_update_test_request_out", "daily_update_test_result_out", "daily_update_dry_run_in",
      "daily_update_dry_run_terminal",
    ],
    x: 64, y: 659, w: 1252, h: 362,
  },
  {
    id: "daily_update_test_instructions", type: "comment", z: TAB, g: testGroup,
    name: "TESTE: 1) reset 2) solicitação, falha ou indisponibilidade 3) confira o terminal; todos os efeitos ficam bloqueados",
    info: "Os testes entram nos mesmos validadores, roteadores e parser da produção. O terminal grava simulated=true e dispatched=false.",
    x: 660, y: 700, wires: [],
  },
  {
    id: "daily_update_test_reset", type: "inject", z: TAB, g: testGroup,
    name: "TESTE 1: reset", props: [{ p: "payload" }], repeat: "", crontab: "",
    once: false, onceDelay: 0.1, topic: "", payload: "", payloadType: "date",
    x: 190, y: 780, wires: [["daily_update_test_reset_state"]],
  },
  functionNode("daily_update_test_reset_state", testGroup, "Resetar teste", resetTest, 0, 460, 780, []),
  {
    id: "daily_update_test_request", type: "inject", z: TAB, g: testGroup,
    name: "TESTE 2A: ciclo após backup", props: [
      { p: "payload", v: '{"event":"git_backup_completed","status":"success","test_mode":true}', vt: "json" },
      { p: "_daily_update_test", v: "true", vt: "bool" },
    ], repeat: "", crontab: "", once: false, onceDelay: 0.1, topic: "",
    payload: "", payloadType: "date", x: 220, y: 840, wires: [["daily_update_test_request_out"]],
  },
  {
    id: "daily_update_test_failure", type: "inject", z: TAB, g: testGroup,
    name: "TESTE 2B: falha DietPi", props: [
      { p: "payload", v: "daily-update status=failed request_id=test-failed dietpi_exit=100 dietpi_stage=dietpi-update containers_exit=0", vt: "str" },
      { p: "_daily_update_test", v: "true", vt: "bool" },
    ], repeat: "", crontab: "", once: false, onceDelay: 0.1, topic: "",
    payload: "", payloadType: "date", x: 200, y: 900, wires: [["daily_update_test_result_out"]],
  },
  {
    id: "daily_update_test_unavailable", type: "inject", z: TAB, g: testGroup,
    name: "TESTE 2C: worker indisponível", props: [
      { p: "payload", v: "daily-update status=unavailable request_id=test-unavailable", vt: "str" },
      { p: "_daily_update_test", v: "true", vt: "bool" },
    ], repeat: "", crontab: "", once: false, onceDelay: 0.1, topic: "",
    payload: "", payloadType: "date", x: 220, y: 960, wires: [["daily_update_test_result_out"]],
  },
  {
    id: "daily_update_test_request_out", type: "link out", z: TAB, g: testGroup,
    name: "Solicitação TESTE → validador", mode: "link", links: ["daily_update_test_request_in"],
    x: 505, y: 840, wires: [],
  },
  {
    id: "daily_update_test_result_out", type: "link out", z: TAB, g: testGroup,
    name: "Resultado TESTE → parser", mode: "link", links: ["daily_update_test_result_in"],
    x: 505, y: 930, wires: [],
  },
  {
    id: "daily_update_dry_run_in", type: "link in", z: TAB, g: testGroup,
    name: "Receber efeito TESTE", links: ["daily_update_request_test_out", "daily_update_result_test_out"],
    x: 715, y: 870, wires: [["daily_update_dry_run_terminal"]],
  },
  functionNode("daily_update_dry_run_terminal", testGroup, "TESTE FINAL: host simulado", dryRunTerminal, 0, 1030, 870, []),
];

let next = flows.filter((node) => !owned(node.id));
for (const node of next) {
  if (Array.isArray(node.nodes)) node.nodes = node.nodes.filter((id) => !owned(id));
  if (Array.isArray(node.scope)) node.scope = node.scope.filter((id) => !owned(id));
  if (Array.isArray(node.wires)) node.wires = node.wires.map((wire) => Array.isArray(wire) ? wire.filter((id) => !owned(id)) : wire);
  if (Array.isArray(node.links)) node.links = node.links.filter((id) => !owned(id));
}
const firstConfig = next.findIndex((node) => node.z === undefined && !["tab", "subflow"].includes(node.type));
next.splice(firstConfig === -1 ? next.length : firstConfig, 0, ...nodes);
fs.writeFileSync(outputPath, `${JSON.stringify(next, null, 4)}\n`);
console.log(`Installed ${nodes.length} daily host update nodes in ${outputPath}`);
