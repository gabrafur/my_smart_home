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
const owned = (node) => node.id === TAB || node.z === TAB || node.id.startsWith("local_ai_rtx_");
const removed = new Set(flows.filter(owned).map((node) => node.id));
const next = flows.filter((node) => !owned(node));
for (const node of next) {
  for (const field of ["nodes", "scope", "links"]) {
    if (Array.isArray(node[field])) node[field] = node[field].filter((id) => !removed.has(id));
  }
  if (Array.isArray(node.wires)) node.wires = node.wires.map((wire) => Array.isArray(wire) ? wire.filter((id) => !removed.has(id)) : wire);
}

const nodes = [];
const add = (node) => { nodes.push(node); return node.id; };
const group = (id, name, x, y, w, h, color) => add({
  id, type: "group", z: TAB, name, style: { label: true, color, fill: "#1f1f1f", fillOpacity: "0.18" },
  nodes: [], x, y, w, h,
});
const groups = {
  health: group("local_ai_rtx_health_group", "1. Saúde passiva e recovery explícito", 64, 20, 900, 330, "#5b8db8"),
  recovery: group("local_ai_rtx_recovery_group", "2. Recovery seguro via MCP", 1000, 20, 1200, 330, "#b5563f"),
  test: group("local_ai_rtx_test_group", "TESTE — ciclo completo em dry-run", 64, 390, 2136, 320, "#c9b458"),
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
const linkOut = (id, g, name, target, x, y) => grouped(g, {
  id, type: "link out", z: TAB, g, name, mode: "link", links: [target], x, y, wires: [],
});
const linkIn = (id, g, name, origin, destination, x, y) => grouped(g, {
  id, type: "link in", z: TAB, g, name, links: [origin], x, y, wires: [[destination]],
});

add({
  id: TAB, type: "tab", label: "recuperacao_rtx", disabled: false,
  info: "Observa passivamente a RTX. Somente o inject manual explícito chama o bridge, inicia uma invocação MCP legítima e permite o helper limitado a duas tentativas.",
  env: [],
});
grouped(groups.health, {
  id: "local_ai_rtx_architecture", type: "comment", z: TAB, g: groups.health,
  name: "A cada 60 s: somente saúde passiva. Recovery MCP exige clique manual explícito. O status dos nós permite acompanhar o ciclo.",
  info: "O Node-RED não executa WSL, Ollama, netsh, iphlpsvc nem SSH. Essas mutações permanecem exclusivamente no helper versionado chamado pelo MCP.",
  x: 500, y: 60, wires: [],
});
inject("local_ai_rtx_tick", groups.health, "Verificar a cada 60 s", [{ p: "payload" }], 165, 130, [["local_ai_rtx_prepare_health"]], {
  repeat: "60", once: true, onceDelay: "15",
});
inject("local_ai_rtx_manual_recovery", groups.health, "Recuperar endpoint via MCP", [
  { p: "payload" },
  { p: "explicit_recovery", v: "true", vt: "bool" },
], 175, 210, [["local_ai_rtx_prepare_health"]]);
fn("local_ai_rtx_prepare_health", groups.health, "Preparar leitura passiva", "local-ai-rtx-health-request.js", 1, 395, 130, [["local_ai_rtx_health_http"]]);
grouped(groups.health, {
  id: "local_ai_rtx_health_http", type: "http request", z: TAB, g: groups.health,
  name: "Ler saúde do bridge", method: "use", ret: "obj", paytoqs: "ignore", url: "", tls: "",
  persist: false, proxy: "", insecureHTTPParser: false, authType: "", senderr: false, headers: [],
  x: 620, y: 130, wires: [["local_ai_rtx_health_evaluate"]],
});
fn("local_ai_rtx_health_evaluate", groups.health, "Decidir disponibilidade", "local-ai-rtx-health-evaluate.js", 2, 830, 170, [
  ["local_ai_rtx_status_terminal"], ["local_ai_rtx_recovery_out"],
]);
fn("local_ai_rtx_status_terminal", groups.health, "Estado visível da RTX", "local-ai-rtx-status-terminal.js", 1, 810, 260, []);
linkOut("local_ai_rtx_recovery_out", groups.health, "Pedido explícito → recovery MCP", "local_ai_rtx_recovery_in", 920, 120);
linkIn("local_ai_rtx_test_health_in", groups.health, "Receber saúde TESTE", "local_ai_rtx_test_health_out", "local_ai_rtx_health_evaluate", 650, 260);

linkIn("local_ai_rtx_recovery_in", groups.recovery, "Receber recovery necessário", "local_ai_rtx_recovery_out", "local_ai_rtx_side_effect_guard", 1040, 120);
fn("local_ai_rtx_side_effect_guard", groups.recovery, "Separar produção e TESTE", "local-ai-rtx-side-effect-guard.js", 2, 1240, 120, [
  ["local_ai_rtx_prepare_recovery"], ["local_ai_rtx_dry_out"],
]);
fn("local_ai_rtx_prepare_recovery", groups.recovery, "Autenticar chamada ao bridge", "local-ai-rtx-recovery-request.js", 1, 1490, 100, [["local_ai_rtx_recovery_http"]]);
grouped(groups.recovery, {
  id: "local_ai_rtx_recovery_http", type: "http request", z: TAB, g: groups.recovery,
  name: "Executar local_ai_status via MCP", method: "use", ret: "obj", paytoqs: "body", url: "", tls: "",
  persist: false, proxy: "", insecureHTTPParser: false, authType: "", senderr: false, headers: [],
  x: 1740, y: 100, wires: [["local_ai_rtx_recovery_response"]],
});
fn("local_ai_rtx_recovery_response", groups.recovery, "Normalizar resultado MCP", "local-ai-rtx-recovery-response.js", 1, 1970, 160, [["local_ai_rtx_recovery_terminal"]]);
fn("local_ai_rtx_recovery_terminal", groups.recovery, "Resultado visível do recovery", "local-ai-rtx-status-terminal.js", 1, 1980, 250, []);
linkOut("local_ai_rtx_dry_out", groups.recovery, "TESTE → terminal dry-run", "local_ai_rtx_dry_in", 1420, 210);
linkIn("local_ai_rtx_test_response_in", groups.recovery, "Receber resposta MCP TESTE", "local_ai_rtx_test_response_out", "local_ai_rtx_recovery_response", 1740, 270);

grouped(groups.test, {
  id: "local_ai_rtx_test_instructions", type: "comment", z: TAB, g: groups.test,
  name: "Ordem: reset → disponível → indisponível (deve terminar em dry-run) → sucesso MCP → falha MCP. Nenhuma chamada HTTP é enviada.",
  info: "Os estados sintéticos usam test_mode, percorrem normalização, decisão, cooldown, guard e lifecycle reais e nunca alcançam o endpoint autenticado.",
  x: 760, y: 430, wires: [],
});
inject("local_ai_rtx_test_reset", groups.test, "TESTE 1: reset", [{ p: "test_mode", v: "true", vt: "bool" }], 170, 500, [["local_ai_rtx_test_reset_state"]]);
fn("local_ai_rtx_test_reset_state", groups.test, "Resetar estado sintético", "local-ai-rtx-reset-test.js", 1, 410, 500, []);
const healthProps = (available) => [
  { p: "test_mode", v: "true", vt: "bool" }, { p: "_rtx_test", v: "true", vt: "bool" },
  { p: "explicit_recovery", v: available ? "false" : "true", vt: "bool" },
  { p: "rtx_now", v: available ? "100000" : "200000", vt: "num" },
  { p: "payload", v: JSON.stringify({ local_ai: { available, state: available ? "LOCAL_AI_AVAILABLE" : "LOCAL_AI_UNAVAILABLE", preflight: { state: available ? "LOCAL_AI_AVAILABLE" : "LOCAL_AI_UNAVAILABLE", reason: available ? null : "listener_absent" } } }), vt: "json" },
];
inject("local_ai_rtx_test_available", groups.test, "TESTE 2: RTX disponível", healthProps(true), 190, 560, [["local_ai_rtx_test_health_out"]]);
inject("local_ai_rtx_test_unavailable", groups.test, "TESTE 3: listener ausente", healthProps(false), 190, 620, [["local_ai_rtx_test_health_out"]]);
linkOut("local_ai_rtx_test_health_out", groups.test, "Saúde TESTE → decisão real", "local_ai_rtx_test_health_in", 510, 590);
const responseProps = (success) => [
  { p: "test_mode", v: "true", vt: "bool" }, { p: "_rtx_test", v: "true", vt: "bool" },
  { p: "payload", v: JSON.stringify({ status: "ok", local_ai: { available: success, state: success ? "LOCAL_AI_AVAILABLE" : "LOCAL_AI_UNAVAILABLE", reason: success ? "endpoint_recovered" : "portproxy_add_failed", recovery_attempted: true, recovery_succeeded: success, recovery_attempts: success ? 1 : 2 } }), vt: "json" },
];
inject("local_ai_rtx_test_recovered", groups.test, "TESTE 4: recovery concluído", responseProps(true), 800, 540, [["local_ai_rtx_test_response_out"]]);
inject("local_ai_rtx_test_failed", groups.test, "TESTE 5: falha do portproxy", responseProps(false), 800, 610, [["local_ai_rtx_test_response_out"]]);
linkOut("local_ai_rtx_test_response_out", groups.test, "Resposta TESTE → normalização real", "local_ai_rtx_test_response_in", 1110, 575);
linkIn("local_ai_rtx_dry_in", groups.test, "Receber side effect TESTE", "local_ai_rtx_dry_out", "local_ai_rtx_dry_run_terminal", 1450, 620);
fn("local_ai_rtx_dry_run_terminal", groups.test, "TESTE FINAL: MCP não chamado", "local-ai-rtx-dry-run.js", 1, 1690, 620, []);

next.push(...nodes);
fs.writeFileSync(outputPath, `${JSON.stringify(next, null, 4)}\n`);
console.log(`Local AI RTX recovery flow installed in ${outputPath}`);
