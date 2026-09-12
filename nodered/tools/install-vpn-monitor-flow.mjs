#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.resolve(process.argv[2] ?? path.resolve(here, "..", "flows.json"));
const outputPath = path.resolve(process.argv[3] ?? sourcePath);
const functionsDir = path.join(here, "functions");
const TAB = "monitoramento_vpn_tab";
const BROKER = "721c47f31046b8bc";
const NOTIFY = "infra_notify_all_mobiles";
const flows = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
const source = (name) => fs.readFileSync(path.join(functionsDir, name), "utf8").trimEnd();
for (const [id, type] of [[BROKER, "mqtt-broker"], [NOTIFY, "subflow"]]) {
  if (!flows.some((node) => node.id === id && node.type === type)) throw new Error(`${type} obrigatório ausente: ${id}`);
}
const removed = new Set(flows.filter((node) => node.id === TAB || node.z === TAB || node.id.startsWith("vpn_monitor_")).map((node) => node.id));
const next = flows.filter((node) => !removed.has(node.id));
for (const node of next) {
  for (const field of ["nodes", "scope", "links"]) if (Array.isArray(node[field])) node[field] = node[field].filter((id) => !removed.has(id));
  if (Array.isArray(node.wires)) node.wires = node.wires.map((wire) => Array.isArray(wire) ? wire.filter((id) => !removed.has(id)) : wire);
}
const nodes = [];
const add = (node) => { nodes.push(node); return node.id; };
const group = (id, name, x, y, w, h, stroke, fill) => add({ id, type: "group", z: TAB, name,
  style: { label: true, "label-position": "nw", color: "#1f2937", stroke, fill, "fill-opacity": "0.35" }, nodes: [], x, y, w, h });
const groups = {
  policy: group("vpn_monitor_policy_group", "0. Política ajustável e validada", 64, 20, 1000, 300, "#2563eb", "#dbeafe"),
  input: group("vpn_monitor_input_group", "1. Fontes e normalização", 1100, 20, 1500, 400, "#7c3aed", "#ede9fe"),
  decision: group("vpn_monitor_decision_group", "2. Decisão, confirmação e estado", 2640, 20, 3500, 700, "#0f766e", "#ccfbf1"),
  notify: group("vpn_monitor_notify_group", "3. Efeito de notificação", 6180, 20, 1050, 280, "#b45309", "#ffedd5"),
  publish: group("vpn_monitor_publish_group", "4. MQTT Discovery e estado", 6180, 340, 1050, 380, "#15803d", "#dcfce7"),
  test: group("vpn_monitor_test_group", "5. TESTE — caminho completo em dry-run", 64, 760, 2500, 400, "#0891b2", "#cffafe"),
};
const grouped = (g, node) => { add(node); nodes.find((entry) => entry.id === g).nodes.push(node.id); return node.id; };
const fn = (id, g, name, file, outputs, x, y, wires) => grouped(g, { id, type: "function", z: TAB, g, name,
  func: source(file), outputs, timeout: 0, noerr: 0, initialize: "", finalize: "", libs: [], x, y, wires });
const inject = (id, g, name, props, x, y, wires, extra = {}) => grouped(g, { id, type: "inject", z: TAB, g, name,
  props, repeat: "", crontab: "", once: false, onceDelay: 0.1, topic: "", payload: "", payloadType: "date", x, y, wires, ...extra });
const sw = (id, g, name, property, propertyType, rules, x, y, wires) => grouped(g, { id, type: "switch", z: TAB, g, name,
  property, propertyType, rules, checkall: "true", repair: false, outputs: rules.length, x, y, wires });
const linkOut = (id, g, name, targets, x, y) => grouped(g, { id, type: "link out", z: TAB, g, name,
  mode: "link", links: Array.isArray(targets) ? targets : [targets], x, y, wires: [] });
const linkIn = (id, g, name, origins, destination, x, y) => grouped(g, { id, type: "link in", z: TAB, g, name,
  links: Array.isArray(origins) ? origins : [origins], x, y, wires: [[destination]] });
const terminal = (id, g, name, status, x, y) => grouped(g, { id, type: "function", z: TAB, g, name,
  func: `node.status(${JSON.stringify(status)});\nreturn null;`, outputs: 0, timeout: 0, noerr: 0, initialize: "", finalize: "", libs: [], x, y, wires: [] });

add({ id: TAB, type: "tab", label: "monitoramento_vpn", disabled: false,
  info: "Relatório sanitizado e internet são fatos. Os quatro tempos, confirmação, supressão, dedupe, recovery e efeitos ficam explícitos no canvas.", env: [] });

const policy = { failure_confirm_s: 120, recovery_confirm_s: 60, report_stale_s: 180, reminder_s: 86400 };
grouped(groups.policy, { id: "vpn_monitor_policy_note", type: "comment", z: TAB, g: groups.policy,
  name: "Padrões: falha 120 s; recovery 60 s; relatório stale 180 s; lembrete 86.400 s.",
  info: "Limites: falha 1–600 s; recovery 1–300 s; stale 30–900 s; lembrete 300–172.800 s. Inválido preserva a última política.", x: 520, y: 60, wires: [] });
inject("vpn_monitor_policy_default", groups.policy, "CONFIG: aplicar política visual", [{ p: "payload", v: JSON.stringify(policy), vt: "json" }], 190, 130, [["vpn_monitor_policy_validate"]], { once: true, onceDelay: "1" });
fn("vpn_monitor_policy_validate", groups.policy, "Validar segundos e limites", "vpn-monitor-policy-validate.js", 1, 440, 130, [["vpn_monitor_policy_switch"]]);
sw("vpn_monitor_policy_switch", groups.policy, "Configuração é válida?", "policy_valid", "msg", [{ t: "true" }, { t: "else" }], 680, 130, [["vpn_monitor_policy_store"], ["vpn_monitor_policy_reject"]]);
fn("vpn_monitor_policy_store", groups.policy, "Guardar última política válida", "vpn-monitor-policy-store.js", 0, 930, 100, []);
fn("vpn_monitor_policy_reject", groups.policy, "Rejeitar sem substituir", "vpn-monitor-policy-reject.js", 0, 930, 170, []);

grouped(groups.input, { id: "vpn_monitor_health_in", type: "mqtt in", z: TAB, g: groups.input, name: "Saúde sanitizada das VPNs",
  topic: "nodered/infrastructure/vpn/host-health", qos: "1", datatype: "auto-detect", broker: BROKER, nl: false, rap: true, rh: 0,
  inputs: 0, x: 1210, y: 100, wires: [["vpn_monitor_report_ingest"]] });
linkIn("vpn_monitor_test_report_in", groups.input, "Receber relatório TESTE", "vpn_monitor_test_report_out", "vpn_monitor_report_ingest", 1160, 150);
fn("vpn_monitor_report_ingest", groups.input, "Validar e guardar relatório", "vpn-monitor-report-ingest.js", 1, 1490, 120, [["vpn_monitor_report_eval_out"]]);
linkOut("vpn_monitor_report_eval_out", groups.input, "Relatório → decisão", "vpn_monitor_evaluate_in", 1760, 120);
grouped(groups.input, { id: "vpn_monitor_internet_in", type: "mqtt in", z: TAB, g: groups.input, name: "Estado canônico da internet",
  topic: "nodered/infrastructure/internet/state", qos: "1", datatype: "utf8", broker: BROKER, nl: false, rap: true, rh: 0,
  inputs: 0, x: 1280, y: 230, wires: [["vpn_monitor_internet_ingest"]] });
linkIn("vpn_monitor_test_internet_in", groups.input, "Receber internet TESTE", "vpn_monitor_test_internet_out", "vpn_monitor_internet_ingest", 1160, 280);
fn("vpn_monitor_internet_ingest", groups.input, "Validar e guardar internet", "vpn-monitor-internet-ingest.js", 1, 1570, 250, [["vpn_monitor_internet_eval_out"]]);
linkOut("vpn_monitor_internet_eval_out", groups.input, "Internet → decisão", "vpn_monitor_evaluate_in", 1840, 250);
inject("vpn_monitor_tick", groups.input, "POLÍTICA: avaliar a cada 30 s", [{ p: "payload" }], 2030, 330, [["vpn_monitor_tick_out"]], { repeat: "30", once: true, onceDelay: "10" });
linkOut("vpn_monitor_tick_out", groups.input, "Agenda → decisão", "vpn_monitor_evaluate_in", 2330, 330);

const stateOrigins = [];
const statePath = (id, name, x, y) => { stateOrigins.push(id); linkOut(id, groups.decision, name, "vpn_monitor_state_in", x, y); };
linkIn("vpn_monitor_evaluate_in", groups.decision, "Receber fato, agenda ou TESTE", ["vpn_monitor_report_eval_out", "vpn_monitor_internet_eval_out", "vpn_monitor_tick_out", "vpn_monitor_test_evaluate_out"], "vpn_monitor_policy_load", 2690, 350);
fn("vpn_monitor_policy_load", groups.decision, "Carregar política canônica", "vpn-monitor-policy-load.js", 1, 2880, 350, [["vpn_monitor_policy_available"]]);
sw("vpn_monitor_policy_available", groups.decision, "Existe política válida?", "policy_available", "msg", [{ t: "true" }, { t: "else" }], 3120, 350, [["vpn_monitor_facts_read"], ["vpn_monitor_policy_missing"]]);
terminal("vpn_monitor_policy_missing", groups.decision, "Falha fechada sem política", { fill: "red", shape: "ring", text: "política ausente" }, 3370, 260);
fn("vpn_monitor_facts_read", groups.decision, "Ler fatos e estado anterior", "vpn-monitor-facts-read.js", 1, 3390, 350, [["vpn_monitor_internet_online"]]);
sw("vpn_monitor_internet_online", groups.decision, "Internet está online?", "vpn.internet_online", "msg", [{ t: "true" }, { t: "else" }], 3650, 350, [["vpn_monitor_healthy"], ["vpn_monitor_suppress"]]);
fn("vpn_monitor_suppress", groups.decision, "Suprimir pela causa internet", "vpn-monitor-suppress.js", 1, 3930, 220, [["vpn_monitor_suppressed_out"]]);
statePath("vpn_monitor_suppressed_out", "Supressão → persistir", 4180, 220);
sw("vpn_monitor_healthy", groups.decision, "VPN e relatório estão saudáveis?", "vpn.healthy", "msg", [{ t: "true" }, { t: "else" }], 3930, 420, [["vpn_monitor_incident_open"], ["vpn_monitor_failure_update"]]);
fn("vpn_monitor_failure_update", groups.decision, "Marcar início da falha", "vpn-monitor-failure-update.js", 1, 4210, 330, [["vpn_monitor_failure_confirmed"]]);
sw("vpn_monitor_failure_confirmed", groups.decision, "Falha atingiu 120 s?", "vpn.failure_elapsed_s >= policy.failure_confirm_s", "jsonata", [{ t: "true" }, { t: "else" }], 4480, 330, [["vpn_monitor_offline_update"], ["vpn_monitor_failure_wait_out"]]);
statePath("vpn_monitor_failure_wait_out", "Confirmação pendente → persistir", 4770, 260);
fn("vpn_monitor_offline_update", groups.decision, "Confirmar offline e lembrete", "vpn-monitor-offline-update.js", 1, 4770, 370, [["vpn_monitor_notification_due"]]);
sw("vpn_monitor_notification_due", groups.decision, "Incidente novo ou lembrete devido?", "vpn.notification_due", "msg", [{ t: "true" }, { t: "else" }], 5050, 370, [["vpn_monitor_down_build"], ["vpn_monitor_offline_no_notify_out"]]);
statePath("vpn_monitor_offline_no_notify_out", "Incidente deduplicado → persistir", 5340, 300);
fn("vpn_monitor_down_build", groups.decision, "Montar alerta de queda", "vpn-monitor-down-build.js", 2, 5340, 400, [["vpn_monitor_down_notify_out"], ["vpn_monitor_down_state_out"]]);
linkOut("vpn_monitor_down_notify_out", groups.decision, "Queda → efeito", "vpn_monitor_notify_in", 5600, 370);
statePath("vpn_monitor_down_state_out", "Queda → persistir", 5600, 430);
sw("vpn_monitor_incident_open", groups.decision, "Existe incidente aberto?", "vpn.current.incident_open", "msg", [{ t: "true" }, { t: "else" }], 4210, 540, [["vpn_monitor_recovery_update"], ["vpn_monitor_online_update"]]);
fn("vpn_monitor_online_update", groups.decision, "Manter online sem incidente", "vpn-monitor-online-update.js", 1, 4490, 610, [["vpn_monitor_online_state_out"]]);
statePath("vpn_monitor_online_state_out", "Online → persistir", 4760, 610);
fn("vpn_monitor_recovery_update", groups.decision, "Marcar início do recovery", "vpn-monitor-recovery-update.js", 1, 4490, 520, [["vpn_monitor_recovery_confirmed"]]);
sw("vpn_monitor_recovery_confirmed", groups.decision, "Recovery atingiu 60 s?", "vpn.recovery_elapsed_s >= policy.recovery_confirm_s", "jsonata", [{ t: "true" }, { t: "else" }], 4770, 520, [["vpn_monitor_recovery_build"], ["vpn_monitor_recovery_wait_out"]]);
statePath("vpn_monitor_recovery_wait_out", "Recovery pendente → persistir", 5050, 590);
fn("vpn_monitor_recovery_build", groups.decision, "Fechar incidente e montar retorno", "vpn-monitor-recovery-build.js", 2, 5050, 510, [["vpn_monitor_recovery_notify_out"], ["vpn_monitor_recovery_state_out"]]);
linkOut("vpn_monitor_recovery_notify_out", groups.decision, "Recovery → efeito", "vpn_monitor_notify_in", 5330, 500);
statePath("vpn_monitor_recovery_state_out", "Recovery → persistir", 5330, 550);
linkIn("vpn_monitor_state_in", groups.decision, "Receber mutação decidida", stateOrigins, "vpn_monitor_state_write", 5650, 620);
fn("vpn_monitor_state_write", groups.decision, "Persistir estado mínimo", "vpn-monitor-state-write.js", 1, 5840, 620, [["vpn_monitor_publish_out"]]);
linkOut("vpn_monitor_publish_out", groups.decision, "Estado → publicação canônica", "vpn_monitor_publish_in", 6050, 620);

linkIn("vpn_monitor_notify_in", groups.notify, "Receber queda ou recovery", ["vpn_monitor_down_notify_out", "vpn_monitor_recovery_notify_out"], "vpn_monitor_notify_guard", 6230, 150);
fn("vpn_monitor_notify_guard", groups.notify, "Produção ou TESTE?", "vpn-monitor-side-effect-guard.js", 2, 6480, 150, [["vpn_monitor_notify_dispatch"], ["vpn_monitor_dry_out"]]);
grouped(groups.notify, { id: "vpn_monitor_notify_dispatch", type: `subflow:${NOTIFY}`, z: TAB, g: groups.notify, name: "Notificar uma vez", env: [], x: 6790, y: 110, wires: [] });
linkOut("vpn_monitor_dry_out", groups.notify, "Notificação TESTE → dry-run", "vpn_monitor_dry_in", 6790, 190);

linkIn("vpn_monitor_publish_in", groups.publish, "Receber estado decidido", "vpn_monitor_publish_out", "vpn_monitor_publications_build", 6230, 450);
fn("vpn_monitor_publications_build", groups.publish, "Adaptar três tópicos canônicos", "vpn-monitor-publications-build.js", 1, 6480, 450, [["vpn_monitor_mqtt_guard"]]);
fn("vpn_monitor_mqtt_guard", groups.publish, "Produção ou TESTE?", "vpn-monitor-side-effect-guard.js", 2, 6740, 450, [["vpn_monitor_state_out"], ["vpn_monitor_publish_dry_out"]]);
grouped(groups.publish, { id: "vpn_monitor_state_out", type: "mqtt out", z: TAB, g: groups.publish, name: "Publicar estado retained", topic: "", qos: "1", retain: "true", respTopic: "", contentType: "", userProps: "", correl: "", expiry: "", broker: BROKER, x: 7040, y: 410, wires: [] });
linkOut("vpn_monitor_publish_dry_out", groups.publish, "MQTT TESTE → dry-run", "vpn_monitor_dry_in", 7040, 490);
inject("vpn_monitor_discovery_tick", groups.publish, "Discovery no startup", [{ p: "payload" }], 6330, 610, [["vpn_monitor_discovery"]], { once: true, onceDelay: "5" });
fn("vpn_monitor_discovery", groups.publish, "Criar sensores diagnósticos", "vpn-monitor-discovery.js", 1, 6610, 610, [["vpn_monitor_discovery_out"]]);
grouped(groups.publish, { id: "vpn_monitor_discovery_out", type: "mqtt out", z: TAB, g: groups.publish, name: "Publicar discovery retained", topic: "", qos: "1", retain: "true", respTopic: "", contentType: "", userProps: "", correl: "", expiry: "", broker: BROKER, x: 7040, y: 610, wires: [] });

grouped(groups.test, { id: "vpn_monitor_test_instructions", type: "comment", z: TAB, g: groups.test,
  name: "Ordem: reset → internet online → VPN offline → +121 s → VPN online → +61 s. Negativo: internet offline suprime a queda.",
  info: "Entradas sintéticas percorrem a política e terminam no dry-run; nenhuma notificação ou publicação MQTT é enviada.", x: 1000, y: 800, wires: [] });
inject("vpn_monitor_test_reset", groups.test, "TESTE 1: reset", [{ p: "payload" }], 180, 870, [["vpn_monitor_test_reset_state"]]);
fn("vpn_monitor_test_reset_state", groups.test, "Resetar estado sintético", "vpn-monitor-reset-test.js", 1, 440, 870, []);
const testProps = (kind, now, payload, vt = "str") => [{ p: "_vpn_test", v: "true", vt: "bool" }, { p: "_vpn_test_kind", v: kind, vt: "str" }, { p: "vpn_now", v: String(now), vt: "num" }, { p: "payload", v: payload, vt }];
inject("vpn_monitor_test_internet_online", groups.test, "TESTE 2: internet online", testProps("internet", 100000, "online"), 210, 930, [["vpn_monitor_test_router"]]);
inject("vpn_monitor_test_internet_offline", groups.test, "TESTE 2B: internet offline", testProps("internet", 100000, "offline"), 210, 970, [["vpn_monitor_test_router"]]);
inject("vpn_monitor_test_vpn_down", groups.test, "TESTE 3: VPN offline", testProps("report", 100000, '{"schema_version":1,"checked_at":"1970-01-01T00:01:40.000Z","vpns":[{"role":"vpn_primary","kind":"tailscale","installed":true,"healthy":false,"reason":"backend_stopped","checked_at":"1970-01-01T00:01:40.000Z"}]}', "json"), 210, 1010, [["vpn_monitor_test_router"]]);
inject("vpn_monitor_test_confirm_down", groups.test, "TESTE 4: avaliar +121 s", testProps("evaluate", 221000, ""), 210, 1050, [["vpn_monitor_test_router"]]);
inject("vpn_monitor_test_vpn_up", groups.test, "TESTE 5: VPN online", testProps("report", 230000, '{"schema_version":1,"checked_at":"1970-01-01T00:03:50.000Z","vpns":[{"role":"vpn_primary","kind":"tailscale","installed":true,"healthy":true,"reason":"running","checked_at":"1970-01-01T00:03:50.000Z"}]}', "json"), 210, 1090, [["vpn_monitor_test_router"]]);
inject("vpn_monitor_test_confirm_up", groups.test, "TESTE 6: avaliar +61 s", testProps("evaluate", 291000, ""), 210, 1130, [["vpn_monitor_test_router"]]);
fn("vpn_monitor_test_router", groups.test, "Rotear estado sintético", "vpn-monitor-test-router.js", 3, 520, 1020, [["vpn_monitor_test_internet_out"], ["vpn_monitor_test_report_out"], ["vpn_monitor_test_evaluate_out"]]);
linkOut("vpn_monitor_test_internet_out", groups.test, "Internet TESTE → normalização", "vpn_monitor_test_internet_in", 800, 960);
linkOut("vpn_monitor_test_report_out", groups.test, "VPN TESTE → normalização", "vpn_monitor_test_report_in", 800, 1020);
linkOut("vpn_monitor_test_evaluate_out", groups.test, "Agenda TESTE → decisão", "vpn_monitor_evaluate_in", 800, 1080);
linkIn("vpn_monitor_dry_in", groups.test, "Receber efeitos TESTE", ["vpn_monitor_dry_out", "vpn_monitor_publish_dry_out"], "vpn_monitor_dry_run_terminal", 1500, 1020);
fn("vpn_monitor_dry_run_terminal", groups.test, "TESTE FINAL: nenhum efeito enviado", "vpn-monitor-dry-run.js", 1, 1770, 1020, []);

next.push(...nodes);
fs.writeFileSync(outputPath, `${JSON.stringify(next, null, 4)}\n`);
console.log(`VPN monitor visual flow installed in ${outputPath}`);
