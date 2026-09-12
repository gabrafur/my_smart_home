#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.resolve(process.argv[2] ?? path.resolve(here, "..", "flows.json"));
const outputPath = path.resolve(process.argv[3] ?? sourcePath);
const functionsDir = path.join(here, "functions");
const TAB = "monitoramento_tuya_tab";
const MQTT = "721c47f31046b8bc";
const SERVER = "4126427d5e161a03";
const NOTIFY = "infra_notify_all_mobiles";
const flows = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
const source = (name) => fs.readFileSync(path.join(functionsDir, name), "utf8").trimEnd();
const owned = (node) => node.id === TAB || node.z === TAB || node.id.startsWith("tuya_") || node.id.startsWith("grp_tuya_");
const removed = new Set(flows.filter(owned).map((node) => node.id));
const next = flows.filter((node) => !owned(node));
for (const node of next) {
  for (const field of ["nodes", "scope", "links"]) if (Array.isArray(node[field])) node[field] = node[field].filter((id) => !removed.has(id));
  if (Array.isArray(node.wires)) node.wires = node.wires.map((wire) => Array.isArray(wire) ? wire.filter((id) => !removed.has(id)) : wire);
}
if (!next.some((node) => node.id === MQTT)) throw new Error("Configuração MQTT ausente");
if (!next.some((node) => node.id === SERVER)) throw new Error("Servidor Home Assistant ausente");
if (!next.some((node) => node.id === NOTIFY)) throw new Error("Subflow de notificação ausente");

const nodes = [];
const add = (node) => { nodes.push(node); return node.id; };
const group = (id, name, x, y, w, h, stroke, fill) => add({ id, type: "group", z: TAB, name,
  style: { label: true, "label-position": "nw", color: "#1f2937", stroke, "stroke-opacity": "1", fill, "fill-opacity": "0.35" }, nodes: [], x, y, w, h });
const groups = {
  input: group("grp_tuya_triggers", "0. Política, agenda e coleta HA", 64, 20, 1100, 760, "#2563eb", "#dbeafe"),
  decision: group("grp_tuya_state", "1. Dispositivos: decisões, estado e resumo", 1200, 20, 4000, 980, "#0f766e", "#ccfbf1"),
  effect: group("grp_tuya_notify", "2. Efeitos e observabilidade", 5240, 20, 1900, 980, "#dc2626", "#fee2e2"),
  test: group("grp_tuya_tests", "3. Replay manual completo — dry-run", 64, 1060, 3500, 660, "#0891b2", "#cffafe"),
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
const api = (id, name, data, property, x, y, wires) => grouped(groups.input, { id, type: "ha-api", z: TAB, g: groups.input,
  name, server: SERVER, version: 1, debugenabled: false, protocol: "websocket", method: "get", path: "",
  data: JSON.stringify(data), dataType: "json", responseType: "json",
  outputProperties: [{ property, propertyType: "msg", value: "", valueType: "results" }], x, y, wires });
const policy = { failure_confirmation_s: 30, recovery_confirmation_s: 60, reminder_interval_h: 24 };
const action = (name, event) => [
  { t: "set", p: "tuya_device_action", pt: "msg", to: name, tot: "str" },
  { t: "set", p: "tuya_event", pt: "msg", to: event, tot: "str" },
];

add({ id: TAB, type: "tab", label: "monitoramento_tuya", disabled: false,
  info: "Descobre Tuya/LocalTuya pelo Home Assistant. Política, decisões, recovery, dedupe e efeitos são visuais; parsing de registros permanece adaptador estrutural.", env: [] });
grouped(groups.input, { id: "tuya_policy_note", type: "comment", z: TAB, g: groups.input,
  name: "Padrões: queda 30 s; retorno 60 s; lembrete 24 h; coleta 30 s.",
  info: "Limites: queda 1–300 s, retorno 1–600 s e lembrete 1–168 h. Configuração inválida preserva a última política persistente válida.", x: 540, y: 60, wires: [] });
inject("tuya_policy_default", groups.input, "CONFIG: aplicar política visual", [{ p: "payload", v: JSON.stringify(policy), vt: "json" }], 190, 120, [["tuya_policy_validate"]], { once: true, onceDelay: "1" });
fn("tuya_policy_validate", groups.input, "Validar unidades e limites", "tuya-policy-validate.js", 1, 470, 120, [["tuya_policy_switch"]]);
sw("tuya_policy_switch", groups.input, "Configuração é válida?", "policy_valid", "msg", [{ t: "true" }, { t: "else" }], 760, 120, [["tuya_policy_store"], ["tuya_policy_reject"]]);
fn("tuya_policy_store", groups.input, "Guardar última política válida", "tuya-policy-store.js", 0, 1030, 90, []);
fn("tuya_policy_reject", groups.input, "Rejeitar sem substituir", "tuya-policy-reject.js", 0, 1030, 150, []);
inject("tuya_cycle", groups.input, "POLÍTICA: coletar a cada 30 s", [{ p: "payload" }], 210, 260, [["tuya_entity_registry"]], { repeat: "30", once: true, onceDelay: "5" });
api("tuya_entity_registry", "FONTE: registro de entidades", { type: "config/entity_registry/list" }, "tuya_entity_registry", 470, 260, [["tuya_device_registry"]]);
api("tuya_device_registry", "FONTE: registro de dispositivos", { type: "config/device_registry/list" }, "tuya_device_registry", 730, 260, [["tuya_states"]]);
api("tuya_states", "FONTE: estados atuais", { type: "get_states" }, "tuya_states", 980, 260, [["tuya_snapshot_out"]]);
linkOut("tuya_snapshot_out", groups.input, "Snapshot HA → normalização", "tuya_snapshot_in", 1120, 260);
grouped(groups.input, { id: "tuya_query_catch", type: "catch", z: TAB, g: groups.input,
  name: "Falha nas três consultas HA", scope: ["tuya_entity_registry", "tuya_device_registry", "tuya_states"], uncaught: false,
  x: 230, y: 360, wires: [["tuya_query_failure_out"]] });
linkOut("tuya_query_failure_out", groups.input, "Falha de coleta → estado checking", "tuya_query_failure_in", 500, 360);
inject("tuya_discovery_tick", groups.input, "Publicar discovery no startup", [{ p: "payload" }], 220, 470, [["tuya_discovery"]], { once: true, onceDelay: "2" });
fn("tuya_discovery", groups.input, "Adaptar discovery HA", "tuya-discovery.js", 1, 490, 470, [["tuya_discovery_out"]]);
linkOut("tuya_discovery_out", groups.input, "Discovery → MQTT retained", "tuya_discovery_in", 750, 470);
grouped(groups.input, { id: "tuya_source_note", type: "comment", z: TAB, g: groups.input,
  name: "Somente Tuya/LocalTuya ativos; button/event não definem disponibilidade.",
  info: "Agrupamento por device_id evita duplicar o mesmo dispositivo. Entidades desabilitadas e plataformas alheias são ignoradas.", x: 550, y: 590, wires: [] });

linkIn("tuya_snapshot_in", groups.decision, "Receber snapshot HA ou TESTE", ["tuya_snapshot_out", "tuya_test_snapshot_out"], "tuya_policy_load", 1250, 280);
fn("tuya_policy_load", groups.decision, "Carregar política canônica", "tuya-policy-load.js", 1, 1440, 280, [["tuya_policy_available"]]);
sw("tuya_policy_available", groups.decision, "Existe política válida?", "policy_available", "msg", [{ t: "true" }, { t: "else" }], 1650, 280, [["tuya_snapshot_validate"], ["tuya_policy_missing"]]);
terminal("tuya_policy_missing", groups.decision, "Falha fechada sem política", { fill: "red", shape: "ring", text: "política indisponível" }, 1870, 220);
fn("tuya_snapshot_validate", groups.decision, "Validar estrutura do snapshot", "tuya-snapshot-validate.js", 1, 1890, 280, [["tuya_snapshot_valid"]]);
sw("tuya_snapshot_valid", groups.decision, "Registros e estados estão disponíveis?", "tuya_snapshot_valid", "msg", [{ t: "true" }, { t: "else" }], 2140, 280, [["tuya_devices_normalize"], ["tuya_snapshot_failure_out"]]);
linkOut("tuya_snapshot_failure_out", groups.decision, "Snapshot inválido → checking", "tuya_query_failure_in", 2370, 220);
fn("tuya_devices_normalize", groups.decision, "ADAPTAR: agrupar dispositivos", "tuya-devices-normalize.js", 1, 2400, 300, [["tuya_devices_present"]]);
sw("tuya_devices_present", groups.decision, "Há dispositivo Tuya monitorável?", "tuya_device_count", "msg", [{ t: "gt", v: "0", vt: "num" }, { t: "else" }], 2660, 300, [["tuya_devices_split"], ["tuya_empty_summary_out"]]);
linkOut("tuya_empty_summary_out", groups.decision, "Sem dispositivos → resumo", "tuya_summary_route_in", 2910, 340);
grouped(groups.decision, { id: "tuya_devices_split", type: "split", z: TAB, g: groups.decision,
  name: "Um dispositivo por mensagem", splt: "\\n", spltType: "str", arraySplt: 1, arraySpltType: "len",
  stream: false, addname: "", property: "payload", x: 2910, y: 260, wires: [["tuya_device_state_read"]] });
fn("tuya_device_state_read", groups.decision, "Ler estado e estabilidade", "tuya-device-state-read.js", 1, 3150, 260, [["tuya_device_raw_switch"]]);
sw("tuya_device_raw_switch", groups.decision, "Dispositivo está online ou offline?", "tuya_device.raw_state", "msg", [{ t: "eq", v: "online", vt: "str" }, { t: "eq", v: "offline", vt: "str" }], 3400, 260, [["tuya_device_online_incident"], ["tuya_device_offline_incident"]]);
sw("tuya_device_online_incident", groups.decision, "Existe incidente para recuperar?", "tuya_device_state.incident_open", "msg", [{ t: "true" }, { t: "else" }], 3670, 150, [["tuya_device_recovery_stable"], ["tuya_device_baseline"]]);
sw("tuya_device_recovery_stable", groups.decision, "Online estável atingiu 60 s?", "tuya_stable_for_ms >= policy.recovery_confirmation_s * 1000", "jsonata", [{ t: "true" }, { t: "else" }], 3950, 100, [["tuya_device_recover"], ["tuya_device_recovering"]]);
change("tuya_device_recover", groups.decision, "Confirmar recuperação", action("recover", "recovery"), 4240, 75, [["tuya_device_mutate_out"]]);
change("tuya_device_recovering", groups.decision, "Aguardar estabilidade do retorno", action("recovering", "none"), 4240, 135, [["tuya_device_mutate_out"]]);
change("tuya_device_baseline", groups.decision, "Estabelecer baseline online", action("baseline", "none"), 3950, 205, [["tuya_device_baseline_out"]]);
linkOut("tuya_device_baseline_out", groups.decision, "Baseline → estado", "tuya_device_mutate_in", 4350, 205);
sw("tuya_device_offline_incident", groups.decision, "A falha já é incidente aberto?", "tuya_device_state.incident_open", "msg", [{ t: "true" }, { t: "else" }], 3670, 390, [["tuya_device_reminder_due"], ["tuya_device_failure_stable"]]);
sw("tuya_device_reminder_due", groups.decision, "Lembrete de 24 h está vencido?", "tuya_now >= tuya_next_reminder_ms", "jsonata", [{ t: "true" }, { t: "else" }], 3950, 340, [["tuya_device_reminder"], ["tuya_device_keep_offline"]]);
change("tuya_device_reminder", groups.decision, "Registrar lembrete devido", action("reminder", "reminder"), 4240, 315, [["tuya_device_mutate_out"]]);
change("tuya_device_keep_offline", groups.decision, "Manter offline sem duplicar", action("keep_offline", "none"), 4240, 375, [["tuya_device_mutate_out"]]);
sw("tuya_device_failure_stable", groups.decision, "Offline estável atingiu 30 s?", "tuya_stable_for_ms >= policy.failure_confirmation_s * 1000", "jsonata", [{ t: "true" }, { t: "else" }], 3950, 460, [["tuya_device_open"], ["tuya_device_checking"]]);
change("tuya_device_open", groups.decision, "Abrir incidente confirmado", action("open", "down"), 4240, 445, [["tuya_device_mutate_out"]]);
change("tuya_device_checking", groups.decision, "Aguardar confirmação", action("checking", "none"), 4240, 505, [["tuya_device_mutate_out"]]);
linkOut("tuya_device_mutate_out", groups.decision, "Decisão → estado do dispositivo", "tuya_device_mutate_in", 4510, 280);
linkIn("tuya_device_mutate_in", groups.decision, "Receber mutação", ["tuya_device_mutate_out", "tuya_device_baseline_out"], "tuya_device_state_mutate", 4610, 280);
fn("tuya_device_state_mutate", groups.decision, "Persistir estado por dispositivo", "tuya-device-state-mutate.js", 1, 4860, 280, [["tuya_device_result", "tuya_device_event_out"]]);
linkOut("tuya_device_event_out", groups.decision, "Transição → fronteira de alerta", "tuya_device_event_in", 5050, 220);
fn("tuya_device_result", groups.decision, "Preparar resultado do dispositivo", "tuya-device-result.js", 1, 4970, 560, [["tuya_result_join_out"]]);
linkOut("tuya_result_join_out", groups.decision, "Resultado → reunião do ciclo", "tuya_result_join_in", 5120, 560);
linkIn("tuya_result_join_in", groups.decision, "Receber resultado do dispositivo", "tuya_result_join_out", "tuya_devices_join", 4260, 650);
grouped(groups.decision, { id: "tuya_devices_join", type: "join", z: TAB, g: groups.decision,
  name: "Reunir ciclo completo", mode: "auto", build: "array", property: "payload", propertyType: "msg",
  key: "topic", joiner: "\\n", joinerType: "str", accumulate: false, timeout: "5", count: "", reduceRight: false,
  reduceExp: "", reduceInit: "", reduceInitType: "", reduceFixup: "", x: 4500, y: 650, wires: [["tuya_join_summary_out"]] });
linkOut("tuya_join_summary_out", groups.decision, "Ciclo reunido → resumo", "tuya_summary_route_in", 4740, 650);
linkIn("tuya_summary_route_in", groups.decision, "Receber ciclo vazio ou reunido", ["tuya_empty_summary_out", "tuya_join_summary_out"], "tuya_summary_facts", 1250, 760);
fn("tuya_summary_facts", groups.decision, "Calcular contagens do ciclo", "tuya-summary-facts.js", 1, 1480, 760, [["tuya_summary_empty"]]);
sw("tuya_summary_empty", groups.decision, "Nenhum dispositivo foi monitorado?", "tuya_monitored_count", "msg", [{ t: "eq", v: "0", vt: "num" }, { t: "else" }], 1730, 760, [["tuya_empty_phase_out"], ["tuya_summary_confirmed"]]);
linkOut("tuya_empty_phase_out", groups.decision, "Ciclo vazio → checking", "tuya_empty_phase_in", 1940, 700);
linkIn("tuya_empty_phase_in", groups.decision, "Receber ciclo vazio", "tuya_empty_phase_out", "tuya_phase_checking", 2530, 700);
sw("tuya_summary_confirmed", groups.decision, "Há dispositivo com falha confirmada?", "tuya_confirmed_count", "msg", [{ t: "gt", v: "0", vt: "num" }, { t: "else" }], 2010, 780, [["tuya_offline_phase_out"], ["tuya_summary_offline"]]);
linkOut("tuya_offline_phase_out", groups.decision, "Falha confirmada → offline", "tuya_offline_phase_in", 2230, 740);
linkIn("tuya_offline_phase_in", groups.decision, "Receber falha confirmada", "tuya_offline_phase_out", "tuya_phase_offline", 2530, 770);
sw("tuya_summary_offline", groups.decision, "Há indisponibilidade ainda não confirmada?", "tuya_offline_count", "msg", [{ t: "gt", v: "0", vt: "num" }, { t: "else" }], 2300, 820, [["tuya_phase_checking"], ["tuya_summary_recovering"]]);
sw("tuya_summary_recovering", groups.decision, "Há recuperação em confirmação?", "tuya_recovering_count", "msg", [{ t: "gt", v: "0", vt: "num" }, { t: "else" }], 2590, 860, [["tuya_phase_recovering"], ["tuya_phase_online"]]);
const phaseRule = (phase) => [{ t: "set", p: "tuya_phase", pt: "msg", to: phase, tot: "str" }];
change("tuya_phase_checking", groups.decision, "Publicar checking", phaseRule("checking"), 2750, 710, [["tuya_summary_out"]]);
change("tuya_phase_offline", groups.decision, "Publicar offline", phaseRule("offline"), 2750, 770, [["tuya_summary_out"]]);
change("tuya_phase_recovering", groups.decision, "Publicar recovering", phaseRule("recovering"), 2900, 850, [["tuya_summary_out"]]);
change("tuya_phase_online", groups.decision, "Publicar online", phaseRule("online"), 2900, 920, [["tuya_summary_out"]]);
linkOut("tuya_summary_out", groups.decision, "Resumo canônico → fronteira", "tuya_summary_in", 3200, 820);

linkIn("tuya_summary_in", groups.effect, "Receber resumo canônico", "tuya_summary_out", "tuya_summary_publish_build", 5290, 260);
fn("tuya_summary_publish_build", groups.effect, "Persistir resumo e montar MQTT", "tuya-summary-publish-build.js", 1, 5530, 260, [["tuya_phase_switch", "tuya_publications_expand"]]);
sw("tuya_phase_switch", groups.effect, "Estado final: online, offline ou transição?", "tuya_phase", "msg", [{ t: "eq", v: "online", vt: "str" }, { t: "eq", v: "offline", vt: "str" }, { t: "else" }], 5800, 125, [["tuya_status_online"], ["tuya_status_offline"], ["tuya_status_transition"]]);
terminal("tuya_status_online", groups.effect, "OBSERVAR: todos online", { fill: "green", shape: "dot", text: "Tuya online" }, 6080, 70);
terminal("tuya_status_offline", groups.effect, "OBSERVAR: falha confirmada", { fill: "red", shape: "ring", text: "Tuya offline" }, 6080, 125);
terminal("tuya_status_transition", groups.effect, "OBSERVAR: confirmação", { fill: "yellow", shape: "ring", text: "confirmando Tuya" }, 6080, 180);
fn("tuya_publications_expand", groups.effect, "Expandir 3 publicações MQTT", "tuya-publications-expand.js", 1, 5800, 310, [["tuya_publication_test_gate"]]);
sw("tuya_publication_test_gate", groups.effect, "Publicação pertence a TESTE?", "_tuya_test", "msg", [{ t: "true" }, { t: "else" }], 6070, 310, [["tuya_publication_dry_out"], ["tuya_mqtt_state_out"]]);
linkOut("tuya_mqtt_state_out", groups.effect, "Estado real → MQTT", "tuya_mqtt_state_in", 6330, 350);
linkIn("tuya_mqtt_state_in", groups.effect, "Receber estado real", "tuya_mqtt_state_out", "tuya_mqtt_publish", 6300, 800);
linkOut("tuya_publication_dry_out", groups.effect, "MQTT TESTE → dry-run", "tuya_dry_in", 6330, 280);
linkIn("tuya_query_failure_in", groups.effect, "Receber falha real ou sintética", ["tuya_query_failure_out", "tuya_snapshot_failure_out", "tuya_test_query_failure_out"], "tuya_query_failure", 5290, 470);
fn("tuya_query_failure", groups.effect, "Montar estado checking sem incidente", "tuya-query-failure-build.js", 1, 5530, 470, [["tuya_query_publications_expand"]]);
fn("tuya_query_publications_expand", groups.effect, "Expandir falha em 3 publicações", "tuya-publications-expand.js", 1, 5800, 470, [["tuya_publication_test_gate"]]);
linkIn("tuya_device_event_in", groups.effect, "Receber transição por dispositivo", "tuya_device_event_out", "tuya_device_event_switch", 5290, 690);
sw("tuya_device_event_switch", groups.effect, "Há queda, retorno ou lembrete?", "tuya_event", "msg", [{ t: "eq", v: "down", vt: "str" }, { t: "eq", v: "recovery", vt: "str" }, { t: "eq", v: "reminder", vt: "str" }, { t: "else" }], 5540, 690, [["tuya_device_notification_build"], ["tuya_device_notification_build"], ["tuya_device_notification_build"], ["tuya_no_notification"]]);
fn("tuya_device_notification_build", groups.effect, "Montar alerta do dispositivo", "tuya-device-notification-build.js", 1, 5830, 660, [["tuya_notification_test_gate"]]);
terminal("tuya_no_notification", groups.effect, "Sem nova notificação", { fill: "grey", shape: "ring", text: "dedupe ativo" }, 5830, 735);
sw("tuya_notification_test_gate", groups.effect, "Alerta pertence a TESTE?", "_tuya_test", "msg", [{ t: "true" }, { t: "else" }], 6120, 660, [["tuya_notification_dry_out"], ["tuya_notify_effect"]]);
linkOut("tuya_notification_dry_out", groups.effect, "Alerta TESTE → dry-run", "tuya_dry_in", 6380, 620);
grouped(groups.effect, { id: "tuya_notify_effect", type: `subflow:${NOTIFY}`, z: TAB, g: groups.effect,
  name: "EFEITO ÚNICO: notificar infraestrutura", env: [], x: 6560, y: 700, wires: [[]] });
linkIn("tuya_discovery_in", groups.effect, "Receber discovery HA", "tuya_discovery_out", "tuya_mqtt_publish", 6070, 840);
grouped(groups.effect, { id: "tuya_mqtt_publish", type: "mqtt out", z: TAB, g: groups.effect,
  name: "EFEITO: publicar MQTT retained", topic: "", qos: "1", retain: "true", respTopic: "", contentType: "",
  userProps: "", correl: "", expiry: "", broker: MQTT, x: 6540, y: 840, wires: [] });

grouped(groups.test, { id: "tuya_test_note", type: "comment", z: TAB, g: groups.test,
  name: "Ordem: reset → 2–8 queda/retorno → 9–11 lembrete → 12 fonte indisponível.",
  info: "O replay atravessa a mesma normalização, split/join, política, estado por dispositivo, resumo e gates. MQTT e alertas terminam no dry-run.", x: 1100, y: 1100, wires: [] });
inject("tuya_test_reset", groups.test, "TESTE 1: reset", [{ p: "_tuya_test", v: "true", vt: "bool" }], 170, 1190, [["tuya_test_reset_state"]]);
fn("tuya_test_reset_state", groups.test, "Resetar apenas estado sintético", "tuya-test-reset.js", 0, 410, 1190, []);
const start = Date.UTC(2026, 0, 1, 0, 0, 0);
const sample = (feeder, at) => [{ p: "payload", v: JSON.stringify({ feeder, relay: "on" }), vt: "json" },
  { p: "monitor_now", v: String(at), vt: "num" }, { p: "_tuya_test", v: "true", vt: "bool" }];
for (const [id, name, feeder, at, x, y] of [
  ["tuya_test_online", "TESTE 2: baseline online", "42", start, 720, 1190],
  ["tuya_test_offline_start", "TESTE 3: iniciar offline", "unavailable", start + 10000, 720, 1250],
  ["tuya_test_offline_29", "TESTE 4: 29 s offline", "unavailable", start + 39000, 720, 1310],
  ["tuya_test_offline_30", "TESTE 5: 30 s offline", "unavailable", start + 40000, 720, 1370],
  ["tuya_test_offline_duplicate", "TESTE 6: offline duplicado", "unavailable", start + 41000, 720, 1430],
  ["tuya_test_recovery_start", "TESTE 7: iniciar retorno", "42", start + 50000, 720, 1490],
  ["tuya_test_recovery_60", "TESTE 8: 60 s online", "42", start + 110000, 720, 1550],
  ["tuya_test_second_offline", "TESTE 9: nova indisponibilidade", "unavailable", start + 120000, 1700, 1190],
  ["tuya_test_second_down", "TESTE 10: confirmar nova queda", "unavailable", start + 150000, 1700, 1250],
  ["tuya_test_reminder", "TESTE 11: lembrete após 24 h", "unavailable", start + 150000 + 86400000, 1700, 1310],
]) inject(id, groups.test, name, sample(feeder, at), x, y, [[x < 1000 ? "tuya_test_samples_left_out" : "tuya_test_samples_right_out"]]);
linkOut("tuya_test_samples_left_out", groups.test, "Amostras 2–8 → adapter", "tuya_test_samples_in", 1010, 1390);
linkOut("tuya_test_samples_right_out", groups.test, "Amostras 9–11 → adapter", "tuya_test_samples_in", 2010, 1360);
linkIn("tuya_test_samples_in", groups.test, "Receber amostra sintética", ["tuya_test_samples_left_out", "tuya_test_samples_right_out"], "tuya_test_snapshot_adapter", 1110, 1460);
fn("tuya_test_snapshot_adapter", groups.test, "Montar snapshot sintético", "tuya-test-snapshot.js", 1, 1340, 1460, [["tuya_test_snapshot_out"]]);
linkOut("tuya_test_snapshot_out", groups.test, "Snapshot TESTE → caminho real", "tuya_snapshot_in", 1600, 1460);
inject("tuya_test_query_failure", groups.test, "TESTE 12: fonte HA indisponível", [{ p: "error", v: JSON.stringify({ message: "Home Assistant unavailable TESTE" }), vt: "json" }, { p: "monitor_now", v: String(start), vt: "num" }, { p: "_tuya_test", v: "true", vt: "bool" }], 1750, 1430, [["tuya_test_query_failure_out"]]);
linkOut("tuya_test_query_failure_out", groups.test, "Falha TESTE → mesma fronteira", "tuya_query_failure_in", 2050, 1430);
linkIn("tuya_dry_in", groups.test, "Receber qualquer efeito TESTE", ["tuya_publication_dry_out", "tuya_notification_dry_out"], "tuya_dry_run_terminal", 2580, 1290);
fn("tuya_dry_run_terminal", groups.test, "TESTE FINAL: efeito bloqueado", "tuya-dry-run.js", 0, 2850, 1290, []);

next.push(...nodes);
fs.writeFileSync(outputPath, `${JSON.stringify(next, null, 4)}\n`);
console.log(`Tuya monitor visual flow installed in ${outputPath}`);
