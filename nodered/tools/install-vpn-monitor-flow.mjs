#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.resolve(process.argv[2] ?? path.resolve(here, "..", "flows.json"));
const outputPath = path.resolve(process.argv[3] ?? sourcePath);
const functionDir = path.join(here, "functions");
const TAB = "monitoramento_vpn_tab";
const BROKER = "721c47f31046b8bc";
const NOTIFY_SUBFLOW = "infra_notify_all_mobiles";
const flows = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
const source = (name) => fs.readFileSync(path.join(functionDir, name), "utf8").trimEnd();

if (!flows.some((node) => node.id === BROKER && node.type === "mqtt-broker")) {
  throw new Error("Broker MQTT obrigatório ausente");
}
if (!flows.some((node) => node.id === NOTIFY_SUBFLOW && node.type === "subflow")) {
  throw new Error("Subflow compartilhado de notificação ausente");
}

const ownedIds = new Set(
  flows
    .filter((node) => node.id === TAB || node.z === TAB || node.id.startsWith("vpn_monitor_"))
    .map((node) => node.id),
);
const next = flows.filter((node) => !ownedIds.has(node.id));
for (const node of next) {
  if (Array.isArray(node.nodes)) node.nodes = node.nodes.filter((id) => !ownedIds.has(id));
  if (Array.isArray(node.scope)) node.scope = node.scope.filter((id) => !ownedIds.has(id));
  if (Array.isArray(node.links)) node.links = node.links.filter((id) => !ownedIds.has(id));
  if (Array.isArray(node.wires)) {
    node.wires = node.wires.map((wire) => Array.isArray(wire) ? wire.filter((id) => !ownedIds.has(id)) : wire);
  }
}

const nodes = [];
const add = (node) => { nodes.push(node); return node.id; };
const group = (id, name, x, y, w, h, style) => add({
  id, type: "group", z: TAB, name, style: {
    label: true,
    color: style,
    fill: "#1f1f1f",
    fillOpacity: "0.18",
  },
  nodes: [], x, y, w, h,
});
const groups = {
  input: group("vpn_monitor_input_group", "1. Estado do host, internet e decisão", 64, 20, 750, 300, "#5b8db8"),
  notify: group("vpn_monitor_notify_group", "2. Notificações deduplicadas", 850, 20, 650, 250, "#b5563f"),
  publish: group("vpn_monitor_publish_group", "3. MQTT Discovery e estado", 850, 310, 800, 280, "#6aa84f"),
  test: group("vpn_monitor_test_group", "TESTE — fluxo completo em dry-run", 64, 360, 750, 380, "#c9b458"),
};
const addGrouped = (groupId, node) => {
  add(node);
  const target = nodes.find((entry) => entry.id === groupId);
  target.nodes.push(node.id);
};
const fn = (id, g, name, file, outputs, x, y, wires) => addGrouped(g, {
  id, type: "function", z: TAB, g, name, func: source(file), outputs,
  timeout: 0, noerr: 0, initialize: "", finalize: "", libs: [], x, y, wires,
});
const inject = (id, g, name, props, x, y, wires, extra = {}) => addGrouped(g, {
  id, type: "inject", z: TAB, g, name, props, repeat: "", crontab: "",
  once: false, onceDelay: 0.1, topic: "", x, y, wires, ...extra,
});

add({
  id: TAB,
  type: "tab",
  label: "monitoramento_vpn",
  disabled: false,
  info: "Monitora as VPNs instaladas no host sem expor topologia privada. Correlaciona com o monitor de internet, confirma falha e recuperação e notifica por canais compartilhados.",
  env: [],
});

addGrouped(groups.input, {
  id: "vpn_monitor_health_in", type: "mqtt in", z: TAB, g: groups.input,
  name: "Saúde sanitizada das VPNs", topic: "nodered/infrastructure/vpn/host-health",
  qos: "1", datatype: "auto-detect", broker: BROKER, nl: false, rap: true, rh: 0,
  inputs: 0, x: 185, y: 80, wires: [["vpn_monitor_report_ingest"]],
});
fn("vpn_monitor_report_ingest", groups.input, "Validar relatório do host", "vpn-monitor-report-ingest.js", 1, 440, 80, [["vpn_monitor_evaluate"]]);
addGrouped(groups.input, {
  id: "vpn_monitor_internet_in", type: "mqtt in", z: TAB, g: groups.input,
  name: "Estado do monitor de internet", topic: "nodered/infrastructure/internet/state",
  qos: "1", datatype: "utf8", broker: BROKER, nl: false, rap: true, rh: 0,
  inputs: 0, x: 190, y: 160, wires: [["vpn_monitor_internet_ingest"]],
});
fn("vpn_monitor_internet_ingest", groups.input, "Correlacionar internet", "vpn-monitor-internet-ingest.js", 1, 435, 160, [["vpn_monitor_evaluate"]]);
inject("vpn_monitor_tick", groups.input, "Avaliar a cada 30 s", [{ p: "payload" }], 195, 240, [["vpn_monitor_evaluate"]], {
  repeat: "30", once: true, onceDelay: "10",
});
fn("vpn_monitor_evaluate", groups.input, "Confirmar falha e recuperação", "vpn-monitor-evaluate.js", 3, 675, 160, [
  ["vpn_monitor_down_guard"], ["vpn_monitor_recovery_guard"], ["vpn_monitor_mqtt_guard"],
]);

fn("vpn_monitor_down_guard", groups.notify, "Separar queda real e TESTE", "vpn-monitor-side-effect-guard.js", 2, 1015, 80, [
  ["vpn_monitor_notify_down"], ["vpn_monitor_dry_out"],
]);
addGrouped(groups.notify, {
  id: "vpn_monitor_notify_down", type: `subflow:${NOTIFY_SUBFLOW}`, z: TAB, g: groups.notify,
  name: "Notificar VPN indisponível", env: [], x: 1320, y: 80, wires: [],
});
fn("vpn_monitor_recovery_guard", groups.notify, "Separar recuperação e TESTE", "vpn-monitor-side-effect-guard.js", 2, 1025, 160, [
  ["vpn_monitor_notify_recovery"], ["vpn_monitor_dry_out"],
]);
addGrouped(groups.notify, {
  id: "vpn_monitor_notify_recovery", type: `subflow:${NOTIFY_SUBFLOW}`, z: TAB, g: groups.notify,
  name: "Notificar VPN recuperada", env: [], x: 1320, y: 160, wires: [],
});
addGrouped(groups.notify, {
  id: "vpn_monitor_dry_out", type: "link out", z: TAB, g: groups.notify,
  name: "TESTE → terminal dry-run", mode: "link", links: ["vpn_monitor_dry_in"],
  x: 1435, y: 235, wires: [],
});

fn("vpn_monitor_mqtt_guard", groups.publish, "Separar MQTT real e TESTE", "vpn-monitor-side-effect-guard.js", 2, 1030, 380, [
  ["vpn_monitor_state_out"], ["vpn_monitor_publish_dry_out"],
]);
addGrouped(groups.publish, {
  id: "vpn_monitor_state_out", type: "mqtt out", z: TAB, g: groups.publish,
  name: "Publicar estado retained", topic: "", qos: "1", retain: "true",
  respTopic: "", contentType: "", userProps: "", correl: "", expiry: "",
  broker: BROKER, x: 1320, y: 380, wires: [],
});
addGrouped(groups.publish, {
  id: "vpn_monitor_publish_dry_out", type: "link out", z: TAB, g: groups.publish,
  name: "MQTT TESTE → dry-run", mode: "link", links: ["vpn_monitor_dry_in"],
  x: 1285, y: 440, wires: [],
});
inject("vpn_monitor_discovery_tick", groups.publish, "Discovery no startup", [{ p: "payload" }], 970, 520, [["vpn_monitor_discovery"]], {
  once: true, onceDelay: "5",
});
fn("vpn_monitor_discovery", groups.publish, "Criar sensores diagnósticos", "vpn-monitor-discovery.js", 1, 1210, 520, [["vpn_monitor_discovery_out"]]);
addGrouped(groups.publish, {
  id: "vpn_monitor_discovery_out", type: "mqtt out", z: TAB, g: groups.publish,
  name: "Publicar discovery retained", topic: "", qos: "1", retain: "true",
  respTopic: "", contentType: "", userProps: "", correl: "", expiry: "",
  broker: BROKER, x: 1510, y: 520, wires: [],
});

addGrouped(groups.test, {
  id: "vpn_monitor_test_instructions", type: "comment", z: TAB, g: groups.test,
  name: "Ordem: reset → internet online → VPN offline → +121 s → VPN online → +61 s. Negativo: reset → internet offline → VPN offline → +121 s.",
  info: "Todos os efeitos terminam em dry-run. O cenário negativo comprova que uma queda geral da internet não duplica o alerta como falha de VPN.",
  x: 390, y: 400, wires: [],
});
inject("vpn_monitor_test_reset", groups.test, "TESTE 1: reset", [{ p: "payload" }], 170, 450, [["vpn_monitor_test_reset_state"]]);
fn("vpn_monitor_test_reset_state", groups.test, "Resetar estado sintético", "vpn-monitor-reset-test.js", 1, 420, 450, []);
const testProps = (kind, now, payload, payloadType = "str") => [
  { p: "_vpn_test", v: "true", vt: "bool" },
  { p: "_vpn_test_kind", v: kind, vt: "str" },
  { p: "vpn_now", v: String(now), vt: "num" },
  { p: "payload", v: payload, vt: payloadType },
];
inject("vpn_monitor_test_internet_online", groups.test, "TESTE 2: internet online", testProps("internet", 100000, "online"), 195, 500, [["vpn_monitor_test_router"]]);
inject("vpn_monitor_test_internet_offline", groups.test, "TESTE 2B: internet offline", testProps("internet", 100000, "offline"), 195, 540, [["vpn_monitor_test_router"]]);
inject("vpn_monitor_test_vpn_down", groups.test, "TESTE 3: VPN offline", testProps("report", 100000, '{"schema_version":1,"checked_at":"1970-01-01T00:01:40.000Z","vpns":[{"role":"vpn_primary","kind":"tailscale","installed":true,"healthy":false,"reason":"backend_stopped","checked_at":"1970-01-01T00:01:40.000Z"}]}', "json"), 195, 580, [["vpn_monitor_test_router"]]);
inject("vpn_monitor_test_confirm_down", groups.test, "TESTE 4: avaliar +121 s", testProps("evaluate", 221000, ""), 195, 620, [["vpn_monitor_test_router"]]);
inject("vpn_monitor_test_vpn_up", groups.test, "TESTE 5: VPN online", testProps("report", 230000, '{"schema_version":1,"checked_at":"1970-01-01T00:03:50.000Z","vpns":[{"role":"vpn_primary","kind":"tailscale","installed":true,"healthy":true,"reason":"running","checked_at":"1970-01-01T00:03:50.000Z"}]}', "json"), 195, 660, [["vpn_monitor_test_router"]]);
inject("vpn_monitor_test_confirm_up", groups.test, "TESTE 6: avaliar +61 s", testProps("evaluate", 291000, ""), 195, 700, [["vpn_monitor_test_router"]]);
fn("vpn_monitor_test_router", groups.test, "Rotear estado sintético", "vpn-monitor-test-router.js", 3, 500, 590, [
  ["vpn_monitor_test_internet_out"], ["vpn_monitor_test_report_out"], ["vpn_monitor_test_evaluate_out"],
]);
for (const [id, name, y, target] of [
  ["vpn_monitor_test_internet_out", "Internet TESTE → produção", 540, "vpn_monitor_test_internet_in"],
  ["vpn_monitor_test_report_out", "VPN TESTE → produção", 590, "vpn_monitor_test_report_in"],
  ["vpn_monitor_test_evaluate_out", "Avaliar TESTE → produção", 640, "vpn_monitor_test_evaluate_in"],
]) addGrouped(groups.test, {
  id, type: "link out", z: TAB, g: groups.test, name, mode: "link", links: [target],
  x: 770, y, wires: [],
});
for (const [id, name, x, y, origin, destination] of [
  ["vpn_monitor_test_report_in", "Receber VPN TESTE", 100, 120, "vpn_monitor_test_report_out", "vpn_monitor_report_ingest"],
  ["vpn_monitor_test_internet_in", "Receber internet TESTE", 100, 200, "vpn_monitor_test_internet_out", "vpn_monitor_internet_ingest"],
  ["vpn_monitor_test_evaluate_in", "Receber avaliação TESTE", 520, 240, "vpn_monitor_test_evaluate_out", "vpn_monitor_evaluate"],
]) addGrouped(groups.input, {
  id, type: "link in", z: TAB, g: groups.input, name, links: [origin],
  x, y, wires: [[destination]],
});
addGrouped(groups.test, {
  id: "vpn_monitor_dry_in", type: "link in", z: TAB, g: groups.test,
  name: "Receber side effects TESTE", links: ["vpn_monitor_dry_out", "vpn_monitor_publish_dry_out"],
  x: 480, y: 720, wires: [["vpn_monitor_dry_run_terminal"]],
});
fn("vpn_monitor_dry_run_terminal", groups.test, "TESTE FINAL: nenhum efeito enviado", "vpn-monitor-dry-run.js", 1, 650, 720, []);

next.push(...nodes);
fs.writeFileSync(outputPath, `${JSON.stringify(next, null, 4)}\n`);
console.log(`VPN monitor flow installed in ${outputPath}`);
