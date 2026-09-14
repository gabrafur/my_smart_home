#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { installNotificationHubs } from "./install-notification-hubs.mjs";

const FLOWS = new URL("../flows.json", import.meta.url).pathname;
const OUT = process.argv[2] || FLOWS;
const TAB = "29d64664bf8cbde8";
const BROKER = "721c47f31046b8bc";
const HA_SERVER = "4126427d5e161a03";

const flows = JSON.parse(readFileSync(FLOWS, "utf8"));

function required(id) {
  const node = flows.find((candidate) => candidate.id === id);
  if (!node) throw new Error(`nó obrigatório ausente: ${id}`);
  return node;
}

function upsert(node) {
  const index = flows.findIndex((candidate) => candidate.id === node.id);
  if (index === -1) flows.push(node);
  else flows[index] = node;
}

function remove(ids) {
  const managed = new Set(ids);
  for (let index = flows.length - 1; index >= 0; index -= 1) {
    if (managed.has(flows[index].id)) flows.splice(index, 1);
  }
}

function functionNode(id, group, name, func, outputs, x, y, wires) {
  return {
    id, type: "function", z: TAB, g: group, name, func, outputs,
    timeout: 0, noerr: 0, initialize: "", finalize: "", libs: [], x, y, wires,
  };
}

function inject(id, group, name, topic, payload, payloadType, x, y, wires, once = false) {
  return {
    id, type: "inject", z: TAB, g: group, name,
    props: [{ p: "payload" }, ...(topic ? [{ p: "topic", vt: "str" }] : [])],
    repeat: "", crontab: "", once, onceDelay: once ? 0.5 : 0.1,
    topic, payload: String(payload), payloadType, x, y, wires,
  };
}

function group(id, name, nodes, x, y, w, h, stroke, fill) {
  return {
    id, type: "group", z: TAB, name,
    style: {
      label: true, "label-position": "nw", stroke, "stroke-opacity": "1",
      fill, "fill-opacity": "0.35", color: "#1f2937",
    },
    nodes, x, y, w, h,
  };
}

const managedIds = [
  "gar_group_pulse",
  "gar_group_policy", "gar_policy_help", "gar_policy_dedupe_ms",
  "gar_policy_cooldown_ms", "gar_policy_pulse_ms", "gar_policy_same_pulse_ms",
  "gar_policy_validate", "gar_group_request", "gar_dashboard_request_in",
  "gar_request_normalize", "gar_request_action_switch", "gar_request_probe_terminal",
  "gar_request_invalid_terminal", "gar_request_load_policy", "gar_request_evaluate",
  "gar_request_decision_switch", "gar_request_blocked_terminal", "gar_group_effect",
  "gar_request_policy_out", "gar_request_policy_in", "gar_request_test_in",
  "gar_request_pulse_out", "gar_request_safe_off_out", "gar_effect_pulse_in",
  "gar_effect_safe_off_in", "gar_effect_safe_off_adapter_out",
  "gar_effect_safe_off_adapter_in", "gar_effect_dry_run_out",
  "gar_pulse_test_gate", "gar_prepare_pulse_delay", "gar_relay_pulse_on",
  "gar_relay_on_publish_out", "gar_relay_on_publish_in",
  "gar_relay_safety_delay", "gar_relay_pulse_off", "gar_relay_mqtt_out",
  "gar_log_pulse_started", "gar_safe_off_test_gate", "gar_notify_relay_on",
  "gar_group_observer", "gar_pulse_watch_note", "gar_pulse_watch_normalize",
  "gar_pulse_watch_state_switch", "gar_pulse_watch_load_policy",
  "gar_pulse_watch_policy_out", "gar_pulse_watch_policy_in",
  "gar_pulse_watch_stamp", "gar_group_tests", "gar_test_instructions",
  "gar_test_reset", "gar_test_reset_state", "gar_test_accept",
  "gar_test_duplicate", "gar_test_cooldown", "gar_test_boundary",
  "gar_test_relay_on", "gar_test_relay_on_prepare", "gar_test_request_out_left",
  "gar_test_request_out_right", "gar_test_dry_run_in", "gar_test_dry_run_terminal",
  "gar_portao_normalizar_click",
];
remove(managedIds);

const tab = required(TAB);
tab.info = "Controlador visual único do pulso do portão. A política validada expõe dedupe, cooldown, largura e coalescência; decisões e fronteiras produção/TESTE são blocos separados. O watchdog independente do Home Assistant continua emitindo somente OFF.";

const policyValidate = String.raw`const limits = {
    dedupe_ms: { min: 100, max: 5000 },
    cooldown_ms: { min: 200, max: 10000 },
    pulse_ms: { min: 100, max: 2000 },
    same_pulse_ms: { min: 0, max: 5000 }
};
const key = String(msg.topic ?? "");
const rule = limits[key];
const value = Number(msg.payload);
if (!rule || !Number.isInteger(value) || value < rule.min || value > rule.max) {
    node.error("Política do portão inválida: " + (key || "campo ausente") + "=" + msg.payload, msg);
    return null;
}
const previous = flow.get("garage_gate_policy_v1", "persistent");
const candidate = previous?.version === 1
    ? { ...previous }
    : { version: 1, owner: "node_red" };
candidate[key] = value;
const complete = Object.keys(limits).every((field) => Number.isFinite(candidate[field]));
if (
    complete &&
    (candidate.pulse_ms >= candidate.cooldown_ms ||
     candidate.same_pulse_ms > candidate.dedupe_ms ||
     candidate.dedupe_ms > candidate.cooldown_ms)
) {
    node.error("Política do portão inválida: pulso < cooldown e coalescência <= dedupe <= cooldown", msg);
    return null;
}
candidate.complete = complete;
candidate.updated_at = Date.now();
flow.set("garage_gate_policy_v1", candidate, "persistent");
node.status({
    fill: complete ? "green" : "yellow",
    shape: complete ? "dot" : "ring",
    text: complete
        ? "pulso " + candidate.pulse_ms + " ms | cooldown " + candidate.cooldown_ms + " ms"
        : "aguardando os quatro valores"
});
return null;`;

const requestNormalize = String.raw`let request = msg.payload;
if (request && typeof request === "object" && request.event && typeof request.event === "object") {
    request = request.event;
}
if (typeof request === "string") request = { action: request };
if (!request || typeof request !== "object") request = {};
msg.request = {
    action: String(request.action ?? ""),
    origin: String(request.origem ?? request.origin ?? (msg.topic ? "botao_zigbee" : "desconhecida"))
};
msg.test_mode = request.test_mode === true || msg.test_mode === true;
if (msg.test_mode && Number.isFinite(Number(request._test_now_ms))) {
    msg._test_now_ms = Number(request._test_now_ms);
}
return msg;`;

const requestEvaluate = String.raw`const policy = msg.policy;
if (policy?.version !== 1 || policy?.complete !== true) {
    node.error("Política visual do portão indisponível", msg);
    return null;
}
const testMode = msg.test_mode === true;
const now = testMode && Number.isFinite(msg._test_now_ms) ? msg._test_now_ms : Date.now();
const stateKey = testMode ? "garage_gate_test_state_v1" : "garage_gate_state_v1";
let state = flow.get(stateKey, "persistent");
if (!state || typeof state !== "object") {
    state = testMode ? {} : {
        last_click_ms: Number(flow.get("portao_garagem_last_click_ms") || NaN),
        last_pulse_ms: Number(flow.get("portao_garagem_last_pulse_ms") || NaN),
        relay_state: flow.get("portao_garagem_relay_state") ?? null,
        migrated_from_legacy: true
    };
}
const hasClick = Number.isFinite(state.last_click_ms);
const hasPulse = Number.isFinite(state.last_pulse_ms);
const sinceClick = hasClick ? now - state.last_click_ms : null;
const sincePulse = hasPulse ? now - state.last_pulse_ms : null;
let action = "pulse";
let reason = "accepted";
if (hasClick && sinceClick < policy.dedupe_ms) {
    action = "blocked";
    reason = "duplicate";
} else if (hasPulse && sincePulse < policy.cooldown_ms) {
    action = "blocked";
    reason = "cooldown";
} else if (state.relay_state === "ON") {
    action = "safe_off";
    reason = "relay_already_on";
} else {
    state.last_click_ms = now;
    state.last_pulse_ms = now;
    flow.set(stateKey, state, "persistent");
    if (!testMode) {
        flow.set("portao_garagem_last_click_ms", now);
        flow.set("portao_garagem_last_pulse_ms", now);
    }
}
msg.decision = {
    action, reason, decided_at: new Date(now).toISOString(),
    elapsed_since_click_ms: sinceClick, elapsed_since_pulse_ms: sincePulse
};
node.status({
    fill: action === "pulse" ? "green" : action === "safe_off" ? "red" : "yellow",
    shape: action === "pulse" ? "dot" : "ring", text: reason
});
return msg;`;

const relayObservationNormalize = String.raw`let state = msg.payload;
if (state && typeof state === "object") state = state.state;
msg.relay_observation = {
    state: String(state ?? "").toUpperCase(),
    topic: String(msg.topic ?? "")
};
return msg;`;

const relayObservationStore = String.raw`const policy = msg.policy;
if (policy?.version !== 1 || policy?.complete !== true) {
    node.error("Política visual do portão indisponível na observação", msg);
    return null;
}
const now = Date.now();
const state = flow.get("garage_gate_state_v1", "persistent") ?? {
    last_pulse_ms: Number(flow.get("portao_garagem_last_pulse_ms") || NaN),
    relay_state: flow.get("portao_garagem_relay_state") ?? null,
    migrated_from_legacy: true
};
const stateTopic = global.get("publicBindings")?.roles?.garage_gate?.topics?.state;
if (stateTopic && msg.relay_observation.topic === stateTopic) {
    state.relay_state = msg.relay_observation.state;
    state.relay_state_at = now;
    flow.set("portao_garagem_relay_state", state.relay_state);
    flow.set("portao_garagem_relay_state_at", now);
}
if (msg.relay_observation.state === "ON") {
    const hasPulse = Number.isFinite(state.last_pulse_ms);
    const elapsed = hasPulse ? now - state.last_pulse_ms : null;
    if (!hasPulse || elapsed >= policy.same_pulse_ms) {
        state.last_pulse_ms = now;
        flow.set("portao_garagem_last_pulse_ms", now);
    }
}
flow.set("garage_gate_state_v1", state, "persistent");
node.status({
    fill: msg.relay_observation.state === "ON" ? "blue" : "grey",
    shape: "dot", text: msg.relay_observation.state
});
return null;`;

const mqttCommand = (state) => String.raw`const topic = global.get("publicBindings")?.roles?.garage_gate?.topics?.command;
if (!topic) {
    node.error("Binding MQTT do portão ausente", msg);
    return null;
}
msg.topic = topic;
msg.payload = JSON.stringify({ state: "${state}" });
return msg;`;

const testReset = String.raw`flow.set("garage_gate_test_state_v1", {}, "persistent");
node.status({ fill: "blue", shape: "dot", text: "estado TESTE limpo" });
return null;`;

const testRelayOn = String.raw`flow.set("garage_gate_test_state_v1", {
    relay_state: "ON",
    relay_state_at: Number(msg.payload?._test_now_ms ?? 0) - 1000
}, "persistent");
return msg;`;

const dryRun = String.raw`msg.payload = {
    simulated: true,
    dispatched: false,
    domain: "garage_gate",
    requested_action: msg.decision?.action ?? "none",
    reason: msg.decision?.reason ?? "test_gate"
};
node.status({ fill: "blue", shape: "ring", text: "TESTE: " + msg.payload.reason });
return null;`;

upsert(group("gar_group_policy", "0. Política visual — edite os valores", [
  "gar_policy_help", "gar_policy_dedupe_ms", "gar_policy_cooldown_ms",
  "gar_policy_pulse_ms", "gar_policy_same_pulse_ms", "gar_policy_validate",
], 64, 40, 656, 300, "#2563eb", "#dbeafe"));
upsert({ id: "gar_policy_help", type: "comment", z: TAB, g: "gar_group_policy", name: "Duplo clique no número → altere → Deploy. Inválido preserva a última política válida.", info: "Inteiros em milissegundos. Limites: dedupe 100–5.000; cooldown 200–10.000; pulso 100–2.000; coalescência 0–5.000. Relações: pulso < cooldown e coalescência <= dedupe <= cooldown.", x: 375, y: 80, wires: [] });
upsert(inject("gar_policy_dedupe_ms", "gar_group_policy", "Dedupe — 900 ms", "dedupe_ms", 900, "num", 220, 140, [["gar_policy_validate"]], true));
upsert(inject("gar_policy_cooldown_ms", "gar_group_policy", "Cooldown — 1.000 ms", "cooldown_ms", 1000, "num", 220, 190, [["gar_policy_validate"]], true));
upsert(inject("gar_policy_pulse_ms", "gar_group_policy", "Pulso — 700 ms", "pulse_ms", 700, "num", 220, 240, [["gar_policy_validate"]], true));
upsert(inject("gar_policy_same_pulse_ms", "gar_group_policy", "Coalescência MQTT — 500 ms", "same_pulse_ms", 500, "num", 230, 290, [["gar_policy_validate"]], true));
upsert(functionNode("gar_policy_validate", "gar_group_policy", "Validar e preservar política única", policyValidate, 0, 550, 215, []));

const jsonInput = required("45296e246a57590d");
Object.assign(jsonInput, { g: "gar_group_request", x: 880, y: 100, wires: [["gar_request_normalize"]] });
const actionInput = required("gar_portao_action_topic_in");
Object.assign(actionInput, { g: "gar_group_request", x: 880, y: 150, wires: [["gar_request_normalize"]] });
upsert({
  id: "gar_dashboard_request_in", type: "server-events", z: TAB, g: "gar_group_request",
  name: "botão do dashboard", server: HA_SERVER, version: 3, exposeAsEntityConfig: "",
  eventType: "portao_garagem_pulso_solicitado", eventData: "", waitForRunning: true,
  outputProperties: [{ property: "payload", propertyType: "msg", value: "", valueType: "eventData" }],
  x: 880, y: 200, wires: [["gar_request_normalize"]],
});
upsert({ id: "gar_request_test_in", type: "link in", z: TAB, g: "gar_group_request", name: "Receber pedidos TESTE", links: ["gar_test_request_out_left", "gar_test_request_out_right"], x: 820, y: 260, wires: [["gar_request_normalize"]] });
upsert(functionNode("gar_request_normalize", "gar_group_request", "Adaptar envelope do pedido", requestNormalize, 1, 1120, 150, [["gar_request_action_switch"]]));
upsert({ id: "gar_request_action_switch", type: "switch", z: TAB, g: "gar_group_request", name: "Ação é single, probe ou inválida?", property: "request.action", propertyType: "msg", rules: [{ t: "eq", v: "single", vt: "str" }, { t: "eq", v: "probe", vt: "str" }, { t: "else" }], checkall: "true", repair: false, outputs: 3, x: 1400, y: 150, wires: [["gar_request_load_policy"], ["gar_request_probe_terminal"], ["gar_request_invalid_terminal"]] });
upsert({ id: "gar_request_probe_terminal", type: "debug", z: TAB, g: "gar_group_request", name: "Diagnóstico: probe sem efeito", active: true, tosidebar: true, console: false, tostatus: true, complete: "request", targetType: "msg", statusVal: "request.action", statusType: "msg", x: 1740, y: 190, wires: [] });
upsert({ id: "gar_request_invalid_terminal", type: "debug", z: TAB, g: "gar_group_request", name: "Diagnóstico: ação ignorada", active: true, tosidebar: true, console: false, tostatus: true, complete: "request", targetType: "msg", statusVal: "request.action", statusType: "msg", x: 1740, y: 240, wires: [] });
upsert({ id: "gar_request_load_policy", type: "change", z: TAB, g: "gar_group_request", name: "Carregar política visual válida", rules: [{ t: "set", p: "policy", pt: "msg", to: "$flowContext(\"garage_gate_policy_v1\", \"persistent\")", tot: "jsonata" }], x: 1690, y: 100, wires: [["gar_request_policy_out"]] });
upsert({ id: "gar_request_policy_out", type: "link out", z: TAB, g: "gar_group_request", name: "Política carregada → avaliação", mode: "link", links: ["gar_request_policy_in"], x: 1900, y: 100, wires: [] });
upsert({ id: "gar_request_policy_in", type: "link in", z: TAB, g: "gar_group_request", name: "Receber pedido com política", links: ["gar_request_policy_out"], x: 940, y: 270, wires: [["gar_request_evaluate"]] });
upsert(functionNode("gar_request_evaluate", "gar_group_request", "Avaliar tempos e estado (sem efeitos)", requestEvaluate, 1, 1150, 270, [["gar_request_decision_switch"]]));
upsert({ id: "gar_request_decision_switch", type: "switch", z: TAB, g: "gar_group_request", name: "Decisão: pulso, OFF seguro ou bloqueio?", property: "decision.action", propertyType: "msg", rules: [{ t: "eq", v: "pulse", vt: "str" }, { t: "eq", v: "safe_off", vt: "str" }, { t: "else" }], checkall: "true", repair: false, outputs: 3, x: 1480, y: 290, wires: [["gar_request_pulse_out"], ["gar_request_safe_off_out"], ["gar_request_blocked_terminal"]] });
upsert({ id: "gar_request_pulse_out", type: "link out", z: TAB, g: "gar_group_request", name: "Pulso decidido → gate final", mode: "link", links: ["gar_effect_pulse_in"], x: 1780, y: 280, wires: [] });
upsert({ id: "gar_request_safe_off_out", type: "link out", z: TAB, g: "gar_group_request", name: "OFF seguro → gate final", mode: "link", links: ["gar_effect_safe_off_in"], x: 1780, y: 320, wires: [] });
upsert({ id: "gar_request_blocked_terminal", type: "debug", z: TAB, g: "gar_group_request", name: "Diagnóstico: dedupe/cooldown bloqueou", active: true, tosidebar: true, console: false, tostatus: true, complete: "decision", targetType: "msg", statusVal: "decision.reason", statusType: "msg", x: 1850, y: 360, wires: [] });
upsert(group("gar_group_request", "1. Entradas, adaptação e decisões", ["45296e246a57590d", "gar_portao_action_topic_in", "gar_dashboard_request_in", "gar_request_test_in", "gar_request_normalize", "gar_request_action_switch", "gar_request_probe_terminal", "gar_request_invalid_terminal", "gar_request_load_policy", "gar_request_policy_out", "gar_request_policy_in", "gar_request_evaluate", "gar_request_decision_switch", "gar_request_pulse_out", "gar_request_safe_off_out", "gar_request_blocked_terminal"], 720, 40, 1280, 340, "#0f766e", "#ccfbf1"));

upsert({ id: "gar_effect_pulse_in", type: "link in", z: TAB, g: "gar_group_effect", name: "Receber pulso decidido", links: ["gar_request_pulse_out"], x: 960, y: 500, wires: [["gar_pulse_test_gate"]] });
upsert({ id: "gar_effect_safe_off_in", type: "link in", z: TAB, g: "gar_group_effect", name: "Receber OFF seguro", links: ["gar_request_safe_off_out"], x: 960, y: 780, wires: [["gar_safe_off_test_gate"]] });
upsert({ id: "gar_pulse_test_gate", type: "switch", z: TAB, g: "gar_group_effect", name: "Gate final: pulso produção ou TESTE?", property: "test_mode", propertyType: "msg", rules: [{ t: "neq", v: "true", vt: "bool" }, { t: "eq", v: "true", vt: "bool" }], checkall: "true", repair: false, outputs: 2, x: 1180, y: 500, wires: [["gar_prepare_pulse_delay"], ["gar_effect_dry_run_out"]] });
upsert({ id: "gar_prepare_pulse_delay", type: "change", z: TAB, g: "gar_group_effect", name: "Aplicar largura da política", rules: [{ t: "set", p: "delay", pt: "msg", to: "policy.pulse_ms", tot: "msg" }], x: 1520, y: 500, wires: [["gar_relay_pulse_on", "gar_log_pulse_started"]] });
upsert(functionNode("gar_relay_pulse_on", "gar_group_effect", "Adaptar MQTT: fechar contato (ON)", mqttCommand("ON"), 1, 2500, 460, [["gar_relay_on_publish_out", "gar_relay_safety_delay"]]));
upsert({ id: "gar_relay_on_publish_out", type: "link out", z: TAB, g: "gar_group_effect", name: "ON → publicação do relé", mode: "link", links: ["gar_relay_on_publish_in"], x: 2750, y: 460, wires: [] });
upsert({ id: "gar_relay_on_publish_in", type: "link in", z: TAB, g: "gar_group_effect", name: "Receber publicação ON", links: ["gar_relay_on_publish_out"], x: 3150, y: 460, wires: [["gar_relay_mqtt_out"]] });
upsert({ id: "gar_relay_safety_delay", type: "delay", z: TAB, g: "gar_group_effect", name: "Aguardar msg.delay da política", pauseType: "delayv", timeout: "700", timeoutUnits: "milliseconds", rate: "1", nbRateUnits: "1", rateUnits: "second", randomFirst: "1", randomLast: "5", randomUnits: "seconds", drop: false, allowrate: false, outputs: 1, x: 2800, y: 540, wires: [["gar_relay_pulse_off"]] });
upsert(functionNode("gar_relay_pulse_off", "gar_group_effect", "Adaptar MQTT: abrir contato (OFF)", mqttCommand("OFF"), 1, 3100, 580, [["gar_relay_mqtt_out"]]));
upsert({ id: "gar_relay_mqtt_out", type: "mqtt out", z: TAB, g: "gar_group_effect", name: "Efeito: publicar comando do relé", topic: "", qos: "", retain: "", respTopic: "", contentType: "", userProps: "", correl: "", expiry: "", broker: BROKER, x: 3400, y: 500, wires: [] });
upsert({ id: "gar_log_pulse_started", type: "api-call-service", z: TAB, g: "gar_group_effect", name: "Confirmar pedido aceito no Logbook", server: HA_SERVER, version: 7, debugenabled: false, action: "logbook.log", floorId: [], areaId: [], deviceId: [], entityId: [], labelId: [], data: '{"name":"Portão garagem","message":"pulso ÚNICO iniciado (origem: " & request.origin & ") — largura " & policy.pulse_ms & " ms, cooldown " & policy.cooldown_ms & " ms."}', dataType: "jsonata", mergeContext: "", mustacheAltTags: false, outputProperties: [], queue: "none", blockInputOverrides: true, domain: "logbook", service: "log", x: 2120, y: 580, wires: [[]] });
upsert({ id: "gar_safe_off_test_gate", type: "switch", z: TAB, g: "gar_group_effect", name: "Gate final: OFF seguro ou TESTE?", property: "test_mode", propertyType: "msg", rules: [{ t: "neq", v: "true", vt: "bool" }, { t: "eq", v: "true", vt: "bool" }], checkall: "true", repair: false, outputs: 2, x: 1180, y: 780, wires: [["gar_effect_safe_off_adapter_out", "gar_notify_relay_on"], ["gar_effect_dry_run_out"]] });
upsert({ id: "gar_effect_safe_off_adapter_out", type: "link out", z: TAB, g: "gar_group_effect", name: "OFF seguro → adapter MQTT", mode: "link", links: ["gar_effect_safe_off_adapter_in"], x: 1450, y: 740, wires: [] });
upsert({ id: "gar_effect_safe_off_adapter_in", type: "link in", z: TAB, g: "gar_group_effect", name: "Receber OFF seguro", links: ["gar_effect_safe_off_adapter_out"], x: 2800, y: 780, wires: [["gar_relay_pulse_off"]] });
upsert({ id: "gar_effect_dry_run_out", type: "link out", z: TAB, g: "gar_group_effect", name: "TESTE → terminal dry-run", mode: "link", links: ["gar_test_dry_run_in"], x: 1450, y: 640, wires: [] });
upsert({ id: "gar_notify_relay_on", type: "api-call-service", z: TAB, g: "gar_group_effect", name: "Avisar: relé já estava ON", server: HA_SERVER, version: 7, debugenabled: false, action: "persistent_notification.create", floorId: [], areaId: [], deviceId: [], entityId: [], labelId: [], data: '{"notification_id":"portao_garagem_rele_preso","title":"Portão da garagem - relé estava ligado","message":"O relé já estava ON. O Node-RED enviou somente OFF e recusou um novo pulso."}', dataType: "jsonata", mergeContext: "", mustacheAltTags: false, outputProperties: [], queue: "all", blockInputOverrides: true, domain: "persistent_notification", service: "create", x: 1650, y: 820, wires: [[]] });
upsert(group("gar_group_effect", "3. Gate final, efeitos e confirmação", ["gar_effect_pulse_in", "gar_effect_safe_off_in", "gar_pulse_test_gate", "gar_prepare_pulse_delay", "gar_relay_pulse_on", "gar_relay_on_publish_out", "gar_relay_on_publish_in", "gar_relay_safety_delay", "gar_relay_pulse_off", "gar_relay_mqtt_out", "gar_log_pulse_started", "gar_safe_off_test_gate", "gar_effect_safe_off_adapter_out", "gar_effect_safe_off_adapter_in", "gar_effect_dry_run_out", "gar_notify_relay_on"], 920, 390, 2600, 500, "#dc2626", "#fee2e2"));

const watchSet = required("gar_pulse_watch_set_in");
Object.assign(watchSet, { g: "gar_group_observer", x: 190, y: 460, wires: [["gar_pulse_watch_normalize"]] });
const watchState = required("gar_pulse_watch_state_in");
Object.assign(watchState, { g: "gar_group_observer", x: 190, y: 520, wires: [["gar_pulse_watch_normalize"]] });
upsert({ id: "gar_pulse_watch_note", type: "comment", z: TAB, g: "gar_group_observer", name: "Estado reportado impede ON; comando externo compartilha cooldown", info: "Somente o tópico de estado atualiza relay_state. Todo ON observado carimba o cooldown, sem gerar outro pulso.", x: 430, y: 420, wires: [] });
upsert(functionNode("gar_pulse_watch_normalize", "gar_group_observer", "Adaptar observação MQTT", relayObservationNormalize, 1, 440, 490, [["gar_pulse_watch_state_switch"]]));
upsert({ id: "gar_pulse_watch_state_switch", type: "switch", z: TAB, g: "gar_group_observer", name: "Estado observado é ON/OFF?", property: "relay_observation.state", propertyType: "msg", rules: [{ t: "eq", v: "ON", vt: "str" }, { t: "eq", v: "OFF", vt: "str" }], checkall: "true", repair: false, outputs: 2, x: 700, y: 490, wires: [["gar_pulse_watch_policy_out"], ["gar_pulse_watch_policy_out"]] });
upsert({ id: "gar_pulse_watch_policy_out", type: "link out", z: TAB, g: "gar_group_observer", name: "Observação válida → política", mode: "link", links: ["gar_pulse_watch_policy_in"], x: 850, y: 540, wires: [] });
upsert({ id: "gar_pulse_watch_policy_in", type: "link in", z: TAB, g: "gar_group_observer", name: "Receber observação válida", links: ["gar_pulse_watch_policy_out"], x: 250, y: 585, wires: [["gar_pulse_watch_load_policy"]] });
upsert({ id: "gar_pulse_watch_load_policy", type: "change", z: TAB, g: "gar_group_observer", name: "Carregar política válida", rules: [{ t: "set", p: "policy", pt: "msg", to: "$flowContext(\"garage_gate_policy_v1\", \"persistent\")", tot: "jsonata" }], x: 450, y: 585, wires: [["gar_pulse_watch_stamp"]] });
upsert(functionNode("gar_pulse_watch_stamp", "gar_group_observer", "Atualizar estado e timestamp", relayObservationStore, 0, 720, 585, []));
upsert(group("gar_group_observer", "2. Estado e deduplicação de observações", ["gar_pulse_watch_note", "gar_pulse_watch_set_in", "gar_pulse_watch_state_in", "gar_pulse_watch_normalize", "gar_pulse_watch_state_switch", "gar_pulse_watch_policy_out", "gar_pulse_watch_policy_in", "gar_pulse_watch_load_policy", "gar_pulse_watch_stamp"], 64, 390, 836, 250, "#7c3aed", "#ede9fe"));

upsert({ id: "gar_test_instructions", type: "comment", z: TAB, g: "gar_group_tests", name: "Ordem: reset → aceito → duplicado → cooldown → limite → relé ON. Tudo termina em dry-run.", info: "Nenhum botão de teste alcança MQTT, Home Assistant, Logbook, notificação ou dispositivo.", x: 455, y: 980, wires: [] });
upsert(inject("gar_test_reset", "gar_group_tests", "TESTE 1: reset", "", "", "date", 180, 1040, [["gar_test_reset_state"]]));
upsert(functionNode("gar_test_reset_state", "gar_group_tests", "Resetar estado sintético", testReset, 0, 430, 1040, []));
upsert(inject("gar_test_accept", "gar_group_tests", "TESTE 2: pulso aceito", "", '{"action":"single","origem":"teste","test_mode":true,"_test_now_ms":2000000}', "json", 200, 1100, [["gar_test_request_out_left"]]));
upsert(inject("gar_test_duplicate", "gar_group_tests", "TESTE 3: duplicado +500 ms", "", '{"action":"single","origem":"teste","test_mode":true,"_test_now_ms":2000500}', "json", 230, 1150, [["gar_test_request_out_left"]]));
upsert(inject("gar_test_cooldown", "gar_group_tests", "TESTE 4: cooldown +950 ms", "", '{"action":"single","origem":"teste","test_mode":true,"_test_now_ms":2000950}', "json", 230, 1200, [["gar_test_request_out_left"]]));
upsert(inject("gar_test_boundary", "gar_group_tests", "TESTE 5: limite +1.000 ms", "", '{"action":"single","origem":"teste","test_mode":true,"_test_now_ms":2001000}', "json", 235, 1250, [["gar_test_request_out_left"]]));
upsert({ id: "gar_test_request_out_left", type: "link out", z: TAB, g: "gar_group_tests", name: "Cenários TESTE → caminho real", mode: "link", links: ["gar_request_test_in"], x: 510, y: 1180, wires: [] });
upsert(inject("gar_test_relay_on", "gar_group_tests", "TESTE 6: relé já ON", "", '{"action":"single","origem":"teste","test_mode":true,"_test_now_ms":2003000}', "json", 700, 1100, [["gar_test_relay_on_prepare"]]));
upsert(functionNode("gar_test_relay_on_prepare", "gar_group_tests", "Preparar relé sintético ON", testRelayOn, 1, 970, 1100, [["gar_test_request_out_right"]]));
upsert({ id: "gar_test_request_out_right", type: "link out", z: TAB, g: "gar_group_tests", name: "Relé ON TESTE → caminho real", mode: "link", links: ["gar_request_test_in"], x: 1180, y: 1100, wires: [] });
upsert({ id: "gar_test_dry_run_in", type: "link in", z: TAB, g: "gar_group_tests", name: "Receber efeito TESTE", links: ["gar_effect_dry_run_out"], x: 1240, y: 1180, wires: [["gar_test_dry_run_terminal"]] });
upsert(functionNode("gar_test_dry_run_terminal", "gar_group_tests", "TESTE FINAL: nenhum efeito enviado", dryRun, 0, 1450, 1150, []));
upsert(group("gar_group_tests", "4. Testes manuais completos — dry-run", ["gar_test_instructions", "gar_test_reset", "gar_test_reset_state", "gar_test_accept", "gar_test_duplicate", "gar_test_cooldown", "gar_test_boundary", "gar_test_request_out_left", "gar_test_relay_on", "gar_test_relay_on_prepare", "gar_test_request_out_right", "gar_test_dry_run_in", "gar_test_dry_run_terminal"], 64, 950, 1846, 340, "#0891b2", "#cffafe"));

writeFileSync(OUT, JSON.stringify(installNotificationHubs(flows), null, 4) + "\n");
console.log(`Fluxo visual da garagem escrito em ${OUT}.`);
