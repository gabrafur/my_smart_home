#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.resolve(process.argv[2] ?? path.resolve(here, "..", "flows.json"));
const outputPath = path.resolve(process.argv[3] ?? sourcePath);
const functionDir = path.join(here, "functions");
const TAB = "local_ai_rtx_recovery_tab";
const SERVER = "4126427d5e161a03";
const flows = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
const source = (name) => fs.readFileSync(path.join(functionDir, name), "utf8").trimEnd();
const owned = (node) => node.id === TAB || node.id.startsWith("local_ai_rtx_");
const removed = new Set(flows.filter(owned).map((node) => node.id));
const next = flows.filter((node) => !owned(node));
for (const node of next) {
  for (const field of ["nodes", "scope", "links"]) {
    if (Array.isArray(node[field])) node[field] = node[field].filter((id) =>
      !removed.has(id) ||
      (field === "links" && ["global_observer_events_in", "global_observer_alert_to_dispatch_in"].includes(node.id) && id === "local_ai_rtx_alert_out")
    );
  }
  if (Array.isArray(node.wires)) node.wires = node.wires.map((wire) => Array.isArray(wire) ? wire.filter((id) => !removed.has(id)) : wire);
}

const nodes = [];
const add = (node) => { nodes.push(node); return node.id; };
const group = (id, name, x, y, w, h, color, fill) => add({
  id, type: "group", z: TAB, name,
  style: { label: true, "label-position": "nw", color: "#1f2937", stroke: color, "stroke-opacity": "1", fill, "fill-opacity": "0.35" },
  nodes: [], x, y, w, h,
});
const groups = {
  policy: group("local_ai_rtx_policy_group", "0. Política visual e agenda passiva", 64, 20, 700, 360, "#2563eb", "#dbeafe"),
  health: group("local_ai_rtx_health_group", "1. Saúde, energia do host, decisões e estado", 800, 20, 5300, 590, "#0f766e", "#ccfbf1"),
  recovery: group("local_ai_rtx_recovery_group", "2. Gate final e recovery seguro via MCP", 800, 640, 2000, 280, "#dc2626", "#fee2e2"),
  alertClose: group("local_ai_rtx_alert_close_group", "3. Encerrar alerta após recuperação", 2850, 640, 2000, 280, "#7c3aed", "#ede9fe"),
  test: group("local_ai_rtx_test_group", "4. Testes manuais completos — dry-run", 64, 960, 2736, 330, "#0891b2", "#cffafe"),
};
const grouped = (groupId, node) => {
  add(node); nodes.find((entry) => entry.id === groupId).nodes.push(node.id); return node.id;
};
const fn = (id, g, name, file, outputs, x, y, wires) => grouped(g, {
  id, type: "function", z: TAB, g, name, func: source(file), outputs,
  timeout: 0, noerr: 0, initialize: "", finalize: "", libs: [], x, y, wires,
});
const inject = (id, g, name, props, x, y, wires, extra = {}) => grouped(g, {
  id, type: "inject", z: TAB, g, name, props, repeat: "", crontab: "", once: false,
  onceDelay: 0.1, topic: "", x, y, wires, ...extra,
});
const linkOut = (id, g, name, targets, x, y) => grouped(g, {
  id, type: "link out", z: TAB, g, name, mode: "link", links: Array.isArray(targets) ? targets : [targets], x, y, wires: [],
});
const linkIn = (id, g, name, origins, destination, x, y) => grouped(g, {
  id, type: "link in", z: TAB, g, name, links: Array.isArray(origins) ? origins : [origins], x, y, wires: [[destination]],
});
const change = (id, g, name, rules, x, y, wires) => grouped(g, {
  id, type: "change", z: TAB, g, name, rules, action: "", property: "", from: "", to: "", reg: false, x, y, wires,
});
const sw = (id, g, name, property, rules, x, y, wires) => grouped(g, {
  id, type: "switch", z: TAB, g, name, property, propertyType: "msg", rules,
  checkall: "true", repair: false, outputs: rules.length, x, y, wires,
});
const rbe = (id, g, name, property, x, y, wires) => grouped(g, {
  id, type: "rbe", z: TAB, g, name, func: "rbe", gap: "0", start: "", inout: "out",
  property, topi: "topic", septopics: true, x, y, wires,
});
const trigger = (id, g, name, duration, x, y, wires) => grouped(g, {
  id, type: "trigger", z: TAB, g, name, op1: "", op2: "", op1type: "nul", op2type: "payl",
  duration: String(duration), extend: false, overrideDelay: true, units: "s", reset: "",
  bytopic: "topic", topic: "topic", outputs: 1, x, y, wires,
});
const callService = (id, g, name, action, data, x, y, wires) => grouped(g, {
  id, type: "api-call-service", z: TAB, g, name, server: SERVER, version: 7,
  debugenabled: false, action, floorId: [], areaId: [], deviceId: [], entityId: [], labelId: [],
  data, dataType: "json", mergeContext: "", mustacheAltTags: false, outputProperties: [],
  queue: "all", blockInputOverrides: true,
  domain: action.split(".")[0], service: action.split(".")[1], x, y, wires,
});

add({
  id: TAB, type: "tab", label: "recuperacao_rtx", disabled: false,
  info: "Observação passiva e decisão visual. Recovery MCP exige clique explícito; cooldown e confirmação de indisponibilidade vêm da política validada e TESTE termina antes do HTTP autenticado.", env: [],
});

grouped(groups.policy, {
  id: "local_ai_rtx_architecture", type: "comment", z: TAB, g: groups.policy,
  name: "Leitura é passiva. Recovery nunca é automático.",
  info: "O Node-RED não executa WSL, Ollama, netsh, iphlpsvc nem SSH. A fonte sensor.codex_rtx_host_reachability_raw apenas confirma se o computador está ligado. Computador desligado silencia alertas; ligado com endpoint indisponível precisa permanecer assim durante a confirmação visual antes de alertar uma vez por incidente.",
  x: 410, y: 60, wires: [],
});
inject("local_ai_rtx_tick", groups.policy, "Agenda visível — verificar a cada 60 s", [{ p: "payload" }], 240, 130, [["local_ai_rtx_health_tick_out"]], { repeat: "60", once: true, onceDelay: "15" });
linkOut("local_ai_rtx_health_tick_out", groups.policy, "Tick passivo → leitura de saúde", "local_ai_rtx_health_tick_in", 560, 130);
inject("local_ai_rtx_policy_cooldown", groups.policy, "Cooldown entre recoveries — 60 s", [{ p: "payload" }, { p: "topic", vt: "str" }], 250, 220, [["local_ai_rtx_policy_validate"]], {
  once: true, onceDelay: 0.5, topic: "recovery_cooldown_seconds", payload: "60", payloadType: "num",
});
inject("local_ai_rtx_policy_confirmation", groups.policy, "Confirmar indisponibilidade — 90 s", [{ p: "payload" }, { p: "topic", vt: "str" }], 250, 290, [["local_ai_rtx_policy_validate"]], {
  once: true, onceDelay: 0.6, topic: "unavailable_confirmation_seconds", payload: "90", payloadType: "num",
});
fn("local_ai_rtx_policy_validate", groups.policy, "Validar limites e preservar último válido", "local-ai-rtx-policy-validate.js", 0, 570, 250, []);

linkIn("local_ai_rtx_health_tick_in", groups.health, "Receber tick passivo", "local_ai_rtx_health_tick_out", "local_ai_rtx_prepare_health", 850, 100);
inject("local_ai_rtx_manual_recovery", groups.health, "Pedido explícito: recuperar endpoint via MCP", [
  { p: "payload" }, { p: "explicit_recovery", v: "true", vt: "bool" },
], 1000, 170, [["local_ai_rtx_prepare_health"]]);
fn("local_ai_rtx_prepare_health", groups.health, "Adaptar requisição GET passiva", "local-ai-rtx-health-request.js", 1, 1200, 100, [["local_ai_rtx_health_http"]]);
grouped(groups.health, {
  id: "local_ai_rtx_health_http", type: "http request", z: TAB, g: groups.health,
  name: "FONTE: ler saúde do bridge", method: "use", ret: "obj", paytoqs: "ignore", url: "", tls: "",
  persist: false, proxy: "", insecureHTTPParser: false, authType: "", senderr: false, headers: [],
  x: 1450, y: 100, wires: [["local_ai_rtx_health_evaluate"]],
});
fn("local_ai_rtx_health_evaluate", groups.health, "Normalizar resposta de saúde", "local-ai-rtx-health-evaluate.js", 1, 1690, 150, [["local_ai_rtx_available_switch"]]);
linkIn("local_ai_rtx_test_health_in", groups.health, "Receber saúde TESTE", "local_ai_rtx_test_health_out", "local_ai_rtx_health_evaluate", 1450, 250);
sw("local_ai_rtx_available_switch", groups.health, "RTX está disponível?", "rtx_status.available", [
  { t: "eq", v: "true", vt: "bool" }, { t: "else" },
], 1950, 150, [["local_ai_rtx_set_available"], ["local_ai_rtx_explicit_switch"]]);
change("local_ai_rtx_set_available", groups.health, "Transição: disponível", [{ t: "set", p: "rtx_transition", pt: "msg", to: "available", tot: "str" }], 2190, 90, [["local_ai_rtx_state_out_left"]]);
sw("local_ai_rtx_explicit_switch", groups.health, "Recovery foi pedido explicitamente?", "explicit_recovery", [
  { t: "eq", v: "true", vt: "bool" }, { t: "else" },
], 2220, 190, [["local_ai_rtx_load_policy"], ["local_ai_rtx_set_unavailable"]]);
change("local_ai_rtx_set_unavailable", groups.health, "Transição: indisponível", [{ t: "set", p: "rtx_transition", pt: "msg", to: "unavailable", tot: "str" }], 2500, 220, [["local_ai_rtx_state_out_middle"]]);
change("local_ai_rtx_load_policy", groups.health, "Carregar política visual válida", [{ t: "set", p: "policy", pt: "msg", to: '$flowContext("local_ai_rtx_policy_v1", "persistent")', tot: "jsonata" }], 2480, 150, [["local_ai_rtx_cooldown_read"]]);
fn("local_ai_rtx_cooldown_read", groups.health, "Ler última tentativa (sem decidir)", "local-ai-rtx-cooldown-read.js", 1, 2740, 150, [["local_ai_rtx_test_mode_switch"]]);
sw("local_ai_rtx_test_mode_switch", groups.health, "Pedido é TESTE?", "test_mode", [
  { t: "eq", v: "true", vt: "bool" }, { t: "else" },
], 2990, 150, [["local_ai_rtx_set_requested"], ["local_ai_rtx_cooldown_switch"]]);
sw("local_ai_rtx_cooldown_switch", groups.health, "Cooldown já terminou?", "rtx_now", [
  { t: "gte", v: "rtx_cooldown_until", vt: "msg" }, { t: "else" },
], 2990, 230, [["local_ai_rtx_set_requested"], ["local_ai_rtx_set_cooldown"]]);
change("local_ai_rtx_set_requested", groups.health, "Transição: recovery solicitado", [{ t: "set", p: "rtx_transition", pt: "msg", to: "recovery_requested", tot: "str" }], 3260, 110, [["local_ai_rtx_state_out_right"]]);
change("local_ai_rtx_set_cooldown", groups.health, "Transição: bloqueado por cooldown", [{ t: "set", p: "rtx_transition", pt: "msg", to: "cooldown", tot: "str" }], 3260, 250, [["local_ai_rtx_state_out_right"]]);
linkOut("local_ai_rtx_state_out_left", groups.health, "Estado disponível → persistência", "local_ai_rtx_state_in", 2410, 90);
linkOut("local_ai_rtx_state_out_middle", groups.health, "Estado indisponível → persistência", "local_ai_rtx_state_in", 2760, 260);
linkOut("local_ai_rtx_state_out_right", groups.health, "Decisão de recovery → persistência", "local_ai_rtx_state_in", 3480, 290);
linkIn("local_ai_rtx_state_in", groups.health, "Receber transição decidida", ["local_ai_rtx_state_out_left", "local_ai_rtx_state_out_middle", "local_ai_rtx_state_out_right"], "local_ai_rtx_state_update", 2380, 360);
fn("local_ai_rtx_state_update", groups.health, "Persistir estado normalizado", "local-ai-rtx-state-update.js", 1, 2610, 400, [["local_ai_rtx_transition_switch"]]);
sw("local_ai_rtx_transition_switch", groups.health, "Rota: status, alerta ou recovery?", "rtx_transition", [
  { t: "eq", v: "available", vt: "str" },
  { t: "eq", v: "unavailable", vt: "str" },
  { t: "eq", v: "recovery_requested", vt: "str" },
  { t: "else" },
], 2870, 400, [["local_ai_rtx_available_mode_switch"], ["local_ai_rtx_unavailable_mode_switch"], ["local_ai_rtx_recovery_out"], ["local_ai_rtx_status_transition_out"]]);
sw("local_ai_rtx_available_mode_switch", groups.health, "Disponível em TESTE ou produção?", "test_mode", [
  { t: "true" }, { t: "else" },
], 3200, 380, [["local_ai_rtx_prepare_test_alert_reset"], ["local_ai_rtx_prepare_prod_alert_reset"]]);
sw("local_ai_rtx_unavailable_mode_switch", groups.health, "Indisponível em TESTE ou produção?", "test_mode", [
  { t: "true" }, { t: "else" },
], 3200, 460, [["local_ai_rtx_test_host_state_switch"], ["local_ai_rtx_host_state_source"]]);
grouped(groups.health, {
  id: "local_ai_rtx_host_state_source", type: "api-current-state", z: TAB, g: groups.health,
  name: "FONTE: computador da RTX está ligado?", server: SERVER, version: 3, outputs: 1,
  halt_if: "", halt_if_type: "str", halt_if_compare: "is",
  entity_id: "sensor.codex_rtx_host_reachability_raw", state_type: "str", blockInputOverrides: true,
  outputProperties: [{ property: "rtx_host_state", propertyType: "msg", value: "", valueType: "entityState" }],
  for: "0", forType: "num", forUnits: "minutes", override_topic: false,
  state_location: "payload", override_payload: "msg", entity_location: "data", override_data: "msg",
  x: 3500, y: 480, wires: [["local_ai_rtx_prod_host_state_switch"]],
});
sw("local_ai_rtx_prod_host_state_switch", groups.health, "Produção: host online, offline ou desconhecido?", "rtx_host_state", [
  { t: "eq", v: "online", vt: "str" }, { t: "eq", v: "offline", vt: "str" }, { t: "else" },
], 3800, 480, [["local_ai_rtx_prepare_prod_alert"], ["local_ai_rtx_prod_alert_reset_request_out"], ["local_ai_rtx_status_gate_out"]]);
sw("local_ai_rtx_test_host_state_switch", groups.health, "TESTE: host online, offline ou desconhecido?", "rtx_host_state", [
  { t: "eq", v: "online", vt: "str" }, { t: "eq", v: "offline", vt: "str" }, { t: "else" },
], 3650, 540, [["local_ai_rtx_prepare_test_alert"], ["local_ai_rtx_test_alert_reset_request_out"], ["local_ai_rtx_status_gate_out"]]);
const prepareAlertRules = (topic) => [
  { t: "set", p: "topic", pt: "msg", to: topic, tot: "str" },
  { t: "set", p: "rtx_alert_condition", pt: "msg", to: "true", tot: "bool" },
  { t: "delete", p: "reset", pt: "msg" },
];
const prepareResetRules = (topic) => [
  { t: "set", p: "topic", pt: "msg", to: topic, tot: "str" },
  { t: "set", p: "reset", pt: "msg", to: "true", tot: "bool" },
  { t: "delete", p: "rtx_alert_condition", pt: "msg" },
];
change("local_ai_rtx_prepare_prod_alert", groups.health, "Condição de alerta: produção", prepareAlertRules("production"), 4100, 460, [["local_ai_rtx_alert_rbe", "local_ai_rtx_alert_close_unavailable_out"]]);
change("local_ai_rtx_prepare_test_alert", groups.health, "Condição de alerta: TESTE", prepareAlertRules("test"), 4100, 540, [["local_ai_rtx_alert_rbe"]]);
change("local_ai_rtx_prepare_prod_alert_reset", groups.health, "Resetar incidente de produção", prepareResetRules("production"), 3500, 360, [["local_ai_rtx_alert_dedupe_reset_out", "local_ai_rtx_status_gate_out", "local_ai_rtx_alert_close_available_out"]]);
change("local_ai_rtx_prepare_test_alert_reset", groups.health, "Resetar incidente de TESTE", prepareResetRules("test"), 3500, 420, [["local_ai_rtx_alert_dedupe_reset_out", "local_ai_rtx_status_gate_out"]]);
linkOut("local_ai_rtx_prod_alert_reset_request_out", groups.health, "Host offline → reset produção", "local_ai_rtx_prod_alert_reset_request_in", 3950, 420);
linkIn("local_ai_rtx_prod_alert_reset_request_in", groups.health, "Receber reset de produção", "local_ai_rtx_prod_alert_reset_request_out", "local_ai_rtx_prepare_prod_alert_reset", 3300, 300);
linkOut("local_ai_rtx_test_alert_reset_request_out", groups.health, "Host offline → reset TESTE", "local_ai_rtx_test_alert_reset_request_in", 3900, 580);
linkIn("local_ai_rtx_test_alert_reset_request_in", groups.health, "Receber reset de TESTE", "local_ai_rtx_test_alert_reset_request_out", "local_ai_rtx_prepare_test_alert_reset", 3350, 580);
linkIn("local_ai_rtx_test_alert_reset_in", groups.health, "Receber reset manual de TESTE", "local_ai_rtx_test_alert_reset_out", "local_ai_rtx_prepare_test_alert_reset", 3300, 520);
linkOut("local_ai_rtx_alert_dedupe_reset_out", groups.health, "Reset → dedupe e confirmação", ["local_ai_rtx_alert_dedupe_reset_in", "local_ai_rtx_alert_confirmation_reset_in"], 3800, 390);
linkOut("local_ai_rtx_alert_close_available_out", groups.health, "Disponível → encerrar alerta", "local_ai_rtx_alert_close_state_in", 3800, 350);
linkOut("local_ai_rtx_alert_close_unavailable_out", groups.health, "Indisponível → manter alerta", "local_ai_rtx_alert_close_state_in", 4370, 450);
linkIn("local_ai_rtx_alert_dedupe_reset_in", groups.health, "Receber reset por modo", "local_ai_rtx_alert_dedupe_reset_out", "local_ai_rtx_alert_rbe", 4050, 390);
rbe("local_ai_rtx_alert_rbe", groups.health, "Uma notificação por incidente e modo", "rtx_alert_condition", 4310, 500, [["local_ai_rtx_alert_load_delay"]]);
change("local_ai_rtx_alert_load_delay", groups.health, "Carregar confirmação visual válida", [{
  t: "set", p: "delay", pt: "msg", to: '$flowContext("local_ai_rtx_policy_v1", "persistent").unavailable_confirmation_seconds * 1000', tot: "jsonata",
}], 4590, 500, [["local_ai_rtx_alert_delay_valid"]]);
sw("local_ai_rtx_alert_delay_valid", groups.health, "Confirmação está entre 60 e 600 s?", "delay", [
  { t: "btwn", v: "60000", vt: "num", v2: "600000", v2t: "num" }, { t: "else" },
], 4870, 500, [["local_ai_rtx_alert_mode_switch"], ["local_ai_rtx_alert_policy_missing"]]);
sw("local_ai_rtx_alert_mode_switch", groups.health, "Confirmação é TESTE ou produção?", "test_mode", [
  { t: "true" }, { t: "else" },
], 5150, 500, [["local_ai_rtx_alert_test_delay"], ["local_ai_rtx_alert_confirm"]]);
change("local_ai_rtx_alert_test_delay", groups.health, "TESTE: confirmar em 3 s", [{ t: "set", p: "delay", pt: "msg", to: "3000", tot: "num" }], 5150, 570, [["local_ai_rtx_alert_confirm"]]);
trigger("local_ai_rtx_alert_confirm", groups.health, "Persistiu pelo tempo configurado?", 90, 5430, 500, [["local_ai_rtx_alert_build"]]);
linkIn("local_ai_rtx_alert_confirmation_reset_in", groups.health, "Recuperação cancela confirmação", "local_ai_rtx_alert_dedupe_reset_out", "local_ai_rtx_alert_confirm", 5390, 590);
fn("local_ai_rtx_alert_policy_missing", groups.health, "Falha fechada sem confirmação válida", "local-ai-rtx-status-terminal.js", 0, 5150, 400, []);
linkOut("local_ai_rtx_status_transition_out", groups.health, "Status sem gate → terminal", "local_ai_rtx_status_in", 3200, 580);
linkOut("local_ai_rtx_status_gate_out", groups.health, "Host offline/desconhecido → status", "local_ai_rtx_status_in", 3970, 330);
linkIn("local_ai_rtx_status_in", groups.health, "Receber status sem alerta", ["local_ai_rtx_status_transition_out", "local_ai_rtx_status_gate_out"], "local_ai_rtx_status_terminal", 4620, 340);
fn("local_ai_rtx_status_terminal", groups.health, "Estado visível da RTX", "local-ai-rtx-status-terminal.js", 0, 4900, 340, []);
fn("local_ai_rtx_alert_build", groups.health, "Adaptar condição para alerta de domínio", "local-ai-rtx-alert-build.js", 1, 5710, 500, [["local_ai_rtx_alert_out"]]);
linkOut("local_ai_rtx_recovery_out", groups.health, "Pedido permitido → gate final MCP", "local_ai_rtx_recovery_in", 3220, 290);
linkOut("local_ai_rtx_alert_out", groups.health, "Indisponibilidade confirmada → entrega central", "global_observer_alert_to_dispatch_in", 5940, 500);

linkIn("local_ai_rtx_recovery_in", groups.recovery, "Receber recovery permitido", "local_ai_rtx_recovery_out", "local_ai_rtx_side_effect_guard", 850, 730);
fn("local_ai_rtx_side_effect_guard", groups.recovery, "Gate final: produção ou TESTE?", "local-ai-rtx-side-effect-guard.js", 2, 1080, 730, [["local_ai_rtx_prepare_recovery"], ["local_ai_rtx_dry_out"]]);
fn("local_ai_rtx_prepare_recovery", groups.recovery, "Adaptar chamada autenticada", "local-ai-rtx-recovery-request.js", 1, 1340, 700, [["local_ai_rtx_recovery_http"]]);
grouped(groups.recovery, {
  id: "local_ai_rtx_recovery_http", type: "http request", z: TAB, g: groups.recovery,
  name: "EFEITO: executar local_ai_status via MCP", method: "use", ret: "obj", paytoqs: "body", url: "", tls: "",
  persist: false, proxy: "", insecureHTTPParser: false, authType: "", senderr: false, headers: [],
  x: 1630, y: 700, wires: [["local_ai_rtx_recovery_response"]],
});
fn("local_ai_rtx_recovery_response", groups.recovery, "Normalizar resultado MCP", "local-ai-rtx-recovery-response.js", 1, 1910, 730, [["local_ai_rtx_recovery_terminal"]]);
fn("local_ai_rtx_recovery_terminal", groups.recovery, "Resultado visível do recovery", "local-ai-rtx-status-terminal.js", 0, 2180, 730, []);
linkOut("local_ai_rtx_dry_out", groups.recovery, "TESTE → terminal dry-run", "local_ai_rtx_dry_in", 1340, 810);
linkIn("local_ai_rtx_test_response_in", groups.recovery, "Receber resposta MCP TESTE", "local_ai_rtx_test_response_out", "local_ai_rtx_recovery_response", 1630, 850);

linkIn("local_ai_rtx_alert_close_state_in", groups.alertClose, "Receber lifecycle do alerta", ["local_ai_rtx_alert_close_available_out", "local_ai_rtx_alert_close_unavailable_out"], "local_ai_rtx_alert_close_rbe", 2920, 740);
rbe("local_ai_rtx_alert_close_rbe", groups.alertClose, "Somente mudança de disponibilidade", "rtx_status.available", 3160, 740, [["local_ai_rtx_alert_recovered_switch"]]);
sw("local_ai_rtx_alert_recovered_switch", groups.alertClose, "RTX está recuperada?", "rtx_status.available", [
  { t: "eq", v: "true", vt: "bool" }, { t: "else" },
], 3430, 740, [["local_ai_rtx_alert_dismiss"], []]);
callService(
  "local_ai_rtx_alert_dismiss",
  groups.alertClose,
  "EFEITO: remover alerta RTX recuperado",
  "persistent_notification.dismiss",
  '{"notification_id":"nodered_observabilidade_global_domain_alert_local_ai_rtx_unavailable"}',
  3770,
  710,
  [["local_ai_rtx_alert_closed"]],
);
change("local_ai_rtx_alert_closed", groups.alertClose, "Alerta persistente encerrado", [
  { t: "set", p: "payload.rtx_alert_closed", pt: "msg", to: "true", tot: "bool" },
], 4160, 710, [[]]);

grouped(groups.test, {
  id: "local_ai_rtx_test_instructions", type: "comment", z: TAB, g: groups.test,
  name: "Ordem: reset → disponível → PC desligado → PC ligado → recovery → respostas. Tudo termina em dry-run.",
  info: "Estados sintéticos usam contexto e dedupe separados. PC desligado silencia. PC ligado com listener ausente espera 3 s e percorre a entrega central até o dry-run; clique em RTX disponível antes dos 3 s para validar o cancelamento transitório.",
  x: 900, y: 1000, wires: [],
});
inject("local_ai_rtx_test_reset", groups.test, "TESTE 1: reset", [{ p: "test_mode", v: "true", vt: "bool" }], 170, 1080, [["local_ai_rtx_test_reset_state", "local_ai_rtx_test_alert_reset_out"]]);
fn("local_ai_rtx_test_reset_state", groups.test, "Resetar estado sintético", "local-ai-rtx-reset-test.js", 0, 410, 1080, []);
linkOut("local_ai_rtx_test_alert_reset_out", groups.test, "Reset TESTE → dedupe", "local_ai_rtx_test_alert_reset_in", 650, 1080);
const healthProps = (available, hostState = "online", explicitRecovery = false) => [
  { p: "test_mode", v: "true", vt: "bool" }, { p: "_rtx_test", v: "true", vt: "bool" },
  { p: "explicit_recovery", v: explicitRecovery ? "true" : "false", vt: "bool" },
  { p: "rtx_host_state", v: hostState, vt: "str" },
  { p: "rtx_now", v: available ? "100000" : "200000", vt: "num" },
  { p: "payload", v: JSON.stringify({ local_ai: { available, state: available ? "LOCAL_AI_AVAILABLE" : "LOCAL_AI_UNAVAILABLE", preflight: { state: available ? "LOCAL_AI_AVAILABLE" : "LOCAL_AI_UNAVAILABLE", reason: available ? null : "listener_absent" } } }), vt: "json" },
];
inject("local_ai_rtx_test_available", groups.test, "TESTE 2: RTX disponível", healthProps(true), 190, 1150, [["local_ai_rtx_test_health_out"]]);
inject("local_ai_rtx_test_host_off", groups.test, "TESTE 3: PC desligado + listener ausente", healthProps(false, "offline"), 210, 1210, [["local_ai_rtx_test_health_out"]]);
inject("local_ai_rtx_test_host_on", groups.test, "TESTE 4: PC ligado + listener ausente", healthProps(false, "online"), 520, 1210, [["local_ai_rtx_test_health_out"]]);
inject("local_ai_rtx_test_unavailable", groups.test, "TESTE 5: pedir recovery com listener ausente", healthProps(false, "online", true), 520, 1150, [["local_ai_rtx_test_health_out"]]);
linkOut("local_ai_rtx_test_health_out", groups.test, "Saúde TESTE → caminho real", "local_ai_rtx_test_health_in", 680, 1180);
const responseProps = (success) => [
  { p: "test_mode", v: "true", vt: "bool" }, { p: "_rtx_test", v: "true", vt: "bool" },
  { p: "payload", v: JSON.stringify({ status: "ok", local_ai: { available: success, state: success ? "LOCAL_AI_AVAILABLE" : "LOCAL_AI_UNAVAILABLE", reason: success ? "endpoint_recovered" : "portproxy_add_failed", recovery_attempted: true, recovery_succeeded: success, recovery_attempts: success ? 1 : 2 } }), vt: "json" },
];
inject("local_ai_rtx_test_recovered", groups.test, "TESTE 6: recovery concluído", responseProps(true), 1100, 1130, [["local_ai_rtx_test_response_out"]]);
inject("local_ai_rtx_test_failed", groups.test, "TESTE 7: recovery falhou", responseProps(false), 1100, 1200, [["local_ai_rtx_test_response_out"]]);
linkOut("local_ai_rtx_test_response_out", groups.test, "Resposta TESTE → normalização real", "local_ai_rtx_test_response_in", 1410, 1165);
linkIn("local_ai_rtx_dry_in", groups.test, "Receber efeito TESTE", "local_ai_rtx_dry_out", "local_ai_rtx_dry_run_terminal", 1650, 1210);
fn("local_ai_rtx_dry_run_terminal", groups.test, "TESTE FINAL: MCP não chamado", "local-ai-rtx-dry-run.js", 0, 1910, 1210, []);

next.push(...nodes);
fs.writeFileSync(outputPath, `${JSON.stringify(next, null, 4)}\n`);
console.log(`Fluxo visual de recovery RTX instalado em ${outputPath}`);
