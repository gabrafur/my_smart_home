#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";

const FLOWS = new URL("../flows.json", import.meta.url).pathname;
const OUT = process.argv[2] || FLOWS;
const TAB = "alarm_house_tab";
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

function change(id, groupId, name, rules, x, y, wires) {
  return {
    id, type: "change", z: TAB, g: groupId, name, rules,
    action: "", property: "", from: "", to: "", reg: false, x, y, wires,
  };
}

function linkIn(id, groupId, name, links, x, y, wires) {
  return { id, type: "link in", z: TAB, g: groupId, name, links, x, y, wires };
}

function linkOut(id, groupId, name, links, x, y) {
  return { id, type: "link out", z: TAB, g: groupId, name, mode: "link", links, x, y, wires: [] };
}

function switchNode(id, groupId, name, property, rules, x, y, wires) {
  return {
    id, type: "switch", z: TAB, g: groupId, name,
    property, propertyType: "msg", rules, checkall: "true", repair: false,
    outputs: rules.length, x, y, wires,
  };
}

const legacyIds = [
  "arm_alarm_retry_decision", "arm_alarm_retry_delay", "disarm_alarm_retry_decision",
  "disarm_alarm_retry_delay", "alarm_guard_arm", "alarm_guard_disarm",
  "4043829dac0a9fee", "0543222ad4ed094d",
];
const managedIds = [
  ...legacyIds,
  "alarm_group_policy", "alarm_policy_help", "alarm_policy_retry_seconds",
  "alarm_policy_notify_every", "alarm_policy_max_attempts", "alarm_policy_validate",
  "alarm_group_inputs", "alarm_event_normalize", "alarm_event_action_switch",
  "alarm_set_arrival_disarm", "alarm_arrival_intent_out", "alarm_arrival_intent_in",
  "alarm_test_request_in", "alarm_test_request_normalize",
  "alarm_test_action_switch", "alarm_record_intent", "alarm_intent_action_switch",
  "alarm_intent_ready_out", "alarm_group_retry", "alarm_failure_in",
  "alarm_failure_load_policy", "alarm_retry_evaluate", "alarm_retry_allowed_switch",
  "alarm_retry_delay_prepare", "alarm_retry_delay", "alarm_retry_read_desired",
  "alarm_retry_still_desired_switch", "alarm_retry_request_out",
  "alarm_retry_cancelled_terminal", "alarm_retry_exhausted_terminal",
  "alarm_retry_notify_switch", "alarm_retry_notify_out", "alarm_group_effects",
  "alarm_effect_request_in", "alarm_effect_load_policy", "alarm_effect_action_switch",
  "alarm_arm_final_gate", "alarm_disarm_final_gate", "alarm_arm_failure_prepare",
  "alarm_disarm_failure_prepare", "alarm_failure_out", "alarm_notification_in",
  "alarm_notification_final_gate", "alarm_security_dry_run_out",
  "alarm_notification_dry_run_out", "alarm_effect_dry_run_out", "alarm_group_tests",
  "alarm_test_instructions", "alarm_test_reset", "alarm_test_reset_state",
  "alarm_test_arm", "alarm_test_disarm", "alarm_test_failure_arm",
  "alarm_test_failure_prepare", "alarm_test_failure_out", "alarm_test_requests_out", "alarm_test_dry_run_in",
  "alarm_test_dry_run_terminal",
];
remove(managedIds);

const tab = required(TAB);
tab.info = "Fonte canônica visual para armar e desarmar o security_panel. Entradas convergem em uma intenção única; retries, avisos e limites vêm da política validada; todo TESTE termina em dry-run antes dos serviços.";

const duloDevice = required("de18d31309e8a0ca");
const armService = required("70eb073f8191e69e");
const disarmService = required("8261c7cfb6756ca8");
const updateService = required("moni_mobile_update_after_arm");
const notifyService = required("alarm_notify_alexa");

const policyValidate = String.raw`const limits = {
    retry_seconds: { min: 1, max: 300 },
    notify_every_attempts: { min: 1, max: 100 },
    max_attempts: { min: 0, max: 1000 }
};
const key = String(msg.topic ?? "");
const rule = limits[key];
const value = Number(msg.payload);
if (!rule || !Number.isInteger(value) || value < rule.min || value > rule.max) {
    node.error("Política do alarme inválida: " + (key || "campo ausente") + "=" + msg.payload, msg);
    return null;
}
const previous = flow.get("alarm_house_policy_v1", "persistent");
const candidate = previous?.version === 1 ? { ...previous } : { version: 1, owner: "node_red" };
candidate[key] = value;
candidate.complete = Object.keys(limits).every((field) => Number.isFinite(candidate[field]));
candidate.updated_at = Date.now();
flow.set("alarm_house_policy_v1", candidate, "persistent");
node.status({
    fill: candidate.complete ? "green" : "yellow",
    shape: candidate.complete ? "dot" : "ring",
    text: candidate.complete
        ? "retry " + candidate.retry_seconds + " s | aviso /" + candidate.notify_every_attempts
        : "aguardando os três valores"
});
return null;`;

const normalizeEvent = String.raw`const event = msg.payload && typeof msg.payload === "object" ? msg.payload : {};
msg.alarm_request = {
    action: String(event.action ?? "arm"),
    source: String(event.source ?? "home_assistant_event")
};
msg.test_mode = false;
return msg;`;

const normalizeTest = String.raw`const request = msg.payload && typeof msg.payload === "object" ? msg.payload : {};
msg.alarm_request = {
    action: String(request.action ?? ""),
    source: "manual_test"
};
msg.test_mode = true;
return msg;`;

const recordIntent = String.raw`const action = msg.alarm_request?.action;
if (action !== "arm" && action !== "disarm") {
    node.error("Intenção de alarme inválida: " + action, msg);
    return null;
}
const testMode = msg.test_mode === true;
const state = {
    version: 1,
    desired: action,
    source: String(msg.alarm_request?.source ?? "unknown"),
    updated_at: Date.now()
};
if (testMode) {
    flow.set("alarm_house_test_state_v1", state, "persistent");
} else {
    flow.set("alarm_house_state_v1", state, "persistent");
    flow.set("alarm_desired", action);
}
msg.retry_count = 0;
return msg;`;

const retryEvaluate = String.raw`const policy = msg.policy;
if (policy?.version !== 1 || policy?.complete !== true) {
    node.error("Política visual do alarme indisponível", msg);
    return null;
}
const attempt = Number.isInteger(msg.retry_count) ? msg.retry_count + 1 : 1;
const unlimited = policy.max_attempts === 0;
const retryAllowed = unlimited || attempt < policy.max_attempts;
const notifyNow = attempt === 1 || attempt % policy.notify_every_attempts === 0 || !retryAllowed;
msg.retry_count = attempt;
msg.retry = {
    attempt,
    retry_allowed: retryAllowed,
    notify_now: notifyNow,
    delay_ms: policy.retry_seconds * 1000,
    reason: retryAllowed ? "temporary_service_failure" : "attempt_limit_reached"
};
const actionLabel = msg.alarm_request?.action === "disarm" ? "desarmar" : "armar";
msg.notify_text = retryAllowed
    ? "Falha ao " + actionLabel + " o alarme. Tentativa " + attempt + "; nova tentativa em " + policy.retry_seconds + " s."
    : "Falha ao " + actionLabel + " o alarme. Limite de " + policy.max_attempts + " tentativas atingido.";
return msg;`;

const readDesired = String.raw`const testMode = msg.test_mode === true;
const state = flow.get(testMode ? "alarm_house_test_state_v1" : "alarm_house_state_v1", "persistent");
const legacy = testMode ? null : flow.get("alarm_desired");
msg.retry = msg.retry ?? {};
msg.retry.still_desired = (state?.desired ?? legacy) === msg.alarm_request?.action;
return msg;`;

const testReset = String.raw`flow.set("alarm_house_test_state_v1", {}, "persistent");
node.status({ fill: "blue", shape: "dot", text: "estado TESTE limpo" });
return null;`;

const dryRun = String.raw`msg.payload = {
    simulated: true,
    dispatched: false,
    domain: "alarm_house",
    requested_action: msg.alarm_request?.action ?? "notification",
    boundary: msg.dry_run_boundary ?? "security_panel_service",
    retry_attempt: msg.retry?.attempt ?? 0
};
node.warn("ALARM_HOUSE_DRY_RUN " + JSON.stringify(msg.payload));
node.status({ fill: "blue", shape: "ring", text: "TESTE: " + msg.payload.requested_action });
return null;`;

upsert(group("alarm_group_policy", "0. Política visual — edite os valores", [
  "alarm_policy_help", "alarm_policy_retry_seconds", "alarm_policy_notify_every",
  "alarm_policy_max_attempts", "alarm_policy_validate",
], 64, 40, 636, 260, "#2563eb", "#dbeafe"));
upsert({
  id: "alarm_policy_help", type: "comment", z: TAB, g: "alarm_group_policy",
  name: "Duplo clique no número → altere → Deploy. Inválido preserva a última política válida.",
  info: "Retry: 1–300 s. Aviso: a cada 1–100 falhas, além da primeira. Limite: 0 mantém retries sem limite (comportamento anterior); 1–1.000 limita tentativas.",
  x: 380, y: 80, wires: [],
});
upsert(inject("alarm_policy_retry_seconds", "alarm_group_policy", "Intervalo de retry — 10 s", "retry_seconds", 10, "num", 220, 140, [["alarm_policy_validate"]], true));
upsert(inject("alarm_policy_notify_every", "alarm_group_policy", "Avisar a cada — 5 tentativas", "notify_every_attempts", 5, "num", 230, 190, [["alarm_policy_validate"]], true));
upsert(inject("alarm_policy_max_attempts", "alarm_group_policy", "Limite — 0 (sem limite)", "max_attempts", 0, "num", 220, 240, [["alarm_policy_validate"]], true));
upsert(functionNode("alarm_policy_validate", "alarm_group_policy", "Validar e preservar política única", policyValidate, 0, 535, 190, []));

Object.assign(required("alarm_dulo_hub_link_in"), {
  g: "alarm_group_inputs", x: 820, y: 100, wires: [["de18d31309e8a0ca"]],
});
Object.assign(duloDevice, {
  g: "alarm_group_inputs", name: "Adaptar dispositivo Dulo: Alarme Casa",
  x: 1040, y: 100, wires: [["922ddf470a08d43f"]],
});
Object.assign(required("922ddf470a08d43f"), {
  g: "alarm_group_inputs", name: "Decisão visual: Dulo ON ou OFF?", x: 1360, y: 100,
  wires: [["alarm_set_desired_arm"], ["alarm_set_desired_disarm"]],
});
upsert(change("alarm_set_desired_arm", "alarm_group_inputs", "Preparar intenção: armar via Dulo", [
  { t: "set", p: "alarm_request", pt: "msg", to: '{"action":"arm","source":"dulo_switch"}', tot: "json" },
  { t: "set", p: "test_mode", pt: "msg", to: "false", tot: "bool" },
], 1660, 80, [["alarm_record_intent"]]));
upsert(change("alarm_set_desired_disarm", "alarm_group_inputs", "Preparar intenção: desarmar via Dulo", [
  { t: "set", p: "alarm_request", pt: "msg", to: '{"action":"disarm","source":"dulo_switch"}', tot: "json" },
  { t: "set", p: "test_mode", pt: "msg", to: "false", tot: "bool" },
], 1670, 130, [["alarm_record_intent"]]));
Object.assign(required("moni_mobile_arm_event"), {
  g: "alarm_group_inputs", name: "Pedido canônico do Home Assistant", x: 890, y: 190,
  wires: [["alarm_event_normalize"]],
});
upsert(functionNode("alarm_event_normalize", "alarm_group_inputs", "Adaptar evento HA", normalizeEvent, 1, 1150, 190, [["alarm_event_action_switch"]]));
upsert(switchNode("alarm_event_action_switch", "alarm_group_inputs", "Decisão: evento arma ou desarma?", "alarm_request.action", [
  { t: "eq", v: "arm", vt: "str" }, { t: "eq", v: "disarm", vt: "str" },
], 1430, 190, [["alarm_record_intent"], ["alarm_record_intent"]]));
Object.assign(required("alarm_arrival_disarm_command_in"), {
  g: "alarm_group_inputs", name: "Pedido canônico: desarme por chegada", x: 890, y: 260,
  wires: [["alarm_set_arrival_disarm"]],
});
upsert(change("alarm_set_arrival_disarm", "alarm_group_inputs", "Preparar intenção: desarmar por chegada", [
  { t: "set", p: "alarm_request", pt: "msg", to: '{"action":"disarm","source":"arrival_policy"}', tot: "json" },
  { t: "set", p: "test_mode", pt: "msg", to: "false", tot: "bool" },
], 1210, 260, [["alarm_arrival_intent_out"]]));
upsert(linkOut("alarm_arrival_intent_out", "alarm_group_inputs", "Chegada normalizada → intenção", ["alarm_arrival_intent_in"], 1460, 260));
upsert(linkIn("alarm_arrival_intent_in", "alarm_group_inputs", "Receber intenção da chegada", ["alarm_arrival_intent_out"], 1630, 280, [["alarm_record_intent"]]));
upsert(linkIn("alarm_test_request_in", "alarm_group_inputs", "Receber intenção TESTE", ["alarm_test_requests_out"], 820, 320, [["alarm_test_request_normalize"]]));
upsert(functionNode("alarm_test_request_normalize", "alarm_group_inputs", "Adaptar intenção sintética", normalizeTest, 1, 1070, 320, [["alarm_test_action_switch"]]));
upsert(switchNode("alarm_test_action_switch", "alarm_group_inputs", "Decisão TESTE: armar ou desarmar?", "alarm_request.action", [
  { t: "eq", v: "arm", vt: "str" }, { t: "eq", v: "disarm", vt: "str" },
], 1360, 320, [["alarm_record_intent"], ["alarm_record_intent"]]));
upsert(functionNode("alarm_record_intent", "alarm_group_inputs", "Registrar intenção e estado isolado", recordIntent, 1, 1810, 230, [["alarm_intent_action_switch"]]));
upsert(switchNode("alarm_intent_action_switch", "alarm_group_inputs", "Decisão canônica: armar ou desarmar?", "alarm_request.action", [
  { t: "eq", v: "arm", vt: "str" }, { t: "eq", v: "disarm", vt: "str" },
], 2140, 230, [["alarm_intent_ready_out"], ["alarm_intent_ready_out"]]));
upsert(linkOut("alarm_intent_ready_out", "alarm_group_inputs", "Intenção validada → gate final", ["alarm_effect_request_in"], 2400, 230));
upsert(group("alarm_group_inputs", "1. Entradas, adaptação, estado e decisão canônica", [
  "alarm_dulo_hub_link_in", "de18d31309e8a0ca", "922ddf470a08d43f",
  "alarm_set_desired_arm", "alarm_set_desired_disarm", "moni_mobile_arm_event",
  "alarm_event_normalize", "alarm_event_action_switch", "alarm_arrival_disarm_command_in",
  "alarm_set_arrival_disarm", "alarm_arrival_intent_out", "alarm_arrival_intent_in",
  "alarm_test_request_in", "alarm_test_request_normalize",
  "alarm_test_action_switch", "alarm_record_intent", "alarm_intent_action_switch",
  "alarm_intent_ready_out",
], 740, 40, 1760, 330, "#0f766e", "#ccfbf1"));

upsert(linkIn("alarm_failure_in", "alarm_group_retry", "Receber falha real ou sintética", ["alarm_failure_out", "alarm_test_failure_out"], 120, 450, [["alarm_failure_load_policy"]]));
upsert(change("alarm_failure_load_policy", "alarm_group_retry", "Carregar política visual válida", [
  { t: "set", p: "policy", pt: "msg", to: '$flowContext("alarm_house_policy_v1", "persistent")', tot: "jsonata" },
], 370, 450, [["alarm_retry_evaluate"]]));
upsert(functionNode("alarm_retry_evaluate", "alarm_group_retry", "Calcular contador (sem decidir rota)", retryEvaluate, 1, 670, 450, [["alarm_retry_allowed_switch", "alarm_retry_notify_switch"]]));
upsert(switchNode("alarm_retry_allowed_switch", "alarm_group_retry", "Retry permitido pelo limite?", "retry.retry_allowed", [
  { t: "eq", v: "true", vt: "bool" }, { t: "else" },
], 970, 430, [["alarm_retry_delay_prepare"], ["alarm_retry_exhausted_terminal"]]));
upsert(change("alarm_retry_delay_prepare", "alarm_group_retry", "Aplicar intervalo da política", [
  { t: "set", p: "delay", pt: "msg", to: "retry.delay_ms", tot: "msg" },
], 1260, 400, [["alarm_retry_delay"]]));
upsert({
  id: "alarm_retry_delay", type: "delay", z: TAB, g: "alarm_group_retry",
  name: "Aguardar msg.delay da política", pauseType: "delayv", timeout: "10",
  timeoutUnits: "seconds", rate: "1", nbRateUnits: "1", rateUnits: "second",
  randomFirst: "1", randomLast: "5", randomUnits: "seconds", drop: false,
  allowrate: false, outputs: 1, x: 1530, y: 400, wires: [["alarm_retry_read_desired"]],
});
upsert(functionNode("alarm_retry_read_desired", "alarm_group_retry", "Ler última intenção (sem decidir)", readDesired, 1, 1810, 400, [["alarm_retry_still_desired_switch"]]));
upsert(switchNode("alarm_retry_still_desired_switch", "alarm_group_retry", "A intenção ainda é a mesma?", "retry.still_desired", [
  { t: "eq", v: "true", vt: "bool" }, { t: "else" },
], 2080, 400, [["alarm_retry_request_out"], ["alarm_retry_cancelled_terminal"]]));
upsert(linkOut("alarm_retry_request_out", "alarm_group_retry", "Retry confirmado → gate final", ["alarm_effect_request_in"], 2370, 410));
upsert({
  id: "alarm_retry_cancelled_terminal", type: "debug", z: TAB, g: "alarm_group_retry",
  name: "Diagnóstico: retry cancelado por nova intenção", active: true, tosidebar: true,
  console: false, tostatus: true, complete: "retry", targetType: "msg",
  statusVal: "retry.reason", statusType: "msg", x: 2370, y: 450, wires: [],
});
upsert({
  id: "alarm_retry_exhausted_terminal", type: "debug", z: TAB, g: "alarm_group_retry",
  name: "Diagnóstico: limite de retries atingido", active: true, tosidebar: true,
  console: false, tostatus: true, complete: "retry", targetType: "msg",
  statusVal: "retry.reason", statusType: "msg", x: 1120, y: 480, wires: [],
});
upsert(switchNode("alarm_retry_notify_switch", "alarm_group_retry", "Avisar na 1ª / a cada N / no limite?", "retry.notify_now", [
  { t: "eq", v: "true", vt: "bool" }, { t: "else" },
], 970, 540, [["alarm_retry_notify_out"], []]));
upsert(linkOut("alarm_retry_notify_out", "alarm_group_retry", "Aviso de falha → gate de notificação", ["alarm_notification_in"], 1260, 540));
upsert(group("alarm_group_retry", "2. Política temporal, retry e cancelamento", [
  "alarm_failure_in", "alarm_failure_load_policy", "alarm_retry_evaluate",
  "alarm_retry_allowed_switch", "alarm_retry_delay_prepare", "alarm_retry_delay",
  "alarm_retry_read_desired", "alarm_retry_still_desired_switch",
  "alarm_retry_request_out", "alarm_retry_cancelled_terminal",
  "alarm_retry_exhausted_terminal", "alarm_retry_notify_switch", "alarm_retry_notify_out",
], 64, 380, 2500, 230, "#7c3aed", "#ede9fe"));

upsert(linkIn("alarm_effect_request_in", "alarm_group_effects", "Receber intenção ou retry", ["alarm_intent_ready_out", "alarm_retry_request_out"], 820, 680, [["alarm_effect_load_policy"]]));
upsert(change("alarm_effect_load_policy", "alarm_group_effects", "Carregar política para o efeito", [
  { t: "set", p: "policy", pt: "msg", to: '$flowContext("alarm_house_policy_v1", "persistent")', tot: "jsonata" },
], 1040, 680, [["alarm_effect_action_switch"]]));
upsert(switchNode("alarm_effect_action_switch", "alarm_group_effects", "Efeito solicitado: armar ou desarmar?", "alarm_request.action", [
  { t: "eq", v: "arm", vt: "str" }, { t: "eq", v: "disarm", vt: "str" },
], 1340, 680, [["alarm_arm_final_gate"], ["alarm_disarm_final_gate"]]));
upsert(switchNode("alarm_arm_final_gate", "alarm_group_effects", "Gate final: armar produção ou TESTE?", "test_mode", [
  { t: "neq", v: "true", vt: "bool" }, { t: "eq", v: "true", vt: "bool" },
], 1680, 650, [["70eb073f8191e69e"], ["alarm_security_dry_run_out"]]));
upsert(switchNode("alarm_disarm_final_gate", "alarm_group_effects", "Gate final: desarmar produção ou TESTE?", "test_mode", [
  { t: "neq", v: "true", vt: "bool" }, { t: "eq", v: "true", vt: "bool" },
], 1690, 750, [["8261c7cfb6756ca8"], ["alarm_security_dry_run_out"]]));
upsert(linkOut("alarm_security_dry_run_out", "alarm_group_effects", "Armar/desarmar TESTE → dry-run", ["alarm_test_dry_run_in"], 1900, 700));
Object.assign(armService, {
  g: "alarm_group_effects", name: "EFEITO: armar security_panel", x: 2050, y: 630,
  wires: [["arm_alarm_notify_success"]],
});
upsert(change("arm_alarm_notify_success", "alarm_group_effects", "Confirmar aceite: alarme armado", [
  { t: "set", p: "notify_text", pt: "msg", to: "Alarme armado com sucesso.", tot: "str" },
], 2350, 630, [["moni_mobile_update_after_arm"]]));
Object.assign(updateService, {
  g: "alarm_group_effects", name: "EFEITO: atualizar estado publicado", x: 2650, y: 630,
  wires: [["alarm_notification_final_gate"]],
});
Object.assign(disarmService, {
  g: "alarm_group_effects", name: "EFEITO: desarmar security_panel", x: 2050, y: 750,
  wires: [["disarm_alarm_notify_success"]],
});
upsert(change("disarm_alarm_notify_success", "alarm_group_effects", "Confirmar aceite: alarme desarmado", [
  { t: "set", p: "notify_text", pt: "msg", to: "Alarme desarmado com sucesso.", tot: "str" },
], 2390, 750, [["alarm_notification_final_gate"]]));
upsert({
  id: "arm_alarm_catch", type: "catch", z: TAB, g: "alarm_group_effects",
  name: "Capturar falha ao armar", scope: ["70eb073f8191e69e"], uncaught: false,
  x: 1040, y: 810, wires: [["alarm_arm_failure_prepare"]],
});
upsert(change("alarm_arm_failure_prepare", "alarm_group_effects", "Identificar falha: armar", [
  { t: "set", p: "alarm_request.action", pt: "msg", to: "arm", tot: "str" },
  { t: "set", p: "dry_run_boundary", pt: "msg", to: "retry_notification", tot: "str" },
], 1290, 810, [["alarm_failure_out"]]));
upsert({
  id: "disarm_alarm_catch", type: "catch", z: TAB, g: "alarm_group_effects",
  name: "Capturar falha ao desarmar", scope: ["8261c7cfb6756ca8"], uncaught: false,
  x: 1050, y: 860, wires: [["alarm_disarm_failure_prepare"]],
});
upsert(change("alarm_disarm_failure_prepare", "alarm_group_effects", "Identificar falha: desarmar", [
  { t: "set", p: "alarm_request.action", pt: "msg", to: "disarm", tot: "str" },
  { t: "set", p: "dry_run_boundary", pt: "msg", to: "retry_notification", tot: "str" },
], 1300, 860, [["alarm_failure_out"]]));
upsert(linkOut("alarm_failure_out", "alarm_group_effects", "Falha de serviço → política de retry", ["alarm_failure_in"], 1530, 835));
upsert(linkIn("alarm_notification_in", "alarm_group_effects", "Receber aviso de falha", ["alarm_retry_notify_out"], 2550, 840, [["alarm_notification_final_gate"]]));
upsert(switchNode("alarm_notification_final_gate", "alarm_group_effects", "Gate final: aviso produção ou TESTE?", "test_mode", [
  { t: "neq", v: "true", vt: "bool" }, { t: "eq", v: "true", vt: "bool" },
], 2810, 790, [["alarm_notify_alexa"], ["alarm_notification_dry_run_out"]]));
Object.assign(notifyService, {
  g: "alarm_group_effects", name: "EFEITO: notificar resident_primary", x: 3120, y: 760,
  wires: [[]],
});
upsert(linkOut("alarm_notification_dry_run_out", "alarm_group_effects", "Aviso TESTE → dry-run", ["alarm_test_dry_run_in"], 3120, 840));
upsert(group("alarm_group_effects", "3. Gates finais, efeitos e confirmação", [
  "alarm_effect_request_in", "alarm_effect_load_policy", "alarm_effect_action_switch",
  "alarm_arm_final_gate", "alarm_disarm_final_gate", "70eb073f8191e69e",
  "arm_alarm_notify_success", "moni_mobile_update_after_arm", "8261c7cfb6756ca8",
  "disarm_alarm_notify_success", "arm_alarm_catch", "alarm_arm_failure_prepare",
  "disarm_alarm_catch", "alarm_disarm_failure_prepare", "alarm_failure_out",
  "alarm_notification_in", "alarm_notification_final_gate", "alarm_notify_alexa",
  "alarm_security_dry_run_out", "alarm_notification_dry_run_out",
], 740, 610, 2540, 300, "#dc2626", "#fee2e2"));

upsert({
  id: "alarm_test_instructions", type: "comment", z: TAB, g: "alarm_group_tests",
  name: "Ordem: reset → armar → falha simulada → desarmar. Aguarde 10 s para observar retry ou cancelamento.",
  info: "Entradas sintéticas usam estado separado. Elas percorrem adaptação, decisão, retry e gates reais; nenhum serviço Home Assistant é chamado.",
  x: 500, y: 980, wires: [],
});
upsert(inject("alarm_test_reset", "alarm_group_tests", "TESTE 1: reset", "", "", "date", 180, 1040, [["alarm_test_reset_state"]]));
upsert(functionNode("alarm_test_reset_state", "alarm_group_tests", "Resetar estado sintético", testReset, 0, 430, 1040, []));
upsert(inject("alarm_test_arm", "alarm_group_tests", "TESTE 2: pedir armar", "", '{"action":"arm"}', "json", 190, 1100, [["alarm_test_requests_out"]]));
upsert(inject("alarm_test_disarm", "alarm_group_tests", "TESTE 4: pedir desarmar", "", '{"action":"disarm"}', "json", 200, 1160, [["alarm_test_requests_out"]]));
upsert(linkOut("alarm_test_requests_out", "alarm_group_tests", "Pedidos TESTE → caminho canônico", ["alarm_test_request_in"], 480, 1130));
upsert(inject("alarm_test_failure_arm", "alarm_group_tests", "TESTE 3: falha ao armar", "", '{"action":"arm"}', "json", 730, 1080, [["alarm_test_failure_out"]]));
upsert(change("alarm_test_failure_prepare", "alarm_group_tests", "Preparar falha sintética", [
  { t: "set", p: "alarm_request", pt: "msg", to: "payload", tot: "msg" },
  { t: "set", p: "test_mode", pt: "msg", to: "true", tot: "bool" },
  { t: "set", p: "retry_count", pt: "msg", to: "0", tot: "num" },
  { t: "set", p: "dry_run_boundary", pt: "msg", to: "retry_notification", tot: "str" },
], 990, 1080, [["alarm_test_failure_out"]]));
upsert(linkOut("alarm_test_failure_out", "alarm_group_tests", "Falha TESTE → política de retry", ["alarm_failure_in"], 1210, 1080));
upsert(linkIn("alarm_test_dry_run_in", "alarm_group_tests", "Receber efeito TESTE", ["alarm_security_dry_run_out", "alarm_notification_dry_run_out"], 1220, 1150, [["alarm_test_dry_run_terminal"]]));
upsert(functionNode("alarm_test_dry_run_terminal", "alarm_group_tests", "TESTE FINAL: registrar sem enviar", dryRun, 0, 1480, 1150, []));
upsert(group("alarm_group_tests", "4. Testes manuais completos — dry-run", [
  "alarm_test_instructions", "alarm_test_reset", "alarm_test_reset_state",
  "alarm_test_arm", "alarm_test_disarm", "alarm_test_requests_out",
  "alarm_test_failure_arm", "alarm_test_failure_prepare", "alarm_test_failure_out", "alarm_test_dry_run_in",
  "alarm_test_dry_run_terminal",
], 64, 930, 1600, 280, "#0891b2", "#cffafe"));

writeFileSync(OUT, JSON.stringify(flows, null, 4) + "\n");
console.log(`Fluxo visual do alarme escrito em ${OUT}.`);
