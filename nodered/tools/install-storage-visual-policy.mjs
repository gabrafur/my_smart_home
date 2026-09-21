#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const inputPath = path.resolve(process.argv[2] ?? path.resolve(here, "..", "flows.json"));
const outputPath = path.resolve(process.argv[3] ?? inputPath);
const functionsDir = path.join(here, "functions");
const TAB = "storage_health_tab";
let flows = JSON.parse(fs.readFileSync(inputPath, "utf8"));
const source = (name) => fs.readFileSync(path.join(functionsDir, name), "utf8").trimEnd();
const newIds = new Set(flows.filter((node) => node.id.startsWith("storage_visual_")).map((node) => node.id));
newIds.add("storage_set_config");
newIds.add("storage_evaluate");
flows = flows.filter((node) => !newIds.has(node.id));
for (const node of flows) {
  for (const field of ["nodes", "scope", "links"]) if (Array.isArray(node[field])) node[field] = node[field].filter((id) => !newIds.has(id));
  if (Array.isArray(node.wires)) node.wires = node.wires.map((wire) => Array.isArray(wire) ? wire.filter((id) => !newIds.has(id)) : wire);
}
const byId = new Map(flows.map((node) => [node.id, node]));
const required = (id) => { const node = byId.get(id); if (!node) throw new Error(`Nó obrigatório ausente: ${id}`); return node; };
const add = (node) => { flows.push(node); byId.set(node.id, node); return node; };
const group = (id, name, x, y, w, h, stroke, fill) => add({ id, type: "group", z: TAB, name,
  style: { label: true, "label-position": "nw", color: "#1f2937", stroke, fill, "fill-opacity": "0.35" }, nodes: [], x, y, w, h });
const decisionGroup = group("storage_visual_decision_group", "3. Tendência, severidade, alertas e autocuidado", 2640, 20, 6900, 680, "#0f766e", "#ccfbf1");
const grouped = (g, node) => { add(node); required(g).nodes.push(node.id); return node; };
const fn = (id, g, name, file, outputs, x, y, wires) => grouped(g, { id, type: "function", z: TAB, g, name,
  func: source(file), outputs, timeout: 0, noerr: 0, initialize: "", finalize: "", libs: [], x, y, wires });
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

const configGroup = required("storage_group_config");
Object.assign(configGroup, { name: "0. Política visual e MQTT discovery", x: 64, y: 20, w: 1500, h: 280 });
configGroup.nodes = configGroup.nodes.filter((id) => !newIds.has(id));
Object.assign(required("storage_comment_architecture"), { x: 700, y: 60,
  name: "Política em unidades humanas; métricas HA são fatos; efeitos privilegiados permanecem allowlisted." });
const policy = { warning_pct: 70, high_pct: 80, critical_pct: 90, hysteresis_pp: 3,
  notification_cooldown_h: 12, command_error_cooldown_h: 6, trend_24h_pp: 5, trend_7d_pp: 10,
  auto_remediation_cooldown_h: 6, sample_interval_min: 15, history_retention_days: 8 };
Object.assign(required("storage_init"), {
  name: "CONFIG: aplicar política visual", x: 190, y: 150,
  props: [{ p: "payload", v: JSON.stringify(policy), vt: "json" }], payload: "", payloadType: "date",
  wires: [["storage_visual_policy_validate"]]
});
fn("storage_visual_policy_validate", configGroup.id, "Validar percentuais e tempos", "storage-policy-validate.js", 1, 440, 150, [["storage_visual_policy_switch"]]);
sw("storage_visual_policy_switch", configGroup.id, "Configuração é válida e ordenada?", "policy_valid", "msg", [{ t: "true" }, { t: "else" }], 700, 150, [["storage_visual_policy_store"], ["storage_visual_policy_reject"]]);
fn("storage_visual_policy_store", configGroup.id, "Guardar última política válida", "storage-policy-store.js", 1, 970, 120, [["storage_discovery"]]);
fn("storage_visual_policy_reject", configGroup.id, "Rejeitar sem substituir", "storage-policy-reject.js", 0, 970, 190, []);
Object.assign(required("storage_discovery"), { x: 1200, y: 120 });
Object.assign(required("storage_mqtt_discovery"), { x: 1440, y: 120 });

const healthGroup = required("storage_group_health");
Object.assign(healthGroup, { name: "1. Entradas e normalização", x: 1600, y: 20, w: 1000, h: 500 });
healthGroup.nodes = healthGroup.nodes.filter((id) => !newIds.has(id) && !["storage_mqtt_state", "storage_manual_status_mqtt", "storage_test_decision_out", "storage_auto_out"].includes(id));
for (const id of healthGroup.nodes) required(id).g = healthGroup.id;
Object.assign(required("storage_health_tick"), { x: 1740, y: 140, name: "POLÍTICA: coletar a cada 15 min" });
Object.assign(required("storage_recheck_in"), { x: 1660, y: 220 });
Object.assign(required("storage_read_ha"), { x: 2050, y: 180, wires: [["storage_visual_input_out"]] });
linkOut("storage_visual_input_out", healthGroup.id, "Métricas HA → política", "storage_visual_input_in", 2450, 180);
grouped(healthGroup.id, { id: "storage_visual_history_seed_tick", type: "inject", z: TAB, g: healthGroup.id,
  name: "Recompor histórico ao iniciar e diariamente", props: [{ p: "payload" }], repeat: "", crontab: "10 02 * * *",
  once: true, onceDelay: "12", payload: "", payloadType: "date", x: 1780, y: 80, wires: [["storage_visual_history_fetch"]] });
grouped(healthGroup.id, { id: "storage_visual_history_fetch", type: "api-get-history", z: TAB, g: healthGroup.id,
  name: "Ler 8 dias reais do Recorder", server: required("storage_read_ha").server, version: 1, startDate: "", endDate: "",
  entityId: "sensor.raspberry_pi_storage_usage", entityIdType: "equals", useRelativeTime: true, relativeTime: "8 days",
  flatten: true, outputType: "array", outputLocationType: "msg", outputLocation: "payload", x: 2070, y: 80,
  wires: [["storage_visual_history_seed"]] });
fn("storage_visual_history_seed", healthGroup.id, "Validar e compactar histórico real", "storage-history-seed.js", 1, 2320, 80, [["storage_visual_history_seed_out"]]);
linkOut("storage_visual_history_seed_out", healthGroup.id, "Histórico recomposto → avaliar", "storage_visual_history_seed_in", 2520, 80);
linkIn("storage_visual_history_seed_in", healthGroup.id, "Reavaliar após recomposição", "storage_visual_history_seed_out", "storage_read_ha", 1660, 270);
Object.assign(required("storage_manual_health"), { x: 1760, y: 330 });
Object.assign(required("storage_manual_start"), { x: 2050, y: 330, wires: [["storage_exec_maintenance"], ["storage_request_host_maintenance"], ["storage_read_ha"], ["storage_manual_status_mqtt"]] });
Object.assign(required("storage_test_input_in"), { x: 1660, y: 430, wires: [["storage_visual_test_input_out"]] });
linkOut("storage_visual_test_input_out", healthGroup.id, "Métricas TESTE → mesma política", "storage_visual_input_in", 2050, 430);

linkIn("storage_visual_input_in", decisionGroup.id, "Receber métricas reais ou sintéticas", ["storage_visual_input_out", "storage_visual_test_input_out"], "storage_visual_policy_load", 2690, 330);
fn("storage_visual_policy_load", decisionGroup.id, "Carregar política canônica", "storage-policy-load.js", 1, 2890, 330, [["storage_visual_policy_available"]]);
sw("storage_visual_policy_available", decisionGroup.id, "Existe política válida?", "policy_available", "msg", [{ t: "true" }, { t: "else" }], 3130, 330, [["storage_visual_input_normalize"], ["storage_visual_policy_missing"]]);
terminal("storage_visual_policy_missing", decisionGroup.id, "Falha fechada sem política", { fill: "red", shape: "ring", text: "política ausente" }, 3390, 230);
fn("storage_visual_input_normalize", decisionGroup.id, "Validar métricas e carregar estado", "storage-input-normalize.js", 1, 3400, 330, [["storage_visual_metrics_valid"]]);
sw("storage_visual_metrics_valid", decisionGroup.id, "Percentual e espaço livre são válidos?", "storage.valid", "msg", [{ t: "true" }, { t: "else" }], 3660, 330, [["storage_visual_history_analyze"], ["storage_visual_error_due"]]);
sw("storage_visual_error_due", decisionGroup.id, "Alerta de coleta venceu cooldown de 6 h?", "storage.error_due", "msg", [{ t: "true" }, { t: "else" }], 3930, 190, [["storage_visual_invalid_finalize"], ["storage_visual_invalid_finalize"]]);
fn("storage_visual_invalid_finalize", decisionGroup.id, "Publicar indisponibilidade sem autocuidado", "storage-invalid-finalize.js", 4, 4240, 190,
  [["storage_visual_invalid_mqtt_out"], ["storage_visual_invalid_notify_out"], ["storage_visual_invalid_test_out"], []]);
linkOut("storage_visual_invalid_mqtt_out", decisionGroup.id, "Indisponível → MQTT", "storage_visual_mqtt_in", 4540, 140);
linkOut("storage_visual_invalid_notify_out", decisionGroup.id, "Indisponível → alerta", "storage_visual_notify_in", 4540, 190);
linkOut("storage_visual_invalid_test_out", decisionGroup.id, "Indisponível TESTE → resultado", "storage_test_decision_in", 4540, 240);
fn("storage_visual_history_analyze", decisionGroup.id, "Calcular janelas e causa provável", "storage-history-analyze.js", 1, 3940, 380, [["storage_visual_raw_severity"]]);
sw("storage_visual_raw_severity", decisionGroup.id, "Classificar uso pelos thresholds", "storage.used", "msg", [
  { t: "gte", v: "policy.critical_pct", vt: "msg" }, { t: "gte", v: "policy.high_pct", vt: "msg" },
  { t: "gte", v: "policy.warning_pct", vt: "msg" }, { t: "else" }
], 4210, 380, [["storage_visual_set_critical"], ["storage_visual_set_high"], ["storage_visual_set_warning"], ["storage_visual_set_normal"]]);
const rawOrigins = [];
for (const [id, name, value, y] of [
  ["storage_visual_set_critical", "Raw: critical", "critical", 300], ["storage_visual_set_high", "Raw: high", "high", 360],
  ["storage_visual_set_warning", "Raw: warning", "warning", 420], ["storage_visual_set_normal", "Raw: normal", "normal", 480]
]) {
  const out = `${id}_out`;
  change(id, decisionGroup.id, name, [{ t: "set", p: "storage.raw_severity", pt: "msg", to: value, tot: "str" }], 4480, y, [[out]]);
  linkOut(out, decisionGroup.id, "Raw → histerese", "storage_visual_hysteresis_in", 4690, y);
  rawOrigins.push(out);
}
linkIn("storage_visual_hysteresis_in", decisionGroup.id, "Receber severidade bruta", rawOrigins, "storage_visual_keep_critical", 4780, 380);
sw("storage_visual_keep_critical", decisionGroup.id, "Manter critical dentro de 3 pp?", 'storage.previous = "critical" and storage.used >= policy.critical_pct - policy.hysteresis_pp', "jsonata", [{ t: "true" }, { t: "else" }], 5000, 380, [["storage_visual_final_critical"], ["storage_visual_keep_high"]]);
sw("storage_visual_keep_high", decisionGroup.id, "Manter high dentro de 3 pp?", 'storage.previous = "high" and storage.used >= policy.high_pct - policy.hysteresis_pp and storage.raw_severity != "critical"', "jsonata", [{ t: "true" }, { t: "else" }], 5280, 380, [["storage_visual_final_high"], ["storage_visual_keep_warning"]]);
sw("storage_visual_keep_warning", decisionGroup.id, "Manter warning dentro de 3 pp?", 'storage.previous = "warning" and storage.used >= policy.warning_pct - policy.hysteresis_pp and storage.raw_severity = "normal"', "jsonata", [{ t: "true" }, { t: "else" }], 5560, 380, [["storage_visual_final_warning"], ["storage_visual_final_raw"]]);
const finalOrigins = [];
for (const [id, name, to, tot, x, y] of [
  ["storage_visual_final_critical", "Final: critical", "critical", "str", 5280, 200],
  ["storage_visual_final_high", "Final: high", "high", "str", 5560, 270],
  ["storage_visual_final_warning", "Final: warning", "warning", "str", 5840, 340],
  ["storage_visual_final_raw", "Final: usar classificação bruta", "storage.raw_severity", "msg", 5840, 450]
]) {
  const out = `${id}_out`;
  change(id, decisionGroup.id, name, [{ t: "set", p: "storage.severity", pt: "msg", to, tot }], x, y, [[out]]);
  linkOut(out, decisionGroup.id, "Severidade → fatos", "storage_visual_facts_in", x + 210, y);
  finalOrigins.push(out);
}
linkIn("storage_visual_facts_in", decisionGroup.id, "Receber severidade final", finalOrigins, "storage_visual_facts", 5750, 570);
change("storage_visual_facts", decisionGroup.id, "Calcular fatos sem rotear", [
  { t: "set", p: "storage.accelerated", pt: "msg", to: "(storage.growth24h != null and storage.growth24h >= policy.trend_24h_pp) or (storage.growth7d != null and storage.growth7d >= policy.trend_7d_pp)", tot: "jsonata" },
  { t: "set", p: "storage.recovered", pt: "msg", to: 'storage.severity = "normal" and storage.previous != "normal"', tot: "jsonata" },
  { t: "set", p: "storage.escalated", pt: "msg", to: '(storage.severity = "critical" and storage.previous != "critical") or (storage.severity = "high" and (storage.previous = "normal" or storage.previous = "warning")) or (storage.severity = "warning" and storage.previous = "normal")', tot: "jsonata" },
  { t: "set", p: "storage.capacity_due", pt: "msg", to: "storage.escalated or (storage.severity != \"normal\" and storage.now - storage.state.lastNotificationAt >= policy.notification_cooldown_h * 3600000)", tot: "jsonata" },
  { t: "set", p: "storage.trend_due", pt: "msg", to: "storage.now - storage.state.lastTrendNotificationAt >= policy.notification_cooldown_h * 3600000", tot: "jsonata" },
  { t: "set", p: "storage.remediation_needed", pt: "msg", to: 'storage.accelerated or storage.severity != "normal"', tot: "jsonata" },
  { t: "set", p: "storage.remediation_due", pt: "msg", to: "storage.now - storage.state.lastAutoRemediationAt >= policy.auto_remediation_cooldown_h * 3600000", tot: "jsonata" }
], 6000, 570, [["storage_visual_recovery_gate"]]);
sw("storage_visual_recovery_gate", decisionGroup.id, "Severidade voltou ao normal?", "storage.recovered", "msg", [{ t: "true" }, { t: "else" }], 6250, 570, [["storage_visual_alert_recovery"], ["storage_visual_capacity_gate"]]);
change("storage_visual_alert_recovery", decisionGroup.id, "Alerta: recovery", [{ t: "set", p: "storage.alert_kind", pt: "msg", to: "recovery", tot: "str" }], 6500, 480, [["storage_visual_alert_recovery_out"]]);
linkOut("storage_visual_alert_recovery_out", decisionGroup.id, "Recovery → construir alerta", "storage_visual_alert_build_in", 6750, 480);
sw("storage_visual_capacity_gate", decisionGroup.id, "Escalada ou lembrete de capacidade?", "storage.capacity_due", "msg", [{ t: "true" }, { t: "else" }], 6550, 590, [["storage_visual_alert_capacity"], ["storage_visual_trend_gate"]]);
change("storage_visual_alert_capacity", decisionGroup.id, "Alerta: capacidade", [{ t: "set", p: "storage.alert_kind", pt: "msg", to: "capacity", tot: "str" }], 6850, 540, [["storage_visual_alert_capacity_out"]]);
linkOut("storage_visual_alert_capacity_out", decisionGroup.id, "Capacidade → construir alerta", "storage_visual_alert_build_in", 7100, 540);
sw("storage_visual_trend_gate", decisionGroup.id, "Crescimento acelerado venceu cooldown?", "storage.accelerated and storage.trend_due", "jsonata", [{ t: "true" }, { t: "else" }], 6850, 640, [["storage_visual_alert_trend"], ["storage_visual_alert_none"]]);
change("storage_visual_alert_trend", decisionGroup.id, "Alerta: tendência", [{ t: "set", p: "storage.alert_kind", pt: "msg", to: "trend", tot: "str" }], 7150, 610, [["storage_visual_alert_trend_out"]]);
linkOut("storage_visual_alert_trend_out", decisionGroup.id, "Tendência → construir alerta", "storage_visual_alert_build_in", 7380, 610);
change("storage_visual_alert_none", decisionGroup.id, "Sem novo alerta", [{ t: "set", p: "storage.alert_kind", pt: "msg", to: "none", tot: "str" }], 7150, 680, [["storage_visual_alert_none_out"]]);
linkOut("storage_visual_alert_none_out", decisionGroup.id, "Sem alerta → continuar", "storage_visual_alert_build_in", 7380, 680);
linkIn("storage_visual_alert_build_in", decisionGroup.id, "Receber seleção de alerta", ["storage_visual_alert_recovery_out", "storage_visual_alert_capacity_out", "storage_visual_alert_trend_out", "storage_visual_alert_none_out"], "storage_visual_alert_build", 7480, 570);
fn("storage_visual_alert_build", decisionGroup.id, "Montar alerta selecionado", "storage-alert-build.js", 1, 7700, 570, [["storage_visual_remediation_gate"]]);
sw("storage_visual_remediation_gate", decisionGroup.id, "Capacidade ou tendência exigem autocuidado?", "storage.remediation_needed", "msg", [{ t: "true" }, { t: "else" }], 7980, 570, [["storage_visual_remediation_cooldown"], ["storage_visual_no_remediation"]]);
sw("storage_visual_remediation_cooldown", decisionGroup.id, "Cooldown de autocuidado venceu?", "storage.remediation_due", "msg", [{ t: "true" }, { t: "else" }], 8260, 520, [["storage_visual_state_finalize"], ["storage_visual_no_remediation"]]);
change("storage_visual_no_remediation", decisionGroup.id, "Não solicitar autocuidado", [{ t: "set", p: "storage.remediation_due", pt: "msg", to: "false", tot: "bool" }], 8260, 630, [["storage_visual_state_finalize"]]);
fn("storage_visual_state_finalize", decisionGroup.id, "Persistir estado e intenção", "storage-state-finalize.js", 1, 8480, 570, [["storage_visual_attributes_build"]]);
fn("storage_visual_attributes_build", decisionGroup.id, "Adaptar atributos canônicos", "storage-attributes-build.js", 1, 8720, 570, [["storage_visual_mqtt_build"]]);
fn("storage_visual_mqtt_build", decisionGroup.id, "Adaptar tópicos MQTT", "storage-mqtt-build.js", 1, 8960, 570, [["storage_visual_output_route"]]);
fn("storage_visual_output_route", decisionGroup.id, "Emitir quatro contratos", "storage-output-route.js", 4, 9200, 570,
  [["storage_visual_mqtt_out"], ["storage_visual_notify_out"], ["storage_test_decision_out"], ["storage_auto_out"]]);
linkOut("storage_visual_mqtt_out", decisionGroup.id, "Estado → MQTT", "storage_visual_mqtt_in", 9460, 500);
linkOut("storage_visual_notify_out", decisionGroup.id, "Alerta → destinatários", "storage_visual_notify_in", 9460, 560);

const effects = required("storage_group_alerts");
Object.assign(effects, { name: "4. Efeitos e confirmação", x: 9580, y: 20, w: 1200, h: 680 });
effects.nodes = effects.nodes.filter((id) => !["storage_mqtt_state", "storage_manual_status_mqtt"].includes(id));
for (const id of effects.nodes) Object.assign(required(id), { g: effects.id });
for (const id of ["storage_mqtt_state", "storage_manual_status_mqtt"]) { const node = required(id); node.g = effects.id; effects.nodes.push(id); }
linkIn("storage_visual_mqtt_in", effects.id, "Receber publicações canônicas", ["storage_visual_mqtt_out", "storage_visual_invalid_mqtt_out"], "storage_mqtt_state", 9630, 140);
Object.assign(required("storage_mqtt_state"), { x: 9910, y: 140 });
Object.assign(required("storage_manual_status_mqtt"), { x: 9910, y: 220 });
grouped(effects.id, { id: "storage_visual_notify_in", type: "link in", z: TAB, g: effects.id, name: "Receber alerta decidido",
  links: ["storage_visual_notify_out", "storage_visual_invalid_notify_out", "storage_visual_maintenance_notify_out"], x: 9630, y: 380, wires: [["storage_notify", "storage_notify_persistent"]] });
Object.assign(required("storage_notify"), { x: 9980, y: 320 });
Object.assign(required("storage_notify_persistent"), { x: 9980, y: 440 });
Object.assign(required("storage_notification_ack"), { x: 10400, y: 380 });
Object.assign(required("storage_notification_catch"), { x: 9800, y: 560 });
Object.assign(required("storage_notification_failure"), { x: 10200, y: 560 });

required("storage_test_decision_out").g = decisionGroup.id;
decisionGroup.nodes.push("storage_test_decision_out");
Object.assign(required("storage_test_decision_out"), { x: 9460, y: 630 });
required("storage_auto_out").g = decisionGroup.id;
decisionGroup.nodes.push("storage_auto_out");
Object.assign(required("storage_auto_out"), { x: 9460, y: 680 });

const shift = (groupId, x, y) => {
  const g = required(groupId); const dx = x - g.x; const dy = y - g.y;
  g.x = x; g.y = y;
  for (const id of g.nodes) { const node = required(id); node.x += dx; node.y += dy; }
};
shift("storage_group_maintenance", 64, 650);
shift("storage_group_tests", 1850, 760);
const maintenance = required("storage_group_maintenance");
const tests = required("storage_group_tests");
Object.assign(maintenance, { name: "5. Efeitos allowlisted, recovery e retries", w: 1750, h: 570 });
Object.assign(tests, { name: "6. TESTE — caminho integral em dry-run", h: 400 });

Object.assign(required("storage_manual_start"), { wires: [["storage_visual_manual_exec_out"], ["storage_visual_manual_host_out"], ["storage_read_ha"], ["storage_visual_manual_status_out"]] });
linkOut("storage_visual_manual_exec_out", healthGroup.id, "Manual → housekeeping", "storage_visual_manual_exec_in", 2470, 300);
linkOut("storage_visual_manual_host_out", healthGroup.id, "Manual → worker do host", "storage_visual_manual_host_in", 2470, 350);
linkOut("storage_visual_manual_status_out", healthGroup.id, "Manual running → MQTT", "storage_visual_manual_status_in", 2470, 400);
linkIn("storage_visual_manual_exec_in", maintenance.id, "Receber housekeeping manual", "storage_visual_manual_exec_out", "storage_exec_maintenance", 620, 680);
linkIn("storage_visual_manual_host_in", maintenance.id, "Receber worker manual", "storage_visual_manual_host_out", "storage_request_host_maintenance", 620, 940);

Object.assign(required("storage_daily_maintenance"), { x: 220, y: 760 });
Object.assign(required("storage_auto_gate"), { x: 520, y: 760 });
Object.assign(required("storage_exec_maintenance"), { x: 850, y: 760 });
Object.assign(required("storage_parse_maintenance"), { x: 1180, y: 740 });
Object.assign(required("storage_store_maintenance_stderr"), { x: 1180, y: 820 });
Object.assign(required("storage_maintenance_complete"), { x: 1500, y: 780 });
Object.assign(required("storage_weekly_inspection"), { x: 220, y: 1080 });
Object.assign(required("storage_exec_inspection"), { x: 520, y: 1080 });
Object.assign(required("storage_parse_inspection"), { x: 850, y: 1080 });
Object.assign(required("storage_request_host_maintenance"), { x: 850, y: 940 });
Object.assign(required("storage_post_maintenance_delay"), { x: 1200, y: 920 });
Object.assign(required("storage_manual_complete"), { x: 1500, y: 1080 });

Object.assign(required("storage_exec_maintenance"), { wires: [["storage_parse_maintenance"], ["storage_store_maintenance_stderr"], ["storage_visual_exec_done_out"]] });
linkOut("storage_visual_exec_done_out", maintenance.id, "Exec concluído → lifecycle", "storage_visual_exec_done_in", 1040, 680);
grouped(maintenance.id, { id: "storage_visual_exec_done_in", type: "link in", z: TAB, g: maintenance.id,
  name: "Receber conclusão do exec", links: ["storage_visual_exec_done_out"], x: 1300, y: 680,
  wires: [["storage_maintenance_complete", "storage_manual_complete"]] });
Object.assign(required("storage_exec_inspection"), { wires: [["storage_parse_inspection"], ["storage_visual_inspection_stderr_out"], ["storage_visual_inspection_done_out"]] });
linkOut("storage_visual_inspection_stderr_out", maintenance.id, "Stderr inspeção → parser", "storage_visual_stderr_in", 780, 1160);
linkOut("storage_visual_inspection_done_out", maintenance.id, "Inspeção concluída → lifecycle", "storage_visual_request_done_in", 780, 1010);
linkIn("storage_visual_stderr_in", maintenance.id, "Receber stderr distante", "storage_visual_inspection_stderr_out", "storage_store_maintenance_stderr", 1020, 1160);
Object.assign(required("storage_request_host_maintenance"), { wires: [["storage_post_maintenance_delay"], ["storage_store_maintenance_stderr"], ["storage_visual_request_done_out"]] });
linkOut("storage_visual_request_done_out", maintenance.id, "Worker concluído → lifecycle", "storage_visual_request_done_in", 1050, 1000);
linkIn("storage_visual_request_done_in", maintenance.id, "Receber conclusão de inspeção/worker", ["storage_visual_inspection_done_out", "storage_visual_request_done_out"], "storage_maintenance_complete", 1300, 1040);
Object.assign(required("storage_maintenance_complete"), { wires: [["storage_visual_maintenance_notify_out"]] });
linkOut("storage_visual_maintenance_notify_out", maintenance.id, "Resultado → alerta unificado", "storage_visual_notify_in", 1740, 780);

Object.assign(required("storage_manual_complete"), { wires: [["storage_visual_manual_complete_status_out"]] });
linkOut("storage_visual_manual_complete_status_out", maintenance.id, "Manual idle → MQTT", "storage_visual_manual_status_in", 1740, 1080);
linkIn("storage_visual_manual_status_in", effects.id, "Receber lifecycle manual", ["storage_visual_manual_status_out", "storage_visual_manual_complete_status_out"], "storage_manual_status_mqtt", 9630, 220);
Object.assign(required("storage_test_dry_out"), { x: 660, y: 840 });
Object.assign(required("storage_auto_gate"), { wires: [["storage_exec_maintenance"], ["storage_request_host_maintenance"], ["storage_test_dry_out"]] });
Object.assign(required("storage_dry_run_terminal"), { x: 3150, y: 980 });
required("storage_test_decision_in").links = ["storage_test_decision_out", "storage_visual_invalid_test_out"];
required(TAB).info = "Métricas HA são fatos. Política, thresholds, histerese, cooldowns, tendência, autocuidado, produção/teste e efeitos ficam explícitos; cálculo de janelas permanece adapter puro.";

fs.writeFileSync(outputPath, `${JSON.stringify(flows, null, 4)}\n`);
console.log(`Storage visual policy installed in ${outputPath}`);
