#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.resolve(process.argv[2] ?? path.resolve(here, "..", "flows.json"));
const outputPath = path.resolve(process.argv[3] ?? sourcePath);
const functionsDir = path.join(here, "functions");
const TAB = "resident_notifications_tab";
const SERVER = "4126427d5e161a03";
const flows = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
const source = (name) => fs.readFileSync(path.join(functionsDir, name), "utf8").trimEnd();
const owned = (node) => node.id === TAB || node.z === TAB || node.id.startsWith("resident_notifications_");
const removed = new Set(flows.filter(owned).map((node) => node.id));
const next = flows.filter((node) => !owned(node));
for (const node of next) {
  for (const field of ["nodes", "scope", "links"]) {
    if (Array.isArray(node[field])) node[field] = node[field].filter((id) => !removed.has(id));
  }
  if (Array.isArray(node.wires)) node.wires = node.wires.map((wire) =>
    Array.isArray(wire) ? wire.filter((id) => !removed.has(id)) : wire
  );
}

const peopleOut = next.find((node) => node.id === "people_location_notification_out_v1");
const peopleTestOut = next.find((node) => node.id === "bc2afbce89f5a9d5");
if (!peopleOut || peopleOut.type !== "link out") throw new Error("Saída canônica de localização ausente");
if (!peopleTestOut || peopleTestOut.type !== "link out") throw new Error("Saída de teste de localização ausente");

const nodes = [];
const add = (node) => { nodes.push(node); return node.id; };
const group = (id, name, x, y, w, h, stroke, fill) => add({
  id, type: "group", z: TAB, name,
  style: { label: true, "label-position": "nw", color: "#1f2937", stroke, "stroke-opacity": "1", fill, "fill-opacity": "0.35" },
  nodes: [], x, y, w, h,
});
const groups = {
  input: group("resident_notifications_input_group", "0. Política única e entrada canônica", 64, 20, 1000, 510, "#2563eb", "#dbeafe"),
  decision: group("resident_notifications_decision_group", "1. Validação, estado, dedupe e decisões visuais", 1100, 20, 5600, 510, "#0f766e", "#ccfbf1"),
  output: group("resident_notifications_output_group", "2. Efeitos reais isolados", 6740, 20, 1300, 510, "#dc2626", "#fee2e2"),
  test: group("resident_notifications_test_group", "3. Replay manual completo — sempre dry-run", 64, 580, 2500, 520, "#0891b2", "#cffafe"),
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
const change = (id, g, name, rules, x, y, wires) => grouped(g, {
  id, type: "change", z: TAB, g, name, rules, action: "", property: "", from: "", to: "", reg: false, x, y, wires,
});
const linkOut = (id, g, name, targets, x, y) => grouped(g, {
  id, type: "link out", z: TAB, g, name, mode: "link", links: Array.isArray(targets) ? targets : [targets], x, y, wires: [],
});
const linkIn = (id, g, name, origins, destination, x, y) => grouped(g, {
  id, type: "link in", z: TAB, g, name, links: Array.isArray(origins) ? origins : [origins], x, y, wires: [[destination]],
});
const policy = {
  approach_zone: "near_home",
  dedupe_ttl_ms: 600000,
  max_event_age_ms: 900000,
  future_tolerance_ms: 60000,
};

add({
  id: TAB, type: "tab", label: "notificacoes_chegadas_residentes", disabled: false,
  info: "Consome somente a decisão canônica de localizacao_pessoas. Política, validações, lifecycle, dedupe, destinatário e produção/teste ficam visíveis. Testes manuais nunca enviam push.", env: [],
});

grouped(groups.input, {
  id: "resident_notifications_note", type: "comment", z: TAB, g: groups.input,
  name: "Padrões: near_home; dedupe 10 min; idade máx. 15 min; futuro 60 s. Sem restrição de horário.",
  info: "Limites: dedupe e idade entre 1 e 60 min; tolerância futura entre 0 e 5 min e menor que a idade máxima. Configuração inválida não substitui a última política persistente válida.", x: 520, y: 60, wires: [],
});
inject("resident_notifications_policy_default", groups.input, "CONFIG: aplicar padrões visuais", [{ p: "payload", v: JSON.stringify(policy), vt: "json" }], 230, 130, [["resident_notifications_policy_validate"]], { once: true, onceDelay: "1" });
fn("resident_notifications_policy_validate", groups.input, "Validar limites e relações", "resident-notifications-policy-validate.js", 1, 480, 130, [["resident_notifications_policy_switch"]]);
sw("resident_notifications_policy_switch", groups.input, "Configuração é válida?", "policy_valid", "msg", [{ t: "true" }, { t: "else" }], 700, 130, [["resident_notifications_policy_store"], ["resident_notifications_policy_reject"]]);
fn("resident_notifications_policy_store", groups.input, "Guardar última política válida", "resident-notifications-policy-store.js", 0, 940, 105, []);
fn("resident_notifications_policy_reject", groups.input, "Rejeitar sem substituir", "resident-notifications-policy-reject.js", 0, 940, 165, []);
linkIn("resident_notifications_canonical_in_v1", groups.input, "Receber decisão canônica de localização", "people_location_notification_out_v1", "resident_notifications_canonical_out", 150, 330);
linkOut("resident_notifications_canonical_out", groups.input, "Evento canônico → decisões", "resident_notifications_event_in", 570, 330);

linkIn("resident_notifications_event_in", groups.decision, "Receber evento real ou sintético", ["resident_notifications_canonical_out", "resident_notifications_test_event_out"], "resident_notifications_policy_load", 1150, 275);
fn("resident_notifications_policy_load", groups.decision, "Carregar política canônica", "resident-notifications-policy-load.js", 1, 1360, 275, [["resident_notifications_policy_available"]]);
sw("resident_notifications_policy_available", groups.decision, "Existe política válida?", "policy_available", "msg", [{ t: "true" }, { t: "else" }], 1570, 275, [["resident_notifications_source_switch"], ["resident_notifications_policy_missing"]]);
terminal("resident_notifications_policy_missing", groups.decision, "Falha fechada sem política", { fill: "red", shape: "ring", text: "política indisponível" }, 1790, 215);
sw("resident_notifications_source_switch", groups.decision, "Quem se aproxima?", "payload.source", "msg", [{ t: "eq", v: "resident_primary", vt: "str" }, { t: "eq", v: "resident_secondary", vt: "str" }, { t: "else" }], 1800, 300, [["resident_notifications_recipient_secondary"], ["resident_notifications_recipient_primary"], ["resident_notifications_source_invalid"]]);
change("resident_notifications_recipient_secondary", groups.decision, "Destinatário: resident_secondary", [{ t: "set", p: "resident_recipient", pt: "msg", to: "resident_secondary", tot: "str" }], 2050, 250, [["resident_notifications_prepare"]]);
change("resident_notifications_recipient_primary", groups.decision, "Destinatário: resident_primary", [{ t: "set", p: "resident_recipient", pt: "msg", to: "resident_primary", tot: "str" }], 2050, 315, [["resident_notifications_prepare"]]);
terminal("resident_notifications_source_invalid", groups.decision, "Ignorar origem desconhecida", { fill: "grey", shape: "ring", text: "origem não canônica" }, 2050, 380);
fn("resident_notifications_prepare", groups.decision, "Adaptar campos do evento", "resident-notifications-event-normalize.js", 1, 2310, 285, [["resident_notifications_states_switch"]]);
sw("resident_notifications_states_switch", groups.decision, "Estados atual e anterior estão disponíveis?", "resident_states_available", "msg", [{ t: "true" }, { t: "else" }], 2570, 285, [["resident_notifications_future_switch"], ["resident_notifications_state_unavailable"]]);
terminal("resident_notifications_state_unavailable", groups.decision, "Bloquear unknown/unavailable", { fill: "yellow", shape: "ring", text: "estado indisponível" }, 2820, 230);
sw("resident_notifications_future_switch", groups.decision, "Evento ultrapassa tolerância futura?", "event_at > $millis() + policy.future_tolerance_ms", "jsonata", [{ t: "true" }, { t: "else" }], 2880, 315, [["resident_notifications_future_terminal"], ["resident_notifications_stale_switch"]]);
terminal("resident_notifications_future_terminal", groups.decision, "Descartar evento futuro", { fill: "yellow", shape: "ring", text: "evento futuro descartado" }, 3190, 230);
sw("resident_notifications_stale_switch", groups.decision, "Evento excede idade máxima?", "$millis() - event_at > policy.max_event_age_ms", "jsonata", [{ t: "true" }, { t: "else" }], 3190, 345, [["resident_notifications_stale_terminal"], ["resident_notifications_state_read"]]);
terminal("resident_notifications_stale_terminal", groups.decision, "Descartar evento antigo", { fill: "yellow", shape: "ring", text: "evento antigo descartado" }, 3500, 240);
fn("resident_notifications_state_read", groups.decision, "Ler lifecycle e assinatura", "resident-notifications-state-read.js", 1, 3500, 355, [["resident_notifications_current_switch"]]);
sw("resident_notifications_current_switch", groups.decision, "Estado atual: fora, casa ou outra zona?", "resident_current", "msg", [{ t: "eq", v: "not_home", vt: "str" }, { t: "eq", v: "home", vt: "str" }, { t: "else" }], 3800, 355, [["resident_notifications_mark_rearm"], ["resident_notifications_mark_home"], ["resident_notifications_approach_switch"]]);
change("resident_notifications_mark_rearm", groups.decision, "Rearmar novo ciclo fora", [{ t: "set", p: "notification_state_action", pt: "msg", to: "rearm", tot: "str" }], 4100, 220, [["resident_notifications_rearm_out"]]);
linkOut("resident_notifications_rearm_out", groups.decision, "Rearmar → estado", "resident_notifications_state_update_in", 4350, 220);
change("resident_notifications_mark_home", groups.decision, "Encerrar ciclo em casa", [{ t: "set", p: "notification_state_action", pt: "msg", to: "home", tot: "str" }], 4100, 275, [["resident_notifications_home_out"]]);
linkOut("resident_notifications_home_out", groups.decision, "Em casa → estado", "resident_notifications_state_update_in", 4350, 275);
sw("resident_notifications_approach_switch", groups.decision, "Estado atual é a zona de aproximação?", "resident_current = policy.approach_zone", "jsonata", [{ t: "true" }, { t: "else" }], 4100, 385, [["resident_notifications_previous_switch"], ["resident_notifications_other_zone"]]);
terminal("resident_notifications_other_zone", groups.decision, "Outra zona — nenhum aviso", { fill: "grey", shape: "ring", text: "fora da zona de aproximação" }, 4360, 455);
sw("resident_notifications_previous_switch", groups.decision, "Veio diretamente de not_home?", "resident_previous", "msg", [{ t: "eq", v: "not_home", vt: "str" }, { t: "else" }], 4370, 385, [["resident_notifications_notified_switch"], ["resident_notifications_departure_terminal"]]);
terminal("resident_notifications_departure_terminal", groups.decision, "home → near_home é saída", { fill: "grey", shape: "ring", text: "saída não notificada" }, 4630, 455);
sw("resident_notifications_notified_switch", groups.decision, "Este ciclo já foi notificado?", "notification_previously_sent", "msg", [{ t: "true" }, { t: "else" }], 4640, 385, [["resident_notifications_notified_terminal"], ["resident_notifications_duplicate_switch"]]);
terminal("resident_notifications_notified_terminal", groups.decision, "Aviso do ciclo já entregue", { fill: "grey", shape: "ring", text: "ciclo já notificado" }, 4900, 455);
sw("resident_notifications_duplicate_switch", groups.decision, "Assinatura está no cooldown de 10 min?", "notification_duplicate", "msg", [{ t: "true" }, { t: "else" }], 4910, 385, [["resident_notifications_duplicate_terminal"], ["resident_notifications_mark_notified"]]);
terminal("resident_notifications_duplicate_terminal", groups.decision, "Duplicata descartada", { fill: "grey", shape: "ring", text: "evento duplicado" }, 5170, 455);
change("resident_notifications_mark_notified", groups.decision, "Marcar aviso no lifecycle", [{ t: "set", p: "notification_state_action", pt: "msg", to: "notified", tot: "str" }], 5170, 385, [["resident_notifications_notified_out"]]);
linkOut("resident_notifications_notified_out", groups.decision, "Aviso → estado", "resident_notifications_state_update_in", 5400, 385);
linkIn("resident_notifications_state_update_in", groups.decision, "Receber atualização de lifecycle", ["resident_notifications_rearm_out", "resident_notifications_home_out", "resident_notifications_notified_out"], "resident_notifications_state_write", 5380, 300);
fn("resident_notifications_state_write", groups.decision, "Persistir somente lifecycle", "resident-notifications-state-write.js", 1, 5580, 300, [["resident_notifications_state_action_switch"]]);
sw("resident_notifications_state_action_switch", groups.decision, "Atualização rearma, encerra ou autoriza aviso?", "notification_state_action", "msg", [{ t: "eq", v: "rearm", vt: "str" }, { t: "eq", v: "home", vt: "str" }, { t: "eq", v: "notified", vt: "str" }, { t: "else" }], 5840, 300, [["resident_notifications_rearmed_terminal"], ["resident_notifications_home_terminal"], ["resident_notifications_message_build"], ["resident_notifications_state_invalid"]]);
terminal("resident_notifications_rearmed_terminal", groups.decision, "Ciclo rearmado", { fill: "green", shape: "dot", text: "ciclo externo rearmado" }, 6100, 205);
terminal("resident_notifications_home_terminal", groups.decision, "Ciclo encerrado em casa", { fill: "green", shape: "dot", text: "ciclo em casa" }, 6100, 255);
fn("resident_notifications_message_build", groups.decision, "Montar envelope da notificação", "resident-notifications-message-build.js", 1, 6100, 335, [["resident_notifications_test_gate"]]);
terminal("resident_notifications_state_invalid", groups.decision, "Rejeitar ação de estado inválida", { fill: "red", shape: "ring", text: "ação de estado inválida" }, 6100, 455);
sw("resident_notifications_test_gate", groups.decision, "Notificação pertence a TESTE?", "_location_test", "msg", [{ t: "true" }, { t: "else" }], 6380, 335, [["resident_notifications_dry_run_out"], ["resident_notifications_recipient_switch"]]);
sw("resident_notifications_recipient_switch", groups.decision, "Entrega real: qual destinatário?", "resident_recipient", "msg", [{ t: "eq", v: "resident_primary", vt: "str" }, { t: "eq", v: "resident_secondary", vt: "str" }, { t: "else" }], 6380, 420, [["resident_notifications_primary_out"], ["resident_notifications_secondary_out"], ["resident_notifications_recipient_invalid"]]);
linkOut("resident_notifications_dry_run_out", groups.decision, "TESTE → terminal dry-run", "resident_notifications_dry_run_in", 6620, 320);
linkOut("resident_notifications_primary_out", groups.decision, "Produção → mobile_primary", "resident_notifications_primary_in", 6620, 390);
linkOut("resident_notifications_secondary_out", groups.decision, "Produção → mobile_secondary", "resident_notifications_secondary_in", 6620, 435);
terminal("resident_notifications_recipient_invalid", groups.decision, "Bloquear destinatário inválido", { fill: "red", shape: "ring", text: "destinatário inválido" }, 6380, 490);

linkIn("resident_notifications_primary_in", groups.output, "Receber aviso para resident_primary", "resident_notifications_primary_out", "resident_notifications_notify_primary", 6790, 150);
grouped(groups.output, {
  id: "resident_notifications_notify_primary", type: "api-call-service", z: TAB, g: groups.output,
  name: "EFEITO: avisar resident_primary", server: SERVER, version: 7, debugenabled: false,
  action: "public_bindings.call", floorId: [], areaId: [], deviceId: [], entityId: [], labelId: [],
  data: '{"role":"mobile_primary","action":"notify_actionable","data":{"title":"Casa inteligente","message":payload.message}}',
  dataType: "jsonata", mergeContext: "", mustacheAltTags: false, outputProperties: [],
  queue: "all", blockInputOverrides: true, domain: "public_bindings", service: "call",
  x: 7110, y: 150, wires: [["resident_notifications_delivery_ack"]],
});
linkIn("resident_notifications_secondary_in", groups.output, "Receber aviso para resident_secondary", "resident_notifications_secondary_out", "resident_notifications_notify_secondary", 6790, 260);
grouped(groups.output, {
  id: "resident_notifications_notify_secondary", type: "api-call-service", z: TAB, g: groups.output,
  name: "EFEITO: avisar resident_secondary", server: SERVER, version: 7, debugenabled: false,
  action: "public_bindings.call", floorId: [], areaId: [], deviceId: [], entityId: [], labelId: [],
  data: '{"role":"mobile_secondary","action":"notify_actionable","data":{"title":"Casa inteligente","message":payload.message}}',
  dataType: "jsonata", mergeContext: "", mustacheAltTags: false, outputProperties: [],
  queue: "all", blockInputOverrides: true, domain: "public_bindings", service: "call",
  x: 7110, y: 260, wires: [["resident_notifications_delivery_ack"]],
});
fn("resident_notifications_delivery_ack", groups.output, "Confirmar entrega de produção", "resident-notifications-delivery-ack.js", 0, 7530, 205, []);
grouped(groups.output, {
  id: "resident_notifications_output_note", type: "comment", z: TAB, g: groups.output,
  name: "Somente estas duas fronteiras enviam push; queue: all preserva eventos durante queda temporária do HA.",
  info: "Nenhum botão manual possui ligação com estes serviços.", x: 7360, y: 390, wires: [],
});

grouped(groups.test, {
  id: "resident_notifications_test_instructions", type: "comment", z: TAB, g: groups.test,
  name: "Ordem: reset → dois positivos → saída → unavailable → antigo → futuro → repetir positivo. Nenhum push é enviado.",
  info: "Os casos entram pela mesma política, normalização, validações temporais, lifecycle, dedupe, destinatário e gate final da produção.", x: 940, y: 620, wires: [],
});
inject("resident_notifications_test_reset", groups.test, "TESTE 1: reset", [{ p: "_location_test", v: "true", vt: "bool" }], 180, 690, [["resident_notifications_reset_test"]]);
fn("resident_notifications_reset_test", groups.test, "Resetar lifecycle sintético", "resident-notifications-reset-test.js", 0, 430, 690, []);
inject("resident_notifications_test_primary", groups.test, "TESTE 2: avisaria resident_primary", [{ p: "test_source", v: "resident_secondary", vt: "str" }], 210, 760, [["resident_notifications_test_adapter"]]);
inject("resident_notifications_test_secondary", groups.test, "TESTE 3: avisaria resident_secondary", [{ p: "test_source", v: "resident_primary", vt: "str" }], 220, 815, [["resident_notifications_test_adapter"]]);
inject("resident_notifications_test_departure", groups.test, "TESTE 4: home → near_home", [{ p: "test_case", v: "departure", vt: "str" }], 200, 870, [["resident_notifications_test_adapter"]]);
inject("resident_notifications_test_unavailable", groups.test, "TESTE 5: previous unavailable", [{ p: "test_case", v: "unavailable", vt: "str" }], 205, 925, [["resident_notifications_test_adapter"]]);
inject("resident_notifications_test_stale", groups.test, "TESTE 6: evento antigo", [{ p: "test_case", v: "stale", vt: "str" }], 190, 980, [["resident_notifications_test_adapter"]]);
inject("resident_notifications_test_future", groups.test, "TESTE 7: evento futuro", [{ p: "test_case", v: "future", vt: "str" }], 190, 1035, [["resident_notifications_test_adapter"]]);
linkIn("resident_notifications_test_cycle_in", groups.test, "Receber teste de localizacao_pessoas", "bc2afbce89f5a9d5", "resident_notifications_test_adapter", 590, 760);
fn("resident_notifications_test_adapter", groups.test, "Adaptar cenário sintético", "resident-notifications-test-adapter.js", 1, 650, 900, [["resident_notifications_test_event_out"]]);
linkOut("resident_notifications_test_event_out", groups.test, "Cenário TESTE → decisões reais", "resident_notifications_event_in", 930, 900);
linkIn("resident_notifications_dry_run_in", groups.test, "Receber notificação TESTE", "resident_notifications_dry_run_out", "resident_notifications_dry_run_terminal", 1230, 760);
fn("resident_notifications_dry_run_terminal", groups.test, "TESTE FINAL: nenhum push enviado", "resident-notifications-dry-run.js", 0, 1520, 760, []);

next.push(...nodes);
for (const [linkNode, target] of [
  [peopleOut, "resident_notifications_canonical_in_v1"],
  [peopleTestOut, "resident_notifications_test_cycle_in"],
]) {
  linkNode.links ??= [];
  if (!linkNode.links.includes(target)) linkNode.links.push(target);
}
fs.writeFileSync(outputPath, `${JSON.stringify(next, null, 4)}\n`);
console.log(`Resident notification visual flow installed in ${outputPath}`);
