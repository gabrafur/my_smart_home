#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { installNotificationHubs } from "./install-notification-hubs.mjs";

const FLOWS = new URL("../flows.json", import.meta.url).pathname;
const OUT = process.argv[2] || FLOWS;
const TAB = "codex_alertas_tab";
const HA = "4126427d5e161a03";
const flows = JSON.parse(readFileSync(FLOWS, "utf8"));

function upsert(value) {
  const index = flows.findIndex((candidate) => candidate.id === value.id);
  if (index === -1) flows.push(value);
  else flows[index] = value;
}

function removeTab() {
  for (let index = flows.length - 1; index >= 0; index -= 1) {
    const item = flows[index];
    if (item.id === TAB || (item.z === TAB && !item.id.startsWith("global_observer_coverage__"))) {
      flows.splice(index, 1);
    }
  }
}

function n(id, type, group, name, x, y, wires, extra = {}) {
  return { id, type, z: TAB, g: group, name, x, y, wires, ...extra };
}

function fn(id, group, name, func, x, y, wires, outputs = 1) {
  return n(id, "function", group, name, x, y, wires, {
    func, outputs, timeout: 0, noerr: 0, initialize: "", finalize: "", libs: [],
  });
}

function inject(id, group, name, topic, payload, payloadType, x, y, wires, options = {}) {
  return n(id, "inject", group, name, x, y, wires, {
    props: [{ p: "payload" }, ...(topic ? [{ p: "topic", vt: "str" }] : [])],
    repeat: options.repeat ?? "", crontab: options.crontab ?? "",
    once: options.once ?? false, onceDelay: options.once ? 0.5 : 0.1,
    topic, payload: String(payload), payloadType,
  });
}

function group(id, name, nodes, x, y, w, h, stroke, fill) {
  return {
    id, type: "group", z: TAB, name, nodes, x, y, w, h,
    style: {
      label: true, "label-position": "nw", stroke, "stroke-opacity": "1",
      fill, "fill-opacity": "0.35", color: "#1f2937",
    },
  };
}

function change(id, groupId, name, rules, x, y, wires) {
  return n(id, "change", groupId, name, x, y, wires, {
    rules, action: "", property: "", from: "", to: "", reg: false,
  });
}

function sw(id, groupId, name, property, rules, x, y, wires) {
  return n(id, "switch", groupId, name, x, y, wires, {
    property, propertyType: "msg", rules, checkall: "true", repair: false,
    outputs: rules.length,
  });
}

function linkIn(id, groupId, name, links, x, y, wires) {
  return n(id, "link in", groupId, name, x, y, wires, { links });
}

function linkOut(id, groupId, name, links, x, y) {
  return n(id, "link out", groupId, name, x, y, [], { mode: "link", links });
}

function service(id, groupId, name, action, data, dataType, x, y, wires) {
  const [domain, api] = action.split(".");
  return n(id, "api-call-service", groupId, name, x, y, wires, {
    server: HA, version: 7, debugenabled: false, action,
    floorId: [], areaId: [], deviceId: [], entityId: [], labelId: [],
    data, dataType, mergeContext: "", mustacheAltTags: false,
    outputProperties: [], queue: "all", blockInputOverrides: true,
    domain, service: api,
  });
}

const monitored = [
  "input_boolean.codex_alertas_iphone",
  "input_boolean.codex_resumo_diario_iphone",
  "sensor.codex_dados_de_limite",
  "sensor.codex_previsao_ate_o_reset",
  "sensor.codex_limite_usado",
  "sensor.codex_eficiencia_de_cache",
  "sensor.codex_creditos_extras",
  "sensor.codex_uso_projetado_no_reset",
  "sensor.codex_folga_projetada_no_reset",
  "sensor.codex_ritmo_do_limite",
  "sensor.codex_limite_disponivel",
  "sensor.codex_proximo_reset",
];

const policyValidate = String.raw`const limits = {
    warning_usage_percent: { min: 10, max: 95 },
    critical_usage_percent: { min: 20, max: 100 },
    minimum_cache_percent: { min: 0, max: 100 },
    minimum_extra_credits: { min: 1, max: 100 },
    critical_cooldown_hours: { min: 1, max: 24 },
    standard_cooldown_hours: { min: 1, max: 48 },
    retry_seconds: { min: 10, max: 600 }
};
const key = String(msg.topic ?? "");
const rule = limits[key];
const value = Number(msg.payload);
if (!rule || !Number.isInteger(value) || value < rule.min || value > rule.max) {
    node.error("Política Codex inválida: " + (key || "campo ausente") + "=" + msg.payload, msg);
    return null;
}
const previous = flow.get("codex_alert_policy_v1", "persistent");
const candidate = previous?.version === 1 ? { ...previous } : { version: 1, owner: "node_red" };
candidate[key] = value;
const complete = Object.keys(limits).every((field) => Number.isFinite(candidate[field]));
if (complete && candidate.warning_usage_percent >= candidate.critical_usage_percent) {
    node.error("Política Codex inválida: aviso deve ser menor que crítico", msg);
    return null;
}
candidate.complete = complete;
candidate.updated_at = Date.now();
flow.set("codex_alert_policy_v1", candidate, "persistent");
node.status({ fill: complete ? "green" : "yellow", shape: complete ? "dot" : "ring", text: complete ? "uso " + candidate.warning_usage_percent + "/" + candidate.critical_usage_percent + "%" : "sincronizando" });
return null;`;

const accumulate = String.raw`const REQUIRED = ${JSON.stringify(monitored)};
const testMode = msg.test_mode === true || msg.payload?.test_mode === true;
const key = testMode ? "codex_alert_test_state_v2" : "codex_alertas_state_v3";
let state = flow.get(key, "persistent");
if (!state || typeof state !== "object") {
    const legacy = testMode
        ? flow.get("codex_alert_test_state_v1", "persistent")
        : flow.get("codex_alertas_state_v2", "persistent");
    const values = legacy?.values && typeof legacy.values === "object" ? { ...legacy.values } : {};
    const valid = (value) => !["", "unknown", "unavailable", "none", "null"].includes(String(value ?? "").trim().toLowerCase());
    state = {
        values,
        last_valid_values: Object.fromEntries(Object.entries(values).filter(([, value]) => valid(value))),
        ready: legacy?.ready === true,
        sequence: Number(legacy?.sequence) || 0,
        migrated_from: legacy ? (testMode ? "v1" : "v2") : null
    };
}
state.values = state.values && typeof state.values === "object" ? state.values : {};
state.last_valid_values = state.last_valid_values && typeof state.last_valid_values === "object" ? state.last_valid_values : {};
const event = msg.payload && typeof msg.payload === "object" ? msg.payload : {};
const entity = String(event.entity_id ?? "");
let previous = entity ? state.last_valid_values[entity] : undefined;
if (entity && REQUIRED.includes(entity)) {
    const current = String(event.state ?? "");
    const currentIsValid = !["", "unknown", "unavailable", "none", "null"].includes(current.trim().toLowerCase());
    state.values[entity] = current;
    if (currentIsValid) {
        if (!Object.prototype.hasOwnProperty.call(state.last_valid_values, entity)) previous = current;
        state.last_valid_values[entity] = current;
    }
}
state.ready = REQUIRED.every((id) => Object.prototype.hasOwnProperty.call(state.values, id));
state.sequence += 1;
flow.set(key, state, "persistent");
msg.test_mode = testMode;
msg.request_type = msg.topic === "codex.daily_summary" ? "daily" : event.type === "manual_test" ? "manual_test" : "entity";
msg.snapshot = {
    values: { ...state.values }, ready: state.ready, sequence: state.sequence,
    entity_id: entity, current: entity ? state.values[entity] : "", previous,
    alerts_enabled: state.values["input_boolean.codex_alertas_iphone"] === "on",
    summary_enabled: state.values["input_boolean.codex_resumo_diario_iphone"] === "on"
};
node.status({ fill: state.ready ? "green" : "yellow", shape: "dot", text: state.ready ? "snapshot canônico" : "sincronizando fontes" });
return msg;`;

const forecastDecision = String.raw`const current = String(msg.snapshot?.current ?? "");
const previous = String(msg.snapshot?.previous ?? "");
msg.decision = { kind: "", reason: "no_transition" };
if (current !== previous) {
    if (current === "não aguenta" && ["aguenta", "atenção"].includes(previous)) msg.decision = { kind: "forecast_critical", reason: "forecast_risk" };
    else if (current === "atenção" && previous === "aguenta") msg.decision = { kind: "forecast_warning", reason: "forecast_attention" };
    else if (current === "aguenta" && ["atenção", "não aguenta"].includes(previous)) msg.decision = { kind: "recovery", reason: "forecast_recovered" };
}
return msg;`;

const usageDecision = String.raw`const current = Number(msg.snapshot?.current);
const previous = Number(msg.snapshot?.previous);
msg.decision = { kind: "", reason: "no_threshold_crossing" };
if (!Number.isFinite(current) || !Number.isFinite(previous)) return msg;
if (current >= msg.policy.critical_usage_percent && previous < msg.policy.critical_usage_percent) msg.decision = { kind: "critical", reason: "critical_usage_crossed" };
else if (current >= msg.policy.warning_usage_percent && previous < msg.policy.warning_usage_percent) msg.decision = { kind: "usage_warning", reason: "warning_usage_crossed" };
return msg;`;

const cacheDecision = String.raw`const current = Number(msg.snapshot?.current);
const previous = Number(msg.snapshot?.previous);
const crossed = Number.isFinite(current) && Number.isFinite(previous) && current < msg.policy.minimum_cache_percent && previous >= msg.policy.minimum_cache_percent;
msg.decision = crossed ? { kind: "cache_low", reason: "cache_minimum_crossed" } : { kind: "", reason: "no_threshold_crossing" };
return msg;`;

const creditsDecision = String.raw`const current = Number(msg.snapshot?.current);
const previous = Number(msg.snapshot?.previous);
const crossed = Number.isFinite(current) && Number.isFinite(previous) && current < msg.policy.minimum_extra_credits && previous >= msg.policy.minimum_extra_credits;
msg.decision = crossed ? { kind: "credits_low", reason: "credits_minimum_crossed" } : { kind: "", reason: "no_threshold_crossing" };
return msg;`;

const buildAlert = String.raw`const values = msg.snapshot?.values || {};
const kind = msg.decision?.kind;
const now = msg.test_mode === true && Number.isFinite(Number(msg._test_now_ms)) ? Number(msg._test_now_ms) : Date.now();
const table = {
    critical: ["Codex — limite crítico", "🚨 Uso chegou a " + (values["sensor.codex_limite_usado"] || "?") + "%. Restam " + (values["sensor.codex_limite_disponivel"] || "?") + "% até o reset."],
    forecast_critical: ["Codex — ritmo pode esgotar o limite", "⚠️ Projeção de ritmo: uso atual " + (values["sensor.codex_limite_usado"] || "?") + "%, ritmo " + (values["sensor.codex_ritmo_do_limite"] || "?") + "%/dia e projeção " + (values["sensor.codex_uso_projetado_no_reset"] || "?") + "% no reset."],
    forecast_warning: ["Codex — pouca folga até o reset", "⚠️ Ritmo atual: " + (values["sensor.codex_ritmo_do_limite"] || "?") + "%/dia. Uso projetado: " + (values["sensor.codex_uso_projetado_no_reset"] || "?") + "%."],
    recovery: ["Codex — autonomia recuperada", "✅ O ritmo voltou a ser sustentável até o reset. Folga projetada: " + (values["sensor.codex_folga_projetada_no_reset"] || "?") + "%."],
    usage_warning: ["Codex — limite em atenção", "⚠️ Uso chegou a " + (values["sensor.codex_limite_usado"] || "?") + "%. Folga projetada: " + (values["sensor.codex_folga_projetada_no_reset"] || "?") + "%."],
    cache_low: ["Codex — eficiência de cache baixa", "⚠️ A eficiência caiu para " + (values["sensor.codex_eficiencia_de_cache"] || "?") + "%. Limite: " + msg.policy.minimum_cache_percent + "%."],
    credits_low: ["Codex — créditos extras baixos", "⚠️ O saldo caiu para " + (values["sensor.codex_creditos_extras"] || "?") + " créditos."],
    daily: ["Codex — resumo diário", "Uso: " + (values["sensor.codex_limite_usado"] || "?") + "%; projeção: " + (values["sensor.codex_uso_projetado_no_reset"] || "?") + "%; folga: " + (values["sensor.codex_folga_projetada_no_reset"] || "?") + "%; cache: " + (values["sensor.codex_eficiencia_de_cache"] || "?") + "%."],
    test: ["Codex — TESTE de alertas", "TESTE: rota canônica pronta; nenhum aviso será enviado."]
};
const content = table[kind];
if (!content) return null;
msg.alert = { title: content[0], message: content[1], kind, at: new Date(now).toISOString(), deliveryAck: { id: kind + ":" + now, kind, at: now } };
return msg;`;

const deliveryEvaluate = String.raw`const policy = msg.policy;
if (policy?.version !== 1 || policy?.complete !== true || !msg.alert) {
    node.error("Alerta Codex sem política ou candidato válido", msg);
    return null;
}
const testMode = msg.test_mode === true;
const key = testMode ? "codex_alert_delivery_test_v1" : "codex_alert_delivery_v1";
let state = flow.get(key, "persistent");
if (!state || typeof state !== "object") {
    const legacy = testMode ? null : flow.get("codex_alertas_state_v1", "persistent");
    state = { sent: legacy?.sent || {}, pending: legacy?.pending || null, migrated_from_legacy: !testMode };
}
const now = Number(msg.alert.deliveryAck.at);
const hours = msg.alert.kind === "critical" ? policy.critical_cooldown_hours : policy.standard_cooldown_hours;
const elapsed = now - Number(state.sent?.[msg.alert.kind] || 0);
const pendingAge = now - Number(state.pending?.lastAttemptAt || 0);
let allowed = elapsed >= hours * 3600000;
let reason = allowed ? "cooldown_elapsed" : "cooldown_active";
if (allowed && state.pending?.kind === msg.alert.kind && pendingAge < policy.retry_seconds * 1000) {
    allowed = false;
    reason = "delivery_pending";
}
if (allowed) {
    msg.alert.lastAttemptAt = now;
    state.pending = msg.alert;
}
state.last_candidate_sequence = msg.snapshot?.sequence ?? null;
flow.set(key, state, "persistent");
msg.delivery = { allowed, reason, elapsed_ms: elapsed, cooldown_ms: hours * 3600000 };
return msg;`;

const pendingCheck = String.raw`const policy = msg.policy;
const state = flow.get("codex_alert_delivery_v1", "persistent");
const pending = state?.pending;
if (policy?.complete !== true || !pending) return null;
const now = Date.now();
const due = now - Number(pending.lastAttemptAt || 0) >= policy.retry_seconds * 1000;
msg.alert = pending;
msg.test_mode = false;
msg.delivery = { allowed: due, reason: due ? "pending_retry_due" : "pending_retry_wait" };
if (due) {
    pending.lastAttemptAt = now;
    state.pending = pending;
    flow.set("codex_alert_delivery_v1", state, "persistent");
}
return msg;`;

const alertAck = String.raw`const ack = msg.alert?.deliveryAck;
if (!ack || typeof ack.kind !== "string" || !Number.isFinite(Number(ack.at))) return null;
const state = flow.get("codex_alert_delivery_v1", "persistent") || { sent: {} };
state.sent = state.sent || {};
state.sent[ack.kind] = Number(ack.at);
if (state.pending?.deliveryAck?.id === ack.id) state.pending = null;
flow.set("codex_alert_delivery_v1", state, "persistent");
node.status({ fill: "green", shape: "dot", text: "entrega aceita pelo HA" });
return null;`;

const alertFailure = String.raw`const source = String(msg.error?.source?.name ?? "notificacao").replace(/[^a-zA-Z0-9 _-]/g, "");
const detail = String(msg.error?.message ?? "erro desconhecido").replace(/[\r\n]+/g, " ").slice(0, 240);
node.error("codex_alert_delivery_failed source=" + source + " message=" + detail, msg);
node.status({ fill: "red", shape: "ring", text: "pendente para retry visual" });
return null;`;

const testReset = String.raw`const values = {
    "input_boolean.codex_alertas_iphone": "on",
    "input_boolean.codex_resumo_diario_iphone": "on",
    "sensor.codex_dados_de_limite": "atual",
    "sensor.codex_previsao_ate_o_reset": "aguenta",
    "sensor.codex_limite_usado": "69",
    "sensor.codex_eficiencia_de_cache": "90",
    "sensor.codex_creditos_extras": "100",
    "sensor.codex_uso_projetado_no_reset": "75",
    "sensor.codex_folga_projetada_no_reset": "25",
    "sensor.codex_ritmo_do_limite": "3",
    "sensor.codex_limite_disponivel": "31",
    "sensor.codex_proximo_reset": "2026-08-20T00:00:00Z"
};
flow.set("codex_alert_test_state_v2", { values, last_valid_values: { ...values }, ready: true, sequence: 0 }, "persistent");
flow.set("codex_alert_delivery_test_v1", { sent: {}, pending: null }, "persistent");
node.status({ fill: "blue", shape: "dot", text: "estado TESTE pronto" });
return null;`;

const dryRun = String.raw`msg.payload = {
    simulated: true,
    dispatched: false,
    domain: "codex_alerts",
    level: msg.canonical_level ?? null,
    alert_kind: msg.alert?.kind ?? null,
    reason: msg.delivery?.reason ?? "canonical_level_publish"
};
node.warn("CODEX_ALERT_DRY_RUN " + JSON.stringify(msg.payload));
node.status({ fill: "blue", shape: "ring", text: "TESTE: sem efeito" });
return null;`;

removeTab();
upsert({ id: TAB, type: "tab", label: "alertas_codex", disabled: false, info: "Fonte canônica visual para nível e alertas Codex. Home Assistant e dashboards consomem o nível publicado; TESTE sempre termina em dry-run.", env: [] });

const policyNodes = ["codex_policy_help", "codex_policy_warning", "codex_policy_critical", "codex_policy_cache", "codex_policy_credits", "codex_policy_critical_cd", "codex_policy_standard_cd", "codex_policy_retry", "codex_policy_validate"];
upsert(group("codex_group_policy", "0. PARÂMETROS AJUSTÁVEIS DO CODEX — edite aqui", policyNodes, 64, 40, 760, 440, "#2563eb", "#dbeafe"));
upsert(n("codex_policy_help", "comment", "codex_group_policy", "Duplo clique no parâmetro; inválidos preservam o último valor válido", 430, 80, [], { info: "Uso: aviso 10–95%, crítico 20–100%, aviso < crítico. Cache 0–100%. Créditos 1–100. Cooldowns 1–24/48 h. Retry 10–600 s." }));
for (const item of [
  ["codex_policy_warning", "Limite de aviso do uso — padrão 70 %", "warning_usage_percent", 70, 140],
  ["codex_policy_critical", "Limite crítico do uso — padrão 90 %", "critical_usage_percent", 90, 190],
  ["codex_policy_cache", "Cache mínimo — padrão 60 %", "minimum_cache_percent", 60, 240],
  ["codex_policy_credits", "Créditos mínimos — padrão 10", "minimum_extra_credits", 10, 290],
  ["codex_policy_critical_cd", "Cooldown crítico — padrão 1 h", "critical_cooldown_hours", 1, 340],
  ["codex_policy_standard_cd", "Cooldown padrão — padrão 6 h", "standard_cooldown_hours", 6, 390],
  ["codex_policy_retry", "Retry de entrega — padrão 60 s", "retry_seconds", 60, 440],
]) upsert(inject(item[0], "codex_group_policy", item[1], item[2], item[3], "num", 230, item[4], [["codex_policy_validate"]], { once: true }));
upsert(fn("codex_policy_validate", "codex_group_policy", "Validar e preservar política única", policyValidate, 590, 290, [], 0));

const inputNodes = ["codex_alert_state", "codex_alert_daily", "codex_test_input_in", "codex_alert_logic", "codex_sources_ready", "codex_snapshot_level_out", "codex_snapshot_alert_out"];
upsert(group("codex_group_inputs", "1. Fontes, normalização e snapshot", inputNodes, 864, 40, 1300, 440, "#0f766e", "#ccfbf1"));
upsert(n("codex_alert_state", "server-state-changed", "codex_group_inputs", "Telemetria bruta e habilitações", 1040, 140, [["codex_alert_logic"]], {
  server: HA, version: 6, outputs: 1, exposeAsEntityConfig: "",
  entities: { entity: monitored, substring: [], regex: [] }, outputInitially: true,
  stateType: "str", ifState: "", ifStateType: "str", ifStateOperator: "is",
  outputOnlyOnStateChange: true, for: "0", forType: "num", forUnits: "minutes",
  ignorePrevStateNull: false, ignorePrevStateUnknown: false, ignorePrevStateUnavailable: false,
  ignoreCurrentStateUnknown: false, ignoreCurrentStateUnavailable: false,
  outputProperties: [{ property: "payload", propertyType: "msg", value: '{"entity_id":$entity().entity_id,"state":$entity().state,"previous":$prevEntity().state}', valueType: "jsonata" }],
}));
upsert(inject("codex_alert_daily", "codex_group_inputs", "Resumo diário — 20:00", "codex.daily_summary", "", "date", 1050, 230, [["codex_alert_logic"]], { crontab: "00 20 * * *" }));
upsert(linkIn("codex_test_input_in", "codex_group_inputs", "Receber evento TESTE", ["codex_test_event_out"], 940, 330, [["codex_alert_logic"]]));
upsert(fn("codex_alert_logic", "codex_group_inputs", "Acumular snapshot (sem política)", accumulate, 1390, 200, [["codex_sources_ready"]]));
upsert(sw("codex_sources_ready", "codex_group_inputs", "Todas as fontes foram observadas?", "snapshot.ready", [{ t: "eq", v: "true", vt: "bool" }, { t: "else" }], 1690, 200, [["codex_snapshot_level_out", "codex_snapshot_alert_out"], []]));
upsert(linkOut("codex_snapshot_level_out", "codex_group_inputs", "Snapshot pronto → nível canônico", ["codex_level_in"], 1990, 170));
upsert(linkOut("codex_snapshot_alert_out", "codex_group_inputs", "Snapshot pronto → decisões de alerta", ["codex_alert_decision_in"], 1990, 230));

const levelNodes = ["codex_level_in", "codex_level_policy", "codex_level_data_current", "codex_level_no_data", "codex_level_critical", "codex_level_set_critical", "codex_level_warning", "codex_level_set_warning", "codex_level_set_normal", "codex_level_effect_out"];
upsert(group("codex_group_level", "2. Decisão do nível canônico", levelNodes, 64, 500, 1200, 260, "#7c3aed", "#ede9fe"));
upsert(linkIn("codex_level_in", "codex_group_level", "Receber snapshot", ["codex_snapshot_level_out"], 110, 590, [["codex_level_policy"]]));
upsert(change("codex_level_policy", "codex_group_level", "Carregar política visual", [{ t: "set", p: "policy", pt: "msg", to: '$flowContext("codex_alert_policy_v1", "persistent")', tot: "jsonata" }], 310, 590, [["codex_level_data_current"]]));
upsert(sw("codex_level_data_current", "codex_group_level", "Dados do limite estão atuais?", 'snapshot.values["sensor.codex_dados_de_limite"]', [{ t: "eq", v: "atual", vt: "str" }, { t: "else" }], 560, 590, [["codex_level_critical"], ["codex_level_no_data"]]));
upsert(change("codex_level_no_data", "codex_group_level", "Nível: sem dados atuais", [{ t: "set", p: "canonical_level", pt: "msg", to: "sem dados atuais", tot: "str" }], 820, 550, [["codex_level_effect_out"]]));
upsert(sw("codex_level_critical", "codex_group_level", "Uso atingiu nível crítico?", 'snapshot.values["sensor.codex_limite_usado"]', [{ t: "gte", v: "policy.critical_usage_percent", vt: "msg" }, { t: "else" }], 820, 610, [["codex_level_set_critical"], ["codex_level_warning"]]));
upsert(change("codex_level_set_critical", "codex_group_level", "Nível: crítico", [{ t: "set", p: "canonical_level", pt: "msg", to: "crítico", tot: "str" }], 1050, 570, [["codex_level_effect_out"]]));
upsert(sw("codex_level_warning", "codex_group_level", "Uso atingiu nível de atenção?", 'snapshot.values["sensor.codex_limite_usado"]', [{ t: "gte", v: "policy.warning_usage_percent", vt: "msg" }, { t: "else" }], 820, 680, [["codex_level_set_warning"], ["codex_level_set_normal"]]));
upsert(change("codex_level_set_warning", "codex_group_level", "Nível: atenção", [{ t: "set", p: "canonical_level", pt: "msg", to: "atenção", tot: "str" }], 1060, 660, [["codex_level_effect_out"]]));
upsert(change("codex_level_set_normal", "codex_group_level", "Nível: normal", [{ t: "set", p: "canonical_level", pt: "msg", to: "normal", tot: "str" }], 1050, 710, [["codex_level_effect_out"]]));
upsert(linkOut("codex_level_effect_out", "codex_group_level", "Nível decidido → publicação", ["codex_level_effect_in"], 1210, 620));

const decisionNodes = ["codex_alert_decision_in", "codex_alert_policy", "codex_request_type", "codex_summary_enabled", "codex_alerts_enabled", "codex_entity_route", "codex_forecast_decision", "codex_usage_decision", "codex_cache_decision", "codex_credits_decision", "codex_candidate_available", "codex_daily_kind", "codex_test_kind", "codex_early_candidate_out", "codex_candidate_out"];
upsert(group("codex_group_decisions", "3. Habilitação e decisões de alerta", decisionNodes, 1300, 500, 1900, 500, "#d97706", "#fef3c7"));
upsert(linkIn("codex_alert_decision_in", "codex_group_decisions", "Receber snapshot", ["codex_snapshot_alert_out"], 1350, 590, [["codex_alert_policy"]]));
upsert(change("codex_alert_policy", "codex_group_decisions", "Carregar política visual", [{ t: "set", p: "policy", pt: "msg", to: '$flowContext("codex_alert_policy_v1", "persistent")', tot: "jsonata" }], 1550, 590, [["codex_request_type"]]));
upsert(sw("codex_request_type", "codex_group_decisions", "Origem: diário, TESTE ou telemetria?", "request_type", [{ t: "eq", v: "daily", vt: "str" }, { t: "eq", v: "manual_test", vt: "str" }, { t: "else" }], 1820, 590, [["codex_summary_enabled"], ["codex_test_kind"], ["codex_alerts_enabled"]]));
upsert(sw("codex_summary_enabled", "codex_group_decisions", "Resumo diário está habilitado?", "snapshot.summary_enabled", [{ t: "eq", v: "true", vt: "bool" }], 2110, 550, [["codex_daily_kind"]]));
upsert(change("codex_daily_kind", "codex_group_decisions", "Candidato: resumo diário", [{ t: "set", p: "decision.kind", pt: "msg", to: "daily", tot: "str" }], 2380, 550, [["codex_early_candidate_out"]]));
upsert(change("codex_test_kind", "codex_group_decisions", "Candidato: TESTE seguro", [{ t: "set", p: "decision.kind", pt: "msg", to: "test", tot: "str" }], 2110, 610, [["codex_early_candidate_out"]]));
upsert(linkOut("codex_early_candidate_out", "codex_group_decisions", "Resumo/TESTE → dedupe", ["codex_candidate_in"], 2600, 580));
upsert(sw("codex_alerts_enabled", "codex_group_decisions", "Alertas móveis estão habilitados?", "snapshot.alerts_enabled", [{ t: "eq", v: "true", vt: "bool" }], 2110, 680, [["codex_entity_route"]]));
upsert(sw("codex_entity_route", "codex_group_decisions", "Qual fonte mudou?", "snapshot.entity_id", [
  { t: "eq", v: "sensor.codex_previsao_ate_o_reset", vt: "str" },
  { t: "eq", v: "sensor.codex_limite_usado", vt: "str" },
  { t: "eq", v: "sensor.codex_eficiencia_de_cache", vt: "str" },
  { t: "eq", v: "sensor.codex_creditos_extras", vt: "str" },
], 2390, 680, [["codex_forecast_decision"], ["codex_usage_decision"], ["codex_cache_decision"], ["codex_credits_decision"]]));
upsert(fn("codex_forecast_decision", "codex_group_decisions", "Calcular transição da previsão", forecastDecision, 2690, 650, [["codex_candidate_available"]]));
upsert(fn("codex_usage_decision", "codex_group_decisions", "Calcular cruzamento de uso", usageDecision, 2690, 710, [["codex_candidate_available"]]));
upsert(fn("codex_cache_decision", "codex_group_decisions", "Calcular cruzamento de cache", cacheDecision, 2690, 770, [["codex_candidate_available"]]));
upsert(fn("codex_credits_decision", "codex_group_decisions", "Calcular cruzamento de créditos", creditsDecision, 2690, 830, [["codex_candidate_available"]]));
upsert(sw("codex_candidate_available", "codex_group_decisions", "Há candidato de alerta?", "decision.kind", [{ t: "neq", v: "", vt: "str" }], 2980, 740, [["codex_candidate_out"]]));
upsert(linkOut("codex_candidate_out", "codex_group_decisions", "Candidato → dedupe e efeitos", ["codex_candidate_in"], 3140, 630));

const testNodes = ["codex_test_instructions", "codex_test_reset", "codex_test_reset_state", "codex_test_warning", "codex_test_duplicate", "codex_test_unavailable", "codex_test_daily", "codex_test_event_out", "codex_test_dry_run_in", "codex_test_dry_run_terminal"];
upsert(group("codex_group_tests", "4. Testes manuais completos — dry-run", testNodes, 64, 780, 760, 600, "#0891b2", "#cffafe"));
upsert(n("codex_test_instructions", "comment", "codex_group_tests", "Ordem: reset → atenção → duplicado → sem dados → resumo", 430, 820, [], { info: "Todos os cenários percorrem snapshot, política, decisões, cooldown e gates reais; nenhum serviço Home Assistant é chamado." }));
upsert(inject("codex_test_reset", "codex_group_tests", "TESTE 1: reset", "", "", "date", 180, 890, [["codex_test_reset_state"]]));
upsert(fn("codex_test_reset_state", "codex_group_tests", "Preparar snapshot sintético", testReset, 480, 890, [], 0));
upsert(inject("codex_test_warning", "codex_group_tests", "TESTE 2: uso 71 %", "", '{"test_mode":true,"entity_id":"sensor.codex_limite_usado","state":"71","previous":"69"}', "json", 190, 960, [["codex_test_event_out"]]));
upsert(inject("codex_test_duplicate", "codex_group_tests", "TESTE 3: duplicado 71 %", "", '{"test_mode":true,"entity_id":"sensor.codex_limite_usado","state":"71","previous":"71"}', "json", 210, 1020, [["codex_test_event_out"]]));
upsert(inject("codex_test_unavailable", "codex_group_tests", "TESTE 4: dados indisponíveis", "", '{"test_mode":true,"entity_id":"sensor.codex_dados_de_limite","state":"unavailable","previous":"atual"}', "json", 220, 1080, [["codex_test_event_out"]]));
upsert(inject("codex_test_daily", "codex_group_tests", "TESTE 5: resumo diário", "codex.daily_summary", '{"test_mode":true}', "json", 200, 1140, [["codex_test_event_out"]]));
upsert(linkOut("codex_test_event_out", "codex_group_tests", "Eventos TESTE → snapshot real", ["codex_test_input_in"], 500, 1050));
upsert(linkIn("codex_test_dry_run_in", "codex_group_tests", "Receber efeito TESTE", ["codex_level_dry_run_out", "codex_alert_dry_run_out"], 420, 1240, [["codex_test_dry_run_terminal"]]));
upsert(fn("codex_test_dry_run_terminal", "codex_group_tests", "TESTE FINAL: registrar sem enviar", dryRun, 640, 1240, [], 0));

const effectNodes = ["codex_level_effect_in", "codex_level_prepare", "codex_level_final_gate", "codex_level_rbe", "codex_level_publish", "codex_level_dry_run_out", "codex_candidate_in", "codex_build_alert", "codex_delivery_evaluate", "codex_delivery_allowed", "codex_alert_final_gate", "codex_alert_push", "codex_alert_text", "codex_alert_time", "codex_alert_persistent", "codex_alert_ack", "codex_alert_catch", "codex_alert_failure", "codex_alert_dry_run_out", "codex_pending_tick", "codex_pending_policy", "codex_pending_check", "codex_pending_due", "codex_pending_retry_out", "codex_pending_retry_in"];
upsert(group("codex_group_effects", "5. Estado, dedupe, gates finais, efeitos e recovery", effectNodes, 864, 1020, 2600, 360, "#dc2626", "#fee2e2"));
upsert(linkIn("codex_level_effect_in", "codex_group_effects", "Receber nível decidido", ["codex_level_effect_out"], 920, 1100, [["codex_level_prepare"]]));
upsert(change("codex_level_prepare", "codex_group_effects", "Preparar estado canônico", [{ t: "set", p: "payload", pt: "msg", to: "canonical_level", tot: "msg" }], 1120, 1100, [["codex_level_final_gate"]]));
upsert(sw("codex_level_final_gate", "codex_group_effects", "Gate final: publicar nível ou TESTE?", "test_mode", [{ t: "neq", v: "true", vt: "bool" }, { t: "eq", v: "true", vt: "bool" }], 1370, 1100, [["codex_level_rbe"], ["codex_level_dry_run_out"]]));
upsert(n("codex_level_rbe", "rbe", "codex_group_effects", "Publicar somente mudança de nível", 1640, 1070, [["codex_level_publish"]], { func: "rbe", gap: "", start: "", inout: "out", septopics: true, property: "payload", topi: "topic" }));
upsert({ ...service("codex_level_publish", "codex_group_effects", "EFEITO: publicar nível canônico", "input_text.set_value", '{"value":canonical_level}', "jsonata", 1910, 1070, [[]]), entityId: ["input_text.codex_nivel_alerta_canonico"] });
upsert(linkOut("codex_level_dry_run_out", "codex_group_effects", "Nível TESTE → dry-run", ["codex_test_dry_run_in"], 1640, 1130));

upsert(linkIn("codex_candidate_in", "codex_group_effects", "Receber candidato de alerta", ["codex_early_candidate_out", "codex_candidate_out"], 920, 1210, [["codex_build_alert"]]));
upsert(fn("codex_build_alert", "codex_group_effects", "Montar texto do candidato", buildAlert, 1130, 1210, [["codex_delivery_evaluate"]]));
upsert(fn("codex_delivery_evaluate", "codex_group_effects", "Calcular cooldown e registrar pendência", deliveryEvaluate, 1420, 1210, [["codex_delivery_allowed"]]));
upsert(sw("codex_delivery_allowed", "codex_group_effects", "Cooldown permite entrega?", "delivery.allowed", [{ t: "eq", v: "true", vt: "bool" }, { t: "else" }], 1710, 1210, [["codex_alert_final_gate"], []]));
upsert(sw("codex_alert_final_gate", "codex_group_effects", "Gate final: alertar produção ou TESTE?", "test_mode", [{ t: "neq", v: "true", vt: "bool" }, { t: "eq", v: "true", vt: "bool" }], 1980, 1210, [["codex_alert_push", "codex_alert_text", "codex_alert_time", "codex_alert_persistent"], ["codex_alert_dry_run_out"]]));
upsert(service("codex_alert_push", "codex_group_effects", "EFEITO: push mobile_primary", "public_bindings.call", '{"role":"mobile_primary","action":"notify_3","data":{"title":alert.title,"message":alert.message}}', "jsonata", 2290, 1160, [["codex_alert_ack"]]));
upsert({ ...service("codex_alert_text", "codex_group_effects", "EFEITO: registrar último alerta", "input_text.set_value", '{"value":alert.title & ": " & alert.message}', "jsonata", 2290, 1210, [[]]), entityId: ["input_text.codex_ultimo_alerta_iphone"] });
upsert({ ...service("codex_alert_time", "codex_group_effects", "EFEITO: registrar horário", "input_datetime.set_datetime", '{"datetime":alert.at}', "jsonata", 2290, 1260, [[]]), entityId: ["input_datetime.codex_ultimo_alerta_iphone_em"] });
upsert(service("codex_alert_persistent", "codex_group_effects", "EFEITO: notificação persistente", "persistent_notification.create", '{"title":alert.title,"message":alert.message,"notification_id":"codex_alert_" & alert.kind}', "jsonata", 2290, 1310, [["codex_alert_ack"]]));
upsert(fn("codex_alert_ack", "codex_group_effects", "Confirmar entrega e iniciar cooldown", alertAck, 2590, 1160, [], 0));
upsert(n("codex_alert_catch", "catch", "codex_group_effects", "Capturar falha dos canais", 2590, 1260, [["codex_alert_failure"]], { scope: ["codex_alert_push", "codex_alert_persistent"], uncaught: false }));
upsert(fn("codex_alert_failure", "codex_group_effects", "Manter pendência para recovery", alertFailure, 2850, 1260, [], 0));
upsert(linkOut("codex_alert_dry_run_out", "codex_group_effects", "Alerta TESTE → dry-run", ["codex_test_dry_run_in"], 2290, 1360));
upsert(inject("codex_pending_tick", "codex_group_effects", "Recovery de pendência — 60 s", "", "", "date", 2850, 1080, [["codex_pending_policy"]], { once: true, repeat: "60" }));
upsert(change("codex_pending_policy", "codex_group_effects", "Carregar política de recovery", [{ t: "set", p: "policy", pt: "msg", to: '$flowContext("codex_alert_policy_v1", "persistent")', tot: "jsonata" }], 3100, 1080, [["codex_pending_check"]]));
upsert(fn("codex_pending_check", "codex_group_effects", "Ler pendência persistente", pendingCheck, 3100, 1160, [["codex_pending_due"]]));
upsert(sw("codex_pending_due", "codex_group_effects", "Retry pendente está vencido?", "delivery.allowed", [{ t: "eq", v: "true", vt: "bool" }], 3280, 1210, [["codex_pending_retry_out"]]));
upsert(linkOut("codex_pending_retry_out", "codex_group_effects", "Recovery vencido → gate final", ["codex_pending_retry_in"], 3310, 1320));
upsert(linkIn("codex_pending_retry_in", "codex_group_effects", "Receber recovery vencido", ["codex_pending_retry_out"], 1840, 1310, [["codex_alert_final_gate"]]));

writeFileSync(OUT, JSON.stringify(installNotificationHubs(flows), null, 4) + "\n");
console.log(`Fluxo visual de alertas Codex escrito em ${OUT}.`);
