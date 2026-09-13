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
  "recorder_retention_policy_raw_days",
  "recorder_retention_policy_compact_days",
  "recorder_retention_policy_baseline_hours",
  "recorder_retention_policy_absolute_tolerance",
  "recorder_retention_policy_relative_percent",
  "recorder_retention_policy_mad_multiplier",
  "recorder_retention_policy_warmup_days",
  "recorder_retention_policy_updates_out",
  "recorder_retention_policy_updates_in",
  "recorder_retention_config",
  "recorder_retention_changes",
  "recorder_retention_compact",
  "recorder_retention_test_compact_in",
  "recorder_retention_result_switch",
  "recorder_retention_test_output_gate",
  "recorder_retention_test_result_out",
  "recorder_retention_baseline_terminal",
  "recorder_retention_change_terminal",
  "recorder_retention_outlier_terminal",
  "recorder_retention_discard_terminal",
  "recorder_retention_schedule",
  "recorder_retention_cycle_marker",
  "recorder_retention_plan_targets",
  "recorder_retention_plan",
  "recorder_retention_split",
  "recorder_retention_dispatch_guard",
  "recorder_retention_rate_limit",
  "recorder_retention_purge",
  "recorder_retention_repack_delay",
  "recorder_retention_repack_status",
  "recorder_retention_repack_evaluate",
  "recorder_retention_repack",
  "recorder_retention_repack_retry_out",
  "recorder_retention_repack_delay_in",
  "recorder_retention_test_repack_out",
  "recorder_retention_repack_test_in",
  "recorder_retention_guard_dry_out",
  "recorder_retention_repack_dry_out",
  "recorder_retention_dry_run_in",
  "recorder_retention_test_instructions",
  "recorder_retention_test_reset",
  "recorder_retention_test_reset_state",
  "recorder_retention_test_baseline",
  "recorder_retention_test_near",
  "recorder_retention_test_outlier",
  "recorder_retention_test_repack_ready",
  "recorder_retention_test_prepare",
  "recorder_retention_test_compact",
  "recorder_retention_test_compact_out",
  "recorder_retention_test_result_in",
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

const configuration = `const limits = {
    rawRetentionDays: { min: 1, max: 14, integer: true },
    compactRetentionDays: { min: 7, max: 180, integer: true },
    baselineIntervalHours: { min: 1, max: 24, integer: true },
    numericAbsoluteTolerance: { min: 0.1, max: 10 },
    numericRelativeTolerancePercent: { min: 0.1, max: 10 },
    madMultiplier: { min: 1, max: 10 },
    warmupDays: { min: 0, max: 14, integer: true }
};
const key = String(msg.topic ?? "");
const rule = limits[key];
const value = Number(msg.payload);
if (!rule || !Number.isFinite(value) || (rule.integer && !Number.isInteger(value)) || value < rule.min || value > rule.max) {
    node.error("recorder_retention: política inválida " + (key || "campo ausente") + "=" + msg.payload, msg);
    return null;
}
const previous = flow.get("recorder_retention_policy_v2", "persistent");
const policy = previous?.version === 2 ? { ...previous } : { version: 2, owner: "node_red" };
policy[key] = value;
const complete = Object.keys(limits).every((field) => Number.isFinite(policy[field]));
if (complete && policy.compactRetentionDays <= policy.rawRetentionDays) {
    node.error("recorder_retention: retenção compacta deve superar a retenção bruta", msg);
    return null;
}
policy.complete = complete;
policy.baselineIntervalMs = Number(policy.baselineIntervalHours || 0) * 3600000;
policy.numericRelativeTolerance = Number(policy.numericRelativeTolerancePercent || 0) / 100;
policy.warmupMs = Number(policy.warmupDays || 0) * 86400000;
policy.updated_at = Date.now();
flow.set("recorder_retention_policy_v2", policy, "persistent");
if (!flow.get("recorder_retention_started_at_v1", "persistent")) {
    flow.set("recorder_retention_started_at_v1", Date.now(), "persistent");
}
node.status({ fill: complete ? "green" : "yellow", shape: complete ? "dot" : "ring", text: complete ? "bruto " + policy.rawRetentionDays + " d | compacto " + policy.compactRetentionDays + " d" : "sincronizando política" });
return null;`;

const compact = `const TEST = msg.test_mode === true;
const STORE = TEST ? undefined : "persistent";
const get = (key) => STORE ? flow.get(key, STORE) : flow.get(key);
const set = (key, value) => STORE ? flow.set(key, value, STORE) : flow.set(key, value);
const config = flow.get("recorder_retention_policy_v2", "persistent");
if (!config || config.complete !== true) {
    node.status({ fill: "red", shape: "ring", text: "configuração ausente" });
    return null;
}
const source = msg.data?.new_state ?? msg.payload?.new_state ?? msg.payload ?? {};
const entityId = String(source.entity_id ?? msg.data?.entity_id ?? msg.entity_id ?? "");
if (!entityId) return null;
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
const set = (key, value) => STORE ? flow.set(key, value, STORE) : flow.set(key, value);
const config = flow.get("recorder_retention_policy_v2", "persistent");
if (!config || config.complete !== true) return null;
const now = Number(msg.testNow ?? Date.now());
const startedAt = Number(get("recorder_retention_started_at_v1") ?? now);
const warmedUp = now >= startedAt + config.warmupMs;
const purgeTargets = Array.isArray(msg.purgeTargets) ? msg.purgeTargets : [];
const actions = purgeTargets
    .filter((target) => target.key === "codex_diagnostics" || warmedUp)
    .map((target) => ({
        key: target.key,
        keep_days: target.key === "codex_diagnostics" ? 0 : config.rawRetentionDays,
        ...(Array.isArray(target.entityId) ? { entity_id: target.entityId } : {}),
        ...(Array.isArray(target.entityGlobs) ? { entity_globs: target.entityGlobs } : {})
    }));
if (!warmedUp && !TEST) node.status({ fill: "blue", shape: "ring", text: "compactando antes do primeiro purge" });
const cycleId = String(now);
if (!TEST) set("recorder_retention_active_cycle_v1", { id: cycleId, phase: "purging", targetKeys: actions.map((action) => action.key) });
const retention = { warmedUp, test_mode: TEST, cycleId, targetKeys: actions.map((action) => action.key), compactRetentionDays: config.compactRetentionDays };
return [{ ...msg, payload: actions, recorderRetention: retention }, { ...msg, recorderRetention: retention }];`;

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

const repackEvaluate = `const TEST = msg.test_mode === true;
const retention = msg.recorderRetention ?? {};
const targets = Array.isArray(retention.targetKeys) ? retention.targetKeys : [];
if (!targets.length) return [null, null, null];
const pending = msg.data?.attributes?.pending_targets;
const state = String(msg.payload ?? "unavailable");
const complete = state === "ready" && Array.isArray(pending) && !targets.some((target) => pending.includes(target));
if (TEST) {
    return [null, null, { ...msg, payload: { simulated: true, dispatched: false, action: "recorder.purge", repack: true, ready: complete } }];
}
if (!complete) {
    node.status({ fill: "blue", shape: "ring", text: "aguardando fila de purge" });
    return [null, msg, null];
}
const active = flow.get("recorder_retention_active_cycle_v1", "persistent");
if (!active || active.id !== retention.cycleId || active.phase === "repack_queued") return [null, null, null];
flow.set("recorder_retention_active_cycle_v1", { ...active, phase: "repack_queued" }, "persistent");
node.status({ fill: "green", shape: "dot", text: "fila concluída; repack solicitado" });
const keepDays = Number(retention.compactRetentionDays);
if (!Number.isInteger(keepDays)) {
    node.error("recorder_retention: retenção compacta ausente no ciclo", msg);
    return [null, null, null];
}
return [{ ...msg, payload: { keep_days: keepDays, repack: true, apply_filter: false } }, null, null];`;

const testReset = `flow.set("recorder_retention_compact_history_v1__test", {}, undefined);
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

const purgeTargets = [
  {
    key: "codex_diagnostics",
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
      "sensor.codex_local_ai_status",
    ],
  },
  { key: "vehicle_refresh", entityId: ["sensor.vehicle_primary_refresh_coordinator"] },
  { key: "zigbee_diagnostics", entityId: ["sensor.zigbee_network_state", "binary_sensor.zigbee_network"] },
  { key: "raspberry_pi_health", entityGlobs: ["sensor.raspberry_pi_*", "binary_sensor.raspberry_pi_*"] },
  { key: "tuya_diagnostics", entityId: ["sensor.tuya_devices_state", "binary_sensor.tuya_devices"] },
  { key: "internet_diagnostics", entityId: ["sensor.internet_connection_state", "binary_sensor.internet_connection"] },
];

const policyInject = (id, name, topic, payload, x, y) => ({
  id, type: "inject", z: TAB, g: "recorder_retention_group_config", name,
  props: [{ p: "payload" }, { p: "topic", vt: "str" }], repeat: "",
  crontab: "", once: true, onceDelay: 0.5, topic, payload: String(payload),
  payloadType: "num", x, y, wires: [["recorder_retention_policy_updates_out"]],
});

const resultTerminal = (id, name, x, y) => ({
  id, type: "debug", z: TAB, g: "recorder_retention_group_capture", name,
  active: true, tosidebar: false, console: false, tostatus: true,
  complete: "payload", targetType: "msg", statusVal: "payload.kind",
  statusType: "msg", x, y, wires: [],
});

const nodes = [
  { id: TAB, type: "tab", label: "recorder_retention", disabled: false, info: "Política visual única: compacta baseline, mudanças e outliers antes do purge suportado. Parâmetros inválidos preservam a última configuração válida; TESTE termina em dry-run." },
  { id: "recorder_retention_group_config", type: "group", z: TAB, name: "0. Política visual — edite os valores", style: { label: true, color: "#7d6ba8" }, nodes: ["recorder_retention_comment", "recorder_retention_policy_raw_days", "recorder_retention_policy_compact_days", "recorder_retention_policy_baseline_hours", "recorder_retention_policy_absolute_tolerance", "recorder_retention_policy_relative_percent", "recorder_retention_policy_mad_multiplier", "recorder_retention_policy_warmup_days", "recorder_retention_policy_updates_out", "recorder_retention_policy_updates_in", "recorder_retention_config"], x: 64, y: 40, w: 1450, h: 300 },
  { id: "recorder_retention_group_capture", type: "group", z: TAB, name: "1. Captura e decisão: baseline, mudança, outlier ou descarte", style: { label: true, color: "#3fadb5" }, nodes: ["recorder_retention_changes", "recorder_retention_test_compact_in", "recorder_retention_compact", "recorder_retention_result_switch", "recorder_retention_test_output_gate", "recorder_retention_test_result_out", "recorder_retention_baseline_terminal", "recorder_retention_change_terminal", "recorder_retention_outlier_terminal", "recorder_retention_discard_terminal"], x: 64, y: 359, w: 1662, h: 202 },
  { id: "recorder_retention_group_execution", type: "group", z: TAB, name: "2. Alvos visíveis, purge serial e repack após a fila", style: { label: true, color: "#4d9a6a" }, nodes: ["recorder_retention_schedule", "recorder_retention_cycle_marker", "recorder_retention_plan_targets", "recorder_retention_plan", "recorder_retention_split", "recorder_retention_dispatch_guard", "recorder_retention_rate_limit", "recorder_retention_purge", "recorder_retention_repack_delay", "recorder_retention_repack_status", "recorder_retention_repack_evaluate", "recorder_retention_repack", "recorder_retention_repack_retry_out", "recorder_retention_repack_delay_in", "recorder_retention_repack_test_in", "recorder_retention_guard_dry_out", "recorder_retention_repack_dry_out"], x: 64, y: 579, w: 2180, h: 202 },
  { id: "recorder_retention_group_tests", type: "group", z: TAB, name: "3. Testes manuais completos — dry-run", style: { label: true, color: "#c9b458" }, nodes: ["recorder_retention_test_instructions", "recorder_retention_test_reset", "recorder_retention_test_reset_state", "recorder_retention_test_baseline", "recorder_retention_test_near", "recorder_retention_test_outlier", "recorder_retention_test_repack_ready", "recorder_retention_test_repack_out", "recorder_retention_test_prepare", "recorder_retention_test_compact_out", "recorder_retention_test_result_in", "recorder_retention_test_finalize", "recorder_retention_dry_run_in", "recorder_retention_dry_run_terminal"], x: 64, y: 799, w: 1662, h: 302 },
  { id: "recorder_retention_comment", type: "comment", z: TAB, g: "recorder_retention_group_config", name: "Inválido não substitui a política persistente. Agenda, serialização e espera ficam nos nós nativos abaixo.", info: "Limites: bruto 1–14 d; compacto 7–180 d; baseline 1–24 h; tolerâncias 0,1–10; MAD 1–10; aquecimento 0–14 d. Compacto deve superar bruto.", x: 760, y: 80, wires: [] },
  policyInject("recorder_retention_policy_raw_days", "Retenção bruta — 2 dias", "rawRetentionDays", 2, 300, 140),
  policyInject("recorder_retention_policy_compact_days", "Retenção compacta — 30 dias", "compactRetentionDays", 30, 300, 190),
  policyInject("recorder_retention_policy_baseline_hours", "Intervalo baseline — 6 h", "baselineIntervalHours", 6, 300, 240),
  policyInject("recorder_retention_policy_absolute_tolerance", "Tolerância absoluta — 0,5", "numericAbsoluteTolerance", 0.5, 300, 290),
  policyInject("recorder_retention_policy_relative_percent", "Tolerância relativa — 1 %", "numericRelativeTolerancePercent", 1, 600, 140),
  policyInject("recorder_retention_policy_mad_multiplier", "Multiplicador MAD — 3", "madMultiplier", 3, 600, 200),
  policyInject("recorder_retention_policy_warmup_days", "Aquecimento — 2 dias", "warmupDays", 2, 600, 260),
  { id: "recorder_retention_policy_updates_out", type: "link out", z: TAB, g: "recorder_retention_group_config", name: "Valor editado → validador", mode: "link", links: ["recorder_retention_policy_updates_in"], x: 790, y: 220, wires: [] },
  { id: "recorder_retention_policy_updates_in", type: "link in", z: TAB, g: "recorder_retention_group_config", name: "Receber valor de política", links: ["recorder_retention_policy_updates_out"], x: 980, y: 220, wires: [["recorder_retention_config"]] },
  functionNode("recorder_retention_config", "recorder_retention_group_config", "Validar e preservar política única", configuration, 0, 1260, 220, []),
  { id: "recorder_retention_changes", type: "server-state-changed", z: TAB, g: "recorder_retention_group_capture", name: "Observar entidades de alta frequência", server: SERVER, version: 6, outputs: 1, exposeAsEntityConfig: "", entities: { entity: ["sensor.vehicle_primary_refresh_coordinator", "sensor.zigbee_network_state", "binary_sensor.zigbee_network", "sensor.tuya_devices_state", "binary_sensor.tuya_devices", "sensor.internet_connection_state", "binary_sensor.internet_connection", "sensor.raspberry_pi_metrics_raw", "sensor.raspberry_pi_health", "sensor.raspberry_pi_cpu_temperature", "sensor.raspberry_pi_cpu_usage", "sensor.raspberry_pi_cpu_frequency", "sensor.raspberry_pi_load_1m", "sensor.raspberry_pi_load_5m", "sensor.raspberry_pi_load_15m", "sensor.raspberry_pi_memory_usage", "sensor.raspberry_pi_memory_used", "sensor.raspberry_pi_memory_available", "sensor.raspberry_pi_swap_usage", "sensor.raspberry_pi_swap_used", "sensor.raspberry_pi_storage_usage", "sensor.raspberry_pi_storage_used", "sensor.raspberry_pi_storage_free", "sensor.raspberry_pi_storage_inodes_usage", "sensor.raspberry_pi_uptime", "sensor.raspberry_pi_network_rx", "sensor.raspberry_pi_network_tx"], substring: [], regex: [] }, outputInitially: false, stateType: "str", ifState: "", ifStateType: "str", ifStateOperator: "is", outputOnlyOnStateChange: false, for: "0", forType: "num", forUnits: "minutes", ignorePrevStateNull: false, ignorePrevStateUnknown: false, ignorePrevStateUnavailable: false, ignoreCurrentStateUnknown: true, ignoreCurrentStateUnavailable: true, outputProperties: [], x: 270, y: 460, wires: [["recorder_retention_compact"]] },
  { id: "recorder_retention_test_compact_in", type: "link in", z: TAB, g: "recorder_retention_group_capture", name: "Receber amostra TESTE", links: ["recorder_retention_test_compact_out"], x: 430, y: 530, wires: [["recorder_retention_compact"]] },
  functionNode("recorder_retention_compact", "recorder_retention_group_capture", "Calcular tolerância e classificar", compact, 1, 650, 460, [["recorder_retention_result_switch"]]),
  { id: "recorder_retention_result_switch", type: "switch", z: TAB, g: "recorder_retention_group_capture", name: "Decisão: baseline, mudança, outlier ou descarte?", property: "payload.kind", propertyType: "msg", rules: [{ t: "eq", v: "baseline", vt: "str" }, { t: "eq", v: "change", vt: "str" }, { t: "eq", v: "outlier", vt: "str" }, { t: "else" }], checkall: "true", repair: false, outputs: 4, x: 980, y: 460, wires: [["recorder_retention_baseline_terminal", "recorder_retention_test_output_gate"], ["recorder_retention_change_terminal", "recorder_retention_test_output_gate"], ["recorder_retention_outlier_terminal", "recorder_retention_test_output_gate"], ["recorder_retention_discard_terminal", "recorder_retention_test_output_gate"]] },
  { id: "recorder_retention_test_output_gate", type: "switch", z: TAB, g: "recorder_retention_group_capture", name: "Resultado pertence a TESTE?", property: "test_mode", propertyType: "msg", rules: [{ t: "true" }], checkall: "true", repair: false, outputs: 1, x: 1030, y: 540, wires: [["recorder_retention_test_result_out"]] },
  { id: "recorder_retention_test_result_out", type: "link out", z: TAB, g: "recorder_retention_group_capture", name: "Decisão TESTE → terminal", mode: "link", links: ["recorder_retention_test_result_in"], x: 1510, y: 540, wires: [] },
  resultTerminal("recorder_retention_baseline_terminal", "Estado: baseline preservado", 1320, 400),
  resultTerminal("recorder_retention_change_terminal", "Estado: mudança preservada", 1320, 440),
  resultTerminal("recorder_retention_outlier_terminal", "Estado: outlier preservado", 1320, 480),
  resultTerminal("recorder_retention_discard_terminal", "Estado: valor próximo descartado", 1320, 520),
  { id: "recorder_retention_schedule", type: "inject", z: TAB, g: "recorder_retention_group_execution", name: "Agenda visível — diariamente 01:15", info: "A janela começa após as atualizações da meia-noite e termina antes do backup nativo do Home Assistant, agendado entre 04:45 e 05:45.", props: [{ p: "payload" }], repeat: "", crontab: "15 01 * * *", once: false, onceDelay: "0.1", topic: "", payload: "", payloadType: "date", x: 220, y: 620, wires: [["recorder_retention_cycle_marker"]] },
  { id: "recorder_retention_cycle_marker", type: "api-call-service", z: TAB, g: "recorder_retention_group_execution", name: "Marcar início imutável do ciclo", server: SERVER, version: 7, debugenabled: false, action: "input_number.set_value", floorId: [], areaId: [], deviceId: [], entityId: ["input_number.recorder_retention_cycle_started_at"], labelId: [], data: "{\"value\": $floor($millis() / 1000)}", dataType: "jsonata", mergeContext: "", mustacheAltTags: false, outputProperties: [], queue: "none", blockInputOverrides: true, domain: "input_number", service: "set_value", x: 500, y: 620, wires: [["recorder_retention_plan_targets"]] },
  { id: "recorder_retention_plan_targets", type: "change", z: TAB, g: "recorder_retention_group_execution", name: "Alvos canônicos de retenção", rules: [{ t: "set", p: "purgeTargets", pt: "msg", to: JSON.stringify(purgeTargets), tot: "json" }], x: 760, y: 620, wires: [["recorder_retention_plan"]] },
  functionNode("recorder_retention_plan", "recorder_retention_group_execution", "Calcular aquecimento e plano", planPurge, 2, 1040, 620, [["recorder_retention_split"], ["recorder_retention_repack_delay"]]),
  { id: "recorder_retention_split", type: "split", z: TAB, g: "recorder_retention_group_execution", name: "Uma política por vez", splt: "\\n", spltType: "str", arraySplt: 1, arraySpltType: "len", stream: false, addname: "", property: "payload", x: 1260, y: 620, wires: [["recorder_retention_dispatch_guard"]] },
  functionNode("recorder_retention_dispatch_guard", "recorder_retention_group_execution", "Gate de dispatch / dry-run", dispatchGuard, 2, 1500, 620, [["recorder_retention_rate_limit"], ["recorder_retention_guard_dry_out"]]),
  { id: "recorder_retention_rate_limit", type: "delay", z: TAB, g: "recorder_retention_group_execution", name: "Serializar: 1 purge a cada 2 min", pauseType: "rate", timeout: "5", timeoutUnits: "seconds", rate: "1", nbRateUnits: "2", rateUnits: "minute", randomFirst: "1", randomLast: "5", randomUnits: "seconds", drop: false, allowrate: false, outputs: 1, x: 1780, y: 620, wires: [["recorder_retention_purge"]] },
  { id: "recorder_retention_purge", type: "api-call-service", z: TAB, g: "recorder_retention_group_execution", name: "EFEITO: purge seletivo do Recorder", server: SERVER, version: 7, debugenabled: false, action: "recorder.purge_entities", floorId: [], areaId: [], deviceId: [], entityId: [], labelId: [], data: "payload", dataType: "jsonata", mergeContext: "", mustacheAltTags: false, outputProperties: [], queue: "none", blockInputOverrides: true, domain: "recorder", service: "purge_entities", x: 2080, y: 620, wires: [[]] },
  { id: "recorder_retention_repack_delay", type: "delay", z: TAB, g: "recorder_retention_group_execution", name: "Aguardar 5 min e confirmar fila", pauseType: "delay", timeout: "5", timeoutUnits: "minutes", rate: "1", nbRateUnits: "1", rateUnits: "second", randomFirst: "1", randomLast: "5", randomUnits: "seconds", drop: false, allowrate: false, outputs: 1, x: 950, y: 720, wires: [["recorder_retention_repack_status"]] },
  { id: "recorder_retention_repack_status", type: "api-current-state", z: TAB, g: "recorder_retention_group_execution", name: "Confirmar fila de purge no Recorder", server: SERVER, version: 3, outputs: 1, halt_if: "", halt_if_type: "str", halt_if_compare: "is", entity_id: "sensor.recorder_retention_purge_ready", state_type: "str", blockInputOverrides: true, outputProperties: [{ property: "payload", propertyType: "msg", value: "", valueType: "entityState" }, { property: "data", propertyType: "msg", value: "", valueType: "entity" }], for: "0", forType: "num", forUnits: "minutes", override_topic: false, state_location: "payload", override_payload: "msg", entity_location: "data", override_data: "msg", x: 1250, y: 720, wires: [["recorder_retention_repack_evaluate"]] },
  functionNode("recorder_retention_repack_evaluate", "recorder_retention_group_execution", "Fila concluída libera repack?", repackEvaluate, 3, 1510, 720, [["recorder_retention_repack"], ["recorder_retention_repack_retry_out"], ["recorder_retention_repack_dry_out"]]),
  { id: "recorder_retention_repack", type: "api-call-service", z: TAB, g: "recorder_retention_group_execution", name: "EFEITO: repack após a fila", server: SERVER, version: 7, debugenabled: false, action: "recorder.purge", floorId: [], areaId: [], deviceId: [], entityId: [], labelId: [], data: "payload", dataType: "jsonata", mergeContext: "", mustacheAltTags: false, outputProperties: [], queue: "all", blockInputOverrides: true, domain: "recorder", service: "purge", x: 1750, y: 720, wires: [[]] },
  { id: "recorder_retention_repack_retry_out", type: "link out", z: TAB, g: "recorder_retention_group_execution", name: "Reverificar em 5 min", mode: "link", links: ["recorder_retention_repack_delay_in"], x: 1680, y: 670, wires: [] },
  { id: "recorder_retention_repack_delay_in", type: "link in", z: TAB, g: "recorder_retention_group_execution", name: "Retorno para espera", links: ["recorder_retention_repack_retry_out"], x: 780, y: 720, wires: [["recorder_retention_repack_delay"]] },
  { id: "recorder_retention_repack_test_in", type: "link in", z: TAB, g: "recorder_retention_group_execution", name: "Teste de fila pronta", links: ["recorder_retention_test_repack_out"], x: 1280, y: 760, wires: [["recorder_retention_repack_evaluate"]] },
  { id: "recorder_retention_guard_dry_out", type: "link out", z: TAB, g: "recorder_retention_group_execution", name: "Dry-run de purge", mode: "link", links: ["recorder_retention_dry_run_in"], x: 1400, y: 670, wires: [] },
  { id: "recorder_retention_repack_dry_out", type: "link out", z: TAB, g: "recorder_retention_group_execution", name: "Dry-run de repack", mode: "link", links: ["recorder_retention_dry_run_in"], x: 1700, y: 760, wires: [] },
  { id: "recorder_retention_test_instructions", type: "comment", z: TAB, g: "recorder_retention_group_tests", name: "Ordem: 1 Reset; 2 Baseline; 3 Próximo; 4 Outlier; 5 Repack. Todos os testes terminam em dry-run, sem serviço no Home Assistant.", info: "", x: 650, y: 820, wires: [] },
  { id: "recorder_retention_test_reset", type: "inject", z: TAB, g: "recorder_retention_group_tests", name: "TESTE 1: reset", props: [{ p: "payload" }], repeat: "", crontab: "", once: false, onceDelay: 0.1, topic: "", payload: "", payloadType: "date", x: 200, y: 890, wires: [["recorder_retention_test_reset_state"]] },
  functionNode("recorder_retention_test_reset_state", "recorder_retention_group_tests", "Resetar estado sintético", testReset, 0, 450, 890, []),
  { id: "recorder_retention_test_baseline", type: "inject", z: TAB, g: "recorder_retention_group_tests", name: "TESTE 2: baseline 40", props: [{ p: "payload" }], repeat: "", crontab: "", once: false, onceDelay: 0.1, topic: "", payload: "baseline", payloadType: "str", x: 210, y: 950, wires: [["recorder_retention_test_prepare"]] },
  { id: "recorder_retention_test_near", type: "inject", z: TAB, g: "recorder_retention_group_tests", name: "TESTE 3: próximo 40,2", props: [{ p: "payload" }], repeat: "", crontab: "", once: false, onceDelay: 0.1, topic: "", payload: "near", payloadType: "str", x: 220, y: 1000, wires: [["recorder_retention_test_prepare"]] },
  { id: "recorder_retention_test_outlier", type: "inject", z: TAB, g: "recorder_retention_group_tests", name: "TESTE 4: outlier 87", props: [{ p: "payload" }], repeat: "", crontab: "", once: false, onceDelay: 0.1, topic: "", payload: "outlier", payloadType: "str", x: 210, y: 1050, wires: [["recorder_retention_test_prepare"]] },
  { id: "recorder_retention_test_repack_ready", type: "inject", z: TAB, g: "recorder_retention_group_tests", name: "TESTE 5: repack com fila pronta", props: [{ p: "payload", v: "ready", vt: "str" }, { p: "test_mode", v: "true", vt: "bool" }, { p: "recorderRetention", v: "{\"targetKeys\":[\"codex_diagnostics\"]}", vt: "json" }, { p: "data", v: "{\"attributes\":{\"pending_targets\":[]}}", vt: "json" }], repeat: "", crontab: "", once: false, onceDelay: 0.1, topic: "", payload: "ready", payloadType: "str", x: 700, y: 1070, wires: [["recorder_retention_test_repack_out"]] },
  { id: "recorder_retention_test_repack_out", type: "link out", z: TAB, g: "recorder_retention_group_tests", name: "Enviar teste ao gate", mode: "link", links: ["recorder_retention_repack_test_in"], x: 950, y: 1070, wires: [] },
  functionNode("recorder_retention_test_prepare", "recorder_retention_group_tests", "Preparar estado sintético", testPrepare, 1, 500, 990, [["recorder_retention_test_compact_out"]]),
  { id: "recorder_retention_test_compact_out", type: "link out", z: TAB, g: "recorder_retention_group_tests", name: "Amostra TESTE → cálculo real", mode: "link", links: ["recorder_retention_test_compact_in"], x: 730, y: 990, wires: [] },
  { id: "recorder_retention_test_result_in", type: "link in", z: TAB, g: "recorder_retention_group_tests", name: "Receber decisão TESTE", links: ["recorder_retention_test_result_out"], x: 850, y: 930, wires: [["recorder_retention_test_finalize"]] },
  functionNode("recorder_retention_test_finalize", "recorder_retention_group_tests", "Normalizar resultado simulado", testFinalize, 1, 1050, 930, [["recorder_retention_dry_run_in"]]),
  { id: "recorder_retention_dry_run_in", type: "link in", z: TAB, g: "recorder_retention_group_tests", name: "Receber resultado simulado", links: ["recorder_retention_guard_dry_out", "recorder_retention_repack_dry_out"], x: 1285, y: 990, wires: [["recorder_retention_dry_run_terminal"]] },
  functionNode("recorder_retention_dry_run_terminal", "recorder_retention_group_tests", "TESTE FINAL: nenhum efeito despachado", dryRun, 0, 1500, 990, []),
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
