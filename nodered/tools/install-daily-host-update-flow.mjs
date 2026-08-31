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

const prepareKiaUpdateCheck = `const TEST_MODE = msg._kia_update_test === true || msg.payload?.test_mode === true;
msg._kia_update_test = TEST_MODE;
msg.payload = {
    version: 1,
    event: "kia_uvo_update_check_requested",
    source: TEST_MODE ? "manual_test" : (msg.payload?.source ?? "node_red_schedule"),
    test_mode: TEST_MODE,
    requested_at: new Date().toISOString()
};
node.status({ fill: TEST_MODE ? "blue" : "green", shape: "dot", text: TEST_MODE ? "TESTE preparado" : "análise segura solicitada" });
return msg;`;

const recordKiaUpdateRequest = `const text = String(msg.payload ?? "").replace(/[\\r\\n]+/g, " ").trim().slice(0, 400);
const status = text.match(/\\bstatus=(accepted|coalesced)\\b/)?.[1];
if (!status) {
    node.error("kia_uvo_update_request_unrecognized");
    node.status({ fill: "red", shape: "ring", text: "resposta inválida" });
    return null;
}
node.status({ fill: status === "accepted" ? "green" : "yellow", shape: "dot", text: status === "accepted" ? "análise aceita" : "análise já pendente" });
return null;`;

const parseKiaUpdateResult = `const TEST_MODE = msg._kia_update_test === true || msg.payload?.test_mode === true;
const text = String(msg.payload ?? "").replace(/[\\r\\n]+/g, " ").trim().slice(0, 700);
if (!text) return null;
const status = text.match(/\\bstatus=(running|compatible|conflict|applied|rollback|failed|deferred|unavailable|unknown)\\b/)?.[1];
if (!status) {
    if (!TEST_MODE) node.error("kia_uvo_update_result_unrecognized");
    return null;
}
const result = {
    version: 1,
    status,
    request_id: text.match(/\\brequest_id=([^ ]+)\\b/)?.[1] ?? "unknown",
    installed_version: text.match(/\\binstalled_version=([^ ]+)\\b/)?.[1] ?? null,
    latest_version: text.match(/\\blatest_version=([^ ]+)\\b/)?.[1] ?? null,
    patch_state: text.match(/\\bpatch_state=([^ ]+)\\b/)?.[1] ?? null,
    conflicts: Number(text.match(/\\bconflicts=(\\d+)\\b/)?.[1] ?? 0),
    checked_at: text.match(/\\bchecked_at=([^ ]+)\\b/)?.[1] ?? null,
    test_mode: TEST_MODE,
    observed_at: Date.now()
};
const signature = [result.request_id, result.status, result.latest_version, result.checked_at].join(":");
const key = TEST_MODE ? "kia_uvo_update_last_result_v1__test" : "kia_uvo_update_last_result_v1";
const previous = TEST_MODE ? flow.get(key) : flow.get(key, "persistent");
if (!TEST_MODE && previous?.signature === signature) return null;
result.signature = signature;
if (TEST_MODE) flow.set(key, result);
else flow.set(key, result, "persistent");
const failed = ["failed", "unavailable", "rollback"].includes(status);
const compatible = ["compatible", "applied"].includes(status);
node.status({
    fill: failed ? "red" : compatible ? "green" : status === "conflict" ? "yellow" : "blue",
    shape: failed || status === "conflict" ? "ring" : "dot",
    text: status === "conflict"
        ? "v" + String(result.latest_version ?? "?") + ": conflito; preservado"
        : status
});
if (TEST_MODE) {
    msg.payload = result;
    return msg;
}
if (failed) node.error("kia_uvo_update_check_failed status=" + status + " request_id=" + result.request_id);
else if (status === "conflict") node.warn("kia_uvo_update_requires_manual_merge latest=" + String(result.latest_version));
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
flow.set("kia_uvo_update_last_result_v1__test", undefined);
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
    kia_uvo_update_check_sent: false,
    status: msg.payload?.status ?? msg.payload?.event ?? "request_prepared",
    completed_at: Date.now()
};
flow.set("daily_update_last_dry_run_v1", result);
node.status({ fill: "blue", shape: "dot", text: "TESTE: " + result.status + "; host bloqueado" });
return null;`;

const productionGroup = "daily_update_production_group";
const resultGroup = "daily_update_result_group";
const testGroup = "daily_update_test_group";
const kiaUpdateGroup = "daily_update_kia_group";
const nodes = [
  {
    id: TAB, type: "tab", label: "atualizacoes_diarias", disabled: false,
    info: "Depois do backup Git diário concluído, solicita ao host a atualização serial do DietPi e dos provedores de imagens dos containers. No mesmo tab, agenda a análise segura do fork Kia UVO/Hyundai Bluelink a cada 30 minutos sem instalar o upstream. O Node-RED não recebe sudo, checkout nem socket Docker.",
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
    name: "Receber efeito TESTE", links: [
      "daily_update_request_test_out", "daily_update_result_test_out",
      "daily_update_kia_test_out", "daily_update_kia_result_test_out",
    ],
    x: 715, y: 870, wires: [["daily_update_dry_run_terminal"]],
  },
  functionNode("daily_update_dry_run_terminal", testGroup, "TESTE FINAL: host simulado", dryRunTerminal, 0, 1030, 870, []),
  {
    id: kiaUpdateGroup, type: "group", z: TAB,
    name: "4. Kia UVO / Hyundai Bluelink: analisar upstream sem sobrescrever o fork",
    style: { label: true, color: "#b58b3f" },
    nodes: [
      "daily_update_kia_architecture", "daily_update_kia_schedule", "daily_update_kia_manual",
      "daily_update_kia_test_request", "daily_update_kia_prepare", "daily_update_kia_route_test",
      "daily_update_kia_request_host", "daily_update_kia_request_ack", "daily_update_kia_request_error",
      "daily_update_kia_request_complete", "daily_update_kia_test_out", "daily_update_kia_result_startup",
      "daily_update_kia_result_poll", "daily_update_kia_read_result", "daily_update_kia_read_error",
      "daily_update_kia_read_complete", "daily_update_kia_parse_result", "daily_update_kia_test_result",
      "daily_update_kia_test_result_out", "daily_update_kia_test_result_in", "daily_update_kia_result_test_out",
    ],
    x: 64, y: 1059, w: 1252, h: 582,
  },
  {
    id: "daily_update_kia_architecture", type: "comment", z: TAB, g: kiaUpdateGroup,
    name: "A cada 30 min: staging + overlay local + testes; conflito preserva v3.10.1; apply continua exclusivamente manual",
    info: "O Node-RED apenas cria uma solicitação coalescente. O worker do host executa o watcher HA existente: Kia/Hyundai segue somente para staging e as demais entidades seguras preservam a política anterior. Nunca chama update.install para a entidade protegida.",
    x: 670, y: 1100, wires: [],
  },
  {
    id: "daily_update_kia_schedule", type: "inject", z: TAB, g: kiaUpdateGroup,
    name: "A cada 30 min + ao subir", props: [{ p: "payload.source", v: "node_red_schedule", vt: "str" }],
    repeat: "", crontab: "*/30 * * * *", once: true, onceDelay: "20", topic: "",
    payload: "", payloadType: "date", x: 200, y: 1180, wires: [["daily_update_kia_prepare"]],
  },
  {
    id: "daily_update_kia_manual", type: "inject", z: TAB, g: kiaUpdateGroup,
    name: "Verificar agora (seguro)", props: [{ p: "payload.source", v: "manual", vt: "str" }],
    repeat: "", crontab: "", once: false, onceDelay: 0.1, topic: "",
    payload: "", payloadType: "date", x: 200, y: 1240, wires: [["daily_update_kia_prepare"]],
  },
  {
    id: "daily_update_kia_test_request", type: "inject", z: TAB, g: kiaUpdateGroup,
    name: "TESTE: solicitação bloqueada", props: [
      { p: "payload", v: '{"source":"manual_test","test_mode":true}', vt: "json" },
      { p: "_kia_update_test", v: "true", vt: "bool" },
    ], repeat: "", crontab: "", once: false, onceDelay: 0.1, topic: "",
    payload: "", payloadType: "date", x: 220, y: 1300, wires: [["daily_update_kia_prepare"]],
  },
  functionNode("daily_update_kia_prepare", kiaUpdateGroup, "Preparar análise segura", prepareKiaUpdateCheck, 1, 470, 1240, [["daily_update_kia_route_test"]]),
  {
    id: "daily_update_kia_route_test", type: "switch", z: TAB, g: kiaUpdateGroup,
    name: "Produção ou TESTE?", property: "_kia_update_test", propertyType: "msg",
    rules: [{ t: "true" }, { t: "else" }], checkall: "true", repair: false, outputs: 2,
    x: 710, y: 1240, wires: [["daily_update_kia_test_out"], ["daily_update_kia_request_host"]],
  },
  {
    id: "daily_update_kia_request_host", type: "exec", z: TAB, g: kiaUpdateGroup,
    command: "/opt/request-host-kia-uvo-update-check.sh", addpay: "", append: "", useSpawn: "false",
    timer: "30", winHide: false, oldrc: false, name: "Solicitar check ao host",
    x: 970, y: 1180,
    wires: [["daily_update_kia_request_ack"], ["daily_update_kia_request_error"], ["daily_update_kia_request_complete"]],
  },
  functionNode("daily_update_kia_request_ack", kiaUpdateGroup, "Registrar solicitação Kia", recordKiaUpdateRequest, 0, 1200, 1140, []),
  functionNode("daily_update_kia_request_error", kiaUpdateGroup, "Falha segura da ponte Kia", recordExecError, 0, 1200, 1200, []),
  functionNode("daily_update_kia_request_complete", kiaUpdateGroup, "Código da ponte Kia", recordCompletion, 0, 1200, 1260, []),
  {
    id: "daily_update_kia_test_out", type: "link out", z: TAB, g: kiaUpdateGroup,
    name: "Solicitação Kia TESTE → dry-run", mode: "link", links: ["daily_update_dry_run_in"],
    x: 965, y: 1300, wires: [],
  },
  {
    id: "daily_update_kia_result_startup", type: "inject", z: TAB, g: kiaUpdateGroup,
    name: "Ler resultado ao subir", props: [{ p: "payload" }], repeat: "", crontab: "",
    once: true, onceDelay: "50", topic: "", payload: "", payloadType: "date",
    x: 200, y: 1400, wires: [["daily_update_kia_read_result"]],
  },
  {
    id: "daily_update_kia_result_poll", type: "inject", z: TAB, g: kiaUpdateGroup,
    name: "Resultado a cada 1 min", props: [{ p: "payload" }], repeat: "60", crontab: "",
    once: false, onceDelay: 0.1, topic: "", payload: "", payloadType: "date",
    x: 200, y: 1460, wires: [["daily_update_kia_read_result"]],
  },
  {
    id: "daily_update_kia_read_result", type: "exec", z: TAB, g: kiaUpdateGroup,
    command: "/opt/read-host-kia-uvo-update-result.sh", addpay: "", append: "", useSpawn: "false",
    timer: "15", winHide: false, oldrc: false, name: "Ler resultado Kia seguro",
    x: 480, y: 1430,
    wires: [["daily_update_kia_parse_result"], ["daily_update_kia_read_error"], ["daily_update_kia_read_complete"]],
  },
  functionNode("daily_update_kia_read_error", kiaUpdateGroup, "Falha ao ler resultado Kia", recordExecError, 0, 750, 1510, []),
  functionNode("daily_update_kia_read_complete", kiaUpdateGroup, "Código da leitura Kia", recordCompletion, 0, 970, 1510, []),
  functionNode("daily_update_kia_parse_result", kiaUpdateGroup, "Normalizar e observar check Kia", parseKiaUpdateResult, 1, 800, 1430, [["daily_update_kia_result_test_out"]]),
  {
    id: "daily_update_kia_result_test_out", type: "link out", z: TAB, g: kiaUpdateGroup,
    name: "Resultado Kia TESTE → dry-run", mode: "link", links: ["daily_update_dry_run_in"],
    x: 1095, y: 1430, wires: [],
  },
  {
    id: "daily_update_kia_test_result", type: "inject", z: TAB, g: kiaUpdateGroup,
    name: "TESTE: conflito preservado", props: [
      { p: "payload", v: "kia-uvo-update status=conflict request_id=test installed_version=3.10.1 latest_version=v3.11.0 patch_state=conflict conflicts=1 checked_at=2026-08-31T00:00:00.000Z", vt: "str" },
      { p: "_kia_update_test", v: "true", vt: "bool" },
    ], repeat: "", crontab: "", once: false, onceDelay: 0.1, topic: "",
    payload: "", payloadType: "date", x: 220, y: 1570, wires: [["daily_update_kia_test_result_out"]],
  },
  {
    id: "daily_update_kia_test_result_out", type: "link out", z: TAB, g: kiaUpdateGroup,
    name: "Resultado Kia TESTE → parser", mode: "link", links: ["daily_update_kia_test_result_in"],
    x: 505, y: 1570, wires: [],
  },
  {
    id: "daily_update_kia_test_result_in", type: "link in", z: TAB, g: kiaUpdateGroup,
    name: "Receber resultado Kia TESTE", links: ["daily_update_kia_test_result_out"],
    x: 625, y: 1570, wires: [["daily_update_kia_parse_result"]],
  },
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
