#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installNotificationHubs } from "./install-notification-hubs.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.resolve(process.argv[2] ?? path.resolve(here, "..", "flows.json"));
const outputPath = path.resolve(process.argv[3] ?? sourcePath);
const functionsDir = path.join(here, "functions");
const TAB = "1f468eaeef0733dd";
const PRESERVED = new Set(["6481cb991b3732f5", "882f727e98158ffe", "dcd87a69ec3c6008"]);
const flows = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
const source = (name) => fs.readFileSync(path.join(functionsDir, name), "utf8").trimEnd();
const template = (id) => {
  const node = flows.find((entry) => entry.id === id);
  if (!node) throw new Error(`Template obrigatório ausente: ${id}`);
  return structuredClone(node);
};
const templates = Object.fromEntries(
  ["af0496cef18e47ca", "9d0d42f03aa9013d", "3b95712a74512929", "370622ddaaf3fcab"]
    .map((id) => [id, template(id)]),
);
const removed = new Set(flows.filter((node) => node.id === TAB || node.z === TAB).map((node) => node.id));
const next = flows.filter((node) => node.id !== TAB && node.z !== TAB);
for (const node of next) {
  for (const field of ["nodes", "scope"]) if (Array.isArray(node[field])) node[field] = node[field].filter((id) => !removed.has(id));
  if (Array.isArray(node.links)) node.links = node.links.filter((id) => !removed.has(id) || PRESERVED.has(id));
  if (Array.isArray(node.wires)) node.wires = node.wires.map((wire) => Array.isArray(wire) ? wire.filter((id) => !removed.has(id)) : wire);
}
const nodes = [];
const add = (node) => { nodes.push(node); return node.id; };
const group = (id, name, x, y, w, h, stroke, fill) => add({ id, type: "group", z: TAB, name,
  style: { label: true, "label-position": "nw", color: "#1f2937", stroke, fill, "fill-opacity": "0.35" }, nodes: [], x, y, w, h });
const groups = {
  policy: group("alarm_arrival_policy_group", "0. Política ajustável", 64, 20, 1000, 280, "#2563eb", "#dbeafe"),
  arrival: group("alarm_arrival_input_group", "1. Contrato canônico e gates de chegada", 1100, 20, 2850, 500, "#7c3aed", "#ede9fe"),
  request: group("alarm_arrival_request_group", "2. Estado armado, pendência e cooldown", 3990, 20, 2520, 500, "#0f766e", "#ccfbf1"),
  effects: group("alarm_arrival_effect_group", "3. Notificações reais e confirmação de entrega", 6550, 20, 1250, 500, "#b45309", "#ffedd5"),
  confirmation: group("alarm_arrival_confirmation_group", "4. Resposta mobile e decisão de desarme", 1100, 560, 5410, 570, "#be123c", "#ffe4e6"),
  test: group("alarm_arrival_full_flow_group", "5. TESTE — notificação, resposta e desarme em dry-run", 64, 1170, 3300, 360, "#0891b2", "#cffafe"),
};
const grouped = (g, node) => { add(node); nodes.find((entry) => entry.id === g).nodes.push(node.id); return node.id; };
const fn = (id, g, name, file, outputs, x, y, wires) => grouped(g, { id, type: "function", z: TAB, g, name,
  func: source(file), outputs, timeout: 0, noerr: 0, initialize: "", finalize: "", libs: [], x, y, wires });
const inject = (id, g, name, props, x, y, wires, extra = {}) => grouped(g, { id, type: "inject", z: TAB, g, name,
  props, repeat: "", crontab: "", once: false, onceDelay: 0.1, topic: "", payload: "", payloadType: "date", x, y, wires, ...extra });
const sw = (id, g, name, property, propertyType, rules, x, y, wires) => grouped(g, { id, type: "switch", z: TAB, g, name,
  property, propertyType, rules, checkall: "true", repair: false, outputs: rules.length, x, y, wires });
const change = (id, g, name, rules, x, y, wires) => grouped(g, { id, type: "change", z: TAB, g, name,
  rules, action: "", property: "", from: "", to: "", reg: false, x, y, wires });
const linkOut = (id, g, name, targets, x, y) => grouped(g, { id, type: "link out", z: TAB, g, name,
  mode: "link", links: Array.isArray(targets) ? targets : [targets], x, y, wires: [] });
const linkIn = (id, g, name, origins, destination, x, y) => grouped(g, { id, type: "link in", z: TAB, g, name,
  links: Array.isArray(origins) ? origins : [origins], x, y, wires: [[destination]] });
const terminal = (id, g, name, status, x, y) => grouped(g, { id, type: "function", z: TAB, g, name,
  func: `node.status(${JSON.stringify(status)});\nreturn null;`, outputs: 0, timeout: 0, noerr: 0, initialize: "", finalize: "", libs: [], x, y, wires: [] });
const cloned = (id, g, name, x, y, wires) => grouped(g, { ...templates[id], z: TAB, g, name, x, y, wires });

add({ id: TAB, type: "tab", label: "alarme_desarme_chegada", disabled: false,
  info: "A chegada é validada por gates visuais. Pendência, cooldown, destinatários, timeout, confirmação e produção/teste permanecem separados até a fronteira final.", env: [] });

const policy = { cooldown_s: 60, confirmation_ttl_s: 300, delivery_window_s: 30, test_ttl_s: 120 };
grouped(groups.policy, { id: "alarm_arrival_policy_note", type: "comment", z: TAB, g: groups.policy,
  name: "Padrões: cooldown 60 s; confirmação 300 s; entrega 30 s; TESTE 120 s.",
  info: "Limites: 0–600 s, 30–900 s, 5–120 s e 30–600 s. Inválido preserva a última política.", x: 510, y: 60, wires: [] });
inject("alarm_arrival_policy_default", groups.policy, "CONFIG: aplicar política visual", [{ p: "payload", v: JSON.stringify(policy), vt: "json" }], 190, 130, [["alarm_arrival_policy_validate"]], { once: true, onceDelay: "1" });
fn("alarm_arrival_policy_validate", groups.policy, "Validar segundos e limites", "alarm-arrival-policy-validate.js", 1, 440, 130, [["alarm_arrival_policy_switch"]]);
sw("alarm_arrival_policy_switch", groups.policy, "Configuração é válida?", "policy_valid", "msg", [{ t: "true" }, { t: "else" }], 680, 130, [["alarm_arrival_policy_store"], ["alarm_arrival_policy_reject"]]);
fn("alarm_arrival_policy_store", groups.policy, "Guardar última política válida", "alarm-arrival-policy-store.js", 0, 930, 100, []);
fn("alarm_arrival_policy_reject", groups.policy, "Rejeitar sem substituir", "alarm-arrival-policy-reject.js", 0, 930, 170, []);

const rejectOrigins = [];
const reject = (id, name, x) => { rejectOrigins.push(id); linkOut(id, groups.arrival, name, "alarm_arrival_reject_in", x, 410); };
linkIn("6481cb991b3732f5", groups.arrival, "Receber security.arrival.v1", ["397c6032b3dad342", "2aa1b0c2907d4017"], "alarm_arrival_normalize", 1150, 300);
fn("alarm_arrival_normalize", groups.arrival, "Adaptar campos da chegada", "alarm-arrival-normalize.js", 1, 1360, 300, [["alarm_arrival_contract_gate"]]);
const gates = [
  ["alarm_arrival_contract_gate", "Contrato é security.arrival.v1?", "arrival_contract_valid"],
  ["alarm_arrival_kind_gate", "Kind é arrival?", "arrival_kind_valid"],
  ["alarm_arrival_source_gate", "Origem é permitida?", "arrival_source_valid"],
  ["alarm_arrival_stage_gate", "Estágio é approach ou home?", "arrival_stage_valid"],
  ["alarm_arrival_direction_gate", "Direção é returning?", "arrival_direction_valid"],
  ["alarm_arrival_cycle_gate", "Ciclo externo foi confirmado?", "arrival_cycle_confirmed"],
  ["alarm_arrival_self_gate", "Lista arriving contém a origem?", "arrival_self_listed"],
];
for (let index = 0; index < gates.length; index += 1) {
  const [id, name, property] = gates[index];
  const nextId = index + 1 < gates.length ? gates[index + 1][0] : "alarm_arrival_test_gate";
  const x = 1600 + index * 300;
  const rejectId = `${id}_reject_out`;
  sw(id, groups.arrival, name, property, "msg", [{ t: "true" }, { t: "else" }], x, 300, [[nextId], [rejectId]]);
  reject(rejectId, "Inválido → ignorar", x, 410);
}
sw("alarm_arrival_test_gate", groups.arrival, "Entrada está em test_mode?", "arrival_test_mode", "msg", [{ t: "true" }, { t: "else" }], 3700, 300, [["alarm_arrival_test_route_out_v1"], ["alarm_arrival_production_out"]]);
linkOut("alarm_arrival_test_route_out_v1", groups.arrival, "TESTE validado → pendência sintética", "alarm_arrival_test_route_in_v1", 3900, 260);
linkOut("alarm_arrival_production_out", groups.arrival, "Produção validada → estado armado", "alarm_arrival_production_in", 3900, 340);
linkIn("alarm_arrival_reject_in", groups.arrival, "Receber rejeições", rejectOrigins, "alarm_arrival_reject_terminal", 3600, 450);
terminal("alarm_arrival_reject_terminal", groups.arrival, "Ignorar chegada fora do contrato", { fill: "grey", shape: "ring", text: "chegada ignorada" }, 3820, 450);

linkIn("alarm_arrival_production_in", groups.request, "Receber chegada de produção", "alarm_arrival_production_out", "af0496cef18e47ca", 4040, 300);
cloned("af0496cef18e47ca", groups.request, "Ler estado atual do security_panel", 4240, 300, [["a305a1379c919215"]]);
sw("a305a1379c919215", groups.request, "Alarme está armed_away?", "payload", "msg", [{ t: "eq", v: "armed_away", vt: "str" }, { t: "else" }], 4490, 300, [["alarm_arrival_request_policy_load"], ["alarm_arrival_not_armed"]]);
terminal("alarm_arrival_not_armed", groups.request, "Não solicitar se já desarmado", { fill: "grey", shape: "ring", text: "alarme não armado" }, 4750, 190);
fn("alarm_arrival_request_policy_load", groups.request, "Carregar política canônica", "alarm-arrival-policy-load.js", 1, 4760, 300, [["alarm_arrival_request_policy_available"]]);
sw("alarm_arrival_request_policy_available", groups.request, "Existe política válida?", "policy_available", "msg", [{ t: "true" }, { t: "else" }], 5030, 300, [["alarm_arrival_request_read"], ["alarm_arrival_request_policy_missing"]]);
terminal("alarm_arrival_request_policy_missing", groups.request, "Falha fechada sem política", { fill: "red", shape: "ring", text: "política ausente" }, 5300, 190);
fn("alarm_arrival_request_read", groups.request, "Ler pendência, entrega e cooldown", "alarm-arrival-request-read.js", 1, 5310, 300, [["alarm_arrival_pending_gate"]]);
sw("alarm_arrival_pending_gate", groups.request, "Já existe confirmação pendente?", "arrival_request.pending_active", "msg", [{ t: "true" }, { t: "else" }], 5580, 300, [["alarm_arrival_duplicate_terminal"], ["alarm_arrival_inflight_gate"]]);
terminal("alarm_arrival_duplicate_terminal", groups.request, "Deduplicar pendência", { fill: "grey", shape: "ring", text: "confirmação pendente" }, 5840, 160);
sw("alarm_arrival_inflight_gate", groups.request, "Entrega ao HA está em voo?", "arrival_request.inflight_active", "msg", [{ t: "true" }, { t: "else" }], 5840, 300, [["alarm_arrival_inflight_terminal"], ["alarm_arrival_cooldown_gate"]]);
terminal("alarm_arrival_inflight_terminal", groups.request, "Serializar entrega", { fill: "yellow", shape: "ring", text: "entrega em voo" }, 6100, 200);
sw("alarm_arrival_cooldown_gate", groups.request, "Cooldown de 60 s está ativo?", "arrival_request.cooldown_active", "msg", [{ t: "true" }, { t: "else" }], 6100, 300, [["alarm_arrival_cooldown_terminal"], ["alarm_arrival_request_build"]]);
terminal("alarm_arrival_cooldown_terminal", groups.request, "Respeitar cooldown aceito", { fill: "grey", shape: "ring", text: "cooldown" }, 6320, 220);
fn("alarm_arrival_request_build", groups.request, "Criar token e candidato", "alarm-arrival-request-build.js", 1, 6280, 360, [["alarm_arrival_notify_out"]]);
linkOut("alarm_arrival_notify_out", groups.request, "Candidato → dois destinatários", "alarm_arrival_notify_in", 6460, 360);

grouped(groups.effects, { id: "alarm_arrival_notify_in", type: "link in", z: TAB, g: groups.effects,
  name: "Receber candidato confirmado", links: ["alarm_arrival_notify_out"], x: 6600, y: 200,
  wires: [["3b95712a74512929", "370622ddaaf3fcab"]] });
cloned("3b95712a74512929", groups.effects, "Notificar mobile_primary", 6870, 160, [["alarm_arrival_notification_ack_v1"]]);
cloned("370622ddaaf3fcab", groups.effects, "Notificar mobile_secondary", 6870, 240, [["alarm_arrival_notification_ack_v1"]]);
fn("alarm_arrival_notification_ack_v1", groups.effects, "Promover pendência após aceite HA", "alarm-arrival-notification-ack.js", 0, 7220, 200, []);
grouped(groups.effects, { id: "7a19b058661ba5f8", type: "catch", z: TAB, g: groups.effects, name: "Capturar falha das notificações", scope: ["3b95712a74512929", "370622ddaaf3fcab"], uncaught: false, x: 6720, y: 360, wires: [["alarm_arrival_notification_failure_v1"]] });
fn("alarm_arrival_notification_failure_v1", groups.effects, "Falhar sem armar cooldown", "alarm-arrival-notification-failure.js", 0, 7070, 360, []);

cloned("9d0d42f03aa9013d", groups.confirmation, "Receber mobile_app_notification_action", 1240, 820, [["alarm_arrival_confirmation_read"]]);
linkIn("alarm_arrival_test_confirmation_in_v1", groups.confirmation, "Receber confirmação simulada", "alarm_arrival_test_confirmation_out_v1", "alarm_arrival_confirmation_read", 1190, 880);
fn("alarm_arrival_confirmation_read", groups.confirmation, "Adaptar action e carregar pendências", "alarm-arrival-confirmation-read.js", 1, 1530, 840, [["alarm_arrival_action_gate"]]);
sw("alarm_arrival_action_gate", groups.confirmation, "Evento contém action?", "confirmation.action_valid", "msg", [{ t: "true" }, { t: "else" }], 1810, 840, [["alarm_arrival_action_test_gate"], ["alarm_arrival_action_invalid"]]);
terminal("alarm_arrival_action_invalid", groups.confirmation, "Ignorar evento sem action", { fill: "grey", shape: "ring", text: "action ausente" }, 2070, 700);
sw("alarm_arrival_action_test_gate", groups.confirmation, "Action começa com ALARME_TESTE_?", "confirmation.is_test", "msg", [{ t: "true" }, { t: "else" }], 2080, 840, [["alarm_arrival_test_pending_gate"], ["alarm_arrival_real_pending_gate"]]);
sw("alarm_arrival_test_pending_gate", groups.confirmation, "Existe pendência de TESTE?", "confirmation.test_pending_exists", "msg", [{ t: "true" }, { t: "else" }], 2380, 730, [["alarm_arrival_test_token_gate"], ["alarm_arrival_test_no_pending"]]);
terminal("alarm_arrival_test_no_pending", groups.confirmation, "Bloquear action TESTE antiga", { fill: "grey", shape: "ring", text: "sem pendência TESTE" }, 2670, 650);
sw("alarm_arrival_test_token_gate", groups.confirmation, "Token TESTE pertence à pendência?", "confirmation.test_token_matches", "msg", [{ t: "true" }, { t: "else" }], 2670, 730, [["alarm_arrival_test_expired_gate"], ["alarm_arrival_test_wrong_token"]]);
terminal("alarm_arrival_test_wrong_token", groups.confirmation, "Ignorar token TESTE antigo", { fill: "grey", shape: "ring", text: "token antigo" }, 2960, 650);
sw("alarm_arrival_test_expired_gate", groups.confirmation, "Pendência TESTE expirou?", "confirmation.now > confirmation.test_pending.expiresAt", "jsonata", [{ t: "true" }, { t: "else" }], 2960, 730, [["alarm_arrival_test_clear"], ["alarm_arrival_test_confirm_gate"]]);
fn("alarm_arrival_test_clear", groups.confirmation, "Limpar TESTE expirado", "alarm-arrival-test-clear.js", 0, 3250, 650, []);
sw("alarm_arrival_test_confirm_gate", groups.confirmation, "Action TESTE confirma?", "confirmation.action", "msg", [{ t: "eq", v: "confirmation.test_pending.confirmAction", vt: "msg" }, { t: "else" }], 3250, 730, [["alarm_arrival_test_result_confirm"], ["alarm_arrival_test_result_cancel"]]);
change("alarm_arrival_test_result_confirm", groups.confirmation, "Resultado TESTE: confirmado", [{ t: "set", p: "alarm_arrival_test_result", pt: "msg", to: "confirmado", tot: "str" }], 3550, 690, [["alarm_arrival_test_finish"]]);
change("alarm_arrival_test_result_cancel", groups.confirmation, "Resultado TESTE: cancelado", [{ t: "set", p: "alarm_arrival_test_result", pt: "msg", to: "cancelado", tot: "str" }], 3550, 770, [["alarm_arrival_test_finish"]]);
fn("alarm_arrival_test_finish", groups.confirmation, "Consumir pendência sintética", "alarm-arrival-test-finish.js", 1, 3850, 730, [["alarm_arrival_test_dry_run_terminal_v1"]]);
fn("alarm_arrival_test_dry_run_terminal_v1", groups.confirmation, "TESTE FINAL: quatro ações simuladas", "alarm-arrival-dry-run.js", 0, 4160, 730, []);

sw("alarm_arrival_real_pending_gate", groups.confirmation, "Existe confirmação real pendente?", "confirmation.pending", "msg", [{ t: "nnull" }, { t: "else" }], 2380, 990, [["alarm_arrival_real_expired_gate"], ["alarm_arrival_real_no_pending"]]);
terminal("alarm_arrival_real_no_pending", groups.confirmation, "Ignorar action sem pendência", { fill: "grey", shape: "ring", text: "sem pendência" }, 2670, 1080);
sw("alarm_arrival_real_expired_gate", groups.confirmation, "Confirmação real expirou?", "confirmation.now > confirmation.pending.expiresAt", "jsonata", [{ t: "true" }, { t: "else" }], 2670, 990, [["alarm_arrival_real_clear_expired"], ["alarm_arrival_real_cancel_gate"]]);
fn("alarm_arrival_real_clear_expired", groups.confirmation, "Limpar confirmação expirada", "alarm-arrival-real-clear.js", 0, 2960, 1080, []);
sw("alarm_arrival_real_cancel_gate", groups.confirmation, "Action escolheu manter armado?", "confirmation.action", "msg", [{ t: "eq", v: "confirmation.pending.cancelAction", vt: "msg" }, { t: "else" }], 2960, 990, [["alarm_arrival_real_clear_cancel"], ["alarm_arrival_real_confirm_gate"]]);
fn("alarm_arrival_real_clear_cancel", groups.confirmation, "Consumir cancelamento", "alarm-arrival-real-clear.js", 0, 3250, 1080, []);
sw("alarm_arrival_real_confirm_gate", groups.confirmation, "Action confirma o token atual?", "confirmation.action", "msg", [{ t: "eq", v: "confirmation.pending.confirmAction", vt: "msg" }, { t: "else" }], 3250, 990, [["alarm_arrival_disarm_build"], ["alarm_arrival_real_wrong_action"]]);
terminal("alarm_arrival_real_wrong_action", groups.confirmation, "Preservar pendência para action correta", { fill: "grey", shape: "ring", text: "action não corresponde" }, 3550, 1080);
fn("alarm_arrival_disarm_build", groups.confirmation, "Consumir token e montar intenção", "alarm-arrival-disarm-build.js", 1, 3550, 990, [["dcd87a69ec3c6008"]]);
linkOut("dcd87a69ec3c6008", groups.confirmation, "Desarmar após confirmação", "alarm_arrival_disarm_command_in", 3840, 990);

linkIn("882f727e98158ffe", groups.test, "Receber reset compartilhado", ["bc2afbce89f5a9d5", "2ff281276fc1d020"], "alarm_arrival_test_reset", 120, 1320);
inject("68bef52acfe15ef6", groups.test, "TESTE 1: reset", [{ p: "payload", v: '{"kind":"alarm_test_reset","test_mode":true}', vt: "json" }, { p: "_location_test_reset", v: "true", vt: "bool" }], 190, 1400, [["alarm_arrival_test_reset"]]);
fn("alarm_arrival_test_reset", groups.test, "Limpar somente pendência sintética", "alarm-arrival-test-reset.js", 1, 480, 1360, [["alarm_arrival_test_reset_terminal"]]);
terminal("alarm_arrival_test_reset_terminal", groups.test, "Confirmar reset isolado", { fill: "blue", shape: "dot", text: "TESTE resetado" }, 760, 1360);
inject("89896182d31675a1", groups.test, "TESTE 2: chegada válida e confirmação", [
  { p: "payload", v: '{"contract":"security.arrival.v1","kind":"arrival","source":"resident_primary","arriving":["resident_primary"],"arrival_stage":"approach","arrival_direction":"returning","external_cycle_confirmed":true,"test_mode":true,"test_case":"alarm_manual"}', vt: "json" },
  { p: "_location_test", v: "true", vt: "bool" },
], 250, 1480, [["alarm_arrival_manual_test_out"]]);
linkOut("alarm_arrival_manual_test_out", groups.test, "Chegada TESTE → gates canônicos", "alarm_arrival_manual_test_in", 560, 1480);
linkIn("alarm_arrival_manual_test_in", groups.arrival, "Receber chegada manual TESTE", "alarm_arrival_manual_test_out", "alarm_arrival_normalize", 1150, 360);
linkIn("alarm_arrival_test_route_in_v1", groups.test, "Receber chegada TESTE validada", "alarm_arrival_test_route_out_v1", "alarm_arrival_test_policy_load", 1000, 1370);
fn("alarm_arrival_test_policy_load", groups.test, "Carregar política canônica", "alarm-arrival-policy-load.js", 1, 1210, 1370, [["alarm_arrival_test_policy_available"]]);
sw("alarm_arrival_test_policy_available", groups.test, "Existe política válida?", "policy_available", "msg", [{ t: "true" }, { t: "else" }], 1450, 1370, [["alarm_arrival_test_read"], ["alarm_arrival_test_policy_missing"]]);
terminal("alarm_arrival_test_policy_missing", groups.test, "Falha fechada sem política", { fill: "red", shape: "ring", text: "política ausente" }, 1700, 1280);
fn("alarm_arrival_test_read", groups.test, "Ler pendência e último reset", "alarm-arrival-test-read.js", 1, 1720, 1370, [["alarm_arrival_test_pending_active"]]);
sw("alarm_arrival_test_pending_active", groups.test, "Já existe TESTE válido pendente?", "arrival_test.pending_active", "msg", [{ t: "true" }, { t: "else" }], 1980, 1370, [["alarm_arrival_test_duplicate"], ["alarm_arrival_test_build"]]);
terminal("alarm_arrival_test_duplicate", groups.test, "Deduplicar cenário sintético", { fill: "grey", shape: "ring", text: "TESTE pendente" }, 2240, 1280);
fn("alarm_arrival_test_build", groups.test, "Criar pendência TESTE isolada", "alarm-arrival-test-build.js", 1, 2250, 1370, [["alarm_arrival_test_simulate_confirmation_v1"]]);
fn("alarm_arrival_test_simulate_confirmation_v1", groups.test, "Simular entrega e resposta mobile", "alarm-arrival-test-simulate.js", 1, 2550, 1370, [["alarm_arrival_test_confirmation_out_v1"]]);
linkOut("alarm_arrival_test_confirmation_out_v1", groups.test, "Confirmação simulada → decisão", "alarm_arrival_test_confirmation_in_v1", 2860, 1370);

next.push(...nodes);
fs.writeFileSync(outputPath, `${JSON.stringify(installNotificationHubs(next), null, 4)}\n`);
console.log(`Alarm arrival visual flow installed in ${outputPath}`);
