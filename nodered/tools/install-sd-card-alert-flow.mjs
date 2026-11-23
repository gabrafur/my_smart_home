#!/usr/bin/env node
// Visual alert for SD card stalls, fed by the host memory guardian readings.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.resolve(process.argv[2] ?? path.resolve(here, "..", "flows.json"));
const outputPath = path.resolve(process.argv[3] ?? sourcePath);
const functionDir = path.join(here, "functions");
const TAB = "sd_card_alert_tab";
const HUB_IN = "notification_hub_persistent_in";
const flows = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
const source = (name) => fs.readFileSync(path.join(functionDir, name), "utf8").trimEnd();
const owned = (node) => node.id === TAB || node.id.startsWith("sd_card_alert_");
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
const group = (id, name, x, y, w, h, color, fill) => add({
  id, type: "group", z: TAB, name,
  style: { label: true, "label-position": "nw", color: "#1f2937", stroke: color, "stroke-opacity": "1", fill, "fill-opacity": "0.35" },
  nodes: [], x, y, w, h,
});
const groups = {
  policy: group("sd_card_alert_policy_group", "0. Política: 2 leituras lentas avisam, 3 normais removem", 64, 20, 620, 180, "#2563eb", "#dbeafe"),
  decision: group("sd_card_alert_decision_group", "1. Avaliar leitura do guardião e avisar pelo hub", 720, 20, 1720, 180, "#0f766e", "#ccfbf1"),
  test: group("sd_card_alert_test_group", "2. Teste manual — dry-run do hub", 64, 240, 620, 200, "#0891b2", "#cffafe"),
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
  id, type: "link out", z: TAB, g, name, mode: "link", links: [targets], x, y, wires: [],
});
const linkIn = (id, g, name, origins, destination, x, y) => grouped(g, {
  id, type: "link in", z: TAB, g, name, links: origins, x, y, wires: [[destination]],
});

add({
  id: TAB, type: "tab", label: "alerta_cartao_sd", disabled: false,
  info: "Regra do proprietário (23/11/2026): as travas de 22/11 vieram do cartão SD. O guardião de memória registra a latência média de escrita (sd_write_ms) e os processos esperando o disco (blocked_tasks). Duas leituras seguidas com escrita acima de 500 ms ou mais de 5 processos em espera criam um aviso persistente no HA; três leituras normais o removem. TESTE termina no dry-run do hub.",
  env: [],
});

grouped(groups.policy, {
  id: "sd_card_alert_policy_note", type: "comment", z: TAB, g: groups.policy,
  name: "Limites: escrita > 500 ms ou > 5 processos em espera.",
  info: "Picos isolados acontecem algumas vezes por hora e não avisam. Os limites e a histerese ficam em tools/functions/sd-card-alert-evaluate.js.",
  x: 360, y: 60, wires: [],
});
inject("sd_card_alert_tick", groups.policy, "Agenda visível — ler a cada 30 s", [{ p: "payload" }], 230, 130, [["sd_card_alert_tick_out"]], {
  repeat: "30", once: true, onceDelay: "100",
});
linkOut("sd_card_alert_tick_out", groups.policy, "Agenda → leitura do guardião", "sd_card_alert_tick_in", 560, 130);

linkIn("sd_card_alert_tick_in", groups.decision, "Receber agenda", ["sd_card_alert_tick_out"], "sd_card_alert_read", 770, 80);
grouped(groups.decision, {
  id: "sd_card_alert_read", type: "exec", z: TAB, g: groups.decision, name: "FONTE: última leitura do guardião (timeout 15 s)",
  command: "/opt/read-host-memory-guardian-result.sh", addpay: "", append: "", useSpawn: "false",
  timer: "15", winHide: false, oldrc: false, x: 1010, y: 80, wires: [["sd_card_alert_evaluate"], [], []],
});
linkIn("sd_card_alert_test_in", groups.decision, "Receber leitura TESTE", ["sd_card_alert_test_out"], "sd_card_alert_evaluate", 1010, 150);
fn("sd_card_alert_evaluate", groups.decision, "Duas lentas avisam, três normais removem", "sd-card-alert-evaluate.js", 1, 1300, 80, [["sd_card_alert_hub_call"]]);
grouped(groups.decision, {
  id: "sd_card_alert_hub_call", type: "link call", z: TAB, g: groups.decision,
  name: "Hub HA → criar ou remover aviso", links: [HUB_IN], linkType: "static", timeout: "30",
  x: 1560, y: 80, wires: [["sd_card_alert_mode"]],
});
grouped(groups.decision, {
  id: "sd_card_alert_mode", type: "switch", z: TAB, g: groups.decision, name: "Aviso real ou TESTE?",
  property: "_sd_card_alert.test_mode", propertyType: "msg",
  rules: [{ t: "true" }, { t: "else" }], checkall: "true", repair: false, outputs: 2,
  x: 1790, y: 80, wires: [["sd_card_alert_dry_run_terminal"], ["sd_card_alert_result"]],
});
fn("sd_card_alert_result", groups.decision, "Resultado visível do aviso", "sd-card-alert-result.js", 0, 2040, 60, []);
fn("sd_card_alert_dry_run_terminal", groups.decision, "TESTE FINAL: nada enviado ao HA", "sd-card-alert-dry-run.js", 0, 2040, 130, []);

const line = (writeMs, blocked) => `"host-memory-guardian status=healthy sd_write_ms=${writeMs} sd_busy_percent=90 blocked_tasks=${blocked} checked_at=" & $now()`;
inject("sd_card_alert_test_reset", groups.test, "TESTE 1: zerar estado de teste", [
  { p: "test_mode", v: "true", vt: "bool" },
  { p: "sd_card_alert_reset", v: "true", vt: "bool" },
], 250, 290, [["sd_card_alert_test_out"]]);
inject("sd_card_alert_test_slow", groups.test, "TESTE 2: leitura lenta (2× cria)", [
  { p: "test_mode", v: "true", vt: "bool" },
  { p: "payload", v: line(1500, 8), vt: "jsonata" },
], 250, 340, [["sd_card_alert_test_out"]]);
inject("sd_card_alert_test_normal", groups.test, "TESTE 3: leitura normal (3× remove)", [
  { p: "test_mode", v: "true", vt: "bool" },
  { p: "payload", v: line(10, 0), vt: "jsonata" },
], 250, 390, [["sd_card_alert_test_out"]]);
linkOut("sd_card_alert_test_out", groups.test, "Leitura TESTE → avaliação real", "sd_card_alert_test_in", 560, 340);

next.push(...nodes);
fs.writeFileSync(outputPath, `${JSON.stringify(next, null, 4)}\n`);
console.log(`Alerta do cartão SD instalado em ${outputPath}`);
