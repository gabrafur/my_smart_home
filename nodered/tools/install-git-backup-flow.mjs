#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.resolve(process.argv[2] ?? path.resolve(here, "..", "flows.json"));
const outputPath = path.resolve(process.argv[3] ?? sourcePath);
const functionsDir = path.join(here, "functions");
const flows = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
const TAB = "git_backup_tab";
const SERVER = "4126427d5e161a03";
const source = (name) => fs.readFileSync(path.join(functionsDir, name), "utf8").trimEnd();
const owned = (node) => node.id === TAB || node.id.startsWith("git_backup_");
const removed = new Set(flows.filter(owned).map((node) => node.id));
const next = flows.filter((node) => !owned(node));
for (const node of next) {
  for (const field of ["nodes", "scope", "links"]) {
    if (Array.isArray(node[field])) node[field] = node[field].filter((id) =>
      !removed.has(id) ||
      (field === "links" && node.id === "daily_update_after_backup_in" && id === "git_backup_daily_update_out")
    );
  }
  if (Array.isArray(node.wires)) node.wires = node.wires.map((wire) => Array.isArray(wire) ? wire.filter((id) => !removed.has(id)) : wire);
}

const nodes = [];
const add = (node) => { nodes.push(node); return node.id; };
const group = (id, name, x, y, w, h, stroke, fill) => add({
  id, type: "group", z: TAB, name,
  style: { label: true, "label-position": "nw", color: "#1f2937", stroke, "stroke-opacity": "1", fill, "fill-opacity": "0.35" },
  nodes: [], x, y, w, h,
});
const groups = {
  input: group("git_backup_input_group", "0. Entradas, agenda e pedido", 64, 20, 620, 390, "#2563eb", "#dbeafe"),
  decision: group("git_backup_decision_group", "1. Normalização e decisões visuais", 720, 20, 1140, 430, "#0f766e", "#ccfbf1"),
  effect: group("git_backup_effect_group", "2. Efeitos isolados, retry e confirmação", 1900, 20, 1260, 480, "#dc2626", "#fee2e2"),
  test: group("git_backup_test_group", "3. Replay manual completo — dry-run", 64, 540, 2400, 400, "#0891b2", "#cffafe"),
};
const grouped = (g, node) => { add(node); nodes.find((entry) => entry.id === g).nodes.push(node.id); return node.id; };
const fn = (id, g, name, file, outputs, x, y, wires) => grouped(g, {
  id, type: "function", z: TAB, g, name, func: source(file), outputs,
  timeout: 0, noerr: 0, initialize: "", finalize: "", libs: [], x, y, wires,
});
const terminal = (id, g, name, status, x, y) => grouped(g, {
  id, type: "function", z: TAB, g, name,
  func: `node.status(${JSON.stringify(status)});\nreturn null;`, outputs: 0,
  timeout: 0, noerr: 0, initialize: "", finalize: "", libs: [], x, y, wires: [],
});
const inject = (id, g, name, props, x, y, wires, extra = {}) => grouped(g, {
  id, type: "inject", z: TAB, g, name, props, repeat: "", crontab: "", once: false,
  onceDelay: 0.1, topic: "", payload: "", payloadType: "date", x, y, wires, ...extra,
});
const sw = (id, g, name, property, propertyType, rules, x, y, wires) => grouped(g, {
  id, type: "switch", z: TAB, g, name, property, propertyType, rules,
  checkall: "true", repair: false, outputs: rules.length, x, y, wires,
});
const linkOut = (id, g, name, targets, x, y) => grouped(g, {
  id, type: "link out", z: TAB, g, name, mode: "link", links: Array.isArray(targets) ? targets : [targets], x, y, wires: [],
});
const linkIn = (id, g, name, origins, destination, x, y) => grouped(g, {
  id, type: "link in", z: TAB, g, name, links: Array.isArray(origins) ? origins : [origins], x, y, wires: [[destination]],
});

add({ id: TAB, type: "tab", label: "backup_git", disabled: false, info: "Node-RED agenda e decide; o helper allowlisted executa Git/SSH no host. Testes percorrem as mesmas decisões e terminam antes de qualquer efeito.", env: [] });
grouped(groups.input, {
  id: "git_backup_architecture", type: "comment", z: TAB, g: groups.input,
  name: "00:30 America/Sao_Paulo (03:30 UTC). Worker e credenciais ficam fora do Node-RED.",
  info: "O retry de cinco minutos apenas observa a solicitação pendente. Backup manual não inicia atualizações diárias.", x: 350, y: 60, wires: [],
});
inject("git_backup_schedule", groups.input, "Agenda: diariamente 00:30 (03:30 UTC)", [
  { p: "payload" }, { p: "topic", v: "scheduled", vt: "str" },
], 250, 130, [["git_backup_request_out"]], { crontab: "30 00 * * *" });
inject("git_backup_manual", groups.input, "Pedido manual: executar backup agora", [
  { p: "payload" }, { p: "topic", v: "manual", vt: "str" },
], 250, 200, [["git_backup_request_out"]]);
linkIn("git_backup_retry_in", groups.input, "Receber observação após retry", "git_backup_retry_out", "git_backup_request_out", 160, 280);
linkOut("git_backup_request_out", groups.input, "Pedido → gate do worker", "git_backup_request_in", 540, 180);

linkIn("git_backup_request_in", groups.decision, "Receber pedido", "git_backup_request_out", "git_backup_request_gate", 770, 90);
sw("git_backup_request_gate", groups.decision, "Pedido é TESTE?", "_git_backup_test", "msg", [
  { t: "true" }, { t: "else" },
], 970, 90, [["git_backup_request_dry_out"], ["git_backup_worker_out"]]);
linkOut("git_backup_request_dry_out", groups.decision, "Pedido TESTE → dry-run", "git_backup_dry_in", 1180, 70);
linkOut("git_backup_worker_out", groups.decision, "Produção → worker allowlisted", "git_backup_worker_in", 1180, 110);
linkIn("git_backup_result_in", groups.decision, "Receber resultado real ou sintético", ["git_backup_result_out", "git_backup_test_result_out"], "git_backup_result", 770, 220);
fn("git_backup_result", groups.decision, "Normalizar resposta textual", "git-backup-result-normalize.js", 1, 980, 220, [["git_backup_status_switch"]]);
sw("git_backup_status_switch", groups.decision, "Resultado: sucesso, falha ou adiado?", "git_backup_status", "msg", [
  { t: "eq", v: "success", vt: "str" }, { t: "eq", v: "failed", vt: "str" },
  { t: "eq", v: "deferred", vt: "str" }, { t: "else" },
], 1230, 220, [["git_backup_success_origin"], ["git_backup_alert_build"], ["git_backup_deferred_gate"], ["git_backup_invalid_gate"]]);
sw("git_backup_success_origin", groups.decision, "Sucesso veio da agenda diária?", "topic", "msg", [
  { t: "eq", v: "scheduled", vt: "str" }, { t: "else" },
], 1430, 140, [["git_backup_success_gate"], ["git_backup_manual_success"]]);
sw("git_backup_success_gate", groups.decision, "Atualização posterior é TESTE?", "_git_backup_test", "msg", [
  { t: "true" }, { t: "else" },
], 1640, 90, [["git_backup_dry_out"], ["git_backup_mark_daily_success"]]);
grouped(groups.decision, {
  id: "git_backup_mark_daily_success", type: "change", z: TAB, g: groups.decision,
  name: "Marcar sucesso diário", rules: [
    { t: "set", p: "payload.event", pt: "msg", to: "git_backup_completed", tot: "str" },
    { t: "set", p: "payload.status", pt: "msg", to: "success", tot: "str" },
  ], action: "", property: "", from: "", to: "", reg: false, x: 1660, y: 50,
  wires: [["git_backup_daily_update_out"]],
});
terminal("git_backup_manual_success", groups.decision, "Sucesso manual — encerrar sem updates", { fill: "green", shape: "dot", text: "backup manual concluído" }, 1730, 170);
fn("git_backup_alert_build", groups.decision, "Montar alerta de falha", "git-backup-alert-build.js", 1, 1400, 280, [["git_backup_failure_gate"]]);
sw("git_backup_failure_gate", groups.decision, "Notificação de falha é TESTE?", "_git_backup_test", "msg", [
  { t: "true" }, { t: "else" },
], 1650, 280, [["git_backup_dry_out"], ["git_backup_notification_out"]]);
sw("git_backup_deferred_gate", groups.decision, "Retry adiado é TESTE?", "_git_backup_test", "msg", [
  { t: "true" }, { t: "else" },
], 1500, 320, [["git_backup_dry_out"], ["git_backup_retry_effect_out"]]);
sw("git_backup_invalid_gate", groups.decision, "Resposta inválida pertence a TESTE?", "_git_backup_test", "msg", [
  { t: "true" }, { t: "else" },
], 1350, 390, [["git_backup_dry_out"], ["git_backup_invalid_result"]]);
fn("git_backup_invalid_result", groups.decision, "Rejeitar resposta não reconhecida", "git-backup-invalid-result.js", 0, 1610, 380, []);
linkOut("git_backup_notification_out", groups.decision, "Falha real → notificações", "git_backup_notification_in", 1810, 280);
linkOut("git_backup_retry_effect_out", groups.decision, "Adiado real → retry", "git_backup_retry_effect_in", 1740, 330);
linkOut("git_backup_daily_update_out", groups.decision, "Sucesso diário → updates", "daily_update_after_backup_in", 1840, 50);
linkOut("git_backup_dry_out", groups.decision, "TESTE → terminal dry-run", "git_backup_dry_in", 1840, 420);

linkIn("git_backup_worker_in", groups.effect, "Receber pedido de produção", "git_backup_worker_out", "git_backup_request", 1950, 100);
grouped(groups.effect, {
  id: "git_backup_request", type: "exec", z: TAB, g: groups.effect,
  command: "/opt/request-host-git-backup.sh", addpay: "", append: "", useSpawn: "false", timer: "240", winHide: false, oldrc: false,
  name: "EFEITO: solicitar backup ao host", x: 2210, y: 100,
  wires: [["git_backup_result_out"], ["git_backup_error"], ["git_backup_complete"]],
});
linkOut("git_backup_result_out", groups.effect, "Resultado do worker → decisões", "git_backup_result_in", 2480, 80);
fn("git_backup_error", groups.effect, "Normalizar erro da ponte", "git-backup-error-build.js", 1, 2480, 150, [["git_backup_notification_direct"]]);
linkOut("git_backup_notification_direct", groups.effect, "Erro da ponte → notificações", "git_backup_notification_in", 2740, 150);
sw("git_backup_complete", groups.effect, "Código da ponte é zero?", "$number(payload.code ? payload.code : payload)", "jsonata", [
  { t: "eq", v: "0", vt: "num" }, { t: "else" },
], 2480, 220, [["git_backup_complete_ok"], ["git_backup_complete_failed"]]);
terminal("git_backup_complete_ok", groups.effect, "Worker finalizado", { fill: "green", shape: "dot", text: "worker finalizado" }, 2740, 200);
terminal("git_backup_complete_failed", groups.effect, "Worker terminou com falha", { fill: "red", shape: "ring", text: "worker falhou" }, 2740, 250);
grouped(groups.effect, {
  id: "git_backup_notification_in", type: "link in", z: TAB, g: groups.effect,
  name: "Receber alerta canônico", links: ["git_backup_notification_out", "git_backup_notification_direct"],
  x: 1950, y: 340, wires: [["git_backup_notify_primary", "git_backup_notify_persistent"]],
});
grouped(groups.effect, {
  id: "git_backup_notify_primary", type: "api-call-service", z: TAB, g: groups.effect,
  name: "EFEITO: avisar resident_primary", server: SERVER, version: 7, debugenabled: false, action: "public_bindings.call",
  floorId: [], areaId: [], deviceId: [], entityId: [], labelId: [], data: '{"role":"mobile_primary","action":"notify_3","data":{"title":alert.title,"message":alert.message}}',
  dataType: "jsonata", mergeContext: "", mustacheAltTags: false, outputProperties: [], queue: "all", blockInputOverrides: true,
  domain: "public_bindings", service: "call", x: 2250, y: 320, wires: [[]],
});
grouped(groups.effect, {
  id: "git_backup_notify_persistent", type: "api-call-service", z: TAB, g: groups.effect,
  name: "EFEITO: registrar aviso persistente", server: SERVER, version: 7, debugenabled: false, action: "persistent_notification.create",
  floorId: [], areaId: [], deviceId: [], entityId: [], labelId: [], data: '{"title":alert.title,"message":alert.message,"notification_id":"git_backup_failure"}',
  dataType: "jsonata", mergeContext: "", mustacheAltTags: false, outputProperties: [], queue: "all", blockInputOverrides: true,
  domain: "persistent_notification", service: "create", x: 2280, y: 370, wires: [[]],
});
linkIn("git_backup_retry_effect_in", groups.effect, "Receber retry permitido", "git_backup_retry_effect_out", "git_backup_retry_delay", 1950, 430);
grouped(groups.effect, {
  id: "git_backup_retry_delay", type: "delay", z: TAB, g: groups.effect,
  name: "POLÍTICA: aguardar 5 min para observar retry", pauseType: "delay", timeout: "5", timeoutUnits: "minutes",
  rate: "1", nbRateUnits: "1", rateUnits: "second", randomFirst: "1", randomLast: "5", randomUnits: "seconds",
  drop: false, allowrate: false, outputs: 1, x: 2250, y: 430, wires: [["git_backup_retry_out"]],
});
linkOut("git_backup_retry_out", groups.effect, "Retry → novo pedido", "git_backup_retry_in", 2510, 430);

grouped(groups.test, {
  id: "git_backup_test_instructions", type: "comment", z: TAB, g: groups.test,
  name: "Ordem: reset → pedido → sucesso/falha/adiado/inválido. Worker, push e avisos permanecem bloqueados.",
  info: "O pedido sintético prova o gate antes do worker. Os resultados sintéticos percorrem o parser e todas as decisões até as fronteiras de efeito.", x: 900, y: 580, wires: [],
});
inject("git_backup_test_reset", groups.test, "TESTE 1: reset", [{ p: "payload" }], 170, 660, [["git_backup_test_reset_state"]]);
fn("git_backup_test_reset_state", groups.test, "Resetar estado sintético", "git-backup-reset-test.js", 0, 410, 660, []);
inject("git_backup_test_request", groups.test, "TESTE 2: pedido ao worker", [
  { p: "_git_backup_test", v: "true", vt: "bool" }, { p: "topic", v: "scheduled", vt: "str" },
  { p: "payload", v: "request_simulated", vt: "str" },
], 200, 730, [["git_backup_test_request_out"]]);
linkOut("git_backup_test_request_out", groups.test, "Pedido TESTE → gate real", "git_backup_test_request_in", 480, 730);
linkIn("git_backup_test_request_in", groups.decision, "Receber pedido TESTE", "git_backup_test_request_out", "git_backup_request_gate", 770, 150);
const testResult = (id, name, status, topic, x, y) => inject(id, groups.test, name, [
  { p: "payload", v: `git-backup status=${status} request_id=test finished_at=synthetic`, vt: "str" },
  { p: "_git_backup_test", v: "true", vt: "bool" }, { p: "topic", v: topic, vt: "str" },
], x, y, [["git_backup_test_result_out"]]);
testResult("git_backup_test_success", "TESTE 3A: sucesso agendado", "success", "scheduled", 200, 800);
testResult("git_backup_test_failure", "TESTE 3B: falha", "failed", "manual", 200, 850);
testResult("git_backup_test_deferred", "TESTE 3C: adiado", "deferred", "scheduled", 200, 900);
inject("git_backup_test_invalid", groups.test, "TESTE 3D: resposta inválida", [
  { p: "payload", v: "synthetic invalid result", vt: "str" }, { p: "_git_backup_test", v: "true", vt: "bool" },
], 520, 850, [["git_backup_test_result_out"]]);
linkOut("git_backup_test_result_out", groups.test, "Resultado TESTE → parser real", "git_backup_result_in", 680, 850);
linkIn("git_backup_dry_in", groups.test, "Receber efeito TESTE", ["git_backup_dry_out", "git_backup_request_dry_out"], "git_backup_dry_run_terminal", 1060, 730);
fn("git_backup_dry_run_terminal", groups.test, "TESTE FINAL: nenhum efeito enviado", "git-backup-dry-run.js", 0, 1340, 730, []);

next.push(...nodes);
const dailyUpdateInput = next.find((node) => node.id === "daily_update_after_backup_in");
if (dailyUpdateInput && Array.isArray(dailyUpdateInput.links) && !dailyUpdateInput.links.includes("git_backup_daily_update_out")) {
  dailyUpdateInput.links.push("git_backup_daily_update_out");
}
fs.writeFileSync(outputPath, `${JSON.stringify(next, null, 4)}\n`);
console.log(`Fluxo visual de backup Git instalado em ${outputPath}`);
