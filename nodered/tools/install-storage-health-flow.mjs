#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const flowsPath = path.resolve(here, "..", "flows.json");
const flows = JSON.parse(fs.readFileSync(flowsPath, "utf8"));

const TAB = "storage_health_tab";
const SERVER = "4126427d5e161a03";
const MQTT = "721c47f31046b8bc";
const ownedIds = new Set([
  TAB,
  "storage_group_config",
  "storage_group_health",
  "storage_group_alerts",
  "storage_group_maintenance",
  "storage_comment_architecture",
  "storage_init",
  "storage_set_config",
  "storage_discovery",
  "storage_mqtt_discovery",
  "storage_health_tick",
  "storage_manual_health",
  "storage_read_ha",
  "storage_evaluate",
  "storage_mqtt_state",
  "storage_notify",
  "storage_daily_maintenance",
  "storage_exec_maintenance",
  "storage_parse_maintenance",
  "storage_store_maintenance_stderr",
  "storage_maintenance_complete",
  "storage_weekly_inspection",
  "storage_exec_inspection",
  "storage_parse_inspection",
  "storage_maintenance_mqtt",
]);

if (!flows.some((node) => node.id === SERVER && node.type === "server")) {
  throw new Error(`Home Assistant server node ${SERVER} not found`);
}
if (!flows.some((node) => node.id === MQTT && node.type === "mqtt-broker")) {
  throw new Error(`MQTT broker node ${MQTT} not found`);
}

const functionNode = (id, group, name, func, outputs, x, y, wires) => ({
  id,
  type: "function",
  z: TAB,
  g: group,
  name,
  func,
  outputs,
  timeout: 0,
  noerr: 0,
  initialize: "",
  finalize: "",
  libs: [],
  x,
  y,
  wires,
});

const storageConfig = `const config = {
    version: 1,
    thresholds: { warning: 70, high: 80, critical: 90 },
    hysteresisPercentagePoints: 3,
    notificationCooldownMs: 12 * 60 * 60 * 1000,
    commandErrorCooldownMs: 6 * 60 * 60 * 1000,
    trendAlert24hPercentagePoints: 5,
    trendAlert7dPercentagePoints: 10,
    sampleIntervalMs: 15 * 60 * 1000,
    historyRetentionMs: 8 * 24 * 60 * 60 * 1000
};
flow.set("storage_health_config_v1", config, "persistent");
msg.storageConfig = config;
node.status({ fill: "green", shape: "dot", text: "config v" + config.version });
return msg;`;

const discovery = `const device = {
    identifiers: ["raspberry_pi_5_host"],
    name: "Raspberry Pi",
    manufacturer: "Raspberry Pi",
    model: "Raspberry Pi 5"
};
const definitions = [
    {
        topic: "homeassistant/sensor/raspberry_storage_status/config",
        payload: { name: "Raspberry Storage Status", unique_id: "raspberry_storage_status", object_id: "raspberry_storage_status", state_topic: "smart_home/raspberry/storage/status", json_attributes_topic: "smart_home/raspberry/storage/attributes", icon: "mdi:harddisk", device }
    },
    {
        topic: "homeassistant/sensor/raspberry_storage_growth_24h/config",
        payload: { name: "Raspberry Storage Growth 24h", unique_id: "raspberry_storage_growth_24h", object_id: "raspberry_storage_growth_24h", state_topic: "smart_home/raspberry/storage/growth_24h", availability_topic: "smart_home/raspberry/storage/growth_24h_available", payload_available: "online", payload_not_available: "offline", unit_of_measurement: "pp", state_class: "measurement", icon: "mdi:chart-line", device }
    },
    {
        topic: "homeassistant/sensor/raspberry_storage_growth_7d/config",
        payload: { name: "Raspberry Storage Growth 7d", unique_id: "raspberry_storage_growth_7d", object_id: "raspberry_storage_growth_7d", state_topic: "smart_home/raspberry/storage/growth_7d", availability_topic: "smart_home/raspberry/storage/growth_7d_available", payload_available: "online", payload_not_available: "offline", unit_of_measurement: "pp", state_class: "measurement", icon: "mdi:chart-line", device }
    },
    {
        topic: "homeassistant/sensor/raspberry_storage_last_maintenance/config",
        payload: { name: "Raspberry Storage Last Maintenance", unique_id: "raspberry_storage_last_maintenance", object_id: "raspberry_storage_last_maintenance", state_topic: "smart_home/raspberry/storage/last_maintenance", device_class: "timestamp", icon: "mdi:broom", device }
    },
    {
        topic: "homeassistant/sensor/raspberry_storage_last_reclaimed/config",
        payload: { name: "Raspberry Storage Last Reclaimed", unique_id: "raspberry_storage_last_reclaimed", object_id: "raspberry_storage_last_reclaimed", state_topic: "smart_home/raspberry/storage/last_reclaimed_mib", unit_of_measurement: "MiB", state_class: "measurement", icon: "mdi:delete-sweep", device }
    }
];
return [definitions.map((entry) => ({ topic: entry.topic, payload: JSON.stringify(entry.payload), retain: true }))];`;

const evaluate = `const CONFIG_KEY = "storage_health_config_v1";
const STATE_KEY = "storage_health_state_v1";
const HISTORY_KEY = "storage_health_history_v1";
const config = flow.get(CONFIG_KEY, "persistent");
const now = Number(msg.testNow ?? Date.now());
const input = msg.payload ?? {};
const used = Number(input.used_percent);
const freeGiB = Number(input.free_gb);
const usedGiB = Number(input.used_gb);
const inodeUsed = input.inode_used_percent === undefined ? null : Number(input.inode_used_percent);
const valid = config && Number.isFinite(used) && used >= 0 && used <= 100 && Number.isFinite(freeGiB) && freeGiB >= 0;
let state = flow.get(STATE_KEY, "persistent") ?? { severity: "normal", lastNotificationAt: 0, lastTrendNotificationAt: 0, lastErrorNotificationAt: 0 };

function notification(title, message) {
    return { payload: { title, message } };
}

if (!valid) {
    node.status({ fill: "red", shape: "ring", text: "metrica invalida" });
    let alert = null;
    const cooldown = config?.commandErrorCooldownMs ?? 6 * 60 * 60 * 1000;
    if (now - Number(state.lastErrorNotificationAt || 0) >= cooldown) {
        state.lastErrorNotificationAt = now;
        alert = notification("Raspberry Pi - storage indisponivel", "Falha ao obter metricas validas de armazenamento do Home Assistant. Nenhuma manutencao foi executada.");
    }
    flow.set(STATE_KEY, state, "persistent");
    return [null, alert, { payload: { event: "invalid_metrics", at: new Date(now).toISOString(), input } }];
}

let history = flow.get(HISTORY_KEY, "persistent");
if (!Array.isArray(history)) history = [];
history = history.filter((point) => Number.isFinite(point?.ts) && Number.isFinite(point?.used) && point.ts >= now - config.historyRetentionMs && point.ts <= now + config.sampleIntervalMs);
const last = history[history.length - 1];
if (!last || now - last.ts >= config.sampleIntervalMs / 2) history.push({ ts: now, used });
else history[history.length - 1] = { ts: now, used };
history.sort((a, b) => a.ts - b.ts);
flow.set(HISTORY_KEY, history, "persistent");

function growthFor(ageMs) {
    const cutoff = now - ageMs;
    const candidates = history.filter((point) => point.ts <= cutoff);
    if (!candidates.length) return null;
    const point = candidates[candidates.length - 1];
    const sampleAge = now - point.ts;
    if (sampleAge < ageMs - 2 * 60 * 60 * 1000 || sampleAge > ageMs + 2 * 60 * 60 * 1000) return null;
    return Math.round((used - point.used) * 10) / 10;
}

const growth24h = growthFor(24 * 60 * 60 * 1000);
const growth7d = growthFor(7 * 24 * 60 * 60 * 1000);
const thresholds = config.thresholds;
function rawSeverity(value) {
    if (value >= thresholds.critical) return "critical";
    if (value >= thresholds.high) return "high";
    if (value >= thresholds.warning) return "warning";
    return "normal";
}
let severity = rawSeverity(used);
const previous = state.severity ?? "normal";
const h = config.hysteresisPercentagePoints;
if (previous === "critical" && used >= thresholds.critical - h) severity = "critical";
else if (previous === "high" && used >= thresholds.high - h && severity !== "critical") severity = "high";
else if (previous === "warning" && used >= thresholds.warning - h && severity === "normal") severity = "warning";

const rank = { normal: 0, warning: 1, high: 2, critical: 3 };
const freeText = freeGiB.toFixed(1) + " GiB livres";
const trendText = growth24h === null ? "" : "; " + (growth24h >= 0 ? "+" : "") + growth24h.toFixed(1) + " pp/24h";
let alert = null;
if (severity === "normal" && previous !== "normal") {
    alert = notification("Raspberry Pi - storage recuperado", "✅ Raspberry Pi storage back to normal: " + used.toFixed(1) + "% used (" + freeText + ")" + trendText + ".");
    state.lastNotificationAt = now;
} else if (rank[severity] > rank[previous] || (severity !== "normal" && now - Number(state.lastNotificationAt || 0) >= config.notificationCooldownMs)) {
    const icon = severity === "critical" ? "🚨" : "⚠️";
    const label = severity === "critical" ? "critical" : severity;
    alert = notification("Raspberry Pi - storage " + label, icon + " Raspberry Pi storage " + label + ": " + used.toFixed(1) + "% used (" + freeText + ")" + trendText + ".");
    state.lastNotificationAt = now;
}

const accelerated = (growth24h !== null && growth24h >= config.trendAlert24hPercentagePoints) || (growth7d !== null && growth7d >= config.trendAlert7dPercentagePoints);
if (alert && accelerated) state.lastTrendNotificationAt = now;
if (!alert && accelerated && now - Number(state.lastTrendNotificationAt || 0) >= config.notificationCooldownMs) {
    const parts = [];
    if (growth24h !== null) parts.push((growth24h >= 0 ? "+" : "") + growth24h.toFixed(1) + " pp/24h");
    if (growth7d !== null) parts.push((growth7d >= 0 ? "+" : "") + growth7d.toFixed(1) + " pp/7d");
    alert = notification("Raspberry Pi - crescimento de storage", "⚠️ Storage crescendo rapidamente: " + parts.join(", ") + ". Uso atual: " + used.toFixed(1) + "% (" + freeText + ").");
    state.lastTrendNotificationAt = now;
}

state.severity = severity;
state.updatedAt = now;
state.usedPercent = used;
state.freeGiB = freeGiB;
state.growth24h = growth24h;
state.growth7d = growth7d;
flow.set(STATE_KEY, state, "persistent");
const color = { normal: "green", warning: "yellow", high: "yellow", critical: "red" }[severity];
node.status({ fill: color, shape: severity === "normal" ? "dot" : "ring", text: severity + " " + used.toFixed(1) + "%" });
if (severity !== previous) node.log("storage_health: " + previous + " -> " + severity + " at " + used.toFixed(1) + "%");

const attributes = {
    used_percent: used,
    used_gib: Number.isFinite(usedGiB) ? usedGiB : null,
    free_gib: freeGiB,
    filesystem: input.filesystem ?? "/",
    inode_used_percent: Number.isFinite(inodeUsed) ? inodeUsed : null,
    growth_24h_percentage_points: growth24h,
    growth_7d_percentage_points: growth7d,
    collected_at: input.collected_at ?? new Date(now).toISOString(),
    thresholds,
    hysteresis_percentage_points: h
};
function growthMessages(window, value) {
    const availabilityTopic = "smart_home/raspberry/storage/growth_" + window + "_available";
    if (value === null) return [{ topic: availabilityTopic, payload: "offline", retain: true }];
    return [
        { topic: "smart_home/raspberry/storage/growth_" + window, payload: String(value), retain: true },
        { topic: availabilityTopic, payload: "online", retain: true }
    ];
}

const mqtt = [
    { topic: "smart_home/raspberry/storage/status", payload: severity, retain: true },
    { topic: "smart_home/raspberry/storage/attributes", payload: JSON.stringify(attributes), retain: true },
    ...growthMessages("24h", growth24h),
    ...growthMessages("7d", growth7d)
];
return [mqtt, alert, { payload: { event: "health_check", severity, previous, used, freeGiB, growth24h, growth7d, at: new Date(now).toISOString() } }];`;

const parseMaintenance = `const line = String(msg.payload ?? "").split(/\\r?\\n/).find((entry) => entry.startsWith("RESULT|"));
if (!line) return null;
const fields = Object.fromEntries(line.split("|").slice(1).map((part) => part.split(/=(.*)/s).slice(0, 2)));
const reclaimed = Number(fields.reclaimed_bytes);
if (fields.status !== "success" || fields.mode !== "apply" || !Number.isFinite(reclaimed)) return null;
node.log("storage_maintenance: success reclaimed_bytes=" + reclaimed);
return [[
    { topic: "smart_home/raspberry/storage/last_maintenance", payload: fields.at, retain: true },
    { topic: "smart_home/raspberry/storage/last_reclaimed_mib", payload: String(Math.round(reclaimed / 104857.6) / 10), retain: true }
]];`;

const maintenanceComplete = `const raw = msg.payload;
const code = Number(raw?.code ?? raw);
if (code === 0) {
    flow.set("storage_maintenance_last_stderr", null);
    node.status({ fill: "green", shape: "dot", text: "sucesso" });
    return null;
}
const config = flow.get("storage_health_config_v1", "persistent") ?? {};
const now = Date.now();
const last = Number(flow.get("storage_maintenance_last_error_notification", "persistent") || 0);
node.status({ fill: "red", shape: "ring", text: "falhou rc=" + code });
node.error("storage_maintenance: failed rc=" + code + " stderr=" + String(flow.get("storage_maintenance_last_stderr") ?? ""));
if (now - last < (config.commandErrorCooldownMs ?? 6 * 60 * 60 * 1000)) return null;
flow.set("storage_maintenance_last_error_notification", now, "persistent");
return { payload: { title: "Raspberry Pi - falha na manutencao", message: "A manutencao segura do Node-RED falhou (codigo " + code + "). Nenhuma etapa adicional foi executada; revise o log do node Storage Maintenance." } };`;

const nodes = [
  { id: TAB, type: "tab", label: "Storage Health", disabled: false, info: "Monitoramento de armazenamento, tendencia, alertas e housekeeping seguro sem Docker socket ou sudo." },
  { id: "storage_group_config", type: "group", z: TAB, name: "1. Configuracao central e MQTT discovery", style: { label: true, color: "#7d6ba8" }, nodes: ["storage_comment_architecture", "storage_init", "storage_set_config", "storage_discovery", "storage_mqtt_discovery"], x: 34, y: 39, w: 1012, h: 162 },
  { id: "storage_group_health", type: "group", z: TAB, name: "2. Health check leve (15 min) e tendencia", style: { label: true, color: "#3fadb5" }, nodes: ["storage_health_tick", "storage_manual_health", "storage_read_ha", "storage_evaluate", "storage_mqtt_state"], x: 34, y: 239, w: 1212, h: 182 },
  { id: "storage_group_alerts", type: "group", z: TAB, name: "3. Alertas com histerese, cooldown e recovery", style: { label: true, color: "#e6a23c" }, nodes: ["storage_notify"], x: 1274, y: 239, w: 312, h: 142 },
  { id: "storage_group_maintenance", type: "group", z: TAB, name: "4. Housekeeping allowlisted e inspecao semanal", style: { label: true, color: "#4d9a6a" }, nodes: ["storage_daily_maintenance", "storage_exec_maintenance", "storage_parse_maintenance", "storage_store_maintenance_stderr", "storage_maintenance_complete", "storage_weekly_inspection", "storage_exec_inspection", "storage_parse_inspection", "storage_maintenance_mqtt"], x: 34, y: 419, w: 1552, h: 262 },
  { id: "storage_comment_architecture", type: "comment", z: TAB, g: "storage_group_config", name: "Reusa sensores HA existentes; MQTT cria somente status/tendencia/manutencao. Node-RED nao recebe Docker socket nem sudo.", info: "", x: 450, y: 80, wires: [] },
  { id: "storage_init", type: "inject", z: TAB, g: "storage_group_config", name: "Inicializar ao subir", props: [{ p: "payload" }, { p: "topic", vt: "str" }], repeat: "", crontab: "", once: true, onceDelay: "2", topic: "", payload: "", payloadType: "date", x: 160, y: 150, wires: [["storage_set_config"]] },
  functionNode("storage_set_config", "storage_group_config", "Configurar thresholds", storageConfig, 1, 410, 150, [["storage_discovery"]]),
  functionNode("storage_discovery", "storage_group_config", "Publicar discovery", discovery, 1, 650, 150, [["storage_mqtt_discovery"]]),
  { id: "storage_mqtt_discovery", type: "mqtt out", z: TAB, g: "storage_group_config", name: "HA MQTT discovery", topic: "", qos: "1", retain: "true", respTopic: "", contentType: "application/json", userProps: "", correl: "", expiry: "", broker: MQTT, x: 900, y: 150, wires: [] },
  { id: "storage_health_tick", type: "inject", z: TAB, g: "storage_group_health", name: "A cada 15 min", props: [{ p: "payload" }, { p: "topic", vt: "str" }], repeat: "900", crontab: "", once: true, onceDelay: "10", topic: "", payload: "", payloadType: "date", x: 160, y: 310, wires: [["storage_read_ha"]] },
  { id: "storage_manual_health", type: "server-events", z: TAB, g: "storage_group_health", name: "Executar pelo painel HA", server: SERVER, version: 3, eventType: "storage_health_manual_run", eventData: "", waitForRunning: true, outputProperties: [{ property: "payload", propertyType: "msg", value: "", valueType: "eventData" }], x: 190, y: 350, wires: [["storage_read_ha"]] },
  { id: "storage_read_ha", type: "api-current-state", z: TAB, g: "storage_group_health", name: "Ler storage existente no HA", server: SERVER, version: 3, outputs: 1, halt_if: "", halt_if_type: "str", halt_if_compare: "is", entity_id: "sensor.raspberry_pi_storage_usage", state_type: "str", blockInputOverrides: true, outputProperties: [{ property: "payload", propertyType: "msg", value: "{\n  \"used_percent\": $entities(\"sensor.raspberry_pi_storage_usage\").state,\n  \"used_gb\": $entities(\"sensor.raspberry_pi_storage_used\").state,\n  \"free_gb\": $entities(\"sensor.raspberry_pi_storage_free\").state,\n  \"inode_used_percent\": $entities(\"sensor.raspberry_pi_metrics_raw\").attributes.disk_inodes_used_percent,\n  \"filesystem\": $entities(\"sensor.raspberry_pi_metrics_raw\").attributes.disk_path,\n  \"collected_at\": $entities(\"sensor.raspberry_pi_metrics_raw\").attributes.collected_at\n}", valueType: "jsonata" }], for: "0", forType: "num", forUnits: "minutes", override_topic: false, state_location: "payload", override_payload: "msg", entity_location: "data", override_data: "msg", x: 430, y: 310, wires: [["storage_evaluate"]] },
  functionNode("storage_evaluate", "storage_group_health", "Thresholds + histerese + tendencia", evaluate, 3, 740, 310, [["storage_mqtt_state"], ["storage_notify"], []]),
  { id: "storage_mqtt_state", type: "mqtt out", z: TAB, g: "storage_group_health", name: "Publicar storage health", topic: "", qos: "1", retain: "true", respTopic: "", contentType: "", userProps: "", correl: "", expiry: "", broker: MQTT, x: 1100, y: 290, wires: [] },
  { id: "storage_notify", type: "api-call-service", z: TAB, g: "storage_group_alerts", name: "Avisar moradores", server: SERVER, version: 7, debugenabled: false, action: "notify.send_message", floorId: [], areaId: [], deviceId: [], entityId: ["notify.iphone_de_gabriel_furlan", "notify.iphone_de_valeria"], labelId: [], data: "{\"title\": payload.title, \"message\": payload.message}", dataType: "jsonata", mergeContext: "", mustacheAltTags: false, outputProperties: [], queue: "all", blockInputOverrides: true, domain: "notify", service: "send_message", x: 1430, y: 310, wires: [[]] },
  { id: "storage_daily_maintenance", type: "inject", z: TAB, g: "storage_group_maintenance", name: "Diario 04:17", props: [{ p: "payload" }, { p: "topic", vt: "str" }], repeat: "", crontab: "17 04 * * *", once: false, onceDelay: "0.1", topic: "", payload: "", payloadType: "date", x: 150, y: 500, wires: [["storage_exec_maintenance"]] },
  { id: "storage_exec_maintenance", type: "exec", z: TAB, g: "storage_group_maintenance", command: "/opt/storage-health-maintenance.sh --apply", addpay: "", append: "", useSpawn: "false", timer: "120", winHide: false, oldrc: false, name: "Housekeeping Node-RED allowlisted", x: 460, y: 500, wires: [["storage_parse_maintenance"], ["storage_store_maintenance_stderr"], ["storage_maintenance_complete"]] },
  functionNode("storage_parse_maintenance", "storage_group_maintenance", "Registrar resultado", parseMaintenance, 1, 790, 470, [["storage_maintenance_mqtt"]]),
  functionNode("storage_store_maintenance_stderr", "storage_group_maintenance", "Guardar erro da etapa", "flow.set(\"storage_maintenance_last_stderr\", String(msg.payload ?? \"\").slice(0, 1000)); return null;", 0, 790, 530, []),
  functionNode("storage_maintenance_complete", "storage_group_maintenance", "Validar termino / cooldown", maintenanceComplete, 1, 1090, 530, [["storage_notify"]]),
  { id: "storage_weekly_inspection", type: "inject", z: TAB, g: "storage_group_maintenance", name: "Domingo 03:43", props: [{ p: "payload" }, { p: "topic", vt: "str" }], repeat: "", crontab: "43 03 * * 0", once: false, onceDelay: "0.1", topic: "", payload: "", payloadType: "date", x: 160, y: 620, wires: [["storage_exec_inspection"]] },
  { id: "storage_exec_inspection", type: "exec", z: TAB, g: "storage_group_maintenance", command: "/opt/storage-health-maintenance.sh --dry-run --deep", addpay: "", append: "", useSpawn: "false", timer: "120", winHide: false, oldrc: false, name: "Inspecao profunda /data", x: 460, y: 620, wires: [["storage_parse_inspection"], ["storage_store_maintenance_stderr"], ["storage_maintenance_complete"]] },
  functionNode("storage_parse_inspection", "storage_group_maintenance", "Logar inspecao", "const lines = String(msg.payload ?? \"\").split(/\\r?\\n/).filter((line) => line.startsWith(\"INSPECT|\")); if (lines.length) node.log(\"storage_inspection: \" + lines.join(\" \")); return null;", 0, 770, 620, []),
  { id: "storage_maintenance_mqtt", type: "mqtt out", z: TAB, g: "storage_group_maintenance", name: "Publicar manutencao", topic: "", qos: "1", retain: "true", respTopic: "", contentType: "", userProps: "", correl: "", expiry: "", broker: MQTT, x: 1090, y: 470, wires: [] },
];

const replacements = new Map(nodes.map((node) => [node.id, node]));
const installed = new Set();
const updated = [];
let lastOwnedIndex = -1;
for (const node of flows) {
  if (!ownedIds.has(node.id)) {
    updated.push(node);
    continue;
  }
  const replacement = replacements.get(node.id);
  if (replacement) {
    updated.push(replacement);
    installed.add(node.id);
    lastOwnedIndex = updated.length - 1;
  }
}
const missing = nodes.filter((node) => !installed.has(node.id));
updated.splice(lastOwnedIndex + 1, 0, ...missing);
fs.writeFileSync(flowsPath, `${JSON.stringify(updated, null, 4)}\n`);
console.log(`Installed ${nodes.length} Storage Health nodes in ${flowsPath}`);
