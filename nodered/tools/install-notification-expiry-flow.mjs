#!/usr/bin/env node
// Visual 24 h expiry for persistent notifications that have no resolution signal.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.resolve(process.argv[2] ?? path.resolve(here, "..", "flows.json"));
const outputPath = path.resolve(process.argv[3] ?? sourcePath);
const functionDir = path.join(here, "functions");
const TAB = "notification_expiry_tab";
const SERVER = "4126427d5e161a03";
const HUB_IN = "notification_hub_persistent_in";
const flows = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
const source = (name) => fs.readFileSync(path.join(functionDir, name), "utf8").trimEnd();
const owned = (node) => node.id === TAB || node.id.startsWith("notification_expiry_");
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
  policy: group("notification_expiry_policy_group", "0. Política: sem sinal de resolução expira em 24 h", 64, 20, 620, 180, "#2563eb", "#dbeafe"),
  sweep: group("notification_expiry_sweep_group", "1. Ler persistentes do HA, selecionar vencidas e remover pelo hub", 720, 20, 1720, 180, "#0f766e", "#ccfbf1"),
  test: group("notification_expiry_test_group", "2. Teste manual — dry-run do hub", 64, 240, 620, 120, "#0891b2", "#cffafe"),
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
  id: TAB, type: "tab", label: "expiracao_notificacoes", disabled: false,
  info: "Regra do proprietário (23/11/2026): notificação persistente sem sinal de resolução (erro pontual de nó, relé do portão, comando do carro, avisos do Codex de cache/créditos/diário) é removida do Home Assistant 24 h depois de criada. Notificações com resolução própria não são tocadas. A remoção passa pelo hub persistente; TESTE termina no dry-run do hub.",
  env: [],
});

grouped(groups.policy, {
  id: "notification_expiry_policy_note", type: "comment", z: TAB, g: groups.policy,
  name: "Só IDs sem resolução; vencem 24 h após a criação.",
  info: "Lista fechada em tools/functions/notification-expiry-select.js. Um ID novo sem resolução precisa ser acrescentado lá e no teste.",
  x: 360, y: 60, wires: [],
});
inject("notification_expiry_tick", groups.policy, "Agenda visível — varrer a cada 30 min", [{ p: "payload" }], 250, 130, [["notification_expiry_tick_out"]], {
  repeat: "1800", once: true, onceDelay: "120",
});
linkOut("notification_expiry_tick_out", groups.policy, "Varredura → leitura do HA", "notification_expiry_tick_in", 560, 130);

linkIn("notification_expiry_tick_in", groups.sweep, "Receber varredura", ["notification_expiry_tick_out"], "notification_expiry_read", 770, 80);
grouped(groups.sweep, {
  id: "notification_expiry_read", type: "ha-api", z: TAB, g: groups.sweep,
  name: "FONTE: notificações persistentes do HA", server: SERVER, version: 1, debugenabled: false,
  protocol: "websocket", method: "get", path: "", data: "{\"type\":\"persistent_notification/get\"}", dataType: "json",
  responseType: "json",
  outputProperties: [{ property: "ha_notifications", propertyType: "msg", value: "", valueType: "results" }],
  x: 1000, y: 80, wires: [["notification_expiry_select"]],
});
linkIn("notification_expiry_test_in", groups.sweep, "Receber lista TESTE", ["notification_expiry_test_out"], "notification_expiry_select", 1000, 150);
fn("notification_expiry_select", groups.sweep, "Selecionar vencidas sem sinal de resolução", "notification-expiry-select.js", 1, 1290, 80, [["notification_expiry_pace"]]);
grouped(groups.sweep, {
  id: "notification_expiry_pace", type: "delay", z: TAB, g: groups.sweep,
  name: "Uma remoção a cada 2 s", pauseType: "rate", timeout: "5", timeoutUnits: "seconds",
  rate: "1", nbRateUnits: "2", rateUnits: "second", randomFirst: "1", randomLast: "5", randomUnits: "seconds",
  drop: false, allowrate: false, outputs: 1, x: 1560, y: 80, wires: [["notification_expiry_hub_call"]],
});
grouped(groups.sweep, {
  id: "notification_expiry_hub_call", type: "link call", z: TAB, g: groups.sweep,
  name: "Hub HA → dismiss", links: [HUB_IN], linkType: "static", timeout: "30",
  x: 1790, y: 80, wires: [["notification_expiry_mode"]],
});
grouped(groups.sweep, {
  id: "notification_expiry_mode", type: "switch", z: TAB, g: groups.sweep, name: "Remoção real ou TESTE?",
  property: "_notification_expiry.test_mode", propertyType: "msg",
  rules: [{ t: "true" }, { t: "else" }], checkall: "true", repair: false, outputs: 2,
  x: 2010, y: 80, wires: [["notification_expiry_dry_run_terminal"], ["notification_expiry_result"]],
});
fn("notification_expiry_result", groups.sweep, "Resultado visível da remoção", "notification-expiry-result.js", 0, 2240, 60, []);
fn("notification_expiry_dry_run_terminal", groups.sweep, "TESTE FINAL: nada removido do HA", "notification-expiry-dry-run.js", 0, 2240, 130, []);

const day = 24 * 60 * 60 * 1000;
const testNow = Date.parse("2026-11-23T12:00:00Z");
const testList = [
  { notification_id: "portao_garagem_rele_preso", created_at: new Date(testNow - day - 60000).toISOString() },
  { notification_id: "codex_alert_credits_low", created_at: new Date(testNow - 3600000).toISOString() },
  { notification_id: "git_backup_failure", created_at: new Date(testNow - 3 * day).toISOString() },
];
inject("notification_expiry_test", groups.test, "TESTE: 1 vencida, 1 recente, 1 com resolução", [
  { p: "test_mode", v: "true", vt: "bool" },
  { p: "expiry_now", v: String(testNow), vt: "num" },
  { p: "ha_notifications", v: JSON.stringify(testList), vt: "json" },
], 270, 300, [["notification_expiry_test_out"]]);
linkOut("notification_expiry_test_out", groups.test, "Lista TESTE → seleção real", "notification_expiry_test_in", 560, 300);

next.push(...nodes);
fs.writeFileSync(outputPath, `${JSON.stringify(next, null, 4)}\n`);
console.log(`Expiração de notificações sem resolução instalada em ${outputPath}`);
