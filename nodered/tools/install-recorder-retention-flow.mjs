#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const flowsPath = path.resolve(process.argv[2] ?? path.resolve(here, "..", "flows.json"));
const flows = JSON.parse(fs.readFileSync(flowsPath, "utf8"));

const TAB = "recorder_retention_tab";
const SERVER = "4126427d5e161a03";
const ownedIds = new Set([
  TAB,
  "recorder_retention_group_config",
  "recorder_retention_group_capture",
  "recorder_retention_group_execution",
  "recorder_retention_group_tests",
  "recorder_retention_comment",
  "recorder_retention_init",
  "recorder_retention_config",
  "recorder_retention_changes",
  "recorder_retention_compact",
  "recorder_retention_schedule",
  "recorder_retention_plan",
  "recorder_retention_split",
  "recorder_retention_dispatch_guard",
  "recorder_retention_rate_limit",
  "recorder_retention_purge",
  "recorder_retention_test_instructions",
  "recorder_retention_test_reset",
  "recorder_retention_test_reset_state",
  "recorder_retention_test_baseline",
  "recorder_retention_test_near",
  "recorder_retention_test_outlier",
  "recorder_retention_test_prepare",
  "recorder_retention_test_compact",
  "recorder_retention_test_finalize",
  "recorder_retention_dry_run_terminal",
]);

if (!flows.some((node) => node.id === SERVER && node.type === "server")) {
  throw new Error(`Home Assistant server node ${SERVER} not found`);
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

const configuration = `const config = {
    version: 1,
    rawRetentionDays: 2,
    compactRetentionDays: 30,
    baselineIntervalMs: 6 * 60 * 60 * 1000,
    numericAbsoluteTolerance: 0.5,
    numericRelativeTolerance: 0.01,
    madMultiplier: 3,
    warmupMs: 2 * 24 * 60 * 60 * 1000,
    // Estas entidades são os emissores de alta frequência identificados na auditoria.
    monitoredEntities: [
        "sensor.vehicle_primary_refresh_coordinator",
        "sensor.zigbee_network_state",
        "binary_sensor.zigbee_network",
        "sensor.tuya_devices_state",
        "binary_sensor.tuya_devices",
        "sensor.internet_connection_state",
        "binary_sensor.internet_connection",
        "sensor.raspberry_pi_metrics_raw",
        "sensor.raspberry_pi_health",
        "sensor.raspberry_pi_cpu_temperature",
        "sensor.raspberry_pi_cpu_usage",
        "sensor.raspberry_pi_cpu_frequency",
        "sensor.raspberry_pi_load_1m",
        "sensor.raspberry_pi_load_5m",
        "sensor.raspberry_pi_load_15m",
        "sensor.raspberry_pi_memory_usage",
        "sensor.raspberry_pi_memory_used",
        "sensor.raspberry_pi_memory_available",
        "sensor.raspberry_pi_swap_usage",
        "sensor.raspberry_pi_swap_used",
        "sensor.raspberry_pi_storage_usage",
        "sensor.raspberry_pi_storage_used",
        "sensor.raspberry_pi_storage_free",
        "sensor.raspberry_pi_storage_inodes_usage",
        "sensor.raspberry_pi_uptime",
        "sensor.raspberry_pi_network_rx",
        "sensor.raspberry_pi_network_tx"
    ],
    purgeTargets: [
        {
            key: "codex_diagnostics",
            keepDays: 0,
            entityId: [
                "sensor.codex_dados_de_limite",
                "sensor.codex_benchmark_rtx_alto_potencial",
                "sensor.codex_canario_extracao_estruturada",
                "sensor.codex_pivot_rtx_restrito",
                "sensor.codex_atualizacao_do_limite_em",
                "sensor.codex_esgotamento_estimado",
                "sensor.codex_proxima_atualizacao_do_limite",
                "sensor.codex_ultima_atualizacao_do_limite",
                "sensor.codex_ritmo_do_limite",
                "sensor.codex_local_ai_status"
            ]
        },
        { key: "vehicle_refresh", keepDays: 2, entityId: ["sensor.vehicle_primary_refresh_coordinator"] },
        { key: "zigbee_diagnostics", keepDays: 2, entityId: ["sensor.zigbee_network_state", "binary_sensor.zigbee_network"] },
        { key: "raspberry_pi_health", keepDays: 2, entityGlobs: ["sensor.raspberry_pi_*", "binary_sensor.raspberry_pi_*"] },
        { key: "tuya_diagnostics", keepDays: 2, entityId: ["sensor.tuya_devices_state", "binary_sensor.tuya_devices"] },
        { key: "internet_diagnostics", keepDays: 2, entityId: ["sensor.internet_connection_state", "binary_sensor.internet_connection"] }
    ]
};
const now = Date.now();
const previous = flow.get("recorder_retention_config_v1", "persistent");
flow.set("recorder_retention_config_v1", config, "persistent");
flow.set("recorder_retention_started_at_v1", Number(previous?.startedAt ?? flow.get("recorder_retention_started_at_v1", "persistent") ?? now), "persistent");
node.status({ fill: "green", shape: "dot", text: "política v" + config.version });
return msg;`;

const compact = `const TEST = msg.test_mode === true;
const STORE = TEST ? undefined : "persistent";
const get = (key) => STORE ? flow.get(key, STORE) : flow.get(key);
const set = (key, value) => STORE ? flow.set(key, value, STORE) : flow.set(key, value);
const config = get("recorder_retention_config_v1");
if (!config) {
    node.status({ fill: "red", shape: "ring", text: "configuração ausente" });
    return null;
}
const source = msg.data?.new_state ?? msg.payload?.new_state ?? msg.payload ?? {};
const entityId = String(source.entity_id ?? msg.data?.entity_id ?? msg.entity_id ?? "");
if (!config.monitoredEntities.includes(entityId)) return null;
const rawValue = source.state;
if (rawValue === undefined || rawValue === null || ["unknown", "unavailable"].includes(String(rawValue))) return null;
const parsedAt = Date.parse(source.last_updated ?? "");
const now = Number(msg.testNow ?? (Number.isFinite(parsedAt) ? parsedAt : Date.now()));
if (!Number.isFinite(now)) return null;
let history = get("recorder_retention_compact_history_v1");
if (!history || typeof history !== "object" || Array.isArray(history)) history = {};
const entries = Array.isArray(history[entityId]) ? history[entityId] : [];
const cutoff = now - config.compactRetentionDays * 24 * 60 * 60 * 1000;
const retained = entries.filter((entry) => entry && Number.isFinite(entry.ts) && entry.ts >= cutoff);
const numeric = Number(rawValue);
const isNumeric = String(rawValue).trim() !== "" && Number.isFinite(numeric);
const baselines = retained.filter((entry) => entry.kind === "baseline" && entry.numeric === true).map((entry) => entry.value).sort((a, b) => a - b);
const median = (values) => {
    if (!values.length) return null;
    const middle = Math.floor(values.length / 2);
    return values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
};
const baselineMedian = median(baselines);
const deviations = baselineMedian === null ? [] : baselines.map((value) => Math.abs(value - baselineMedian)).sort((a, b) => a - b);
const mad = median(deviations) ?? 0;
const tolerance = isNumeric
    ? Math.max(config.numericAbsoluteTolerance, Math.abs(numeric) * config.numericRelativeTolerance, mad * config.madMultiplier)
    : 0;
const last = retained[retained.length - 1];
const nearPrevious = last && last.numeric === isNumeric
    ? isNumeric ? Math.abs(numeric - last.value) <= tolerance : String(rawValue) === String(last.value)
    : false;
const outlier = isNumeric && baselineMedian !== null && Math.abs(numeric - baselineMedian) > tolerance;
const baselineDue = !last || now - last.ts >= config.baselineIntervalMs;
const changed = !nearPrevious;
let kind = null;
if (!last || baselineDue) kind = "baseline";
else if (outlier) kind = "outlier";
else if (changed) kind = "change";
if (!kind) {
    set("recorder_retention_compact_history_v1", { ...history, [entityId]: retained });
    node.status({ fill: "grey", shape: "ring", text: "próximo; descartado" });
    return { ...msg, payload: { entity_id: entityId, retained: false, reason: "near_subsequent", test_mode: TEST } };
}
const record = { ts: now, value: isNumeric ? numeric : String(rawValue), numeric: isNumeric, kind };
retained.push(record);
set("recorder_retention_compact_history_v1", { ...history, [entityId]: retained });
node.status({ fill: kind === "outlier" ? "yellow" : "green", shape: "dot", text: kind });
return {
    ...msg,
    payload: {
        entity_id: entityId,
        retained: true,
        kind,
        value: record.value,
        baseline: baselineMedian,
        tolerance: isNumeric ? tolerance : null,
        test_mode: TEST
    }
};`;

const planPurge = `const TEST = msg.test_mode === true;
const STORE = TEST ? undefined : "persistent";
const get = (key) => STORE ? flow.get(key, STORE) : flow.get(key);
const config = get("recorder_retention_config_v1");
if (!config) return null;
const now = Number(msg.testNow ?? Date.now());
const startedAt = Number(get("recorder_retention_started_at_v1") ?? now);
const warmedUp = now >= startedAt + config.warmupMs;
const actions = config.purgeTargets
    .filter((target) => target.key === "codex_diagnostics" || warmedUp)
    .map((target) => ({
        key: target.key,
        keep_days: target.keepDays,
        ...(Array.isArray(target.entityId) ? { entity_id: target.entityId } : {}),
        ...(Array.isArray(target.entityGlobs) ? { entity_globs: target.entityGlobs } : {})
    }));
if (!warmedUp && !TEST) node.status({ fill: "blue", shape: "ring", text: "compactando antes do primeiro purge" });
return { ...msg, payload: actions, recorderRetention: { warmedUp, test_mode: TEST } };`;

const dispatchGuard = `const action = msg.payload ?? {};
if (!action.key || !Number.isInteger(action.keep_days) || (!Array.isArray(action.entity_id) && !Array.isArray(action.entity_globs))) {
    node.error("recorder_retention: ação de purge inválida", msg);
    return [null, null];
}
if (msg.test_mode === true) {
    return [null, { ...msg, payload: { simulated: true, dispatched: false, action: "recorder.purge_entities", target: action.key, keep_days: action.keep_days } }];
}
msg.payload = { keep_days: action.keep_days, ...(action.entity_id ? { entity_id: action.entity_id } : {}), ...(action.entity_globs ? { entity_globs: action.entity_globs } : {}) };
return [msg, null];`;

const testReset = `flow.set("recorder_retention_compact_history_v1__test", {}, undefined);
flow.set("recorder_retention_config_v1", { version: 1, compactRetentionDays: 30, baselineIntervalMs: 6 * 60 * 60 * 1000, numericAbsoluteTolerance: 0.5, numericRelativeTolerance: 0.01, madMultiplier: 3, warmupMs: 0, monitoredEntities: ["sensor.raspberry_pi_cpu_usage"], purgeTargets: [{ key: "codex_diagnostics", keepDays: 0, entityId: ["sensor.codex_dados_de_limite"] }, { key: "raspberry_pi_health", keepDays: 2, entityGlobs: ["sensor.raspberry_pi_*"] }] }, undefined);
flow.set("recorder_retention_started_at_v1__test", 0, undefined);
node.status({ fill: "green", shape: "dot", text: "teste resetado" });
return null;`;

const testPrepare = `const state = String(msg.payload ?? "baseline");
const values = { baseline: 40, near: 40.2, outlier: 87 };
return { test_mode: true, testNow: 1_800_000_000_000 + ({ baseline: 0, near: 60_000, outlier: 120_000 }[state] ?? 0), payload: { entity_id: "sensor.raspberry_pi_cpu_usage", state: String(values[state] ?? values.baseline) } };`;

const testFinalize = `const result = msg.payload ?? {};
return { ...msg, payload: { simulated: true, dispatched: false, action: "recorder-compaction", entity_id: result.entity_id, retained: result.retained, kind: result.kind ?? result.reason } };`;

const dryRun = `const DRY_RUN_CONTRACT = { simulated: true, dispatched: false };
const value = msg.payload ?? {};
if (value.simulated !== true || value.dispatched !== false) {
    node.error("recorder_retention: terminal recebeu efeito não simulado", msg);
    return null;
}
node.status({ fill: "green", shape: "dot", text: "dry-run " + String(value.target ?? value.kind ?? "compactação") });
node.log("recorder_retention_dry_run=" + JSON.stringify(value));
return null;`;

const nodes = [
  { id: TAB, type: "tab", label: "recorder_retention", disabled: false, info: "Política central: compacta baseline, mudanças e outliers em contexto persistente antes do purge suportado do Recorder." },
  { id: "recorder_retention_group_config", type: "group", z: TAB, name: "1. Política central e limites", style: { label: true, color: "#7d6ba8" }, nodes: ["recorder_retention_comment", "recorder_retention_init", "recorder_retention_config"], x: 64, y: 59, w: 972, h: 142 },
  { id: "recorder_retention_group_capture", type: "group", z: TAB, name: "2. Captura: baseline, mudanças e outliers", style: { label: true, color: "#3fadb5" }, nodes: ["recorder_retention_changes", "recorder_retention_compact"], x: 64, y: 239, w: 972, h: 182 },
  { id: "recorder_retention_group_execution", type: "group", z: TAB, name: "3. Purge serial, suportado e somente após aquecimento", style: { label: true, color: "#4d9a6a" }, nodes: ["recorder_retention_schedule", "recorder_retention_plan", "recorder_retention_split", "recorder_retention_dispatch_guard", "recorder_retention_rate_limit", "recorder_retention_purge"], x: 64, y: 459, w: 1662, h: 182 },
  { id: "recorder_retention_group_tests", type: "group", z: TAB, name: "TESTE — baseline, valor próximo e outlier em dry-run", style: { label: true, color: "#c9b458" }, nodes: ["recorder_retention_test_instructions", "recorder_retention_test_reset", "recorder_retention_test_reset_state", "recorder_retention_test_baseline", "recorder_retention_test_near", "recorder_retention_test_outlier", "recorder_retention_test_prepare", "recorder_retention_test_compact", "recorder_retention_test_finalize", "recorder_retention_dry_run_terminal"], x: 64, y: 679, w: 1662, h: 322 },
  { id: "recorder_retention_comment", type: "comment", z: TAB, g: "recorder_retention_group_config", name: "Não altera SQLite diretamente: o contexto guarda referências normais, mudanças e outliers; recorder.purge_entities remove somente a série bruta com mais de 2 dias.", info: "", x: 570, y: 100, wires: [] },
  { id: "recorder_retention_init", type: "inject", z: TAB, g: "recorder_retention_group_config", name: "Inicializar ao subir", props: [{ p: "payload" }], repeat: "", crontab: "", once: true, onceDelay: "3", topic: "", payload: "", payloadType: "date", x: 220, y: 160, wires: [["recorder_retention_config"]] },
  functionNode("recorder_retention_config", "recorder_retention_group_config", "Configurar política", configuration, 1, 540, 160, []),
  { id: "recorder_retention_changes", type: "server-state-changed", z: TAB, g: "recorder_retention_group_capture", name: "Observar entidades de alta frequência", server: SERVER, version: 6, outputs: 1, exposeAsEntityConfig: "", entities: { entity: ["sensor.vehicle_primary_refresh_coordinator", "sensor.zigbee_network_state", "binary_sensor.zigbee_network", "sensor.tuya_devices_state", "binary_sensor.tuya_devices", "sensor.internet_connection_state", "binary_sensor.internet_connection", "sensor.raspberry_pi_metrics_raw", "sensor.raspberry_pi_health", "sensor.raspberry_pi_cpu_temperature", "sensor.raspberry_pi_cpu_usage", "sensor.raspberry_pi_cpu_frequency", "sensor.raspberry_pi_load_1m", "sensor.raspberry_pi_load_5m", "sensor.raspberry_pi_load_15m", "sensor.raspberry_pi_memory_usage", "sensor.raspberry_pi_memory_used", "sensor.raspberry_pi_memory_available", "sensor.raspberry_pi_swap_usage", "sensor.raspberry_pi_swap_used", "sensor.raspberry_pi_storage_usage", "sensor.raspberry_pi_storage_used", "sensor.raspberry_pi_storage_free", "sensor.raspberry_pi_storage_inodes_usage", "sensor.raspberry_pi_uptime", "sensor.raspberry_pi_network_rx", "sensor.raspberry_pi_network_tx"], substring: [], regex: [] }, outputInitially: false, stateType: "str", ifState: "", ifStateType: "str", ifStateOperator: "is", outputOnlyOnStateChange: false, for: "0", forType: "num", forUnits: "minutes", ignorePrevStateNull: false, ignorePrevStateUnknown: false, ignorePrevStateUnavailable: false, ignoreCurrentStateUnknown: true, ignoreCurrentStateUnavailable: true, outputProperties: [], x: 280, y: 340, wires: [["recorder_retention_compact"]] },
  functionNode("recorder_retention_compact", "recorder_retention_group_capture", "Compactar: baseline / mudança / outlier", compact, 1, 700, 340, []),
  { id: "recorder_retention_schedule", type: "inject", z: TAB, g: "recorder_retention_group_execution", name: "Diariamente 04:30", props: [{ p: "payload" }], repeat: "", crontab: "30 04 * * *", once: false, onceDelay: "0.1", topic: "", payload: "", payloadType: "date", x: 200, y: 560, wires: [["recorder_retention_plan"]] },
  functionNode("recorder_retention_plan", "recorder_retention_group_execution", "Planejar purges elegíveis", planPurge, 1, 480, 560, [["recorder_retention_split"]]),
  { id: "recorder_retention_split", type: "split", z: TAB, g: "recorder_retention_group_execution", name: "Uma política por vez", splt: "\\n", spltType: "str", arraySplt: 1, arraySpltType: "len", stream: false, addname: "", property: "payload", x: 710, y: 560, wires: [["recorder_retention_dispatch_guard"]] },
  functionNode("recorder_retention_dispatch_guard", "recorder_retention_group_execution", "Gate de dispatch / dry-run", dispatchGuard, 2, 960, 560, [["recorder_retention_rate_limit"], ["recorder_retention_dry_run_terminal"]]),
  { id: "recorder_retention_rate_limit", type: "delay", z: TAB, g: "recorder_retention_group_execution", name: "Serializar: 1 purge a cada 2 min", pauseType: "rate", timeout: "5", timeoutUnits: "seconds", rate: "1", nbRateUnits: "2", rateUnits: "minute", randomFirst: "1", randomLast: "5", randomUnits: "seconds", drop: false, allowrate: false, outputs: 1, x: 1230, y: 560, wires: [["recorder_retention_purge"]] },
  { id: "recorder_retention_purge", type: "api-call-service", z: TAB, g: "recorder_retention_group_execution", name: "Purge seletivo do Recorder", server: SERVER, version: 7, debugenabled: false, action: "recorder.purge_entities", floorId: [], areaId: [], deviceId: [], entityId: [], labelId: [], data: "payload", dataType: "jsonata", mergeContext: "", mustacheAltTags: false, outputProperties: [], queue: "none", blockInputOverrides: true, domain: "recorder", service: "purge_entities", x: 1510, y: 560, wires: [[]] },
  { id: "recorder_retention_test_instructions", type: "comment", z: TAB, g: "recorder_retention_group_tests", name: "Ordem: 1 Reset; 2 Baseline; 3 Próximo; 4 Outlier. O último teste verifica que nenhum purge é enviado ao Home Assistant.", info: "", x: 650, y: 720, wires: [] },
  { id: "recorder_retention_test_reset", type: "inject", z: TAB, g: "recorder_retention_group_tests", name: "TESTE 1: reset", props: [{ p: "payload" }], repeat: "", crontab: "", once: false, onceDelay: 0.1, topic: "", payload: "", payloadType: "date", x: 200, y: 790, wires: [["recorder_retention_test_reset_state"]] },
  functionNode("recorder_retention_test_reset_state", "recorder_retention_group_tests", "Resetar estado sintético", testReset, 0, 450, 790, []),
  { id: "recorder_retention_test_baseline", type: "inject", z: TAB, g: "recorder_retention_group_tests", name: "TESTE 2: baseline 40", props: [{ p: "payload" }], repeat: "", crontab: "", once: false, onceDelay: 0.1, topic: "", payload: "baseline", payloadType: "str", x: 210, y: 850, wires: [["recorder_retention_test_prepare"]] },
  { id: "recorder_retention_test_near", type: "inject", z: TAB, g: "recorder_retention_group_tests", name: "TESTE 3: próximo 40,2", props: [{ p: "payload" }], repeat: "", crontab: "", once: false, onceDelay: 0.1, topic: "", payload: "near", payloadType: "str", x: 220, y: 900, wires: [["recorder_retention_test_prepare"]] },
  { id: "recorder_retention_test_outlier", type: "inject", z: TAB, g: "recorder_retention_group_tests", name: "TESTE 4: outlier 87", props: [{ p: "payload" }], repeat: "", crontab: "", once: false, onceDelay: 0.1, topic: "", payload: "outlier", payloadType: "str", x: 210, y: 950, wires: [["recorder_retention_test_prepare"]] },
  functionNode("recorder_retention_test_prepare", "recorder_retention_group_tests", "Preparar estado sintético", testPrepare, 1, 500, 890, [["recorder_retention_test_compact"]]),
  functionNode("recorder_retention_test_compact", "recorder_retention_group_tests", "Aplicar compactação real", compact, 1, 730, 890, [["recorder_retention_test_finalize"]]),
  functionNode("recorder_retention_test_finalize", "recorder_retention_group_tests", "Normalizar resultado simulado", testFinalize, 1, 1000, 890, [["recorder_retention_dry_run_terminal"]]),
  functionNode("recorder_retention_dry_run_terminal", "recorder_retention_group_tests", "TESTE FINAL: nenhum efeito despachado", dryRun, 0, 1270, 890, []),
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
console.log(`Installed ${nodes.length} Recorder Retention nodes in ${flowsPath}`);
