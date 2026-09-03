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
  "storage_group_tests",
  "storage_comment_architecture",
  "storage_init",
  "storage_set_config",
  "storage_discovery",
  "storage_mqtt_discovery",
  "storage_health_tick",
  "storage_manual_health",
  "storage_manual_start",
  "storage_manual_complete",
  "storage_manual_status_mqtt",
  "storage_read_ha",
  "storage_evaluate",
  "storage_auto_gate",
  "storage_auto_out",
  "storage_auto_in",
  "storage_post_maintenance_delay",
  "storage_recheck_out",
  "storage_recheck_in",
  "storage_mqtt_state",
  "storage_notify",
  "storage_notify_secondary",
  "storage_notify_persistent",
  "storage_notification_ack",
  "storage_notification_catch",
  "storage_notification_failure",
  "storage_daily_maintenance",
  "storage_exec_maintenance",
  "storage_request_host_maintenance",
  "storage_parse_maintenance",
  "storage_store_maintenance_stderr",
  "storage_maintenance_complete",
  "storage_weekly_inspection",
  "storage_exec_inspection",
  "storage_parse_inspection",
  "storage_maintenance_mqtt",
  "storage_test_instructions",
  "storage_test_reset",
  "storage_test_reset_state",
  "storage_test_normal",
  "storage_test_growth",
  "storage_test_prepare",
  "storage_test_input_out",
  "storage_test_input_in",
  "storage_test_decision_out",
  "storage_test_decision_in",
  "storage_test_dry_out",
  "storage_test_dry_in",
  "storage_test_decision_terminal",
  "storage_dry_run_terminal",
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
    autoRemediationCooldownMs: 6 * 60 * 60 * 1000,
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
        topic: "homeassistant/sensor/raspberry_storage_health_last_run/config",
        payload: { name: "Storage Health Last Run", unique_id: "raspberry_storage_health_last_run", object_id: "raspberry_storage_health_last_run", default_entity_id: "sensor.raspberry_pi_storage_health_last_run", state_topic: "smart_home/raspberry/storage/health_last_run", device_class: "timestamp", icon: "mdi:clock-check-outline", device }
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
    },
    {
        topic: "homeassistant/sensor/raspberry_storage_growth_cause/config",
        payload: { name: "Raspberry Storage Growth Cause", unique_id: "raspberry_storage_growth_cause", object_id: "raspberry_storage_growth_cause", state_topic: "smart_home/raspberry/storage/growth_cause", icon: "mdi:magnify-scan", device }
    },
    {
        topic: "homeassistant/binary_sensor/raspberry_storage_manual_running/config",
        payload: { name: "Storage Health Manual Running", unique_id: "raspberry_storage_manual_running", object_id: "raspberry_storage_manual_running", default_entity_id: "binary_sensor.raspberry_pi_storage_manual_running", state_topic: "smart_home/raspberry/storage/manual_running", payload_on: "ON", payload_off: "OFF", device_class: "running", icon: "mdi:harddisk", device }
    }
];
return [[
    ...definitions.map((entry) => ({ topic: entry.topic, payload: JSON.stringify(entry.payload), retain: true })),
    { topic: "smart_home/raspberry/storage/manual_running", payload: "OFF", retain: true }
]];`;

const manualStart = `const LOCK = "storage_manual_running";
if (flow.get(LOCK, "memoryOnly") === true) {
    node.status({ fill: "yellow", shape: "ring", text: "execução manual já ativa" });
    return [null, null, null, { topic: "smart_home/raspberry/storage/manual_running", payload: "ON", retain: true }];
}
flow.set(LOCK, true, "memoryOnly");
msg.storageManualRun = true;
node.status({ fill: "blue", shape: "dot", text: "running" });
const status = { topic: "smart_home/raspberry/storage/manual_running", payload: "ON", retain: true };
return [msg, { ...msg }, { ...msg }, status];`;

const manualComplete = `if (msg.storageManualRun !== true) return null;
flow.set("storage_manual_running", false, "memoryOnly");
node.status({ fill: "green", shape: "dot", text: "idle" });
return { topic: "smart_home/raspberry/storage/manual_running", payload: "OFF", retain: true };`;

const evaluate = `const CONFIG_KEY = "storage_health_config_v1";
const STATE_KEY = "storage_health_state_v1";
const HISTORY_KEY = "storage_health_history_v1";
const CATEGORY_HISTORY_KEY = "storage_health_category_history_v1";
const config = flow.get(CONFIG_KEY, "persistent");
const now = Number(msg.testNow ?? Date.now());
const input = msg.payload ?? {};
const used = Number(input.used_percent);
const freeGiB = Number(input.free_gb);
const usedGiB = Number(input.used_gb);
const inodeUsed = input.inode_used_percent === undefined ? null : Number(input.inode_used_percent);
const maintenanceAt = typeof input.maintenance_last_at === "string" && !Number.isNaN(Date.parse(input.maintenance_last_at)) ? input.maintenance_last_at : null;
const maintenanceReclaimedBytes = Number(input.maintenance_reclaimed_bytes);
const categoryInput = input.categories ?? {};
const categoryLabels = { docker: "Docker", repository: "repositorio", vscode: "VS Code Server", recorder: "Recorder", backups: "backups do Home Assistant", npmCache: "cache npm", knownLogs: "logs" };
const categoryValues = {};
for (const [key, raw] of Object.entries(categoryInput)) {
    const value = Number(raw);
    if (Number.isFinite(value) && value >= 0 && Object.hasOwn(categoryLabels, key)) categoryValues[key] = value;
}
const valid = config && Number.isFinite(used) && used >= 0 && used <= 100 && Number.isFinite(freeGiB) && freeGiB >= 0;
let state = flow.get(STATE_KEY, "persistent") ?? { severity: "normal", lastNotificationAt: 0, lastTrendNotificationAt: 0, lastErrorNotificationAt: 0 };

function notification(title, message, fields) {
    const id = String(now) + ":" + fields.join(",");
    return {
        payload: { title, message },
        notificationAck: {
            id,
            at: now,
            targets: fields.map((field) => ({ key: STATE_KEY, field }))
        }
    };
}

if (!valid) {
    node.status({ fill: "red", shape: "ring", text: "metrica invalida" });
    const lastRun = { topic: "smart_home/raspberry/storage/health_last_run", payload: new Date(now).toISOString(), retain: true };
    let alert = null;
    const cooldown = config?.commandErrorCooldownMs ?? 6 * 60 * 60 * 1000;
    if (now - Number(state.lastErrorNotificationAt || 0) >= cooldown) {
        alert = notification("Raspberry Pi - storage indisponivel", "Falha ao obter metricas validas de armazenamento do Home Assistant. Nenhuma manutencao foi executada.", ["lastErrorNotificationAt"]);
        state.pendingAlert = alert;
    }
    flow.set(STATE_KEY, state, "persistent");
    return [[lastRun], alert, { ...msg, payload: { event: "invalid_metrics", at: new Date(now).toISOString(), input } }, null];
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
let categoryHistory = flow.get(CATEGORY_HISTORY_KEY, "persistent");
if (!Array.isArray(categoryHistory)) categoryHistory = [];
categoryHistory = categoryHistory.filter((point) => point && Number.isFinite(point.ts) && point.ts >= now - config.historyRetentionMs && point.ts <= now + config.sampleIntervalMs);
if (Object.keys(categoryValues).length) {
    const categoryLast = categoryHistory[categoryHistory.length - 1];
    if (!categoryLast || now - categoryLast.ts >= config.sampleIntervalMs / 2) categoryHistory.push({ ts: now, values: categoryValues });
    else categoryHistory[categoryHistory.length - 1] = { ts: now, values: categoryValues };
}
categoryHistory.sort((a, b) => a.ts - b.ts);
flow.set(CATEGORY_HISTORY_KEY, categoryHistory, "persistent");
const categoryCutoff = now - 24 * 60 * 60 * 1000;
const categoryCandidates = categoryHistory.filter((point) => point.ts <= categoryCutoff && now - point.ts >= 22 * 60 * 60 * 1000 && now - point.ts <= 26 * 60 * 60 * 1000);
const categoryBaseline = categoryCandidates.length ? categoryCandidates[categoryCandidates.length - 1] : null;
const categoryGrowth = {};
if (categoryBaseline?.values) {
    for (const [key, value] of Object.entries(categoryValues)) {
        const before = Number(categoryBaseline.values[key]);
        if (Number.isFinite(before)) categoryGrowth[key] = value - before;
    }
}
const largestCategory = Object.entries(categoryGrowth).filter(([, bytes]) => bytes >= 64 * 1024 * 1024).sort((a, b) => b[1] - a[1])[0] ?? null;
const growthCause = largestCategory ? categoryLabels[largestCategory[0]] : "nao identificado";
const growthCauseBytes = largestCategory ? largestCategory[1] : null;
const causeSuffix = largestCategory ? "; causa provavel: " + growthCause + " +" + (growthCauseBytes / 1073741824).toFixed(1) + " GiB/24h" : "";
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
    alert = notification("Raspberry Pi - storage recuperado", "✅ Raspberry Pi storage back to normal: " + used.toFixed(1) + "% used (" + freeText + ")" + trendText + ".", ["lastNotificationAt"]);
} else if (rank[severity] > rank[previous] || (severity !== "normal" && now - Number(state.lastNotificationAt || 0) >= config.notificationCooldownMs)) {
    const icon = severity === "critical" ? "🚨" : "⚠️";
    const label = severity === "critical" ? "critical" : severity;
    alert = notification("Raspberry Pi - storage " + label, icon + " Raspberry Pi storage " + label + ": " + used.toFixed(1) + "% used (" + freeText + ")" + trendText + causeSuffix + ".", ["lastNotificationAt"]);
}

const accelerated = (growth24h !== null && growth24h >= config.trendAlert24hPercentagePoints) || (growth7d !== null && growth7d >= config.trendAlert7dPercentagePoints);
if (alert && accelerated && !alert.notificationAck.targets.some((target) => target.field === "lastTrendNotificationAt")) {
    alert.notificationAck.targets.push({ key: STATE_KEY, field: "lastTrendNotificationAt" });
}
if (!alert && accelerated && now - Number(state.lastTrendNotificationAt || 0) >= config.notificationCooldownMs) {
    const parts = [];
    if (growth24h !== null) parts.push((growth24h >= 0 ? "+" : "") + growth24h.toFixed(1) + " pp/24h");
    if (growth7d !== null) parts.push((growth7d >= 0 ? "+" : "") + growth7d.toFixed(1) + " pp/7d");
    alert = notification("Raspberry Pi - crescimento de storage", "⚠️ Storage crescendo rapidamente: " + parts.join(", ") + ". Uso atual: " + used.toFixed(1) + "% (" + freeText + ")" + causeSuffix + ". A limpeza segura foi solicitada automaticamente.", ["lastTrendNotificationAt"]);
}

if (alert) state.pendingAlert = alert;
else if (state.pendingAlert?.notificationAck?.id) alert = state.pendingAlert;

state.severity = severity;
state.updatedAt = now;
state.usedPercent = used;
state.freeGiB = freeGiB;
state.growth24h = growth24h;
state.growth7d = growth7d;
state.growthCause = growthCause;
state.growthCauseBytes = growthCauseBytes;
let remediation = null;
const remediationNeeded = accelerated || severity !== "normal";
if (remediationNeeded && now - Number(state.lastAutoRemediationAt || 0) >= config.autoRemediationCooldownMs) {
    state.lastAutoRemediationAt = now;
    remediation = { ...msg, storageAutoRemediation: true, test_mode: msg.test_mode === true, payload: { reason: accelerated ? "accelerated-growth" : "capacity-threshold", used, growth24h, growth7d, growthCause, growthCauseBytes } };
}
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
    growth_cause: growthCause,
    growth_cause_bytes: growthCauseBytes,
    category_growth_24h_bytes: categoryGrowth,
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
    { topic: "smart_home/raspberry/storage/health_last_run", payload: new Date(now).toISOString(), retain: true },
    { topic: "smart_home/raspberry/storage/growth_cause", payload: growthCause, retain: true },
    ...(maintenanceAt ? [{ topic: "smart_home/raspberry/storage/last_maintenance", payload: maintenanceAt, retain: true }] : []),
    ...(Number.isFinite(maintenanceReclaimedBytes) && maintenanceReclaimedBytes >= 0 ? [{ topic: "smart_home/raspberry/storage/last_reclaimed_mib", payload: String(Math.round(maintenanceReclaimedBytes / 104857.6) / 10), retain: true }] : []),
    ...growthMessages("24h", growth24h),
    ...growthMessages("7d", growth7d)
];
const event = { event: "health_check", severity, previous, used, freeGiB, growth24h, growth7d, growthCause, growthCauseBytes, remediationRequested: remediation !== null, at: new Date(now).toISOString() };
return [msg.test_mode === true ? [] : mqtt, msg.test_mode === true ? null : alert, { ...msg, payload: event }, remediation];`;

const autoGate = `if (msg.storageAutoRemediation !== true) return null;
if (msg.test_mode === true) {
    return [null, null, { payload: { simulated: true, dispatched: false, action: "storage-safe-maintenance", reason: msg.payload?.reason, growthCause: msg.payload?.growthCause } }];
}
node.status({ fill: "blue", shape: "dot", text: "limpeza automatica solicitada" });
return [{ ...msg }, { ...msg }, null];`;

const testReset = `for (const key of ["storage_health_state_v1", "storage_health_history_v1", "storage_health_category_history_v1"]) flow.set(key, null, "persistent");
node.status({ fill: "green", shape: "dot", text: "teste resetado" });
return null;`;

const testPrepare = `const now = Date.now();
const growth = msg.payload === "growth";
const beforeUsed = growth ? 55 : 60;
const currentUsed = growth ? 64 : 60;
flow.set("storage_health_history_v1", [{ ts: now - 24 * 60 * 60 * 1000, used: beforeUsed }], "persistent");
flow.set("storage_health_category_history_v1", [{ ts: now - 24 * 60 * 60 * 1000, values: { docker: growth ? 12000000000 : 16000000000, recorder: 4000000000, backups: 1600000000 } }], "persistent");
return {
    test_mode: true,
    testNow: now,
    payload: {
        used_percent: currentUsed,
        used_gb: 37,
        free_gb: 21,
        inode_used_percent: 18,
        filesystem: "/",
        collected_at: new Date(now).toISOString(),
        categories: { docker: 16000000000, recorder: 4000000000, backups: 1600000000 }
    }
};`;

const testDecision = `if (msg.test_mode !== true) return null;
msg.payload = { ...msg.payload, simulated: true, dispatched: false };
return msg;`;

const dryRunTerminal = `msg.payload = { ...msg.payload, simulated: true, dispatched: false };
node.status({ fill: "blue", shape: "ring", text: "simulado; nenhum efeito" });
return null;`;

const parseMaintenance = `const line = String(msg.payload ?? "").split(/\\r?\\n/).find((entry) => entry.startsWith("RESULT|"));
if (!line) return null;
const fields = Object.fromEntries(line.split("|").slice(1).map((part) => part.split(/=(.*)/s).slice(0, 2)));
const reclaimed = Number(fields.reclaimed_bytes);
if (fields.status !== "success" || fields.mode !== "apply" || !Number.isFinite(reclaimed)) return null;
node.log("storage_maintenance: success reclaimed_bytes=" + reclaimed);
return null;`;

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
return {
    payload: { title: "Raspberry Pi - falha na manutencao", message: "A manutencao segura de storage falhou (codigo " + code + "). Nenhuma etapa adicional foi executada; revise o log do flow Storage Health." },
    notificationAck: {
        id: "maintenance:" + String(now),
        at: now,
        targets: [{ key: "storage_maintenance_last_error_notification" }]
    }
};`;

const notificationAck = `const ack = msg.notificationAck;
if (!ack || !Number.isFinite(Number(ack.at)) || !Array.isArray(ack.targets)) return null;
for (const target of ack.targets) {
    if (!target || typeof target.key !== "string") continue;
    if (typeof target.field === "string") {
        const value = flow.get(target.key, "persistent") ?? {};
        value[target.field] = Number(ack.at);
        if (value.pendingAlert?.notificationAck?.id === ack.id) value.pendingAlert = null;
        flow.set(target.key, value, "persistent");
    } else {
        flow.set(target.key, Number(ack.at), "persistent");
    }
}
node.status({ fill: "green", shape: "dot", text: "entrega aceita pelo HA" });
return null;`;

const notificationFailure = `const source = String(msg.error?.source?.name ?? "notificacao").replace(/[^a-zA-Z0-9 _-]/g, "");
const detail = String(msg.error?.message ?? "erro desconhecido").replace(/[\\r\\n]+/g, " ").slice(0, 240);
node.error("storage_notification_failed source=" + source + " message=" + detail);
node.status({ fill: "red", shape: "ring", text: "entrega falhou; sem cooldown" });
return null;`;

const nodes = [
  { id: TAB, type: "tab", label: "storage_health", disabled: false, info: "Monitoramento de armazenamento, tendencia, alertas e housekeeping seguro sem Docker socket ou sudo." },
  { id: "storage_group_config", type: "group", z: TAB, name: "1. Configuracao central e MQTT discovery", style: { label: true, color: "#7d6ba8" }, nodes: ["storage_comment_architecture", "storage_init", "storage_set_config", "storage_discovery", "storage_mqtt_discovery"], x: -16, y: 39, w: 1042, h: 152 },
  { id: "storage_group_health", type: "group", z: TAB, name: "2. Health check leve (15 min) e tendencia", style: { label: true, color: "#3fadb5" }, nodes: ["storage_health_tick", "storage_manual_health", "storage_manual_start", "storage_read_ha", "storage_evaluate", "storage_mqtt_state", "storage_manual_status_mqtt", "storage_recheck_in", "storage_test_input_in", "storage_test_decision_out", "storage_auto_out"], x: 34, y: 249, w: 1352, h: 202 },
  { id: "storage_group_alerts", type: "group", z: TAB, name: "3. Alertas com histerese, cooldown e recovery", style: { label: true, color: "#e6a23c" }, nodes: ["storage_notify", "storage_notify_secondary", "storage_notify_persistent", "storage_notification_ack", "storage_notification_catch", "storage_notification_failure"], x: 1314, y: 209, w: 594, h: 262 },
  { id: "storage_group_maintenance", type: "group", z: TAB, name: "4. Housekeeping allowlisted e inspecao semanal", style: { label: true, color: "#4d9a6a" }, nodes: ["storage_daily_maintenance", "storage_auto_in", "storage_auto_gate", "storage_exec_maintenance", "storage_request_host_maintenance", "storage_post_maintenance_delay", "storage_recheck_out", "storage_parse_maintenance", "storage_store_maintenance_stderr", "storage_maintenance_complete", "storage_manual_complete", "storage_weekly_inspection", "storage_exec_inspection", "storage_parse_inspection", "storage_test_dry_out"], x: 24, y: 489, w: 1592, h: 279.5 },
  { id: "storage_group_tests", type: "group", z: TAB, name: "TESTE — aumento e normalidade em dry-run", style: { label: true, color: "#c9b458" }, nodes: ["storage_test_instructions", "storage_test_reset", "storage_test_reset_state", "storage_test_normal", "storage_test_growth", "storage_test_prepare", "storage_test_input_out", "storage_test_decision_in", "storage_test_decision_terminal", "storage_test_dry_in", "storage_dry_run_terminal"], x: 24, y: 809, w: 1592, h: 242 },
  { id: "storage_comment_architecture", type: "comment", z: TAB, g: "storage_group_config", name: "Reusa sensores HA existentes; MQTT cria somente status/tendencia/manutencao. Node-RED nao recebe Docker socket nem sudo.", info: "", x: 450, y: 80, wires: [] },
  { id: "storage_init", type: "inject", z: TAB, g: "storage_group_config", name: "Inicializar ao subir", props: [{ p: "payload" }, { p: "topic", vt: "str" }], repeat: "", crontab: "", once: true, onceDelay: "2", topic: "", payload: "", payloadType: "date", x: 160, y: 150, wires: [["storage_set_config"]] },
  functionNode("storage_set_config", "storage_group_config", "Configurar thresholds", storageConfig, 1, 410, 150, [["storage_discovery"]]),
  functionNode("storage_discovery", "storage_group_config", "Publicar discovery", discovery, 1, 650, 150, [["storage_mqtt_discovery"]]),
  { id: "storage_mqtt_discovery", type: "mqtt out", z: TAB, g: "storage_group_config", name: "HA MQTT discovery", topic: "", qos: "1", retain: "true", respTopic: "", contentType: "application/json", userProps: "", correl: "", expiry: "", broker: MQTT, x: 900, y: 150, wires: [] },
  { id: "storage_health_tick", type: "inject", z: TAB, g: "storage_group_health", name: "A cada 15 min", props: [{ p: "payload" }, { p: "topic", vt: "str" }], repeat: "900", crontab: "", once: true, onceDelay: "10", topic: "", payload: "", payloadType: "date", x: 160, y: 310, wires: [["storage_read_ha"]] },
  { id: "storage_manual_health", type: "server-state-changed", z: TAB, g: "storage_group_health", name: "Executar pelo painel HA", server: SERVER, version: 6, outputs: 1, exposeAsEntityConfig: "", entities: { entity: ["input_button.storage_health_manual_run"], substring: [], regex: [] }, outputInitially: false, stateType: "str", ifState: "", ifStateType: "str", ifStateOperator: "is", outputOnlyOnStateChange: true, for: "0", forType: "num", forUnits: "minutes", ignorePrevStateNull: false, ignorePrevStateUnknown: false, ignorePrevStateUnavailable: false, ignoreCurrentStateUnknown: true, ignoreCurrentStateUnavailable: true, outputProperties: [], x: 170, y: 370, wires: [["storage_manual_start"]] },
  functionNode("storage_manual_start", "storage_group_health", "Iniciar execução manual", manualStart, 4, 430, 370, [["storage_exec_maintenance"], ["storage_request_host_maintenance"], ["storage_read_ha"], ["storage_manual_status_mqtt"]]),
  { id: "storage_read_ha", type: "api-current-state", z: TAB, g: "storage_group_health", name: "Ler storage e categorias no HA", server: SERVER, version: 3, outputs: 1, halt_if: "", halt_if_type: "str", halt_if_compare: "is", entity_id: "sensor.raspberry_pi_storage_usage", state_type: "str", blockInputOverrides: true, outputProperties: [{ property: "payload", propertyType: "msg", value: "{\n  \"used_percent\": $entities(\"sensor.raspberry_pi_storage_usage\").state,\n  \"used_gb\": $entities(\"sensor.raspberry_pi_storage_used\").state,\n  \"free_gb\": $entities(\"sensor.raspberry_pi_storage_free\").state,\n  \"inode_used_percent\": $entities(\"sensor.raspberry_pi_metrics_raw\").attributes.disk_inodes_used_percent,\n  \"filesystem\": $entities(\"sensor.raspberry_pi_metrics_raw\").attributes.disk_path,\n  \"collected_at\": $entities(\"sensor.raspberry_pi_metrics_raw\").attributes.collected_at,\n  \"maintenance_last_at\": $entities(\"sensor.raspberry_pi_metrics_raw\").attributes.storage_maintenance_last_at,\n  \"maintenance_reclaimed_bytes\": $entities(\"sensor.raspberry_pi_metrics_raw\").attributes.storage_maintenance_last_reclaimed_bytes,\n  \"categories\": {\n    \"docker\": $entities(\"sensor.raspberry_pi_metrics_raw\").attributes.storage_maintenance_docker_logical_bytes,\n    \"repository\": $entities(\"sensor.raspberry_pi_metrics_raw\").attributes.storage_maintenance_repository_bytes,\n    \"vscode\": $entities(\"sensor.raspberry_pi_metrics_raw\").attributes.storage_maintenance_vscode_server_logical_bytes,\n    \"recorder\": $entities(\"sensor.raspberry_pi_metrics_raw\").attributes.storage_maintenance_home_assistant_recorder_logical_bytes,\n    \"backups\": $entities(\"sensor.raspberry_pi_metrics_raw\").attributes.storage_maintenance_home_assistant_backups_logical_bytes,\n    \"npmCache\": $entities(\"sensor.raspberry_pi_metrics_raw\").attributes.storage_maintenance_npm_cache_logical_bytes,\n    \"knownLogs\": $entities(\"sensor.raspberry_pi_metrics_raw\").attributes.storage_maintenance_known_logs_bytes\n  }\n}", valueType: "jsonata" }], for: "0", forType: "num", forUnits: "minutes", override_topic: false, state_location: "payload", override_payload: "msg", entity_location: "data", override_data: "msg", x: 430, y: 310, wires: [["storage_evaluate"]] },
  functionNode("storage_evaluate", "storage_group_health", "Diagnosticar + tendencia + autocuidado", evaluate, 4, 740, 310, [["storage_mqtt_state"], ["storage_notify", "storage_notify_secondary", "storage_notify_persistent"], ["storage_test_decision_out"], ["storage_auto_out"]]),
  { id: "storage_recheck_in", type: "link in", z: TAB, g: "storage_group_health", name: "Reavaliar apos limpeza", links: ["storage_recheck_out"], x: 295, y: 270, wires: [["storage_read_ha"]] },
  { id: "storage_test_input_in", type: "link in", z: TAB, g: "storage_group_health", name: "Metricas sinteticas", links: ["storage_test_input_out"], x: 595, y: 370, wires: [["storage_evaluate"]] },
  { id: "storage_test_decision_out", type: "link out", z: TAB, g: "storage_group_health", name: "Resultado para teste", mode: "link", links: ["storage_test_decision_in"], x: 1055, y: 430, wires: [] },
  { id: "storage_auto_out", type: "link out", z: TAB, g: "storage_group_health", name: "Solicitar autocuidado", mode: "link", links: ["storage_auto_in"], x: 1095, y: 500, wires: [] },
  { id: "storage_mqtt_state", type: "mqtt out", z: TAB, g: "storage_group_health", name: "Publicar storage health", topic: "", qos: "1", retain: "true", respTopic: "", contentType: "", userProps: "", correl: "", expiry: "", broker: MQTT, x: 1100, y: 290, wires: [] },
  { id: "storage_manual_status_mqtt", type: "mqtt out", z: TAB, g: "storage_group_health", name: "Publicar execução manual", topic: "", qos: "1", retain: "true", respTopic: "", contentType: "", userProps: "", correl: "", expiry: "", broker: MQTT, x: 1190, y: 390, wires: [] },
  { id: "storage_notify", type: "api-call-service", z: TAB, g: "storage_group_alerts", name: "Avisar resident_primary", server: SERVER, version: 7, debugenabled: false, action: "public_bindings.call", floorId: [], areaId: [], deviceId: [], entityId: [], labelId: [], data: "{\"role\":\"mobile_primary\",\"action\":\"notify_3\",\"data\":{\"title\":payload.title,\"message\":payload.message}}", dataType: "jsonata", mergeContext: "", mustacheAltTags: false, outputProperties: [], queue: "all", blockInputOverrides: true, domain: "public_bindings", service: "call", x: 1480, y: 250, wires: [["storage_notification_ack"]] },
  { id: "storage_notify_secondary", type: "api-call-service", z: TAB, g: "storage_group_alerts", name: "Avisar resident_secondary", server: SERVER, version: 7, debugenabled: false, action: "public_bindings.call", floorId: [], areaId: [], deviceId: [], entityId: [], labelId: [], data: "{\"role\":\"mobile_secondary\",\"action\":\"notify_2\",\"data\":{\"title\":payload.title,\"message\":payload.message}}", dataType: "jsonata", mergeContext: "", mustacheAltTags: false, outputProperties: [], queue: "all", blockInputOverrides: true, domain: "public_bindings", service: "call", x: 1480, y: 310, wires: [["storage_notification_ack"]] },
  { id: "storage_notify_persistent", type: "api-call-service", z: TAB, g: "storage_group_alerts", name: "Fallback persistente no HA", server: SERVER, version: 7, debugenabled: false, action: "persistent_notification.create", floorId: [], areaId: [], deviceId: [], entityId: [], labelId: [], data: "{\"title\":payload.title,\"message\":payload.message,\"notification_id\":\"raspberry_storage_health\"}", dataType: "jsonata", mergeContext: "", mustacheAltTags: false, outputProperties: [], queue: "all", blockInputOverrides: true, domain: "persistent_notification", service: "create", x: 1480, y: 370, wires: [["storage_notification_ack"]] },
  functionNode("storage_notification_ack", "storage_group_alerts", "Confirmar entrega e iniciar cooldown", notificationAck, 0, 1770, 310, []),
  { id: "storage_notification_catch", type: "catch", z: TAB, g: "storage_group_alerts", name: "Capturar falha de notificacao", scope: ["storage_notify", "storage_notify_secondary", "storage_notify_persistent"], uncaught: false, x: 1480, y: 430, wires: [["storage_notification_failure"]] },
  functionNode("storage_notification_failure", "storage_group_alerts", "Registrar falha sem cooldown", notificationFailure, 0, 1760, 430, []),
  { id: "storage_daily_maintenance", type: "inject", z: TAB, g: "storage_group_maintenance", name: "A cada 6h (:23)", props: [{ p: "payload" }, { p: "storageAutoRemediation", v: "true", vt: "bool" }], repeat: "", crontab: "23 */6 * * *", once: false, onceDelay: "0.1", topic: "", payload: "", payloadType: "date", x: 150, y: 500, wires: [["storage_auto_gate"]] },
  { id: "storage_auto_in", type: "link in", z: TAB, g: "storage_group_maintenance", name: "Receber autocuidado", links: ["storage_auto_out"], x: 315, y: 760, wires: [["storage_auto_gate"]] },
  functionNode("storage_auto_gate", "storage_group_maintenance", "Gate de autocuidado / dry-run", autoGate, 3, 220, 620, [["storage_exec_maintenance"], ["storage_request_host_maintenance"], ["storage_test_dry_out"]]),
  { id: "storage_exec_maintenance", type: "exec", z: TAB, g: "storage_group_maintenance", command: "/opt/storage-health-maintenance.sh --apply", addpay: "", append: "", useSpawn: "false", timer: "120", winHide: false, oldrc: false, name: "Housekeeping Node-RED allowlisted", x: 460, y: 560, wires: [["storage_parse_maintenance"], ["storage_store_maintenance_stderr"], ["storage_maintenance_complete", "storage_manual_complete"]] },
  { id: "storage_request_host_maintenance", type: "exec", z: TAB, g: "storage_group_maintenance", command: "/opt/request-host-storage-maintenance.sh", addpay: "", append: "", useSpawn: "false", timer: "15", winHide: false, oldrc: false, name: "Solicitar limpeza segura no host", x: 520, y: 570, wires: [["storage_post_maintenance_delay"], ["storage_store_maintenance_stderr"], ["storage_maintenance_complete"]] },
  { id: "storage_post_maintenance_delay", type: "delay", z: TAB, g: "storage_group_maintenance", name: "Aguardar worker e medir novamente", pauseType: "delay", timeout: "3", timeoutUnits: "minutes", rate: "1", nbRateUnits: "1", rateUnits: "second", randomFirst: "1", randomLast: "5", randomUnits: "seconds", drop: false, allowrate: false, outputs: 1, x: 870, y: 570, wires: [["storage_recheck_out"]] },
  { id: "storage_recheck_out", type: "link out", z: TAB, g: "storage_group_maintenance", name: "Voltar ao diagnostico", mode: "link", links: ["storage_recheck_in"], x: 1195, y: 570, wires: [] },
  { id: "storage_test_dry_out", type: "link out", z: TAB, g: "storage_group_maintenance", name: "Autocuidado simulado", mode: "link", links: ["storage_test_dry_in"], x: 1195, y: 620, wires: [] },
  functionNode("storage_parse_maintenance", "storage_group_maintenance", "Registrar resultado", parseMaintenance, 0, 790, 470, []),
  functionNode("storage_store_maintenance_stderr", "storage_group_maintenance", "Guardar erro da etapa", "flow.set(\"storage_maintenance_last_stderr\", String(msg.payload ?? \"\").slice(0, 1000)); return null;", 0, 790, 530, []),
  functionNode("storage_maintenance_complete", "storage_group_maintenance", "Validar termino / cooldown", maintenanceComplete, 1, 1090, 530, [["storage_notify", "storage_notify_secondary", "storage_notify_persistent"]]),
  functionNode("storage_manual_complete", "storage_group_maintenance", "Finalizar execução manual", manualComplete, 1, 1250, 590, [["storage_manual_status_mqtt"]]),
  { id: "storage_weekly_inspection", type: "inject", z: TAB, g: "storage_group_maintenance", name: "Domingo 03:43", props: [{ p: "payload" }, { p: "topic", vt: "str" }], repeat: "", crontab: "43 03 * * 0", once: false, onceDelay: "0.1", topic: "", payload: "", payloadType: "date", x: 160, y: 660, wires: [["storage_exec_inspection"]] },
  { id: "storage_exec_inspection", type: "exec", z: TAB, g: "storage_group_maintenance", command: "/opt/storage-health-maintenance.sh --dry-run --deep", addpay: "", append: "", useSpawn: "false", timer: "120", winHide: false, oldrc: false, name: "Inspecao profunda /data", x: 460, y: 660, wires: [["storage_parse_inspection"], ["storage_store_maintenance_stderr"], ["storage_maintenance_complete"]] },
  functionNode("storage_parse_inspection", "storage_group_maintenance", "Logar inspecao", "const lines = String(msg.payload ?? \"\").split(/\\r?\\n/).filter((line) => line.startsWith(\"INSPECT|\")); if (lines.length) node.log(\"storage_inspection: \" + lines.join(\" \")); return null;", 0, 770, 620, []),
  { id: "storage_test_instructions", type: "comment", z: TAB, g: "storage_group_tests", name: "Ordem: 1 Reset; 2 Normal; 3 Crescimento. Tudo termina em dry-run, sem exec, MQTT ou notificacao.", info: "", x: 480, y: 850, wires: [] },
  { id: "storage_test_reset", type: "inject", z: TAB, g: "storage_group_tests", name: "TESTE 1: reset", props: [{ p: "payload" }], repeat: "", crontab: "", once: false, onceDelay: 0.1, topic: "", payload: "", payloadType: "date", x: 150, y: 910, wires: [["storage_test_reset_state"]] },
  functionNode("storage_test_reset_state", "storage_group_tests", "Resetar estado sintetico", testReset, 0, 390, 910, []),
  { id: "storage_test_normal", type: "inject", z: TAB, g: "storage_group_tests", name: "TESTE 2: normal", props: [{ p: "payload" }], repeat: "", crontab: "", once: false, onceDelay: 0.1, topic: "", payload: "normal", payloadType: "str", x: 150, y: 970, wires: [["storage_test_prepare"]] },
  { id: "storage_test_growth", type: "inject", z: TAB, g: "storage_group_tests", name: "TESTE 3: +9 pp Docker", props: [{ p: "payload" }], repeat: "", crontab: "", once: false, onceDelay: 0.1, topic: "", payload: "growth", payloadType: "str", x: 170, y: 1020, wires: [["storage_test_prepare"]] },
  functionNode("storage_test_prepare", "storage_group_tests", "Preparar metricas sinteticas", testPrepare, 1, 450, 990, [["storage_test_input_out"]]),
  { id: "storage_test_input_out", type: "link out", z: TAB, g: "storage_group_tests", name: "Enviar metricas ao diagnostico", mode: "link", links: ["storage_test_input_in"], x: 735, y: 990, wires: [] },
  { id: "storage_test_decision_in", type: "link in", z: TAB, g: "storage_group_tests", name: "Receber decisao", links: ["storage_test_decision_out"], x: 835, y: 930, wires: [["storage_test_decision_terminal"]] },
  functionNode("storage_test_decision_terminal", "storage_group_tests", "Decisao sintetica", testDecision, 1, 1040, 930, [["storage_dry_run_terminal"]]),
  { id: "storage_test_dry_in", type: "link in", z: TAB, g: "storage_group_tests", name: "Receber autocuidado simulado", links: ["storage_test_dry_out"], x: 835, y: 1010, wires: [["storage_dry_run_terminal"]] },
  functionNode("storage_dry_run_terminal", "storage_group_tests", "TESTE FINAL: nenhum efeito despachado", dryRunTerminal, 0, 1380, 970, []),
];

const canonicalLayout = new Map([
  ["storage_group_config", { x: 74, y: 99, w: 1042, h: 152 }],
  ["storage_group_health", { x: 64, y: 299, w: 1302, h: 297 }],
  ["storage_group_alerts", { x: 1564, y: 239, w: 702, h: 262 }],
  ["storage_group_maintenance", { x: 74, y: 629, w: 1642, h: 320 }],
  ["storage_group_tests", { x: 74, y: 989, w: 1642, h: 300 }],
  ["storage_comment_architecture", { x: 540, y: 140 }],
  ["storage_init", { x: 250, y: 210 }],
  ["storage_set_config", { x: 500, y: 210 }],
  ["storage_discovery", { x: 740, y: 210 }],
  ["storage_mqtt_discovery", { x: 990, y: 210 }],
  ["storage_health_tick", { x: 190, y: 430 }],
  ["storage_manual_health", { x: 200, y: 490 }],
  ["storage_read_ha", { x: 470, y: 400 }],
  ["storage_evaluate", { x: 790, y: 400 }],
  ["storage_mqtt_state", { x: 1090, y: 340 }],
  ["storage_recheck_in", { x: 245, y: 350 }],
  ["storage_test_input_in", { x: 555, y: 550 }],
  ["storage_test_decision_out", { x: 1095, y: 550 }],
  ["storage_auto_out", { x: 1095, y: 510 }],
  ["storage_notify", { x: 1710, y: 280 }],
  ["storage_notify_secondary", { x: 1710, y: 340 }],
  ["storage_daily_maintenance", { x: 200, y: 700 }],
  ["storage_auto_gate", { x: 500, y: 700 }],
  ["storage_auto_in", { x: 285, y: 780 }],
  ["storage_exec_maintenance", { x: 820, y: 680 }],
  ["storage_parse_maintenance", { x: 1140, y: 670 }],
  ["storage_store_maintenance_stderr", { x: 1140, y: 730 }],
  ["storage_maintenance_complete", { x: 1450, y: 730 }],
  ["storage_weekly_inspection", { x: 210, y: 860 }],
  ["storage_exec_inspection", { x: 510, y: 860 }],
  ["storage_parse_inspection", { x: 820, y: 860 }],
  ["storage_request_host_maintenance", { x: 820, y: 780 }],
  ["storage_post_maintenance_delay", { x: 1140, y: 780 }],
  ["storage_recheck_out", { x: 1510, y: 800 }],
  ["storage_test_dry_out", { x: 1510, y: 860 }],
  ["storage_notify_persistent", { x: 1710, y: 400 }],
  ["storage_notification_ack", { x: 2090, y: 340 }],
  ["storage_notification_catch", { x: 1710, y: 460 }],
  ["storage_notification_failure", { x: 1990, y: 460 }],
  ["storage_manual_start", { x: 520, y: 500 }],
  ["storage_manual_status_mqtt", { x: 1220, y: 510 }],
  ["storage_manual_complete", { x: 1100, y: 920 }],
  ["storage_test_instructions", { x: 540, y: 1030 }],
  ["storage_test_reset", { x: 200, y: 1100 }],
  ["storage_test_reset_state", { x: 450, y: 1100 }],
  ["storage_test_normal", { x: 200, y: 1170 }],
  ["storage_test_growth", { x: 210, y: 1230 }],
  ["storage_test_prepare", { x: 500, y: 1200 }],
  ["storage_test_input_out", { x: 790, y: 1200 }],
  ["storage_test_decision_in", { x: 900, y: 1100 }],
  ["storage_test_decision_terminal", { x: 1130, y: 1100 }],
  ["storage_test_dry_in", { x: 900, y: 1190 }],
  ["storage_dry_run_terminal", { x: 1450, y: 1150 }],
]);
const canonicalNodes = nodes.map((node) => ({
  ...node,
  ...(canonicalLayout.get(node.id) ?? {}),
}));

const replacements = new Map(canonicalNodes.map((node) => [node.id, node]));
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
const missing = canonicalNodes.filter((node) => !installed.has(node.id));
updated.splice(lastOwnedIndex + 1, 0, ...missing);
fs.writeFileSync(flowsPath, `${JSON.stringify(updated, null, 4)}\n`);
console.log(`Installed ${canonicalNodes.length} Storage Health nodes in ${flowsPath}`);
