#!/usr/bin/env node

import fs from "node:fs";

const flowUrl = new URL("../flows.json", import.meta.url);
const flows = JSON.parse(fs.readFileSync(flowUrl, "utf8"));

const TAB = "codex_alertas_tab";
const GROUP = "codex_alertas_group";
const HA = "4126427d5e161a03";

function node(id, type, extra) {
  return { id, type, z: TAB, ...extra };
}

function stateNode(id, name, entities, outputInitially, wires, payload) {
  return node(id, "server-state-changed", {
    g: GROUP,
    name,
    server: HA,
    version: 6,
    outputs: 1,
    exposeAsEntityConfig: "",
    entities: { entity: entities, substring: [], regex: [] },
    outputInitially,
    stateType: "str",
    ifState: "",
    ifStateType: "str",
    ifStateOperator: "is",
    outputOnlyOnStateChange: true,
    for: "0",
    forType: "num",
    forUnits: "minutes",
    ignorePrevStateNull: false,
    ignorePrevStateUnknown: false,
    ignorePrevStateUnavailable: false,
    ignoreCurrentStateUnknown: true,
    ignoreCurrentStateUnavailable: true,
    outputProperties: [{
      property: "payload",
      propertyType: "msg",
      value: payload,
      valueType: "jsonata",
    }],
    x: 190,
    y: 120,
    wires: [wires],
  });
}

const monitored = [
  "input_boolean.codex_alertas_iphone",
  "input_boolean.codex_resumo_diario_iphone",
  "input_number.codex_alerta_aviso_percentual",
  "input_number.codex_alerta_critico_percentual",
  "input_number.codex_alerta_cache_minimo",
  "input_number.codex_alerta_saldo_creditos",
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

const alertLogic = String.raw`
const REQUIRED = ${JSON.stringify(monitored)};
const KEY = "codex_alertas_state_v1";
let state = flow.get(KEY, "persistent") || { values: {}, ready: false, sent: {} };
const event = msg.payload || {};

function num(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function build(title, message, kind) {
  const now = Date.now();
  const cooldownMs = kind === "critical" ? 60 * 60 * 1000 : 6 * 60 * 60 * 1000;
  if (now - Number(state.sent[kind] || 0) < cooldownMs) return null;
  if (state.pending?.kind === kind && now - Number(state.pending.lastAttemptAt || 0) < 60 * 1000) return null;
  const alert = {
    title,
    message,
    kind,
    at: new Date(now).toISOString(),
    lastAttemptAt: now,
    deliveryAck: { id: kind + ":" + String(now), kind, at: now },
  };
  state.pending = alert;
  return alert;
}

function summary() {
  if (state.values["input_boolean.codex_alertas_iphone"] !== "on"
      || state.values["input_boolean.codex_resumo_diario_iphone"] !== "on") return null;
  return build(
    "Codex — resumo diário",
    "Uso: " + (state.values["sensor.codex_limite_usado"] || "?") + "%; " +
      "projeção no reset: " + (state.values["sensor.codex_uso_projetado_no_reset"] || "?") + "%; " +
      "folga: " + (state.values["sensor.codex_folga_projetada_no_reset"] || "?") + "%; " +
      "cache: " + (state.values["sensor.codex_eficiencia_de_cache"] || "?") + "%; " +
      "previsão: " + (state.values["sensor.codex_previsao_ate_o_reset"] || "?") + ".",
    "daily",
  );
}

if (msg.topic === "codex.daily_summary") {
  const alert = state.ready ? summary() : null;
  flow.set(KEY, state, "persistent");
  return alert ? [ { alert }, { alert }, { alert }, { alert } ] : null;
}

if (event.type === "manual_test") {
  const alert = build(
    "Codex — teste de alertas",
    "✅ O Node-RED está conectado ao iPhone de resident_primary. Uso atual: " +
      (state.values["sensor.codex_limite_usado"] || "?") + "%; projeção no reset: " +
      (state.values["sensor.codex_uso_projetado_no_reset"] || "?") + "%.",
    "test",
  );
  flow.set(KEY, state, "persistent");
  return alert ? [ { alert }, { alert }, { alert }, { alert } ] : null;
}

const entity = event.entity_id;
if (!entity || !REQUIRED.includes(entity)) return null;
const previous = state.values[entity];
state.values[entity] = String(event.state ?? "");
if (!state.ready) {
  state.ready = REQUIRED.every((id) => Object.prototype.hasOwnProperty.call(state.values, id));
  flow.set(KEY, state, "persistent");
  node.status({ fill: state.ready ? "green" : "yellow", shape: "dot", text: state.ready ? "monitorando" : "sincronizando" });
  return null;
}

if (state.values["input_boolean.codex_alertas_iphone"] !== "on") {
  flow.set(KEY, state, "persistent");
  node.status({ fill: "grey", shape: "ring", text: "alertas desativados" });
  return null;
}

let alert = null;
if (entity === "sensor.codex_previsao_ate_o_reset") {
  if (["atenção", "não aguenta"].includes(event.state) && previous !== event.state) {
    const critical = event.state === "não aguenta";
    alert = build(
      critical ? "Codex — risco de esgotamento" : "Codex — pouca folga até o reset",
      (critical ? "🔴" : "⚠️") + " Ritmo atual: " +
        (state.values["sensor.codex_ritmo_do_limite"] || "?") + "%/dia. Uso projetado no reset: " +
        (state.values["sensor.codex_uso_projetado_no_reset"] || "?") + "%. Reset: " +
        (state.values["sensor.codex_proximo_reset"] || "?") + ".",
      critical ? "critical" : "forecast_warning",
    );
  } else if (event.state === "aguenta" && ["atenção", "não aguenta"].includes(previous)) {
    alert = build("Codex — autonomia recuperada", "✅ O ritmo voltou a ser sustentável até o reset. Folga projetada: " + (state.values["sensor.codex_folga_projetada_no_reset"] || "?") + "%.", "recovery");
  }
} else if (entity === "sensor.codex_limite_usado") {
  const used = num(event.state); const old = num(previous, -1);
  const warning = num(state.values["input_number.codex_alerta_aviso_percentual"], 70);
  const critical = num(state.values["input_number.codex_alerta_critico_percentual"], 90);
  if (used >= critical && old < critical) alert = build("Codex — limite crítico", "🚨 Uso chegou a " + used + "%. Restam " + (state.values["sensor.codex_limite_disponivel"] || "?") + "% até o reset.", "critical");
  else if (used >= warning && old < warning) alert = build("Codex — limite em atenção", "⚠️ Uso chegou a " + used + "%. Folga projetada no reset: " + (state.values["sensor.codex_folga_projetada_no_reset"] || "?") + "%.", "usage_warning");
} else if (entity === "sensor.codex_eficiencia_de_cache") {
  const value = num(event.state); const old = num(previous, 101); const minimum = num(state.values["input_number.codex_alerta_cache_minimo"], 60);
  if (value < minimum && old >= minimum) alert = build("Codex — eficiência de cache baixa", "⚠️ A eficiência caiu para " + value + "%. Limite configurado: " + minimum + "%.", "cache_low");
} else if (entity === "sensor.codex_creditos_extras") {
  const value = num(event.state); const old = num(previous, -1); const minimum = num(state.values["input_number.codex_alerta_saldo_creditos"], 10);
  if (value < minimum && old >= minimum) alert = build("Codex — créditos extras baixos", "⚠️ O saldo caiu para " + value + " créditos.", "credits_low");
}

if (!alert && state.pending?.deliveryAck?.id) {
  const now = Date.now();
  if (now - Number(state.pending.lastAttemptAt || 0) >= 60 * 1000) {
    state.pending.lastAttemptAt = now;
    alert = state.pending;
  }
}

flow.set(KEY, state, "persistent");
node.status({ fill: alert ? "red" : "green", shape: alert ? "ring" : "dot", text: alert ? "alerta: " + alert.kind : "monitorando" });
return alert ? [ { alert }, { alert }, { alert }, { alert } ] : null;
`;

const alertAck = String.raw`const ack = msg.alert?.deliveryAck;
if (!ack || typeof ack.kind !== "string" || !Number.isFinite(Number(ack.at))) return null;
const KEY = "codex_alertas_state_v1";
const state = flow.get(KEY, "persistent") || { values: {}, ready: false, sent: {} };
state.sent = state.sent || {};
state.sent[ack.kind] = Number(ack.at);
if (state.pending?.deliveryAck?.id === ack.id) state.pending = null;
flow.set(KEY, state, "persistent");
node.status({ fill: "green", shape: "dot", text: "entrega aceita pelo HA" });
return null;`;

const alertFailure = String.raw`const source = String(msg.error?.source?.name ?? "notificacao").replace(/[^a-zA-Z0-9 _-]/g, "");
const detail = String(msg.error?.message ?? "erro desconhecido").replace(/[\r\n]+/g, " ").slice(0, 240);
node.error("codex_alert_delivery_failed source=" + source + " message=" + detail);
node.status({ fill: "red", shape: "ring", text: "pendente para nova tentativa" });
return null;`;

const nodes = [
  { id: TAB, type: "tab", label: "alertas_codex", disabled: false, info: "Alertas de uso do Codex: lógica, teste manual e deduplicação no Node-RED; painel e configurações no Home Assistant.", env: [] },
  { id: GROUP, type: "group", z: TAB, name: "Alertas Codex → iPhone de resident_primary", style: { label: true, "label-position": "nw", stroke: "#5d6f96", "stroke-opacity": "1", fill: "none", color: "#a4a4a4" }, nodes: ["codex_alert_state", "codex_alert_manual_test", "codex_alert_daily", "codex_alert_logic", "codex_alert_push", "codex_alert_text", "codex_alert_time", "codex_alert_persistent", "codex_alert_ack", "codex_alert_catch", "codex_alert_failure"], x: 40, y: 40, w: 1760, h: 360 },
  stateNode("codex_alert_state", "Estados e limites do Codex", monitored, true, ["codex_alert_logic"], "{\"entity_id\":$entity().entity_id,\"state\":$entity().state,\"previous\":$prevEntity().state}"),
  node("codex_alert_manual_test", "inject", { g: GROUP, name: "Testar push no iPhone", props: [{ p: "payload", v: "{\"type\":\"manual_test\"}", vt: "json" }], repeat: "", crontab: "", once: false, onceDelay: 0.1, topic: "", payload: "{\"type\":\"manual_test\"}", payloadType: "json", x: 180, y: 180, wires: [["codex_alert_logic"]] }),
  node("codex_alert_daily", "inject", { g: GROUP, name: "Resumo diário — 20:00", props: [{ p: "payload" }, { p: "topic", v: "codex.daily_summary", vt: "str" }], repeat: "", crontab: "00 20 * * *", once: false, onceDelay: 0.1, topic: "codex.daily_summary", payload: "", payloadType: "date", x: 180, y: 240, wires: [["codex_alert_logic"]] }),
  node("codex_alert_logic", "function", { g: GROUP, name: "Avaliar alertas, cooldown e resumo", func: alertLogic, outputs: 4, timeout: 0, noerr: 0, initialize: "", finalize: "", libs: [], x: 590, y: 160, wires: [["codex_alert_push"], ["codex_alert_text"], ["codex_alert_time"], ["codex_alert_persistent"]] }),
  node("codex_alert_push", "api-call-service", { g: GROUP, name: "Push iPhone resident_primary", server: HA, version: 7, debugenabled: false, action: "public_bindings.call", floorId: [], areaId: [], deviceId: [], entityId: [], labelId: [], data: "{\"role\":\"mobile_primary\",\"action\":\"notify_3\",\"data\":{\"title\":alert.title,\"message\":alert.message}}", dataType: "jsonata", mergeContext: "", mustacheAltTags: false, outputProperties: [], queue: "all", blockInputOverrides: true, domain: "public_bindings", service: "call", x: 920, y: 100, wires: [["codex_alert_ack"]] }),
  node("codex_alert_text", "api-call-service", { g: GROUP, name: "Registrar último alerta", server: HA, version: 7, debugenabled: false, action: "input_text.set_value", floorId: [], areaId: [], deviceId: [], entityId: ["input_text.codex_ultimo_alerta_iphone"], labelId: [], data: "{\"value\": alert.title & \": \" & alert.message}", dataType: "jsonata", mergeContext: "", mustacheAltTags: false, outputProperties: [], queue: "all", blockInputOverrides: true, domain: "input_text", service: "set_value", x: 940, y: 160, wires: [[]] }),
  node("codex_alert_time", "api-call-service", { g: GROUP, name: "Registrar horário", server: HA, version: 7, debugenabled: false, action: "input_datetime.set_datetime", floorId: [], areaId: [], deviceId: [], entityId: ["input_datetime.codex_ultimo_alerta_iphone_em"], labelId: [], data: "{\"datetime\": alert.at}", dataType: "jsonata", mergeContext: "", mustacheAltTags: false, outputProperties: [], queue: "all", blockInputOverrides: true, domain: "input_datetime", service: "set_datetime", x: 920, y: 220, wires: [[]] }),
  node("codex_alert_persistent", "api-call-service", { g: GROUP, name: "Notificação persistente", server: HA, version: 7, debugenabled: false, action: "persistent_notification.create", floorId: [], areaId: [], deviceId: [], entityId: [], labelId: [], data: "{\"title\":alert.title,\"message\":alert.message,\"notification_id\":\"codex_alert_\" & alert.kind}", dataType: "jsonata", mergeContext: "", mustacheAltTags: false, outputProperties: [], queue: "all", blockInputOverrides: true, domain: "persistent_notification", service: "create", x: 930, y: 280, wires: [["codex_alert_ack"]] }),
  node("codex_alert_ack", "function", { g: GROUP, name: "Confirmar entrega e iniciar cooldown", func: alertAck, outputs: 0, timeout: 0, noerr: 0, initialize: "", finalize: "", libs: [], x: 1370, y: 120, wires: [] }),
  node("codex_alert_catch", "catch", { g: GROUP, name: "Capturar falha de entrega", scope: ["codex_alert_push", "codex_alert_persistent"], uncaught: false, x: 930, y: 340, wires: [["codex_alert_failure"]] }),
  node("codex_alert_failure", "function", { g: GROUP, name: "Manter alerta pendente", func: alertFailure, outputs: 0, timeout: 0, noerr: 0, initialize: "", finalize: "", libs: [], x: 1260, y: 340, wires: [] }),
];

const retained = flows.filter((item) => item.z !== TAB && item.id !== TAB && item.id !== GROUP);
retained.push(...nodes);
fs.writeFileSync(flowUrl, `${JSON.stringify(retained, null, 4)}\n`);
console.log(`Installed Codex alert flow (${nodes.length} nodes).`);
