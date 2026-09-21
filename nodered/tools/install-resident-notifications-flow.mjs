#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installNotificationHubs } from "./install-notification-hubs.mjs";
import { reconcileGeneratedFlows } from "./reconcile-generated-flows.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.resolve(process.argv[2] ?? path.resolve(here, "..", "flows.json"));
const outputPath = path.resolve(process.argv[3] ?? sourcePath);
const functionsDir = path.join(here, "functions");
const TAB = "resident_notifications_tab";
const SERVER = "4126427d5e161a03";
const flows = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
const originalFlows = structuredClone(flows);
const source = (name) => fs.readFileSync(path.join(functionsDir, name), "utf8").trimEnd();
const isObserverCoverage = (id) => typeof id === "string" && id.startsWith("global_observer_coverage__");
const owned = (node) => node.id === TAB ||
  (node.z === TAB && !isObserverCoverage(node.id)) ||
  node.id.startsWith("resident_notifications_");
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
  decision: group("resident_notifications_decision_group", "2. Validar contrato, direção e ciclo", 2780, 40, 1550, 450, "#7c3aed", "#ede9fe"),
  confirmation: group("resident_notifications_confirmation_group", "3. Confirmar HOME contínuo antes de afirmar chegada", 4380, 40, 3000, 450, "#0e7490", "#cffafe"),
  state: group("resident_notifications_state_group", "4. Frescor, reserva e deduplicação da entrega", 7430, 40, 1700, 450, "#b45309", "#fef3c7"),
  output: group("resident_notifications_output_group", "5. Gate final, efeitos e retry", 9180, 40, 1900, 450, "#dc2626", "#fee2e2"),
  test: group("resident_notifications_test_group", "5. Replay dry-run + teste explícito de entrega", 64, 560, 2900, 680, "#0891b2", "#cffafe"),
};
const grouped = (g, node) => { add(node); nodes.find((entry) => entry.id === g).nodes.push(node.id); return node.id; };
const fn = (id, g, name, file, outputs, x, y, wires, extra = {}) => grouped(g, {
  id, type: "function", z: TAB, g, name, func: source(file), outputs,
  timeout: 0, noerr: 0, initialize: "", finalize: "", libs: [], x, y, wires,
  ...extra,
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
const sw = (id, g, name, property, propertyType, rules, x, y, wires, extra = {}) => grouped(g, {
  id, type: "switch", z: TAB, g, name, property, propertyType, rules,
  checkall: "true", repair: false, outputs: rules.length, x, y, wires,
  ...extra,
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
const currentState = (id, g, name, entityId, x, y, wires) => grouped(g, {
  id, type: "api-current-state", z: TAB, g, name, server: SERVER, version: 3,
  outputs: 1, halt_if: "", halt_if_type: "str", halt_if_compare: "is",
  entity_id: entityId, state_type: "str", blockInputOverrides: true,
  outputProperties: [
    { property: "home_confirmation_state", propertyType: "msg", value: "", valueType: "entityState" },
    { property: "home_confirmation_entity", propertyType: "msg", value: "", valueType: "entity" },
  ],
  for: "0", forType: "num", forUnits: "seconds", override_topic: false,
  state_location: "home_confirmation_state", override_payload: "none",
  entity_location: "home_confirmation_entity", override_data: "none",
  x, y, wires,
});
const policy = {
  dedupe_ttl_ms: 600000,
  max_event_age_ms: 900000,
  future_tolerance_ms: 60000,
  service_retry_seconds: 60,
  home_confirmation_seconds: 90,
  home_confirmation_window_seconds: 300,
  home_confirmation_recheck_seconds: 30,
};

add({
  id: TAB, type: "tab", label: "notificacoes_chegadas_residentes", disabled: false,
  info: "Consome somente security.arrival.v1 já decidido por localizacao_pessoas. Antes de afirmar que alguém chegou em casa, exige HOME contínuo e localização fresca; oscilações near_home reiniciam a confirmação dentro de uma janela limitada. Encaminha cada chegada somente ao outro morador (resident_primary → mobile_secondary; resident_secondary → mobile_primary), registra o aceite do Home Assistant e separa produção/teste. Os replays manuais são dry-run; somente o botão explicitamente marcado envia um push TESTE ao mobile_secondary.", env: [],
});

grouped(groups.config, {
  id: "resident_notifications_note", type: "comment", z: TAB, g: groups.config,
  name: "Duplo clique para editar; defaults e limites estão em cada bloco",
  info: "Os sete valores formam uma única política. Após o deploy, o join acumula os valores e alterações individuais também recompõem a política. Inválidos não substituem a última versão válida.", x: 650, y: 80, wires: [],
});
for (const [id, name, topic, value, x, y] of [
  ["resident_notifications_policy_dedupe", "Dedupe da entrega — padrão 10 min [1..60]", "dedupe_ttl_ms", policy.dedupe_ttl_ms, 250, 150],
  ["resident_notifications_policy_age", "Idade máxima — padrão 15 min [1..60]", "max_event_age_ms", policy.max_event_age_ms, 250, 210],
  ["resident_notifications_policy_future", "Tolerância futura — padrão 60 s [0..300]", "future_tolerance_ms", policy.future_tolerance_ms, 250, 270],
  ["resident_notifications_policy_retry", "Retry do serviço — padrão 60 s [10..600]", "service_retry_seconds", policy.service_retry_seconds, 250, 330],
  ["resident_notifications_policy_home_stable", "HOME contínuo — padrão 90 s [30..300]", "home_confirmation_seconds", policy.home_confirmation_seconds, 570, 160],
  ["resident_notifications_policy_home_window", "Janela de confirmação — padrão 300 s [90..900]", "home_confirmation_window_seconds", policy.home_confirmation_window_seconds, 570, 240],
  ["resident_notifications_policy_home_recheck", "Rechecagem — padrão 30 s [10..60]", "home_confirmation_recheck_seconds", policy.home_confirmation_recheck_seconds, 570, 320],
]) inject(id, groups.config, name, [{ p: "payload", v: String(value), vt: "num" }, { p: "topic", v: topic, vt: "str" }], x === 250 ? 200 : 500, y, [["resident_notifications_policy_join"]], { once: true, onceDelay: "1", w: 200 });
grouped(groups.config, {
  id: "resident_notifications_policy_join", type: "join", z: TAB, g: groups.config,
  name: "Reunir política única", mode: "custom", build: "object", property: "payload",
  propertyType: "msg", key: "topic", joiner: "\\n", joinerType: "str",
  accumulate: true, timeout: "", count: "7", reduceRight: false, reduceExp: "",
  reduceInit: "", reduceInitType: "", reduceFixup: "", x: 750, y: 240, w: 100,
  wires: [["resident_notifications_policy_validate"]],
});
fn("resident_notifications_policy_validate", groups.config, "Validar unidades, limites e relações", "resident-notifications-policy-validate.js", 1, 970, 160, [["resident_notifications_policy_switch"]], { w: 160 });
sw("resident_notifications_policy_switch", groups.config, "Configuração completa é válida?", "policy_valid", "msg", [{ t: "true" }, { t: "else" }], 970, 320, [["resident_notifications_policy_store"], ["resident_notifications_policy_reject"]], { w: 160 });
fn("resident_notifications_policy_store", groups.config, "Guardar última política válida", "resident-notifications-policy-store.js", 0, 1230, 160, [], { w: 160 });
fn("resident_notifications_policy_reject", groups.config, "Rejeitar sem substituir", "resident-notifications-policy-reject.js", 0, 1230, 320, [], { w: 160 });

linkIn("resident_notifications_canonical_in_v1", groups.input, "Receber security.arrival.v1 real ou sintético", ["people_location_notification_out_v1", "resident_notifications_test_event_out"], "resident_notifications_prepare", 1420, 240);
fn("resident_notifications_prepare", groups.input, "Adaptar estrutura do contrato", "resident-notifications-event-normalize.js", 1, 1640, 240, [["resident_notifications_contract_switch"]]);
sw("resident_notifications_contract_switch", groups.input, "Contrato é security.arrival.v1?", "arrival_contract_valid", "msg", [{ t: "true" }, { t: "else" }], 1880, 200, [["resident_notifications_kind_switch"], ["resident_notifications_contract_invalid"]]);
terminal("resident_notifications_contract_invalid", groups.input, "Bloquear contrato desconhecido", { fill: "red", shape: "ring", text: "contrato inválido" }, 2140, 130);
sw("resident_notifications_kind_switch", groups.input, "É chegada de pessoa?", "arrival_kind_valid", "msg", [{ t: "true" }, { t: "else" }], 2140, 240, [["resident_notifications_canonical_out"], ["resident_notifications_kind_invalid"]]);
terminal("resident_notifications_kind_invalid", groups.input, "Bloquear tipo não compatível", { fill: "grey", shape: "ring", text: "não é chegada de pessoa" }, 2400, 330);
linkOut("resident_notifications_canonical_out", groups.input, "Contrato válido → direção", "resident_notifications_event_in", 2610, 240);

linkIn("resident_notifications_event_in", groups.decision, "Receber chegada normalizada", "resident_notifications_canonical_out", "resident_notifications_policy_load", 2830, 240);
fn("resident_notifications_policy_load", groups.decision, "Carregar política canônica", "resident-notifications-policy-load.js", 1, 3030, 240, [["resident_notifications_policy_available"]]);
sw("resident_notifications_policy_available", groups.decision, "Existe política válida?", "policy_available", "msg", [{ t: "true" }, { t: "else" }], 3250, 200, [["resident_notifications_direction_switch"], ["resident_notifications_policy_missing"]]);
terminal("resident_notifications_policy_missing", groups.decision, "Falha fechada sem política", { fill: "red", shape: "ring", text: "política indisponível" }, 3490, 120);
sw("resident_notifications_direction_switch", groups.decision, "Direção é returning?", "arrival_returning", "msg", [{ t: "true" }, { t: "else" }], 3500, 240, [["resident_notifications_cycle_switch"], ["resident_notifications_direction_invalid"]], { w: 180 });
terminal("resident_notifications_direction_invalid", groups.decision, "Bloquear saída ou direção desconhecida", { fill: "grey", shape: "ring", text: "não é retorno" }, 3810, 120);
sw("resident_notifications_cycle_switch", groups.decision, "Ciclo de retorno foi confirmado?", "arrival_cycle_confirmed", "msg", [{ t: "true" }, { t: "else" }], 3750, 240, [["resident_notifications_stage_switch"], ["resident_notifications_cycle_invalid"]], { w: 180 });
terminal("resident_notifications_cycle_invalid", groups.decision, "Bloquear chegada sem ciclo confirmado", { fill: "yellow", shape: "ring", text: "ciclo de retorno não confirmado" }, 4090, 120);
sw("resident_notifications_stage_switch", groups.decision, "Etapa é approach, retorno local ou home?", "arrival_stage", "msg", [{ t: "eq", v: "approach", vt: "str" }, { t: "eq", v: "local_return", vt: "str" }, { t: "eq", v: "home", vt: "str" }, { t: "else" }], 4050, 250, [["resident_notifications_confirmation_bypass_out"], ["resident_notifications_confirmation_bypass_out"], ["resident_notifications_home_candidate_out"], ["resident_notifications_stage_invalid"]], { w: 190 });
linkOut("resident_notifications_confirmation_bypass_out", groups.decision, "Approach válido → destinatário", "resident_notifications_confirmation_routing_in", 4240, 190);
linkOut("resident_notifications_home_candidate_out", groups.decision, "HOME candidato → confirmar", "resident_notifications_home_candidate_in", 4240, 300);
terminal("resident_notifications_stage_invalid", groups.decision, "Bloquear etapa desconhecida", { fill: "grey", shape: "ring", text: "etapa inválida" }, 4210, 400);

linkIn("resident_notifications_home_candidate_in", groups.confirmation, "Receber HOME candidato", "resident_notifications_home_candidate_out", "resident_notifications_home_confirmation_prepare", 4450, 220);
linkIn("resident_notifications_home_confirmation_retry_in", groups.confirmation, "Reavaliar HOME dentro da janela", "resident_notifications_home_confirmation_retry_out", "resident_notifications_home_confirmation_delay", 4470, 360);
fn("resident_notifications_home_confirmation_prepare", groups.confirmation, "Iniciar janela de HOME contínuo", "resident-notifications-home-confirmation-prepare.js", 1, 4680, 220, [["resident_notifications_home_confirmation_delay"]], { w: 190 });
delay("resident_notifications_home_confirmation_delay", groups.confirmation, "Aguardar estabilidade configurada", 4940, 250, [["resident_notifications_home_confirmation_test_switch"]]);
sw("resident_notifications_home_confirmation_test_switch", groups.confirmation, "Usar estado sintético em TESTE?", "_location_test", "msg", [{ t: "true" }, { t: "else" }], 5200, 250, [["resident_notifications_home_confirmation_test_state"], ["resident_notifications_home_confirmation_source"]], { w: 190 });
sw("resident_notifications_home_confirmation_source", groups.confirmation, "Consultar qual tracker canônico?", "resident_source", "msg", [{ t: "eq", v: "resident_primary", vt: "str" }, { t: "eq", v: "resident_secondary", vt: "str" }, { t: "else" }], 5480, 250, [["resident_notifications_home_confirmation_primary"], ["resident_notifications_home_confirmation_secondary"], ["resident_notifications_home_confirmation_source_invalid"]], { w: 190 });
currentState("resident_notifications_home_confirmation_primary", groups.confirmation, "Ler resident_primary atual", "device_tracker.resident_primary_location", 5750, 200, [["resident_notifications_home_confirmation_evaluate"]]);
currentState("resident_notifications_home_confirmation_secondary", groups.confirmation, "Ler resident_secondary atual", "device_tracker.resident_secondary_location", 5750, 280, [["resident_notifications_home_confirmation_evaluate"]]);
terminal("resident_notifications_home_confirmation_source_invalid", groups.confirmation, "Bloquear tracker desconhecido", { fill: "red", shape: "ring", text: "fonte inválida" }, 5750, 370);
fn("resident_notifications_home_confirmation_test_state", groups.confirmation, "Montar HOME sintético estável", "resident-notifications-home-confirmation-test-state.js", 1, 5750, 450, [["resident_notifications_home_confirmation_evaluate"]], { w: 190 });
fn("resident_notifications_home_confirmation_evaluate", groups.confirmation, "Validar frescor e permanência em HOME", "resident-notifications-home-confirmation-evaluate.js", 1, 6040, 250, [["resident_notifications_home_confirmation_result"]], { w: 210 });
sw("resident_notifications_home_confirmation_result", groups.confirmation, "HOME foi confirmado?", "home_confirmation_result", "msg", [{ t: "eq", v: "confirmed", vt: "str" }, { t: "eq", v: "retry", vt: "str" }, { t: "else" }], 6320, 250, [["resident_notifications_home_confirmation_confirmed_out"], ["resident_notifications_home_confirmation_retry_out"], ["resident_notifications_home_confirmation_rejected"]], { w: 180 });
linkOut("resident_notifications_home_confirmation_confirmed_out", groups.confirmation, "HOME confirmado → destinatário", "resident_notifications_confirmation_routing_in", 6550, 250);
linkOut("resident_notifications_home_confirmation_retry_out", groups.confirmation, "Oscilação → reavaliar", "resident_notifications_home_confirmation_retry_in", 6550, 350);
terminal("resident_notifications_home_confirmation_rejected", groups.confirmation, "Não afirmar chegada sem HOME contínuo", { fill: "yellow", shape: "ring", text: "HOME não confirmado" }, 6550, 430);
linkIn("resident_notifications_confirmation_routing_in", groups.confirmation, "Convergir approach ou HOME confirmado", ["resident_notifications_confirmation_bypass_out", "resident_notifications_home_confirmation_confirmed_out"], "resident_notifications_source_switch", 6710, 120);
sw("resident_notifications_source_switch", groups.confirmation, "Quem está chegando?", "resident_source", "msg", [{ t: "eq", v: "resident_primary", vt: "str" }, { t: "eq", v: "resident_secondary", vt: "str" }, { t: "else" }], 6920, 240, [["resident_notifications_recipient_secondary"], ["resident_notifications_recipient_primary"], ["resident_notifications_source_invalid"]], { w: 180 });
change("resident_notifications_recipient_secondary", groups.confirmation, "primary chegando → avisar secondary", [{ t: "set", p: "resident_recipient", pt: "msg", to: "resident_secondary", tot: "str" }], 7180, 180, [["resident_notifications_decision_out"]]);
change("resident_notifications_recipient_primary", groups.confirmation, "secondary chegando → avisar primary", [{ t: "set", p: "resident_recipient", pt: "msg", to: "resident_primary", tot: "str" }], 7180, 310, [["resident_notifications_decision_out"]]);
terminal("resident_notifications_source_invalid", groups.confirmation, "Ignorar origem desconhecida", { fill: "grey", shape: "ring", text: "origem não canônica" }, 7170, 410);
linkOut("resident_notifications_decision_out", groups.confirmation, "Chegada válida → frescor e entrega", "resident_notifications_state_in", 7340, 240);

linkIn("resident_notifications_state_in", groups.state, "Receber chegada validada", "resident_notifications_decision_out", "resident_notifications_event_time_switch", 7500, 240);
linkIn("resident_notifications_retry_in", groups.state, "Receber retry do serviço", "resident_notifications_retry_out", "resident_notifications_state_read", 8250, 410);
sw("resident_notifications_event_time_switch", groups.state, "Timestamp canônico é válido?", "arrival_event_time_valid", "msg", [{ t: "true" }, { t: "else" }], 7660, 200, [["resident_notifications_future_switch"], ["resident_notifications_time_invalid"]]);
terminal("resident_notifications_time_invalid", groups.state, "Bloquear timestamp inválido", { fill: "yellow", shape: "ring", text: "timestamp inválido" }, 7900, 110);
sw("resident_notifications_future_switch", groups.state, "Evento ultrapassa tolerância futura?", "event_at > $millis() + policy.future_tolerance_ms", "jsonata", [{ t: "true" }, { t: "else" }], 7910, 220, [["resident_notifications_future_terminal"], ["resident_notifications_stale_switch"]]);
terminal("resident_notifications_future_terminal", groups.state, "Descartar evento futuro", { fill: "yellow", shape: "ring", text: "evento futuro descartado" }, 8180, 110);
sw("resident_notifications_stale_switch", groups.state, "Evento excede idade máxima?", "$millis() - event_at > policy.max_event_age_ms", "jsonata", [{ t: "true" }, { t: "else" }], 8170, 240, [["resident_notifications_stale_terminal"], ["resident_notifications_state_migrate"]]);
terminal("resident_notifications_stale_terminal", groups.state, "Descartar evento antigo", { fill: "yellow", shape: "ring", text: "evento antigo descartado" }, 8440, 110);
fn("resident_notifications_state_migrate", groups.state, "Migrar recibos para estado por destinatário", "resident-notifications-state-migrate.js", 1, 8210, 330, [["resident_notifications_state_read"]], { w: 160 });
fn("resident_notifications_state_read", groups.state, "Ler recibo e reserva do destinatário", "resident-notifications-state-read.js", 1, 8470, 330, [["resident_notifications_duplicate_switch"]], { w: 160 });
sw("resident_notifications_duplicate_switch", groups.state, "Entrega já ocorreu ou está reservada?", "notification_duplicate", "msg", [{ t: "true" }, { t: "else" }], 8730, 330, [["resident_notifications_duplicate_terminal"], ["resident_notifications_state_write"]], { w: 160 });
terminal("resident_notifications_duplicate_terminal", groups.state, "Duplicata descartada", { fill: "grey", shape: "ring", text: "entrega duplicada" }, 8740, 150);
fn("resident_notifications_state_write", groups.state, "Reservar entrega antes do efeito", "resident-notifications-state-write.js", 1, 8990, 410, [["resident_notifications_delivery_out"]], { w: 160 });
linkOut("resident_notifications_delivery_out", groups.state, "Entrega reservada → gate final", "resident_notifications_delivery_in", 9100, 470);

linkIn("resident_notifications_delivery_in", groups.output, "Receber entrega reservada", "resident_notifications_delivery_out", "resident_notifications_message_build", 9250, 240);
fn("resident_notifications_message_build", groups.output, "Montar envelope da notificação", "resident-notifications-message-build.js", 1, 9470, 240, [["resident_notifications_test_gate"]]);
sw("resident_notifications_test_gate", groups.output, "Notificação pertence a TESTE?", "_location_test", "msg", [{ t: "true" }, { t: "else" }], 9730, 240, [["resident_notifications_dry_run_out"], ["resident_notifications_recipient_switch"]]);
linkOut("resident_notifications_dry_run_out", groups.output, "TESTE → terminal dry-run", "resident_notifications_dry_run_in", 9920, 150);
sw("resident_notifications_recipient_switch", groups.output, "Entrega real: qual destinatário?", "resident_recipient", "msg", [{ t: "eq", v: "resident_primary", vt: "str" }, { t: "eq", v: "resident_secondary", vt: "str" }, { t: "else" }], 9990, 280, [["resident_notifications_primary_out"], ["resident_notifications_secondary_out"], ["resident_notifications_recipient_invalid"]]);
linkOut("resident_notifications_primary_out", groups.output, "Produção → mobile_primary", "resident_notifications_primary_in", 10220, 230);
linkOut("resident_notifications_secondary_out", groups.output, "Produção → mobile_secondary", "resident_notifications_secondary_in", 10220, 310);
terminal("resident_notifications_recipient_invalid", groups.output, "Bloquear destinatário inválido", { fill: "red", shape: "ring", text: "destinatário inválido" }, 10220, 130);

linkIn("resident_notifications_primary_in", groups.output, "Receber aviso para resident_primary", "resident_notifications_primary_out", "resident_notifications_notify_primary", 10300, 230);
grouped(groups.output, {
  id: "resident_notifications_notify_primary", type: "api-call-service", z: TAB, g: groups.output,
  name: "EFEITO: avisar resident_primary", server: SERVER, version: 7, debugenabled: false,
  action: "public_bindings.call", floorId: [], areaId: [], deviceId: [], entityId: [], labelId: [],
  data: '{"role":"mobile_primary","action":"notify_actionable","data":{"title":"Casa inteligente","message":payload.message,"data":{"tag":payload.notification_key,"push":{"sound":"default","interruption-level":"time-sensitive"}}}}',
  dataType: "jsonata", mergeContext: "", mustacheAltTags: false, outputProperties: [],
  queue: "all", blockInputOverrides: true, domain: "public_bindings", service: "call",
  x: 10520, y: 230, wires: [["resident_notifications_delivery_ack"]],
});
linkIn("resident_notifications_secondary_in", groups.output, "Receber aviso para resident_secondary", "resident_notifications_secondary_out", "resident_notifications_notify_secondary", 10300, 310);
grouped(groups.output, {
  id: "resident_notifications_notify_secondary", type: "api-call-service", z: TAB, g: groups.output,
  name: "EFEITO: avisar resident_secondary", server: SERVER, version: 7, debugenabled: false,
  action: "public_bindings.call", floorId: [], areaId: [], deviceId: [], entityId: [], labelId: [],
  data: '{"role":"mobile_secondary","action":"notify_actionable","data":{"title":"Casa inteligente","message":payload.message,"data":{"tag":payload.notification_key,"push":{"sound":"default","interruption-level":"time-sensitive"}}}}',
  dataType: "jsonata", mergeContext: "", mustacheAltTags: false, outputProperties: [],
  queue: "all", blockInputOverrides: true, domain: "public_bindings", service: "call",
  x: 10520, y: 310, wires: [["resident_notifications_delivery_ack"]],
});
fn("resident_notifications_delivery_ack", groups.output, "Registrar aceite do Home Assistant", "resident-notifications-delivery-ack.js", 0, 10800, 270, []);
grouped(groups.output, {
  id: "resident_notifications_delivery_catch", type: "catch", z: TAB, g: groups.output,
  name: "Capturar falha dos dois serviços", scope: ["resident_notifications_notify_primary", "resident_notifications_notify_secondary"],
  uncaught: false, x: 9890, y: 410, wires: [["resident_notifications_delivery_failure"]],
});
fn("resident_notifications_delivery_failure", groups.output, "Liberar reserva e limitar tentativas", "resident-notifications-delivery-failure.js", 1, 10150, 410, [["resident_notifications_retry_switch"]]);
sw("resident_notifications_retry_switch", groups.output, "Ainda restam tentativas?", "notification_retry_allowed", "msg", [{ t: "true" }, { t: "else" }], 10420, 410, [["resident_notifications_retry_delay"], ["resident_notifications_retry_exhausted"]]);
delay("resident_notifications_retry_delay", groups.output, "Aguardar retry da política", 10650, 360, [["resident_notifications_retry_out"]]);
linkOut("resident_notifications_retry_out", groups.output, "Retry → dedupe da entrega", "resident_notifications_retry_in", 10900, 360);
terminal("resident_notifications_retry_exhausted", groups.output, "Falha após três tentativas", { fill: "red", shape: "ring", text: "retry esgotado" }, 10650, 450);
grouped(groups.output, {
  id: "resident_notifications_output_note", type: "comment", z: TAB, g: groups.output,
  name: "Cada chegada avisa somente o outro morador; nunca o próprio.",
  info: "queue: all preserva eventos durante queda temporária do HA. O recibo confirma somente o aceite do serviço; a entrega no iOS continua best-effort. Nenhum botão manual possui ligação com estes serviços.", x: 10000, y: 80, wires: [],
});

grouped(groups.test, {
  id: "resident_notifications_test_instructions", type: "comment", z: TAB, g: groups.test,
  name: "TESTES 1–9: dry-run. TESTE 10: único push real, marcado TESTE, para mobile_secondary.",
  info: "Os casos 1–9 usam security.arrival.v1 e percorrem contrato, direção, ciclo externo, etapa, frescor, reserva, dedupe, destinatário e gate final sem efeitos. O caso 10 existe somente para conferir a entrega ponta a ponta no celular secundário.", x: 1450, y: 610, wires: [],
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
linkOut("resident_notifications_test_event_out", groups.test, "security.arrival.v1 de TESTE → normalização real", "resident_notifications_canonical_in_v1", 1040, 920);
linkIn("resident_notifications_dry_run_in", groups.test, "Receber notificação TESTE", "resident_notifications_dry_run_out", "resident_notifications_dry_run_terminal", 1430, 780);
fn("resident_notifications_dry_run_terminal", groups.test, "TESTE FINAL: nenhum push enviado", "resident-notifications-dry-run.js", 0, 1730, 780, []);
inject("resident_notifications_test_delivery_secondary", groups.test,
  "TESTE 10: enviar push real para mobile_secondary",
  [{ p: "payload" }],
  2110, 1080, [["resident_notifications_test_notify_secondary"]], {
    payload: "TESTE — confirmação do push de chegada para o celular.",
    payloadType: "str",
  });
grouped(groups.test, {
  id: "resident_notifications_test_notify_secondary", type: "api-call-service",
  z: TAB, g: groups.test, name: "EFEITO DE TESTE: push real mobile_secondary",
  server: SERVER, version: 7, debugenabled: false, action: "public_bindings.call",
  floorId: [], areaId: [], deviceId: [], entityId: [], labelId: [],
  data: '{"role":"mobile_secondary","action":"notify_actionable","data":{"title":"TESTE — Casa inteligente","message":"TESTE — confirmação do push de chegada para o celular.","data":{"tag":"resident-notification-delivery-test","push":{"sound":"default","interruption-level":"time-sensitive"}}}}',
  dataType: "json", mergeContext: "", mustacheAltTags: false,
  outputProperties: [], queue: "all", blockInputOverrides: true,
  domain: "public_bindings", service: "call", x: 2450, y: 1080,
  wires: [["resident_notifications_test_delivery_accepted"]],
});
grouped(groups.test, {
  id: "resident_notifications_test_delivery_accepted", type: "debug", z: TAB,
  g: groups.test, name: "TESTE: push mobile_secondary aceito pelo HA",
  active: true, tosidebar: false, console: true, tostatus: false,
  complete: "payload", targetType: "msg", statusVal: "", statusType: "auto",
  x: 2770, y: 1080, wires: [],
});

next.push(...nodes);
for (const [linkNode, target] of [
  [peopleOut, "resident_notifications_canonical_in_v1"],
  [peopleTestOut, "resident_notifications_test_cycle_in"],
]) {
  linkNode.links ??= [];
  if (!linkNode.links.includes(target)) linkNode.links.push(target);
}
const desired = installNotificationHubs(next, { routeWires: false });
const linkedInputs = new Set([peopleOut.id, peopleTestOut.id, "global_observer_events_in"]);
const originalById = new Map(originalFlows.map((node) => [node.id, node]));
const desiredById = new Map(desired.map((node) => [node.id, node]));
for (const routeOut of originalFlows.filter((node) =>
  node.z === TAB && node.type === "link out" && (
    node.notification_hub_wire_route ||
    /^notification_hub_wire_out_[a-f0-9]{12}$/.test(node.id)
  )
)) {
  const routeIn = (routeOut.links ?? []).map((id) => originalById.get(id))
    .find((node) => node?.type === "link in");
  if (routeIn?.wires?.[0]?.length !== 1) continue;
  const target = routeIn.wires[0][0];
  let restoredSource = false;
  // A manually named route may be shared by several sources. Restore every
  // still-equivalent edge, not just the first source found for the pair.
  for (const original of originalFlows) {
    for (const [output, wire] of (original.wires ?? []).entries()) {
      if (!wire.includes(routeOut.id)) continue;
      const sourceNode = desiredById.get(original.id);
      const targetIndex = sourceNode?.wires?.[output]?.indexOf(target) ?? -1;
      if (targetIndex < 0) continue;
      sourceNode.wires[output][targetIndex] = routeOut.id;
      restoredSource = true;
    }
  }
  if (!restoredSource) continue;
  for (const routeNode of [routeOut, routeIn]) {
    const restored = structuredClone(routeNode);
    desired.push(restored);
    desiredById.set(restored.id, restored);
    const owner = desiredById.get(restored.g);
    if (owner?.type === "group" && !owner.nodes.includes(restored.id)) owner.nodes.push(restored.id);
  }
}
const reconciled = reconcileGeneratedFlows(originalFlows, desired, {
  isOwned: owned,
  shouldUpdate: (current) => owned(current) || linkedInputs.has(current.id),
});
fs.writeFileSync(outputPath, `${JSON.stringify(reconciled, null, 4)}\n`);
console.log(`Resident notification visual flow installed in ${outputPath}`);
