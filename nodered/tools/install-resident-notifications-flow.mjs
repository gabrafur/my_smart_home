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
  config: group("resident_notifications_config_group", "0. PARÂMETROS AJUSTÁVEIS — aviso de chegada", 64, 40, 1300, 450, "#2563eb", "#dbeafe"),
  input: group("resident_notifications_input_group", "1. Entrada do evento canônico", 1370, 40, 1360, 450, "#0f766e", "#ccfbf1"),
  decision: group("resident_notifications_decision_group", "2. Validação da chegada e destinatário", 2780, 40, 1950, 450, "#7c3aed", "#ede9fe"),
  state: group("resident_notifications_state_group", "3. Frescor, reserva e deduplicação da entrega", 4730, 40, 1650, 450, "#b45309", "#fef3c7"),
  output: group("resident_notifications_output_group", "4. Gate final, efeitos e retry", 6430, 40, 1900, 450, "#dc2626", "#fee2e2"),
  test: group("resident_notifications_test_group", "5. Replay manual completo — sempre dry-run", 64, 560, 2900, 610, "#0891b2", "#cffafe"),
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
const delay = (id, g, name, x, y, wires) => grouped(g, {
  id, type: "delay", z: TAB, g, name, pauseType: "delayv", timeout: "60",
  timeoutUnits: "seconds", rate: "1", nbRateUnits: "1", rateUnits: "second",
  randomFirst: "1", randomLast: "5", randomUnits: "seconds", drop: false,
  allowrate: false, outputs: 1, x, y, wires,
});
const policy = {
  dedupe_ttl_ms: 600000,
  max_event_age_ms: 900000,
  future_tolerance_ms: 60000,
  service_retry_seconds: 60,
};

add({
  id: TAB, type: "tab", label: "notificacoes_chegadas_residentes", disabled: false,
  info: "Consome somente security.arrival.v1 já decidido por localizacao_pessoas. Este tab valida o contrato, escolhe o destinatário, garante entrega idempotente e separa produção/teste. Testes manuais nunca enviam push.", env: [],
});

grouped(groups.config, {
  id: "resident_notifications_note", type: "comment", z: TAB, g: groups.config,
  name: "Duplo clique para editar; defaults e limites estão em cada bloco",
  info: "Os quatro valores formam uma única política. Após o deploy, o join acumula os valores e alterações individuais também recompõem a política. Inválidos não substituem a última versão válida.", x: 650, y: 80, wires: [],
});
for (const [id, name, topic, value, y] of [
  ["resident_notifications_policy_dedupe", "Dedupe da entrega — padrão 10 min [1..60]", "dedupe_ttl_ms", policy.dedupe_ttl_ms, 150],
  ["resident_notifications_policy_age", "Idade máxima — padrão 15 min [1..60]", "max_event_age_ms", policy.max_event_age_ms, 210],
  ["resident_notifications_policy_future", "Tolerância futura — padrão 60 s [0..300]", "future_tolerance_ms", policy.future_tolerance_ms, 270],
  ["resident_notifications_policy_retry", "Retry do serviço — padrão 60 s [10..600]", "service_retry_seconds", policy.service_retry_seconds, 330],
]) inject(id, groups.config, name, [{ p: "payload", v: String(value), vt: "num" }, { p: "topic", v: topic, vt: "str" }], 250, y, [["resident_notifications_policy_join"]], { once: true, onceDelay: "1" });
grouped(groups.config, {
  id: "resident_notifications_policy_join", type: "join", z: TAB, g: groups.config,
  name: "Reunir política única", mode: "custom", build: "object", property: "payload",
  propertyType: "msg", key: "topic", joiner: "\\n", joinerType: "str",
  accumulate: true, timeout: "", count: "4", reduceRight: false, reduceExp: "",
  reduceInit: "", reduceInitType: "", reduceFixup: "", x: 570, y: 240,
  wires: [["resident_notifications_policy_validate"]],
});
fn("resident_notifications_policy_validate", groups.config, "Validar unidades, limites e relações", "resident-notifications-policy-validate.js", 1, 800, 240, [["resident_notifications_policy_switch"]]);
sw("resident_notifications_policy_switch", groups.config, "Configuração completa é válida?", "policy_valid", "msg", [{ t: "true" }, { t: "else" }], 1060, 240, [["resident_notifications_policy_store"], ["resident_notifications_policy_reject"]]);
fn("resident_notifications_policy_store", groups.config, "Guardar última política válida", "resident-notifications-policy-store.js", 0, 1220, 190, []);
fn("resident_notifications_policy_reject", groups.config, "Rejeitar sem substituir", "resident-notifications-policy-reject.js", 0, 1220, 290, []);

linkIn("resident_notifications_canonical_in_v1", groups.input, "Receber security.arrival.v1", "people_location_notification_out_v1", "resident_notifications_prepare", 1420, 240);
fn("resident_notifications_prepare", groups.input, "Adaptar estrutura do contrato", "resident-notifications-event-normalize.js", 1, 1640, 240, [["resident_notifications_contract_switch"]]);
sw("resident_notifications_contract_switch", groups.input, "Contrato é security.arrival.v1?", "arrival_contract_valid", "msg", [{ t: "true" }, { t: "else" }], 1880, 200, [["resident_notifications_kind_switch"], ["resident_notifications_contract_invalid"]]);
terminal("resident_notifications_contract_invalid", groups.input, "Bloquear contrato desconhecido", { fill: "red", shape: "ring", text: "contrato inválido" }, 2140, 130);
sw("resident_notifications_kind_switch", groups.input, "É chegada de pessoa?", "arrival_kind_valid", "msg", [{ t: "true" }, { t: "else" }], 2140, 240, [["resident_notifications_canonical_out"], ["resident_notifications_kind_invalid"]]);
terminal("resident_notifications_kind_invalid", groups.input, "Bloquear tipo não compatível", { fill: "grey", shape: "ring", text: "não é chegada de pessoa" }, 2400, 330);
linkOut("resident_notifications_canonical_out", groups.input, "Contrato válido → direção", "resident_notifications_event_in", 2610, 240);

linkIn("resident_notifications_event_in", groups.decision, "Receber chegada real ou sintética", ["resident_notifications_canonical_out", "resident_notifications_test_event_out"], "resident_notifications_policy_load", 2830, 240);
fn("resident_notifications_policy_load", groups.decision, "Carregar política canônica", "resident-notifications-policy-load.js", 1, 3030, 240, [["resident_notifications_policy_available"]]);
sw("resident_notifications_policy_available", groups.decision, "Existe política válida?", "policy_available", "msg", [{ t: "true" }, { t: "else" }], 3250, 200, [["resident_notifications_direction_switch"], ["resident_notifications_policy_missing"]]);
terminal("resident_notifications_policy_missing", groups.decision, "Falha fechada sem política", { fill: "red", shape: "ring", text: "política indisponível" }, 3490, 120);
sw("resident_notifications_direction_switch", groups.decision, "Direção é returning?", "arrival_returning", "msg", [{ t: "true" }, { t: "else" }], 3530, 240, [["resident_notifications_cycle_switch"], ["resident_notifications_direction_invalid"]]);
terminal("resident_notifications_direction_invalid", groups.decision, "Bloquear saída ou direção desconhecida", { fill: "grey", shape: "ring", text: "não é retorno" }, 3810, 120);
sw("resident_notifications_cycle_switch", groups.decision, "Ciclo externo foi confirmado?", "arrival_external_cycle_confirmed", "msg", [{ t: "true" }, { t: "else" }], 3810, 240, [["resident_notifications_stage_switch"], ["resident_notifications_cycle_invalid"]]);
terminal("resident_notifications_cycle_invalid", groups.decision, "Bloquear chegada sem ciclo externo", { fill: "yellow", shape: "ring", text: "ciclo externo não confirmado" }, 4090, 120);
sw("resident_notifications_stage_switch", groups.decision, "Etapa é approach ou home?", "arrival_stage", "msg", [{ t: "eq", v: "approach", vt: "str" }, { t: "eq", v: "home", vt: "str" }, { t: "else" }], 4090, 240, [["resident_notifications_source_switch"], ["resident_notifications_source_switch"], ["resident_notifications_stage_invalid"]]);
terminal("resident_notifications_stage_invalid", groups.decision, "Bloquear etapa desconhecida", { fill: "grey", shape: "ring", text: "etapa inválida" }, 4370, 120);
sw("resident_notifications_source_switch", groups.decision, "Quem está chegando?", "resident_source", "msg", [{ t: "eq", v: "resident_primary", vt: "str" }, { t: "eq", v: "resident_secondary", vt: "str" }, { t: "else" }], 4370, 260, [["resident_notifications_recipient_secondary"], ["resident_notifications_recipient_primary"], ["resident_notifications_source_invalid"]]);
change("resident_notifications_recipient_secondary", groups.decision, "Destinatário: resident_secondary", [{ t: "set", p: "resident_recipient", pt: "msg", to: "resident_secondary", tot: "str" }], 4590, 180, [["resident_notifications_decision_out"]]);
change("resident_notifications_recipient_primary", groups.decision, "Destinatário: resident_primary", [{ t: "set", p: "resident_recipient", pt: "msg", to: "resident_primary", tot: "str" }], 4590, 340, [["resident_notifications_decision_out"]]);
terminal("resident_notifications_source_invalid", groups.decision, "Ignorar origem desconhecida", { fill: "grey", shape: "ring", text: "origem não canônica" }, 4370, 400);
linkOut("resident_notifications_decision_out", groups.decision, "Chegada válida → frescor e entrega", "resident_notifications_state_in", 4710, 260);

linkIn("resident_notifications_state_in", groups.state, "Receber chegada validada", "resident_notifications_decision_out", "resident_notifications_event_time_switch", 4780, 240);
linkIn("resident_notifications_retry_in", groups.state, "Receber retry do serviço", "resident_notifications_retry_out", "resident_notifications_state_read", 5580, 400);
sw("resident_notifications_event_time_switch", groups.state, "Timestamp canônico é válido?", "arrival_event_time_valid", "msg", [{ t: "true" }, { t: "else" }], 5000, 200, [["resident_notifications_future_switch"], ["resident_notifications_time_invalid"]]);
terminal("resident_notifications_time_invalid", groups.state, "Bloquear timestamp inválido", { fill: "yellow", shape: "ring", text: "timestamp inválido" }, 5280, 110);
sw("resident_notifications_future_switch", groups.state, "Evento ultrapassa tolerância futura?", "event_at > $millis() + policy.future_tolerance_ms", "jsonata", [{ t: "true" }, { t: "else" }], 5280, 220, [["resident_notifications_future_terminal"], ["resident_notifications_stale_switch"]]);
terminal("resident_notifications_future_terminal", groups.state, "Descartar evento futuro", { fill: "yellow", shape: "ring", text: "evento futuro descartado" }, 5560, 110);
sw("resident_notifications_stale_switch", groups.state, "Evento excede idade máxima?", "$millis() - event_at > policy.max_event_age_ms", "jsonata", [{ t: "true" }, { t: "else" }], 5560, 240, [["resident_notifications_stale_terminal"], ["resident_notifications_state_read"]]);
terminal("resident_notifications_stale_terminal", groups.state, "Descartar evento antigo", { fill: "yellow", shape: "ring", text: "evento antigo descartado" }, 5840, 110);
fn("resident_notifications_state_read", groups.state, "Ler recibo e reserva de entrega", "resident-notifications-state-read.js", 1, 5840, 260, [["resident_notifications_duplicate_switch"]]);
sw("resident_notifications_duplicate_switch", groups.state, "Entrega já ocorreu ou está reservada?", "notification_duplicate", "msg", [{ t: "true" }, { t: "else" }], 6120, 260, [["resident_notifications_duplicate_terminal"], ["resident_notifications_state_write"]]);
terminal("resident_notifications_duplicate_terminal", groups.state, "Duplicata descartada", { fill: "grey", shape: "ring", text: "entrega duplicada" }, 6120, 150);
fn("resident_notifications_state_write", groups.state, "Reservar entrega antes do efeito", "resident-notifications-state-write.js", 1, 6120, 350, [["resident_notifications_delivery_out"]]);
linkOut("resident_notifications_delivery_out", groups.state, "Entrega reservada → gate final", "resident_notifications_delivery_in", 6340, 350);

linkIn("resident_notifications_delivery_in", groups.output, "Receber entrega reservada", "resident_notifications_delivery_out", "resident_notifications_message_build", 6480, 240);
fn("resident_notifications_message_build", groups.output, "Montar envelope da notificação", "resident-notifications-message-build.js", 1, 6700, 240, [["resident_notifications_test_gate"]]);
sw("resident_notifications_test_gate", groups.output, "Notificação pertence a TESTE?", "_location_test", "msg", [{ t: "true" }, { t: "else" }], 6960, 240, [["resident_notifications_dry_run_out"], ["resident_notifications_recipient_switch"]]);
linkOut("resident_notifications_dry_run_out", groups.output, "TESTE → terminal dry-run", "resident_notifications_dry_run_in", 7160, 150);
sw("resident_notifications_recipient_switch", groups.output, "Entrega real: qual destinatário?", "resident_recipient", "msg", [{ t: "eq", v: "resident_primary", vt: "str" }, { t: "eq", v: "resident_secondary", vt: "str" }, { t: "else" }], 7180, 280, [["resident_notifications_primary_out"], ["resident_notifications_secondary_out"], ["resident_notifications_recipient_invalid"]]);
linkOut("resident_notifications_primary_out", groups.output, "Produção → mobile_primary", "resident_notifications_primary_in", 7390, 230);
linkOut("resident_notifications_secondary_out", groups.output, "Produção → mobile_secondary", "resident_notifications_secondary_in", 7390, 310);
terminal("resident_notifications_recipient_invalid", groups.output, "Bloquear destinatário inválido", { fill: "red", shape: "ring", text: "destinatário inválido" }, 7390, 130);

linkIn("resident_notifications_primary_in", groups.output, "Receber aviso para resident_primary", "resident_notifications_primary_out", "resident_notifications_notify_primary", 7480, 230);
grouped(groups.output, {
  id: "resident_notifications_notify_primary", type: "api-call-service", z: TAB, g: groups.output,
  name: "EFEITO: avisar resident_primary", server: SERVER, version: 7, debugenabled: false,
  action: "public_bindings.call", floorId: [], areaId: [], deviceId: [], entityId: [], labelId: [],
  data: '{"role":"mobile_primary","action":"notify_actionable","data":{"title":"Casa inteligente","message":payload.message}}',
  dataType: "jsonata", mergeContext: "", mustacheAltTags: false, outputProperties: [],
  queue: "all", blockInputOverrides: true, domain: "public_bindings", service: "call",
  x: 7720, y: 230, wires: [["resident_notifications_delivery_ack"]],
});
linkIn("resident_notifications_secondary_in", groups.output, "Receber aviso para resident_secondary", "resident_notifications_secondary_out", "resident_notifications_notify_secondary", 7480, 310);
grouped(groups.output, {
  id: "resident_notifications_notify_secondary", type: "api-call-service", z: TAB, g: groups.output,
  name: "EFEITO: avisar resident_secondary", server: SERVER, version: 7, debugenabled: false,
  action: "public_bindings.call", floorId: [], areaId: [], deviceId: [], entityId: [], labelId: [],
  data: '{"role":"mobile_secondary","action":"notify_actionable","data":{"title":"Casa inteligente","message":payload.message}}',
  dataType: "jsonata", mergeContext: "", mustacheAltTags: false, outputProperties: [],
  queue: "all", blockInputOverrides: true, domain: "public_bindings", service: "call",
  x: 7720, y: 310, wires: [["resident_notifications_delivery_ack"]],
});
fn("resident_notifications_delivery_ack", groups.output, "Confirmar recibo persistente", "resident-notifications-delivery-ack.js", 0, 8040, 270, []);
grouped(groups.output, {
  id: "resident_notifications_delivery_catch", type: "catch", z: TAB, g: groups.output,
  name: "Capturar falha dos dois serviços", scope: ["resident_notifications_notify_primary", "resident_notifications_notify_secondary"],
  uncaught: false, x: 7200, y: 410, wires: [["resident_notifications_delivery_failure"]],
});
fn("resident_notifications_delivery_failure", groups.output, "Liberar reserva e limitar tentativas", "resident-notifications-delivery-failure.js", 1, 7490, 410, [["resident_notifications_retry_switch"]]);
sw("resident_notifications_retry_switch", groups.output, "Ainda restam tentativas?", "notification_retry_allowed", "msg", [{ t: "true" }, { t: "else" }], 7770, 410, [["resident_notifications_retry_delay"], ["resident_notifications_retry_exhausted"]]);
delay("resident_notifications_retry_delay", groups.output, "Aguardar retry da política", 8010, 360, [["resident_notifications_retry_out"]]);
linkOut("resident_notifications_retry_out", groups.output, "Retry → dedupe da entrega", "resident_notifications_retry_in", 8280, 360);
terminal("resident_notifications_retry_exhausted", groups.output, "Falha após três tentativas", { fill: "red", shape: "ring", text: "retry esgotado" }, 8010, 450);
grouped(groups.output, {
  id: "resident_notifications_output_note", type: "comment", z: TAB, g: groups.output,
  name: "Somente estas duas fronteiras enviam push; sucesso grava recibo, falha libera a reserva e tenta novamente.",
  info: "queue: all preserva eventos durante queda temporária do HA. Nenhum botão manual possui ligação com estes serviços.", x: 7300, y: 80, wires: [],
});

grouped(groups.test, {
  id: "resident_notifications_test_instructions", type: "comment", z: TAB, g: groups.test,
  name: "Ordem: reset → approach → home direto → outro residente → direção inválida → stale → futuro → duplicata. Nenhum push é enviado.",
  info: "Os casos usam security.arrival.v1 e percorrem contrato, direção, ciclo externo, etapa, frescor, reserva, dedupe, destinatário e gate final da produção.", x: 1350, y: 610, wires: [],
});
inject("resident_notifications_test_reset", groups.test, "TESTE 1: reset", [{ p: "_location_test", v: "true", vt: "bool" }], 190, 680, [["resident_notifications_reset_test"]]);
fn("resident_notifications_reset_test", groups.test, "Resetar recibos sintéticos", "resident-notifications-reset-test.js", 0, 450, 680, []);
inject("resident_notifications_test_primary", groups.test, "TESTE 2: secondary em approach → primary", [{ p: "test_source", v: "resident_secondary", vt: "str" }], 250, 750, [["resident_notifications_test_adapter"]]);
inject("resident_notifications_test_home", groups.test, "TESTE 3: secondary direto em home → primary", [{ p: "test_case", v: "direct_home", vt: "str" }], 250, 805, [["resident_notifications_test_adapter"]]);
inject("resident_notifications_test_secondary", groups.test, "TESTE 4: primary em approach → secondary", [{ p: "test_source", v: "resident_primary", vt: "str" }], 250, 860, [["resident_notifications_test_adapter"]]);
inject("resident_notifications_test_direction", groups.test, "TESTE 5: direção de saída bloqueada", [{ p: "test_case", v: "invalid_direction", vt: "str" }], 230, 915, [["resident_notifications_test_adapter"]]);
inject("resident_notifications_test_unavailable", groups.test, "TESTE 6: ciclo externo não confirmado", [{ p: "test_case", v: "unavailable", vt: "str" }], 240, 970, [["resident_notifications_test_adapter"]]);
inject("resident_notifications_test_stale", groups.test, "TESTE 7: evento antigo", [{ p: "test_case", v: "stale", vt: "str" }], 200, 1025, [["resident_notifications_test_adapter"]]);
inject("resident_notifications_test_future", groups.test, "TESTE 8: evento futuro", [{ p: "test_case", v: "future", vt: "str" }], 200, 1080, [["resident_notifications_test_adapter"]]);
inject("resident_notifications_test_duplicate", groups.test, "TESTE 9: repetir última chegada", [{ p: "test_case", v: "duplicate", vt: "str" }], 220, 1130, [["resident_notifications_test_adapter"]]);
linkIn("resident_notifications_test_cycle_in", groups.test, "Receber teste de localizacao_pessoas", "bc2afbce89f5a9d5", "resident_notifications_test_adapter", 620, 750);
fn("resident_notifications_test_adapter", groups.test, "Adaptar somente cenário sintético", "resident-notifications-test-adapter.js", 1, 670, 920, [["resident_notifications_test_event_out"]]);
linkOut("resident_notifications_test_event_out", groups.test, "security.arrival.v1 de TESTE → caminho real", "resident_notifications_event_in", 1040, 920);
linkIn("resident_notifications_dry_run_in", groups.test, "Receber notificação TESTE", "resident_notifications_dry_run_out", "resident_notifications_dry_run_terminal", 1430, 780);
fn("resident_notifications_dry_run_terminal", groups.test, "TESTE FINAL: nenhum push enviado", "resident-notifications-dry-run.js", 0, 1730, 780, []);

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
