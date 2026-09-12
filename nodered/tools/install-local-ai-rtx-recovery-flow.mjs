#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.resolve(process.argv[2] ?? path.resolve(here, "..", "flows.json"));
const outputPath = path.resolve(process.argv[3] ?? sourcePath);
const functionDir = path.join(here, "functions");
const TAB = "local_ai_rtx_recovery_tab";
const flows = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
const source = (name) => fs.readFileSync(path.join(functionDir, name), "utf8").trimEnd();
const owned = (node) => node.id === TAB || node.id.startsWith("local_ai_rtx_");
const removed = new Set(flows.filter(owned).map((node) => node.id));
const next = flows.filter((node) => !owned(node));
for (const node of next) {
  for (const field of ["nodes", "scope", "links"]) {
    if (Array.isArray(node[field])) node[field] = node[field].filter((id) =>
      !removed.has(id) ||
      (field === "links" && node.id === "global_observer_events_in" && id === "local_ai_rtx_alert_out")
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
  policy: group("local_ai_rtx_policy_group", "0. Política visual e agenda passiva", 64, 20, 700, 300, "#2563eb", "#dbeafe"),
  health: group("local_ai_rtx_health_group", "1. Saúde, decisões e estado", 800, 20, 2800, 430, "#0f766e", "#ccfbf1"),
  recovery: group("local_ai_rtx_recovery_group", "2. Gate final e recovery seguro via MCP", 800, 480, 2000, 280, "#dc2626", "#fee2e2"),
  test: group("local_ai_rtx_test_group", "3. Testes manuais completos — dry-run", 64, 800, 2736, 330, "#0891b2", "#cffafe"),
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

add({
  id: TAB, type: "tab", label: "recuperacao_rtx", disabled: false,
  info: "Observação passiva e decisão visual. Recovery MCP exige clique explícito; cooldown vem da política validada e TESTE termina antes do HTTP autenticado.", env: [],
});

grouped(groups.policy, {
  id: "local_ai_rtx_architecture", type: "comment", z: TAB, g: groups.policy,
  name: "Leitura é passiva. Recovery nunca é automático.",
  info: "O Node-RED não executa WSL, Ollama, netsh, iphlpsvc nem SSH. Essas mutações permanecem exclusivamente no helper versionado chamado pelo MCP.",
  x: 410, y: 60, wires: [],
});
inject("local_ai_rtx_tick", groups.policy, "Agenda visível — verificar a cada 60 s", [{ p: "payload" }], 240, 130, [["local_ai_rtx_health_tick_out"]], { repeat: "60", once: true, onceDelay: "15" });
linkOut("local_ai_rtx_health_tick_out", groups.policy, "Tick passivo → leitura de saúde", "local_ai_rtx_health_tick_in", 560, 130);
inject("local_ai_rtx_policy_cooldown", groups.policy, "Cooldown entre recoveries — 60 s", [{ p: "payload" }, { p: "topic", vt: "str" }], 250, 220, [["local_ai_rtx_policy_validate"]], {
  once: true, onceDelay: 0.5, topic: "recovery_cooldown_seconds", payload: "60", payloadType: "num",
});
fn("local_ai_rtx_policy_validate", groups.policy, "Validar 10–600 s e preservar último válido", "local-ai-rtx-policy-validate.js", 0, 570, 220, []);

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
fn("local_ai_rtx_state_update", groups.health, "Persistir estado (sem decidir rota)", "local-ai-rtx-state-update.js", 1, 2610, 360, [["local_ai_rtx_transition_switch"]]);
sw("local_ai_rtx_transition_switch", groups.health, "Rota: status, alerta ou recovery?", "rtx_transition", [
  { t: "eq", v: "available", vt: "str" },
  { t: "eq", v: "unavailable", vt: "str" },
  { t: "eq", v: "recovery_requested", vt: "str" },
  { t: "else" },
], 2870, 360, [["local_ai_rtx_status_terminal"], ["local_ai_rtx_alert_build"], ["local_ai_rtx_recovery_out"], ["local_ai_rtx_status_terminal"]]);
fn("local_ai_rtx_status_terminal", groups.health, "Estado visível da RTX", "local-ai-rtx-status-terminal.js", 0, 3190, 350, []);
fn("local_ai_rtx_alert_build", groups.health, "Adaptar incidente para observador global", "local-ai-rtx-alert-build.js", 1, 3200, 410, [["local_ai_rtx_alert_out"]]);
linkOut("local_ai_rtx_recovery_out", groups.health, "Pedido permitido → gate final MCP", "local_ai_rtx_recovery_in", 3220, 290);
linkOut("local_ai_rtx_alert_out", groups.health, "RTX indisponível → alerta central", "global_observer_events_in", 3480, 420);

linkIn("local_ai_rtx_recovery_in", groups.recovery, "Receber recovery permitido", "local_ai_rtx_recovery_out", "local_ai_rtx_side_effect_guard", 850, 570);
fn("local_ai_rtx_side_effect_guard", groups.recovery, "Gate final: produção ou TESTE?", "local-ai-rtx-side-effect-guard.js", 2, 1080, 570, [["local_ai_rtx_prepare_recovery"], ["local_ai_rtx_dry_out"]]);
fn("local_ai_rtx_prepare_recovery", groups.recovery, "Adaptar chamada autenticada", "local-ai-rtx-recovery-request.js", 1, 1340, 540, [["local_ai_rtx_recovery_http"]]);
grouped(groups.recovery, {
  id: "local_ai_rtx_recovery_http", type: "http request", z: TAB, g: groups.recovery,
  name: "EFEITO: executar local_ai_status via MCP", method: "use", ret: "obj", paytoqs: "body", url: "", tls: "",
  persist: false, proxy: "", insecureHTTPParser: false, authType: "", senderr: false, headers: [],
  x: 1630, y: 540, wires: [["local_ai_rtx_recovery_response"]],
});
fn("local_ai_rtx_recovery_response", groups.recovery, "Normalizar resultado MCP", "local-ai-rtx-recovery-response.js", 1, 1910, 570, [["local_ai_rtx_recovery_terminal"]]);
fn("local_ai_rtx_recovery_terminal", groups.recovery, "Resultado visível do recovery", "local-ai-rtx-status-terminal.js", 0, 2180, 570, []);
linkOut("local_ai_rtx_dry_out", groups.recovery, "TESTE → terminal dry-run", "local_ai_rtx_dry_in", 1340, 650);
linkIn("local_ai_rtx_test_response_in", groups.recovery, "Receber resposta MCP TESTE", "local_ai_rtx_test_response_out", "local_ai_rtx_recovery_response", 1630, 690);

grouped(groups.test, {
  id: "local_ai_rtx_test_instructions", type: "comment", z: TAB, g: groups.test,
  name: "Ordem: reset → disponível → indisponível → sucesso MCP → falha MCP. Nenhum HTTP de recovery é enviado.",
  info: "Estados sintéticos usam contexto separado e percorrem normalização, decisões, cooldown, gate e lifecycle reais.",
  x: 900, y: 840, wires: [],
});
inject("local_ai_rtx_test_reset", groups.test, "TESTE 1: reset", [{ p: "test_mode", v: "true", vt: "bool" }], 170, 920, [["local_ai_rtx_test_reset_state"]]);
fn("local_ai_rtx_test_reset_state", groups.test, "Resetar estado sintético", "local-ai-rtx-reset-test.js", 0, 410, 920, []);
const healthProps = (available) => [
  { p: "test_mode", v: "true", vt: "bool" }, { p: "_rtx_test", v: "true", vt: "bool" },
  { p: "explicit_recovery", v: available ? "false" : "true", vt: "bool" },
  { p: "rtx_now", v: available ? "100000" : "200000", vt: "num" },
  { p: "payload", v: JSON.stringify({ local_ai: { available, state: available ? "LOCAL_AI_AVAILABLE" : "LOCAL_AI_UNAVAILABLE", preflight: { state: available ? "LOCAL_AI_AVAILABLE" : "LOCAL_AI_UNAVAILABLE", reason: available ? null : "listener_absent" } } }), vt: "json" },
];
inject("local_ai_rtx_test_available", groups.test, "TESTE 2: RTX disponível", healthProps(true), 190, 990, [["local_ai_rtx_test_health_out"]]);
inject("local_ai_rtx_test_unavailable", groups.test, "TESTE 3: listener ausente", healthProps(false), 190, 1050, [["local_ai_rtx_test_health_out"]]);
linkOut("local_ai_rtx_test_health_out", groups.test, "Saúde TESTE → caminho real", "local_ai_rtx_test_health_in", 500, 1020);
const responseProps = (success) => [
  { p: "test_mode", v: "true", vt: "bool" }, { p: "_rtx_test", v: "true", vt: "bool" },
  { p: "payload", v: JSON.stringify({ status: "ok", local_ai: { available: success, state: success ? "LOCAL_AI_AVAILABLE" : "LOCAL_AI_UNAVAILABLE", reason: success ? "endpoint_recovered" : "portproxy_add_failed", recovery_attempted: true, recovery_succeeded: success, recovery_attempts: success ? 1 : 2 } }), vt: "json" },
];
inject("local_ai_rtx_test_recovered", groups.test, "TESTE 4: recovery concluído", responseProps(true), 800, 970, [["local_ai_rtx_test_response_out"]]);
inject("local_ai_rtx_test_failed", groups.test, "TESTE 5: recovery falhou", responseProps(false), 800, 1040, [["local_ai_rtx_test_response_out"]]);
linkOut("local_ai_rtx_test_response_out", groups.test, "Resposta TESTE → normalização real", "local_ai_rtx_test_response_in", 1110, 1005);
linkIn("local_ai_rtx_dry_in", groups.test, "Receber efeito TESTE", "local_ai_rtx_dry_out", "local_ai_rtx_dry_run_terminal", 1450, 1050);
fn("local_ai_rtx_dry_run_terminal", groups.test, "TESTE FINAL: MCP não chamado", "local-ai-rtx-dry-run.js", 0, 1710, 1050, []);

next.push(...nodes);
fs.writeFileSync(outputPath, `${JSON.stringify(next, null, 4)}\n`);
console.log(`Fluxo visual de recovery RTX instalado em ${outputPath}`);
