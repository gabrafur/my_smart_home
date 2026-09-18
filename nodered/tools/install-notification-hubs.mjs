#!/usr/bin/env node

import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { nodeDimensions } from "./flow-layout-validator.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const functionsDir = path.join(here, "functions");
const SERVER = "4126427d5e161a03";
const OBSERVER_INPUT = "global_observer_alert_to_dispatch_in";

export const NOTIFICATION_HUBS = Object.freeze({
  mobile: Object.freeze({ tab: "notification_hub_mobile_tab", input: "notification_hub_mobile_in" }),
  alexa: Object.freeze({ tab: "notification_hub_alexa_tab", input: "notification_hub_alexa_in" }),
  persistent: Object.freeze({ tab: "notification_hub_persistent_tab", input: "notification_hub_persistent_in" }),
});

const LEGACY_SUBFLOW = "infra_notify_all_mobiles";
const INFRASTRUCTURE_CALLERS = Object.freeze([
  "vpn_monitor_notify_dispatch",
  "internet_notify_down",
  "internet_notify_recovery",
  "zigbee_notify_effect",
  "tuya_notify_effect",
]);

const rpiStartMessage = '"A CPU chegou a " & $string(trigger_temperature) & " °C. O ar-condicionado do escritorio foi controlado em 16 °C, modo frio e ventilacao maxima. Origem: " & start_source & ". Ele sera restaurado depois que a CPU permanecer abaixo de 70 °C por 10 minutos."';
const mobile = (id, source, recipient, profile, title, message, data, extra = {}) => ({
  id, channel: "mobile", source, recipient, profile, title, message, data, ...extra,
});
const alexa = (id, source, message, extra = {}) => ({
  id, channel: "alexa", source, target: "voice_assistant_primary", mode: "announce", message, ...extra,
});
const persistent = (id, source, operation, delivery, notificationId, title, message, extra = {}) => ({
  id, channel: "persistent", source, operation, delivery, notificationId, title, message, ...extra,
});

export const NOTIFICATION_MIGRATIONS = Object.freeze([
  persistent("gar_notify_relay_on", "garagem", "create", "queued", '"portao_garagem_rele_preso"', '"Portão da garagem - relé estava ligado"', '"O relé já estava ON. O Node-RED enviou somente OFF e recusou um novo pulso."'),
  alexa("9d81b75a18d482f1", "iluminacao_externa", "notify_text"),
  mobile("ext_send_recovery_mobile", "iluminacao_externa", "resident_primary", "actionable", "notification_title", "notification_message", '{"tag":notification_tag,"actions":[{"action":confirm_action,"title":"Ligar"},{"action":cancel_action,"title":"Não ligar"}]}', { testMode: "_external_lighting_test = true" }),
  alexa("alarm_notify_alexa", "alarme_casa", "notify_text"),
  persistent("349bc099633fee5d", "resfriamento_raspberry_pi", "create", "immediate", '"raspberry_pi_emergency_cooling"', '"Raspberry Pi - resfriamento de emergencia"', rpiStartMessage),
  persistent("a240a1bb42481943", "resfriamento_raspberry_pi", "create", "immediate", '"raspberry_pi_emergency_cooling_recovered"', '"Raspberry Pi - temperatura normalizada"', '"A CPU permaneceu abaixo de 70 °C por 10 minutos e esta em " & $string(trigger_temperature) & " °C. " & (restore.state = "off" ? "O ar-condicionado foi desligado, como estava antes da emergência." : "O estado anterior do ar-condicionado foi restaurado (modo " & restore.state & ", " & $string(restore.temperature) & " °C, ventilação " & $string(restore.fan_mode) & ").") & (restore_fallback ? " O snapshot estava indisponível; foi aplicado o fallback seguro de desligamento." : "") & " Origem: " & stop_source & "."'),
  persistent("ab4f85af1ed94f86", "resfriamento_raspberry_pi", "create", "immediate", '"raspberry_pi_emergency_cooling_failure"', '"Raspberry Pi - falha no resfriamento automático"', '"Operação " & failure_operation & " falhou após " & $string(attempt) & " tentativa(s): " & failure_reason & ". Temperatura observada: " & $string(trigger_temperature) & " °C. Ownership: " & $string(cooling_owner) & ". Verifique o Node-RED e " & "climate.ar_condicionado_escritorio" & "."'),
  persistent("5dd0deebdc474035", "resfriamento_raspberry_pi", "dismiss", "immediate", '"raspberry_pi_emergency_cooling"'),
  persistent("36968b4881eab9d3", "resfriamento_raspberry_pi", "dismiss", "immediate", '"raspberry_pi_emergency_cooling_failure"'),
  persistent("4b48bc3c0c58d87c", "resfriamento_raspberry_pi", "dismiss", "immediate", '"raspberry_pi_emergency_cooling_recovered"'),
  mobile("rpi_emergency_cooling_push_primary", "resfriamento_raspberry_pi", "resident_primary", "simple", '"Raspberry Pi - resfriamento de emergencia"', rpiStartMessage),
  alexa("rpi_emergency_cooling_alexa_primary", "resfriamento_raspberry_pi", '"Raspberry Pi - resfriamento de emergencia. A CPU chegou a " & $string(trigger_temperature) & " °C. O ar-condicionado do escritorio foi controlado em 16 °C, modo frio e ventilacao maxima. Origem: " & start_source & ". Ele sera restaurado depois que a CPU permanecer abaixo de 70 °C por 10 minutos."'),
  mobile("storage_notify", "storage_health", "resident_primary", "simple", "_notification_hub_context.payload.title", "_notification_hub_context.payload.message"),
  mobile("storage_notify_secondary", "storage_health", "resident_secondary", "simple", "_notification_hub_context.payload.title", "_notification_hub_context.payload.message"),
  persistent("storage_notify_persistent", "storage_health", "create", "queued", '"raspberry_storage_health"', "_notification_hub_context.payload.title", "_notification_hub_context.payload.message"),
  mobile("564fdc36031eaef8", "localizacao_pessoas", "resident_primary", "background_command", null, '"request_location_update"', null, { testMode: "_location_test = true" }),
  mobile("e0b7c0ecf1d8ee28", "localizacao_pessoas", "resident_secondary", "background_command", null, '"request_location_update"', null, { testMode: "_location_test = true" }),
  persistent("vehicle_primary_manual_refresh_blocked_notification_v1", "contexto_vehicle_primary", "create", "immediate", "_notification_hub_context.notification.id", "_notification_hub_context.notification.title", "_notification_hub_context.notification.message"),
  mobile("vehicle_primary_refresh_notify_primary_v1", "contexto_vehicle_primary", "resident_primary", "simple", "alert.title", "alert.message", null, { testMode: "_location_test = true" }),
  mobile("vehicle_primary_remote_command_notify_primary_v1", "contexto_vehicle_primary", "resident_primary", "simple", "alert.title", "alert.message", null, { testMode: "_vehicle_primary_remote_command_test = true" }),
  persistent("vehicle_primary_remote_command_notify_persistent_v1", "contexto_vehicle_primary", "create", "queued", "_notification_hub_context.notification.id", "_notification_hub_context.notification.title", "_notification_hub_context.notification.message", { testMode: "_vehicle_primary_remote_command_test = true" }),
  persistent("vehicle_primary_refresh_notify_persistent_v1", "contexto_vehicle_primary", "create", "queued", "_notification_hub_context.notification.id", "_notification_hub_context.notification.title", "_notification_hub_context.notification.message", { testMode: "_location_test = true" }),
  persistent("vehicle_primary_refresh_dismiss_persistent_v1", "contexto_vehicle_primary", "dismiss", "queued", "_notification_hub_context.notification.id", null, null, { testMode: "_location_test = true" }),
  mobile("2818bf202b397612", "iluminacao_seguranca", "resident_primary", "actionable", '_notification_hub_context.payload.test_mode=true ? "Casa inteligente — TESTE" : "Casa inteligente"', '_notification_hub_context.payload.test_mode=true ? "[TESTE] O refletor da garagem foi ligado." : "O refletor da garagem foi ligado."', null, { testMode: "_notification_hub_context.payload.test_mode = true" }),
  mobile("light_notify_on_secondary", "iluminacao_seguranca", "resident_secondary", "actionable", '_notification_hub_context.payload.test_mode=true ? "Casa inteligente — TESTE" : "Casa inteligente"', '_notification_hub_context.payload.test_mode=true ? "[TESTE] O refletor da garagem foi ligado." : "O refletor da garagem foi ligado."', null, { testMode: "_notification_hub_context.payload.test_mode = true" }),
  mobile("04007cc1732f60c9", "iluminacao_seguranca", "resident_primary", "actionable", '_notification_hub_context.payload.test_mode=true ? "Casa inteligente — TESTE — erro no refletor" : "Casa inteligente — erro no refletor"', "_notification_hub_context.payload.message", null, { testMode: "_notification_hub_context.payload.test_mode = true" }),
  mobile("light_notify_unavailable_secondary", "iluminacao_seguranca", "resident_secondary", "actionable", '_notification_hub_context.payload.test_mode=true ? "Casa inteligente — TESTE — erro no refletor" : "Casa inteligente — erro no refletor"', "_notification_hub_context.payload.message", null, { testMode: "_notification_hub_context.payload.test_mode = true" }),
  mobile("3b95712a74512929", "alarme_desarme_chegada", "resident_primary", "actionable", "notification_title", "notification_message", '{"tag":notification_tag,"actions":[{"action":confirm_action,"title":confirm_action_title},{"action":cancel_action,"title":cancel_action_title}]}', { testMode: "_alarm_arrival_test = true" }),
  mobile("370622ddaaf3fcab", "alarme_desarme_chegada", "resident_secondary", "actionable", "notification_title", "notification_message", '{"tag":notification_tag,"actions":[{"action":confirm_action,"title":confirm_action_title},{"action":cancel_action,"title":cancel_action_title}]}', { testMode: "_alarm_arrival_test = true" }),
  persistent("local_ai_rtx_alert_dismiss", "recuperacao_rtx", "dismiss", "queued", '"nodered_observabilidade_global_domain_alert_local_ai_rtx_unavailable"'),
  persistent("internet_remote_alert_dismiss", "monitoramento_internet", "dismiss", "queued", '"nodered_observabilidade_global_domain_alert_remote_access_ssh_unavailable"'),
  mobile("codex_alert_push", "alertas_codex", "resident_primary", "simple", "alert.title", "alert.message", null, { testMode: "_codex_test = true" }),
  persistent("codex_alert_persistent", "alertas_codex", "create", "queued", '"codex_alert_" & alert.kind', "alert.title", "alert.message", { testMode: "_codex_test = true" }),
  mobile("git_backup_notify_primary", "backup_git", "resident_primary", "simple", "alert.title", "alert.message", null, { testMode: "_git_backup_test = true" }),
  persistent("git_backup_notify_persistent", "backup_git", "create", "queued", '"git_backup_failure"', "alert.title", "alert.message", { testMode: "_git_backup_test = true" }),
  mobile("resident_notifications_notify_primary", "notificacoes_chegadas_residentes", "resident_primary", "actionable", '"Casa inteligente"', "_notification_hub_context.payload.message", '{"tag":_notification_hub_context.payload.notification_key,"push":{"sound":"default","interruption-level":"time-sensitive"}}', { testMode: "_location_test = true" }),
  mobile("resident_notifications_notify_secondary", "notificacoes_chegadas_residentes", "resident_secondary", "actionable", '"Casa inteligente"', "_notification_hub_context.payload.message", '{"tag":_notification_hub_context.payload.notification_key,"push":{"sound":"default","interruption-level":"time-sensitive"}}', { testMode: "_location_test = true" }),
  mobile("resident_notifications_test_notify_secondary", "notificacoes_chegadas_residentes", "resident_secondary", "actionable", '"TESTE — Casa inteligente"', '"TESTE — confirmação do push de chegada para o celular."', '{"tag":"resident-notification-delivery-test","push":{"sound":"default","interruption-level":"time-sensitive"}}', { testMode: "true", deliveryUnderTest: "true" }),
  mobile("global_observer_notify_primary", "observabilidade_global", "resident_primary", "simple", '_observer_delivery_test=true ? "TESTE — Monitor global do Node-RED" : alert.title', '_observer_delivery_test=true ? "TESTE de entrega do canal central de falhas do Node-RED via Home Assistant." : alert.message', null, { testMode: "_observer_delivery_test = true", deliveryUnderTest: "_observer_delivery_test = true", beforeRules: [{ t: "set", p: "_observer_notification_channel", pt: "msg", to: "mobile_primary", tot: "str" }] }),
  persistent("global_observer_notify_persistent", "observabilidade_global", "create", "queued", "_observer_persistent_notification_id", "alert.title", "alert.message", {
    operationExpression: 'payload.persistent_notification_operation="dismiss" ? "dismiss" : "create"',
    beforeRules: [{ t: "set", p: "_observer_notification_channel", pt: "msg", to: "persistent_notification", tot: "str" }],
  }),
]);

const source = (name) => fs.readFileSync(path.join(functionsDir, name), "utf8").trimEnd();
const contextRule = () => ({
  t: "set", p: "_notification_hub_context", pt: "msg",
  to: '{"payload":payload,"notification":notification,"had_notification":$exists(notification)}', tot: "jsonata",
});
const setRule = (property, value, valueType = "jsonata") => ({
  t: "set", p: property, pt: "msg", to: value, tot: valueType,
});
const setRuntimeMetadata = (node, property, value) => {
  Object.defineProperty(node, property, {
    value,
    configurable: true,
    writable: true,
  });
};
const notificationExpression = (migration) => {
  const fields = [`"source":"${migration.source}"`];
  if (migration.channel === "mobile") {
    fields.push(`"recipients":["${migration.recipient}"]`, `"profile":"${migration.profile}"`);
    if (migration.title) fields.push(`"title":${migration.title}`);
    if (migration.data) fields.push(`"data":${migration.data}`);
  } else if (migration.channel === "alexa") {
    fields.push(`"targets":["${migration.target}"]`, `"mode":"${migration.mode}"`);
    if (migration.data) fields.push(`"data":${migration.data}`);
  } else {
    const operation = migration.operationExpression ?? `"${migration.operation}"`;
    fields.push(
      `"operation":${operation}`,
      `"delivery":"${migration.delivery}"`,
      `"notification_id":${migration.notificationId}`,
    );
    if (migration.title) fields.push(`"title":${migration.title}`);
  }
  if (migration.testMode) fields.push(`"test_mode":${migration.testMode}`);
  if (migration.deliveryUnderTest) fields.push(`"delivery_under_test":${migration.deliveryUnderTest}`);
  return `{${fields.join(",")}}`;
};
const adapterRules = (migration) => [
  contextRule(),
  ...(migration.beforeRules ?? []),
  setRule("notification", notificationExpression(migration)),
  setRule("payload", migration.message ?? '""'),
];

const group = (id, z, name, x, y, w, h, color, fill) => ({
  id, type: "group", z, name, style: { label: true, color, fill }, nodes: [], x, y, w, h,
});
const fn = (id, z, g, name, file, outputs, x, y, wires) => ({
  id, type: "function", z, g, name, func: source(file), outputs, timeout: 0, noerr: 0,
  initialize: "", finalize: "", libs: [], x, y, wires,
});
const change = (id, z, g, name, rules, x, y, wires) => ({
  id, type: "change", z, g, name, rules, action: "", property: "", from: "", to: "", reg: false, x, y, wires,
});
const sw = (id, z, g, name, property, propertyType, rules, x, y, wires) => ({
  id, type: "switch", z, g, name, property, propertyType, rules, checkall: "true", repair: false,
  outputs: rules.length, x, y, wires,
});
const linkIn = (id, z, g, name, links, x, y, wires) => ({
  id, type: "link in", z, g, name, links, x, y, wires,
});
const linkOut = (id, z, g, name, links, x, y, mode = "link") => ({
  id, type: "link out", z, g, name, mode, links, x, y, wires: [],
});
const inject = (id, z, g, name, payload, notification, x, y, wires) => ({
  id, type: "inject", z, g, name,
  props: [
    { p: "payload", v: payload, vt: "str" },
    { p: "notification", v: JSON.stringify(notification), vt: "json" },
  ],
  repeat: "", crontab: "", once: false, onceDelay: 0.1, topic: "", x, y, wires,
});
const dashboardAlexaInject = (id, z, g, name, message, x, y, wires) => ({
  id, type: "inject", z, g, name,
  props: [
    { p: "payload", v: JSON.stringify({ message, origin: "manual_test" }), vt: "json" },
    { p: "_notification_hub_dashboard_test", v: "true", vt: "bool" },
  ],
  repeat: "", crontab: "", once: false, onceDelay: 0.1, topic: "", x, y, wires,
});
const service = (id, z, g, name, action, data, queue, x, y, wires) => ({
  id, type: "api-call-service", z, g, name, server: SERVER, version: 7, debugenabled: false,
  action, floorId: [], areaId: [], deviceId: [], entityId: [], labelId: [], data, dataType: "jsonata",
  mergeContext: "", mustacheAltTags: false, outputProperties: [], queue, blockInputOverrides: true,
  domain: action.split(".")[0], service: action.split(".")[1], x, y, wires,
});
const caller = (id, z, g, name, target, x, y, wires) => ({
  id, type: "link call", z, g, name, links: [target], linkType: "static", timeout: "30", x, y, wires,
});
const comment = (id, z, g, name, info, x, y) => ({
  id, type: "comment", z, g, name, info, x, y, wires: [],
});
const addGrouped = (nodes, groups, node) => {
  nodes.push(node);
  if (node.g) groups.get(node.g).nodes.push(node.id);
  return node;
};

function mobileHubNodes() {
  const z = NOTIFICATION_HUBS.mobile.tab;
  const nodes = [{ id: z, type: "tab", label: "hub_notificacoes_moveis", disabled: false,
    info: "Única fronteira Node-RED para celulares. Contrato fail-closed: msg.payload é a mensagem; msg.notification informa source, recipients, profile, title/data opcionais e flags explícitas de TESTE." }];
  const groups = new Map();
  const main = group("notification_hub_mobile_main_group", z, "Contrato, destinatários e perfis de entrega", 64, 40, 3020, 600, "#2563eb", "#dbeafe");
  const test = group("notification_hub_mobile_test_group", z, "TESTES — destinatários explícitos e fail-closed", 64, 700, 1320, 360, "#0891b2", "#cffafe");
  nodes.push(main, test); groups.set(main.id, main); groups.set(test.id, test);
  const add = (node) => addGrouped(nodes, groups, node);
  add(comment("notification_hub_mobile_contract", z, main.id, "payload=mensagem | recipients obrigatórios | nunca broadcast", "Perfis: simple preserva notify_3/notify_2 com queue all; actionable preserva tags/actions/push; background_command preserva request_location_update/clear_notification com queue first.", 760, 80));
  add(linkIn(NOTIFICATION_HUBS.mobile.input, z, main.id, "Entrada canônica móvel", [], 120, 160, [["notification_hub_mobile_mark_channel"]]));
  add(linkIn("notification_hub_mobile_test_in", z, main.id, "Receber TESTE do próprio hub", ["notification_hub_mobile_test_out"], 120, 220, [["notification_hub_mobile_mark_channel"]]));
  add(change("notification_hub_mobile_mark_channel", z, main.id, "Identificar canal móvel", [setRule("_notification_hub_channel", "mobile", "str")], 350, 190, [["notification_hub_mobile_validate"]]));
  add(fn("notification_hub_mobile_validate", z, main.id, "Validar contrato móvel", "notification-hub-mobile-validate.js", 2, 590, 190, [["notification_hub_mobile_test_gate"], ["notification_hub_mobile_invalid_test_gate"]]));
  add(sw("notification_hub_mobile_invalid_test_gate", z, main.id, "Inválido pertence a TESTE?", "notification.test_mode", "msg", [{ t: "true" }, { t: "else" }], 840, 300, [["notification_hub_mobile_dry_out"], ["notification_hub_mobile_reject_early_out"]]));
  add(sw("notification_hub_mobile_test_gate", z, main.id, "Produção, teste real ou dry-run?", "notification.test_mode = true and notification.delivery_under_test != true", "jsonata", [{ t: "true" }, { t: "else" }], 850, 175, [["notification_hub_mobile_dry_out"], ["notification_hub_mobile_count"]]));
  add(linkOut("notification_hub_mobile_dry_out", z, main.id, "TESTE seguro → terminal", ["notification_hub_mobile_dry_in"], 1090, 330));
  add(sw("notification_hub_mobile_count", z, main.id, "Um ou dois destinatários?", "_notification_hub_recipient_count", "msg", [{ t: "eq", v: "1", vt: "num" }, { t: "eq", v: "2", vt: "num" }, { t: "else" }], 1110, 175, [["notification_hub_mobile_single"], ["notification_hub_mobile_both_primary"], ["notification_hub_mobile_reject_selection_out"]]));
  add(sw("notification_hub_mobile_single", z, main.id, "Destinatário único", "notification.recipients[0]", "msg", [{ t: "eq", v: "resident_primary", vt: "str" }, { t: "eq", v: "resident_secondary", vt: "str" }, { t: "else" }], 1350, 130, [["notification_hub_mobile_only_primary"], ["notification_hub_mobile_only_secondary"], ["notification_hub_mobile_reject_selection_out"]]));
  const recipientRule = (recipient) => [setRule("_notification_hub_recipient", recipient, "str")];
  add(change("notification_hub_mobile_only_primary", z, main.id, "Somente resident_primary", recipientRule("resident_primary"), 1580, 100, [["notification_hub_mobile_profile"]]));
  add(change("notification_hub_mobile_only_secondary", z, main.id, "Somente resident_secondary", recipientRule("resident_secondary"), 1580, 140, [["notification_hub_mobile_profile"]]));
  add(change("notification_hub_mobile_both_primary", z, main.id, "Ambos: incluir resident_primary", recipientRule("resident_primary"), 1370, 220, [["notification_hub_mobile_profile"]]));
  add(linkIn("notification_hub_mobile_pair_continue_in", z, main.id, "Continuar com resident_secondary", ["notification_hub_mobile_pair_continue_out", "notification_hub_mobile_pair_retry_out"], 1300, 280, [["notification_hub_mobile_both_secondary"]]));
  add(change("notification_hub_mobile_both_secondary", z, main.id, "Ambos: incluir resident_secondary", recipientRule("resident_secondary"), 1500, 280, [["notification_hub_mobile_profile"]]));
  add(sw("notification_hub_mobile_profile", z, main.id, "Selecionar perfil de entrega", "notification.profile", "msg", [{ t: "eq", v: "simple", vt: "str" }, { t: "eq", v: "actionable", vt: "str" }, { t: "eq", v: "background_command", vt: "str" }, { t: "else" }], 1820, 190, [["notification_hub_mobile_simple_recipient"], ["notification_hub_mobile_actionable_recipient"], ["notification_hub_mobile_background_recipient"], ["notification_hub_mobile_reject_late_out"]]));
  const recipientSwitch = (id, name, y, primary, secondary) => add(sw(id, z, main.id, name, "_notification_hub_recipient", "msg", [{ t: "eq", v: "resident_primary", vt: "str" }, { t: "eq", v: "resident_secondary", vt: "str" }, { t: "else" }], 2070, y, [[primary], [secondary], ["notification_hub_mobile_reject_late_out"]]));
  recipientSwitch("notification_hub_mobile_simple_recipient", "Simple: qual celular?", 100, "notification_hub_mobile_primary_simple", "notification_hub_mobile_secondary_simple");
  recipientSwitch("notification_hub_mobile_actionable_recipient", "Actionable: qual celular?", 220, "notification_hub_mobile_primary_actionable", "notification_hub_mobile_secondary_actionable");
  recipientSwitch("notification_hub_mobile_background_recipient", "Background: qual celular?", 340, "notification_hub_mobile_primary_background", "notification_hub_mobile_secondary_background");
  const simpleData = (role, action) => `{"role":"${role}","action":"${action}","data":$merge([{"message":payload},notification.title ? {"title":notification.title} : {},$exists(notification.data) ? {"data":notification.data} : {}])}`;
  const actionableData = (role) => `{"role":"${role}","action":"notify_actionable","data":$merge([{"message":payload},notification.title ? {"title":notification.title} : {},$exists(notification.data) ? {"data":notification.data} : {}])}`;
  const backgroundData = (role, action) => `{"role":"${role}","action":"${action}","data":$merge([{"message":payload},$exists(notification.data) ? {"data":notification.data} : {}])}`;
  const services = [
    ["notification_hub_mobile_primary_simple", "Enviar simple para resident_primary", simpleData("mobile_primary", "notify_3"), "all", 2380, 70],
    ["notification_hub_mobile_secondary_simple", "Enviar simple para resident_secondary", simpleData("mobile_secondary", "notify_2"), "all", 2380, 120],
    ["notification_hub_mobile_primary_actionable", "Enviar actionable para resident_primary", actionableData("mobile_primary"), "all", 2380, 190],
    ["notification_hub_mobile_secondary_actionable", "Enviar actionable para resident_secondary", actionableData("mobile_secondary"), "all", 2380, 240],
    ["notification_hub_mobile_primary_background", "Enviar background para resident_primary", backgroundData("mobile_primary", "notify_3"), "first", 2380, 310],
    ["notification_hub_mobile_secondary_background", "Enviar background para resident_secondary", backgroundData("mobile_secondary", "notify_2"), "first", 2380, 360],
  ];
  for (const [id, name, data, queue, x, y] of services) add(service(id, z, main.id, name, "public_bindings.call", data, queue, x, y, [["notification_hub_mobile_after_service"]]));
  add(sw("notification_hub_mobile_after_service", z, main.id, "Concluir par explícito?", "_notification_hub_recipient_count = 2 and _notification_hub_recipient = \"resident_primary\" ? \"continue\" : $exists(_notification_hub_prior_failure) ? \"failed\" : \"accepted\"", "jsonata", [{ t: "eq", v: "continue", vt: "str" }, { t: "eq", v: "failed", vt: "str" }, { t: "else" }], 2650, 120, [["notification_hub_mobile_pair_continue_out"], ["notification_hub_mobile_failure"], ["notification_hub_mobile_success"]]));
  add(linkOut("notification_hub_mobile_pair_continue_out", z, main.id, "Par: seguir para resident_secondary", ["notification_hub_mobile_pair_continue_in"], 2860, 100));
  add(fn("notification_hub_mobile_success", z, main.id, "Registrar aceite do canal móvel", "notification-hub-success.js", 1, 2820, 200, [["notification_hub_mobile_return_success"]]));
  add(linkOut("notification_hub_mobile_return_success", z, main.id, "Retornar aceite ao chamador", [], 3030, 200, "return"));
  add({ id: "notification_hub_mobile_service_catch", type: "catch", z, g: main.id, name: "Capturar falha dos serviços móveis", scope: services.map(([id]) => id), uncaught: false, x: 2030, y: 470, wires: [["notification_hub_mobile_leg_failure"]] });
  add(fn("notification_hub_mobile_leg_failure", z, main.id, "Tentar segundo destinatário e falhar uma vez", "notification-hub-mobile-leg-failure.js", 2, 2310, 470, [["notification_hub_mobile_pair_retry_out"], ["notification_hub_mobile_failure"]]));
  add(linkOut("notification_hub_mobile_pair_retry_out", z, main.id, "Falha primária: tentar resident_secondary", ["notification_hub_mobile_pair_continue_in"], 2550, 500));
  add(fn("notification_hub_mobile_failure", z, main.id, "Retornar falha e observar", "notification-hub-failure.js", 2, 2630, 440, [["notification_hub_mobile_return_failure"], ["notification_hub_mobile_observer_out"]]));
  add(linkOut("notification_hub_mobile_return_failure", z, main.id, "Retornar falha ao chamador", [], 2930, 420, "return"));
  add(linkOut("notification_hub_mobile_observer_out", z, main.id, "Falha móvel → observador global", [OBSERVER_INPUT], 2930, 480));
  add(linkOut("notification_hub_mobile_reject_early_out", z, main.id, "Contrato inválido → rejeitar", ["notification_hub_mobile_reject_in"], 1090, 390));
  add(linkOut("notification_hub_mobile_reject_selection_out", z, main.id, "Seleção inválida → rejeitar", ["notification_hub_mobile_reject_in"], 1500, 390));
  add(linkOut("notification_hub_mobile_reject_late_out", z, main.id, "Perfil/rota inválido → rejeitar", ["notification_hub_mobile_reject_in"], 2250, 420));
  add(linkIn("notification_hub_mobile_reject_in", z, main.id, "Rejeitar contrato móvel", ["notification_hub_mobile_reject_early_out", "notification_hub_mobile_reject_selection_out", "notification_hub_mobile_reject_late_out"], 2700, 540, [["notification_hub_mobile_reject"]]));
  add(fn("notification_hub_mobile_reject", z, main.id, "Rejeitar sem enviar", "notification-hub-reject.js", 1, 2870, 540, [["notification_hub_mobile_return_reject"]]));
  add(linkOut("notification_hub_mobile_return_reject", z, main.id, "Retornar rejeição ao chamador", [], 3050, 540, "return"));
  add(comment("notification_hub_mobile_test_note", z, test.id, "Ordem livre: primary, secondary, ambos e inválido", "Todos usam test_mode e chegam ao mesmo validador do hub. Nenhum serviço do Home Assistant é chamado.", 480, 750));
  const testCases = [
    ["notification_hub_mobile_test_primary", "TESTE A: somente resident_primary", ["resident_primary"], "simple", 220, 820],
    ["notification_hub_mobile_test_secondary", "TESTE B: somente resident_secondary", ["resident_secondary"], "simple", 220, 875],
    ["notification_hub_mobile_test_both", "TESTE C: ambos explicitamente", ["resident_primary", "resident_secondary"], "simple", 220, 930],
    ["notification_hub_mobile_test_invalid", "TESTE F: destinatário ausente", [], "simple", 220, 985],
  ];
  for (const [id, name, recipients, profile, x, y] of testCases) add(inject(id, z, test.id, name, "TESTE — mensagem sem efeito", { source: "hub_mobile_manual_test", recipients, profile, title: "TESTE", test_mode: true }, x, y, [["notification_hub_mobile_test_out"]]));
  add(linkOut("notification_hub_mobile_test_out", z, test.id, "Cenário TESTE → contrato real", ["notification_hub_mobile_test_in"], 480, 900));
  add(linkIn("notification_hub_mobile_dry_in", z, test.id, "Receber resultado bloqueado", ["notification_hub_mobile_dry_out"], 720, 900, [["notification_hub_mobile_dry_run_terminal"]]));
  add(fn("notification_hub_mobile_dry_run_terminal", z, test.id, "Registrar resultado dry-run móvel", "notification-hub-dry-run.js", 2, 980, 900, [["notification_hub_mobile_dry_run_assert"], ["notification_hub_mobile_return_dry"]]));
  add(fn("notification_hub_mobile_dry_run_assert", z, test.id, "TESTE FINAL: nenhum celular acionado", "notification-hub-dry-run-terminal.js", 0, 1230, 850, []));
  add(linkOut("notification_hub_mobile_return_dry", z, test.id, "Retornar dry-run ao chamador", [], 1260, 900, "return"));
  return nodes;
}

function alexaHubNodes() {
  const z = NOTIFICATION_HUBS.alexa.tab;
  const nodes = [{ id: z, type: "tab", label: "hub_notificacoes_alexa", disabled: false,
    info: "Única fronteira Node-RED para Alexa. O target lógico explícito preserva o binding atual sem fallback para todas as Alexas." }];
  const groups = new Map();
  const main = group("notification_hub_alexa_main_group", z, "Contrato, target lógico e anúncio", 64, 40, 1880, 440, "#7c3aed", "#ede9fe");
  const test = group("notification_hub_alexa_test_group", z, "TESTES — target, mensagem do painel e rejeições", 64, 540, 1320, 340, "#0891b2", "#cffafe");
  nodes.push(main, test); groups.set(main.id, main); groups.set(test.id, test); const add = (node) => addGrouped(nodes, groups, node);
  add(comment("notification_hub_alexa_contract", z, main.id, "payload=mensagem | target obrigatório | nunca todas as Alexas", "O target voice_assistant_primary mantém exatamente public_bindings mobile_primary/notify. Dados adicionais são repassados sem escolher outro dispositivo.", 690, 80));
  add(linkIn(NOTIFICATION_HUBS.alexa.input, z, main.id, "Entrada canônica Alexa", [], 120, 150, [["notification_hub_alexa_mark_channel"]]));
  add(linkIn("notification_hub_alexa_test_in", z, main.id, "Receber TESTE do próprio hub", ["notification_hub_alexa_test_out"], 120, 210, [["notification_hub_alexa_mark_channel"]]));
  add(change("notification_hub_alexa_mark_channel", z, main.id, "Identificar canal Alexa", [setRule("_notification_hub_channel", "alexa", "str")], 340, 180, [["notification_hub_alexa_validate"]]));
  add(fn("notification_hub_alexa_validate", z, main.id, "Validar contrato e target Alexa", "notification-hub-alexa-validate.js", 2, 590, 180, [["notification_hub_alexa_test_gate"], ["notification_hub_alexa_invalid_test_gate"]]));
  add(sw("notification_hub_alexa_invalid_test_gate", z, main.id, "Inválido pertence a TESTE?", "notification.test_mode", "msg", [{ t: "true" }, { t: "else" }], 850, 300, [["notification_hub_alexa_dry_out"], ["notification_hub_alexa_reject"]]));
  add(sw("notification_hub_alexa_test_gate", z, main.id, "Produção, teste real ou dry-run?", "notification.test_mode = true and notification.delivery_under_test != true", "jsonata", [{ t: "true" }, { t: "else" }], 850, 160, [["notification_hub_alexa_dry_out"], ["notification_hub_alexa_target"]]));
  add(sw("notification_hub_alexa_target", z, main.id, "Validar target Alexa", "notification.targets[0]", "msg", [{ t: "eq", v: "voice_assistant_primary", vt: "str" }, { t: "else" }], 1110, 150, [["notification_hub_alexa_select_target"], ["notification_hub_alexa_reject"]]));
  add(change("notification_hub_alexa_select_target", z, main.id, "Selecionar voice_assistant_primary", [setRule("_notification_hub_target", "voice_assistant_primary", "str")], 1360, 130, [["notification_hub_alexa_service"]]));
  add(service("notification_hub_alexa_service", z, main.id, "Anunciar no target Alexa atual", "public_bindings.call", '{"role":"mobile_primary","action":"notify","data":$merge([{"message":payload},$exists(notification.data) ? notification.data : {}])}', "all", 1650, 130, [["notification_hub_alexa_success"]]));
  add(fn("notification_hub_alexa_success", z, main.id, "Registrar aceite do canal Alexa", "notification-hub-success.js", 1, 1650, 200, [["notification_hub_alexa_return_success"]]));
  add(linkOut("notification_hub_alexa_return_success", z, main.id, "Retornar aceite ao chamador", [], 1900, 200, "return"));
  add({ id: "notification_hub_alexa_service_catch", type: "catch", z, g: main.id, name: "Capturar falha do serviço Alexa", scope: ["notification_hub_alexa_service"], uncaught: false, x: 1120, y: 360, wires: [["notification_hub_alexa_failure"]] });
  add(fn("notification_hub_alexa_failure", z, main.id, "Retornar falha e observar", "notification-hub-failure.js", 2, 1390, 360, [["notification_hub_alexa_return_failure"], ["notification_hub_alexa_observer_out"]]));
  add(linkOut("notification_hub_alexa_return_failure", z, main.id, "Retornar falha ao chamador", [], 1660, 330, "return"));
  add(linkOut("notification_hub_alexa_observer_out", z, main.id, "Falha Alexa → observador global", [OBSERVER_INPUT], 1660, 390));
  add(fn("notification_hub_alexa_reject", z, main.id, "Rejeitar sem anunciar", "notification-hub-reject.js", 1, 1120, 270, [["notification_hub_alexa_return_reject"]]));
  add(linkOut("notification_hub_alexa_return_reject", z, main.id, "Retornar rejeição ao chamador", [], 1380, 270, "return"));
  add(linkOut("notification_hub_alexa_dry_out", z, main.id, "TESTE seguro → terminal", ["notification_hub_alexa_dry_in"], 1090, 230));
  add({
    id: "notification_hub_alexa_dashboard_event", type: "server-events", z, g: main.id,
    name: "Mensagem enviada pelo painel Chat", server: SERVER, version: 3,
    exposeAsEntityConfig: "", eventType: "alexa_text_announcement_requested", eventData: "",
    waitForRunning: true,
    outputProperties: [{ property: "payload", propertyType: "msg", value: "", valueType: "eventData" }],
    x: 220, y: 360, wires: [["notification_hub_alexa_dashboard_request"]],
  });
  add(linkIn("notification_hub_alexa_dashboard_test_in", z, main.id, "Receber mensagem TESTE do painel", ["notification_hub_alexa_dashboard_test_out"], 180, 420, [["notification_hub_alexa_dashboard_request"]]));
  add(fn("notification_hub_alexa_dashboard_request", z, main.id, "Adaptar intenção do painel", "notification-hub-alexa-dashboard-request.js", 1, 500, 390, [["notification_hub_alexa_dashboard_call"]]));
  add(caller("notification_hub_alexa_dashboard_call", z, main.id, "Entregar pelo hub canônico", NOTIFICATION_HUBS.alexa.input, 760, 390, [[]]));
  add(comment("notification_hub_alexa_test_note", z, test.id, "Teste válido e target inválido", "Ambos atravessam o validador real com test_mode. Nenhuma Alexa é acionada.", 430, 590));
  add(inject("notification_hub_alexa_test_valid", z, test.id, "TESTE D: Alexa definida", "TESTE — anúncio sem efeito", { source: "hub_alexa_manual_test", targets: ["voice_assistant_primary"], mode: "announce", test_mode: true }, 220, 660, [["notification_hub_alexa_test_out"]]));
  add(inject("notification_hub_alexa_test_invalid", z, test.id, "TESTE: target inválido", "TESTE — anúncio sem efeito", { source: "hub_alexa_manual_test", targets: ["unknown"], mode: "announce", test_mode: true }, 220, 720, [["notification_hub_alexa_test_out"]]));
  add(linkOut("notification_hub_alexa_test_out", z, test.id, "Cenário TESTE → contrato real", ["notification_hub_alexa_test_in"], 450, 690));
  add(linkIn("notification_hub_alexa_dry_in", z, test.id, "Receber resultado bloqueado", ["notification_hub_alexa_dry_out"], 690, 690, [["notification_hub_alexa_dry_run_terminal"]]));
  add(fn("notification_hub_alexa_dry_run_terminal", z, test.id, "Registrar resultado dry-run Alexa", "notification-hub-dry-run.js", 2, 940, 690, [["notification_hub_alexa_dry_run_assert"], ["notification_hub_alexa_return_dry"]]));
  add(fn("notification_hub_alexa_dry_run_assert", z, test.id, "TESTE FINAL: nenhuma Alexa acionada", "notification-hub-dry-run-terminal.js", 0, 1190, 650, []));
  add(linkOut("notification_hub_alexa_return_dry", z, test.id, "Retornar dry-run ao chamador", [], 1200, 690, "return"));
  add(dashboardAlexaInject("notification_hub_alexa_dashboard_test_valid", z, test.id, "TESTE: mensagem do painel", "TESTE — mensagem digitada", 230, 790, [["notification_hub_alexa_dashboard_test_out"]]));
  add(dashboardAlexaInject("notification_hub_alexa_dashboard_test_empty", z, test.id, "TESTE: mensagem vazia", "   ", 230, 850, [["notification_hub_alexa_dashboard_test_out"]]));
  add(linkOut("notification_hub_alexa_dashboard_test_out", z, test.id, "Pedido do painel → adaptador real", ["notification_hub_alexa_dashboard_test_in"], 520, 820));
  return nodes;
}

function persistentHubNodes() {
  const z = NOTIFICATION_HUBS.persistent.tab;
  const nodes = [{ id: z, type: "tab", label: "hub_notificacoes_persistentes_ha", disabled: false,
    info: "Única fronteira Node-RED para persistent_notification.create/dismiss. IDs e política de fila são obrigatórios e explícitos." }];
  const groups = new Map();
  const main = group("notification_hub_persistent_main_group", z, "Contrato, operação, fila e efeito HA", 64, 40, 2180, 500, "#0f766e", "#ccfbf1");
  const test = group("notification_hub_persistent_test_group", z, "TESTES — criar, remover e rejeitar", 64, 600, 1320, 320, "#0891b2", "#cffafe");
  nodes.push(main, test); groups.set(main.id, main); groups.set(test.id, test); const add = (node) => addGrouped(nodes, groups, node);
  add(comment("notification_hub_persistent_contract", z, main.id, "payload=mensagem | notification_id obrigatório | create/dismiss", "delivery=queued preserva queue all; delivery=immediate preserva queue none. Dismiss mantém o mesmo notification_id e nunca cria outro alerta.", 760, 80));
  add(linkIn(NOTIFICATION_HUBS.persistent.input, z, main.id, "Entrada canônica HA persistente", [], 120, 160, [["notification_hub_persistent_mark_channel"]]));
  add(linkIn("notification_hub_persistent_test_in", z, main.id, "Receber TESTE do próprio hub", ["notification_hub_persistent_test_out"], 120, 220, [["notification_hub_persistent_mark_channel"]]));
  add(change("notification_hub_persistent_mark_channel", z, main.id, "Identificar canal persistente", [setRule("_notification_hub_channel", "persistent", "str")], 370, 190, [["notification_hub_persistent_validate"]]));
  add(fn("notification_hub_persistent_validate", z, main.id, "Validar contrato persistente", "notification-hub-persistent-validate.js", 2, 640, 190, [["notification_hub_persistent_test_gate"], ["notification_hub_persistent_invalid_test_gate"]]));
  add(sw("notification_hub_persistent_invalid_test_gate", z, main.id, "Inválido pertence a TESTE?", "notification.test_mode", "msg", [{ t: "true" }, { t: "else" }], 900, 340, [["notification_hub_persistent_dry_out"], ["notification_hub_persistent_reject_early_out"]]));
  add(sw("notification_hub_persistent_test_gate", z, main.id, "Produção ou dry-run?", "notification.test_mode", "msg", [{ t: "true" }, { t: "else" }], 900, 170, [["notification_hub_persistent_dry_out"], ["notification_hub_persistent_operation"]]));
  add(sw("notification_hub_persistent_operation", z, main.id, "Criar ou remover?", "notification.operation", "msg", [{ t: "eq", v: "create", vt: "str" }, { t: "eq", v: "dismiss", vt: "str" }, { t: "else" }], 1140, 170, [["notification_hub_persistent_create_delivery"], ["notification_hub_persistent_dismiss_delivery"], ["notification_hub_persistent_reject_early_out"]]));
  add(sw("notification_hub_persistent_create_delivery", z, main.id, "Create: queued ou immediate?", "notification.delivery", "msg", [{ t: "eq", v: "queued", vt: "str" }, { t: "eq", v: "immediate", vt: "str" }, { t: "else" }], 1410, 130, [["notification_hub_persistent_create_queued"], ["notification_hub_persistent_create_immediate"], ["notification_hub_persistent_reject"]]));
  add(sw("notification_hub_persistent_dismiss_delivery", z, main.id, "Dismiss: queued ou immediate?", "notification.delivery", "msg", [{ t: "eq", v: "queued", vt: "str" }, { t: "eq", v: "immediate", vt: "str" }, { t: "else" }], 1410, 250, [["notification_hub_persistent_dismiss_queued"], ["notification_hub_persistent_dismiss_immediate"], ["notification_hub_persistent_reject"]]));
  const createData = '{"title":notification.title,"message":payload,"notification_id":notification.notification_id}';
  const dismissData = '{"notification_id":notification.notification_id}';
  const services = [
    ["notification_hub_persistent_create_queued", "Criar/atualizar — queue all", "persistent_notification.create", createData, "all", 1710, 90],
    ["notification_hub_persistent_create_immediate", "Criar/atualizar — queue none", "persistent_notification.create", createData, "none", 1710, 140],
    ["notification_hub_persistent_dismiss_queued", "Remover — queue all", "persistent_notification.dismiss", dismissData, "all", 1710, 230],
    ["notification_hub_persistent_dismiss_immediate", "Remover — queue none", "persistent_notification.dismiss", dismissData, "none", 1710, 280],
  ];
  for (const [id, name, action, data, queue, x, y] of services) add(service(id, z, main.id, name, action, data, queue, x, y, [["notification_hub_persistent_success"]]));
  add(fn("notification_hub_persistent_success", z, main.id, "Registrar aceite do canal persistente", "notification-hub-success.js", 1, 1990, 180, [["notification_hub_persistent_return_success"]]));
  add(linkOut("notification_hub_persistent_return_success", z, main.id, "Retornar aceite ao chamador", [], 2200, 180, "return"));
  add({ id: "notification_hub_persistent_service_catch", type: "catch", z, g: main.id, name: "Capturar falha do serviço persistente", scope: services.map(([id]) => id), uncaught: false, x: 1430, y: 420, wires: [["notification_hub_persistent_failure"]] });
  add(fn("notification_hub_persistent_failure", z, main.id, "Retornar falha e observar", "notification-hub-failure.js", 2, 1720, 420, [["notification_hub_persistent_return_failure"], ["notification_hub_persistent_observer_out"]]));
  add(linkOut("notification_hub_persistent_return_failure", z, main.id, "Retornar falha ao chamador", [], 1990, 390, "return"));
  add(linkOut("notification_hub_persistent_observer_out", z, main.id, "Falha persistente → observador global", [OBSERVER_INPUT], 2000, 450));
  add(linkOut("notification_hub_persistent_reject_early_out", z, main.id, "Contrato/operação inválido → rejeitar", ["notification_hub_persistent_reject_in"], 1190, 390));
  add(linkIn("notification_hub_persistent_reject_in", z, main.id, "Rejeitar contrato persistente", ["notification_hub_persistent_reject_early_out"], 1570, 350, [["notification_hub_persistent_reject"]]));
  add(fn("notification_hub_persistent_reject", z, main.id, "Rejeitar sem chamar o HA", "notification-hub-reject.js", 1, 1750, 350, [["notification_hub_persistent_return_reject"]]));
  add(linkOut("notification_hub_persistent_return_reject", z, main.id, "Retornar rejeição ao chamador", [], 2010, 350, "return"));
  add(linkOut("notification_hub_persistent_dry_out", z, main.id, "TESTE seguro → terminal", ["notification_hub_persistent_dry_in"], 1150, 310));
  add(comment("notification_hub_persistent_test_note", z, test.id, "Criar, remover e contrato inválido", "Todos atravessam o validador real com test_mode. Nenhum serviço persistent_notification é chamado.", 440, 650));
  add(inject("notification_hub_persistent_test_create", z, test.id, "TESTE E: criar sem efeito", "TESTE — conteúdo persistente", { source: "hub_persistent_manual_test", operation: "create", delivery: "queued", notification_id: "notification_hub_test", title: "TESTE", test_mode: true }, 220, 730, [["notification_hub_persistent_test_out"]]));
  add(inject("notification_hub_persistent_test_dismiss", z, test.id, "TESTE: remover sem efeito", "", { source: "hub_persistent_manual_test", operation: "dismiss", delivery: "queued", notification_id: "notification_hub_test", test_mode: true }, 220, 790, [["notification_hub_persistent_test_out"]]));
  add(inject("notification_hub_persistent_test_invalid", z, test.id, "TESTE: ID ausente", "TESTE — inválido", { source: "hub_persistent_manual_test", operation: "create", delivery: "queued", title: "TESTE", test_mode: true }, 220, 850, [["notification_hub_persistent_test_out"]]));
  add(linkOut("notification_hub_persistent_test_out", z, test.id, "Cenário TESTE → contrato real", ["notification_hub_persistent_test_in"], 480, 790));
  add(linkIn("notification_hub_persistent_dry_in", z, test.id, "Receber resultado bloqueado", ["notification_hub_persistent_dry_out"], 720, 790, [["notification_hub_persistent_dry_run_terminal"]]));
  add(fn("notification_hub_persistent_dry_run_terminal", z, test.id, "Registrar resultado dry-run persistente", "notification-hub-dry-run.js", 2, 1000, 790, [["notification_hub_persistent_dry_run_assert"], ["notification_hub_persistent_return_dry"]]));
  add(fn("notification_hub_persistent_dry_run_assert", z, test.id, "TESTE FINAL: nenhum alerta criado/removido", "notification-hub-dry-run-terminal.js", 0, 1250, 750, []));
  add(linkOut("notification_hub_persistent_return_dry", z, test.id, "Retornar dry-run ao chamador", [], 1290, 790, "return"));
  return nodes;
}

function migrateDirectCall(flows, migration) {
  const byId = new Map(flows.map((node) => [node.id, node]));
  const original = byId.get(migration.id);
  if (!original) return flows;
  const callId = `${migration.id}__hub_call`;
  const resultId = `${migration.id}__hub_result`;
  const existingCall = byId.get(callId);
  const existingResult = byId.get(resultId);
  // The generated call is the durable structural marker. Node-RED removes
  // custom metadata, while approved coordinates may legitimately differ from
  // the generator defaults.
  const layoutPreviouslyApplied = original.notification_hub_layout_version === 1 || Boolean(existingCall);
  const catches = flows.filter((node) => node.type === "catch" && Array.isArray(node.scope));
  const failureTargets = existingResult?.wires?.[1] ?? catches
    .filter((node) => node.scope.includes(migration.id) || node.scope.includes(callId))
    .flatMap((node) => node.wires?.[0] ?? []);
  const successTargets = existingResult?.wires?.[0] ?? existingCall?.wires?.[0] ?? original.wires?.[0] ?? [];
  for (const node of catches) {
    node.scope = node.scope.map((id) => id === migration.id ? callId : id);
  }
  const generated = new Set([callId, resultId]);
  flows = flows.filter((node) => !generated.has(node.id));
  for (const node of flows) {
    if (Array.isArray(node.nodes)) node.nodes = node.nodes.filter((id) => !generated.has(id));
    if (Array.isArray(node.scope)) node.scope = node.scope.filter((id) => !generated.has(id) || id === callId);
    if (Array.isArray(node.wires)) node.wires = node.wires.map((wire) => wire.filter((id) => !generated.has(id)));
  }
  const target = NOTIFICATION_HUBS[migration.channel].input;
  const hasResult = successTargets.length > 0 || failureTargets.length > 0;
  const adapter = change(
    migration.id,
    original.z,
    original.g,
    `Preparar ${migration.channel === "persistent" ? "HA persistente" : migration.channel} para o hub`,
    adapterRules(migration),
    original.x,
    original.y,
    [[callId]],
  );
  if (layoutPreviouslyApplied) {
    setRuntimeMetadata(adapter, "notification_hub_layout_version", 1);
  }
  const hubCall = caller(
    callId,
    original.z,
    original.g,
    migration.channel === "mobile"
      ? `Hub móvel → ${migration.recipient}`
      : migration.channel === "alexa"
        ? `Hub Alexa → ${migration.target}`
        : `Hub HA → ${migration.operation}`,
    target,
    Number(original.x ?? 0) + 240,
    original.y,
    hasResult ? [[resultId]] : [[]],
  );
  const result = hasResult ? sw(
    resultId,
    original.z,
    original.g,
    "Hub aceitou a entrega?",
    "notification_delivery.status",
    "msg",
    [{ t: "eq", v: "accepted", vt: "str" }, { t: "else" }],
    Number(original.x ?? 0) + 480,
    original.y,
    [successTargets, [...new Set(failureTargets)]],
  ) : null;
  const output = [];
  for (const node of flows) {
    if (node.id !== migration.id) output.push(node);
    else output.push(adapter, hubCall, ...(result ? [result] : []));
  }
  const owner = output.find((node) => node.id === original.g && node.type === "group");
  if (owner) {
    owner.nodes = owner.nodes.filter((id) => id !== callId && id !== resultId);
    const originalIndex = owner.nodes.indexOf(migration.id);
    owner.nodes.splice(originalIndex + 1, 0, callId, ...(result ? [resultId] : []));
    const requiredRight = Number(original.x ?? 0) + (result ? 600 : 360);
    owner.w = Math.max(Number(owner.w ?? 0), requiredRight - Number(owner.x ?? 0));
  }
  return output;
}

function migrateInfrastructureCaller(flows, id) {
  const generatedIds = ["contract_gate", "contract_reject", "mobile_prepare", "mobile_call", "mobile_secondary_prepare", "mobile_secondary_call", "alexa_prepare", "alexa_call", "persistent_prepare", "persistent_call", "dismiss_gate", "dismiss_prepare", "dismiss_call"].map((suffix) => `${id}__${suffix}`);
  const generated = new Set(generatedIds);
  let current = flows.find((node) => node.id === id);
  if (!current) return flows;
  const existing = new Map(flows.map((node) => [node.id, node]));
  const layoutPreviouslyApplied = generatedIds.some((generatedId) => existing.has(generatedId));
  if (current.type === `subflow:${LEGACY_SUBFLOW}` || current.type === "change") {
    current = { ...current };
  }
  flows = flows.filter((node) => !generated.has(node.id));
  for (const node of flows) {
    if (Array.isArray(node.nodes)) node.nodes = node.nodes.filter((member) => !generated.has(member));
    if (Array.isArray(node.scope)) node.scope = node.scope.filter((member) => !generated.has(member));
    if (Array.isArray(node.wires)) node.wires = node.wires.map((wire) => wire.filter((target) => !generated.has(target)));
  }
  const x = Number(current.x ?? 0);
  const y = Number(current.y ?? 0);
  const z = current.z;
  const g = current.g;
  const shared = change(id, z, g, "Ler contrato legado de infraestrutura", [setRule("_notification_hub_shared", "notification", "msg")], x, y, [[`${id}__contract_gate`]]);
  const storedAnchorY = Number(current.notification_hub_anchor_y);
  if (Number.isFinite(storedAnchorY) || layoutPreviouslyApplied) {
    // Node-RED removes custom properties and structuredClone intentionally
    // drops our non-enumerable runtime marker. The generated child nodes are
    // therefore the durable proof that the current Y is already approved.
    setRuntimeMetadata(
      shared,
      "notification_hub_anchor_y",
      Number.isFinite(storedAnchorY) ? storedAnchorY : Number(current.y ?? 0),
    );
  }
  const contractGate = sw(`${id}__contract_gate`, z, g, "Título, mensagem e ID presentes?", "$boolean(_notification_hub_shared.title) and $boolean(_notification_hub_shared.message) and $boolean(_notification_hub_shared.id)", "jsonata", [{ t: "true" }, { t: "else" }], x + 300, y, [[`${id}__mobile_prepare`, `${id}__mobile_secondary_prepare`, `${id}__alexa_prepare`, `${id}__persistent_prepare`, `${id}__dismiss_gate`], [`${id}__contract_reject`]]);
  const contractReject = fn(`${id}__contract_reject`, z, g, "Descartar contrato incompleto", "notification-hub-infrastructure-reject.js", 0, x + 300, y + 160, []);
  const channelAdapter = (suffix, name, payload, notification, dx, dy, callSuffix, target, callName) => [
    change(`${id}__${suffix}`, z, g, name, [contextRule(), setRule("notification", notification), setRule("payload", payload)], x + dx, y + dy, [[`${id}__${callSuffix}`]]),
    caller(`${id}__${callSuffix}`, z, g, callName, target, x + dx + 250, y + dy, [[]]),
  ];
  const sourceName = z === "monitoramento_vpn_tab" ? "monitoramento_vpn" : z === "monitoramento_internet_tab" ? "monitoramento_internet" : z === "monitoramento_zigbee_tab" ? "monitoramento_zigbee" : "monitoramento_tuya";
  const mobileNodes = channelAdapter("mobile_prepare", "Preparar celular principal", "_notification_hub_shared.message", `{"source":"${sourceName}","recipients":["resident_primary"],"profile":"simple","title":_notification_hub_shared.title}`, 600, -150, "mobile_call", NOTIFICATION_HUBS.mobile.input, "Hub móvel → residente principal");
  const mobileSecondaryNodes = channelAdapter("mobile_secondary_prepare", "Preparar celular secundário", "_notification_hub_shared.message", `{"source":"${sourceName}","recipients":["resident_secondary"],"profile":"simple","title":_notification_hub_shared.title}`, 600, -90, "mobile_secondary_call", NOTIFICATION_HUBS.mobile.input, "Hub móvel → residente secundário");
  const alexaNodes = channelAdapter("alexa_prepare", "Preparar anúncio Alexa", '"" & _notification_hub_shared.title & ". " & _notification_hub_shared.message', `{"source":"${sourceName}","targets":["voice_assistant_primary"],"mode":"announce"}`, 600, -30, "alexa_call", NOTIFICATION_HUBS.alexa.input, "Hub Alexa → target atual");
  const persistentNodes = channelAdapter("persistent_prepare", "Preparar alerta persistente", "_notification_hub_shared.message", `{"source":"${sourceName}","operation":"create","delivery":"queued","notification_id":_notification_hub_shared.id,"title":_notification_hub_shared.title}`, 600, 30, "persistent_call", NOTIFICATION_HUBS.persistent.input, "Hub HA → criar/atualizar");
  const dismissGate = sw(`${id}__dismiss_gate`, z, g, "Há alerta anterior para remover?", "_notification_hub_shared.dismiss_id", "msg", [{ t: "nnull" }, { t: "else" }], x + 600, y + 100, [[`${id}__dismiss_prepare`], []]);
  const dismissNodes = channelAdapter("dismiss_prepare", "Preparar remoção persistente", '""', `{"source":"${sourceName}","operation":"dismiss","delivery":"queued","notification_id":_notification_hub_shared.dismiss_id}`, 900, 100, "dismiss_call", NOTIFICATION_HUBS.persistent.input, "Hub HA → remover anterior");
  const replacements = [shared, contractGate, contractReject, ...mobileNodes, ...mobileSecondaryNodes, ...alexaNodes, ...persistentNodes, dismissGate, ...dismissNodes];
  const output = [];
  for (const node of flows) {
    if (node.id !== id) output.push(node);
    else output.push(...replacements);
  }
  const owner = output.find((node) => node.id === g && node.type === "group");
  if (owner) {
    owner.nodes = owner.nodes.filter((member) => member !== id && !generated.has(member));
    owner.nodes.push(...replacements.map((node) => node.id));
    owner.w = Math.max(Number(owner.w ?? 0), x + 1300 - Number(owner.x ?? 0));
    owner.h = Math.max(Number(owner.h ?? 0), y + 210 - Number(owner.y ?? 0));
  }
  return output;
}

export function restoreGeneratedWireRoutes(inputFlows) {
  const routeNodes = inputFlows.filter((node) =>
    node.notification_hub_wire_route || /^notification_hub_wire_(?:out|in)_[a-f0-9]{12}$/.test(node.id),
  );
  if (!routeNodes.length) return inputFlows;
  const byId = new Map(inputFlows.map((node) => [node.id, node]));
  const removed = new Set();
  for (const routeOut of routeNodes.filter((node) => node.type === "link out")) {
    let route = routeOut.notification_hub_wire_route;
    let routeIn = null;
    if (!route) {
      const match = /^notification_hub_wire_out_([a-f0-9]{12})$/.exec(routeOut.id);
      routeIn = match ? byId.get(`notification_hub_wire_in_${match[1]}`) : null;
      const sources = [];
      for (const candidate of inputFlows) {
        for (const [output, targets] of (candidate.wires ?? []).entries()) {
          if (targets.includes(routeOut.id)) sources.push({ candidate, output });
        }
      }
      const targets = routeIn?.wires?.[0] ?? [];
      if (
        routeIn?.type !== "link in" ||
        routeIn.z !== routeOut.z ||
        !routeOut.links?.includes(routeIn.id) ||
        !routeIn.links?.includes(routeOut.id) ||
        targets.length !== 1
      ) continue;
      if (sources.length === 0) {
        removed.add(routeOut.id);
        removed.add(routeIn.id);
        continue;
      }
      if (sources.length !== 1) continue;
      route = { source: sources[0].candidate.id, target: targets[0], output: sources[0].output };
    } else {
      routeIn = (routeOut.links ?? []).map((id) => byId.get(id)).find((node) => node?.type === "link in") ?? null;
    }
    const source = byId.get(route?.source);
    if (!source || !Array.isArray(source.wires?.[route.output])) continue;
    source.wires[route.output] = source.wires[route.output]
      .flatMap((target) => target === routeOut.id ? [route.target] : [target]);
    removed.add(routeOut.id);
    if (routeIn) removed.add(routeIn.id);
  }
  if (!removed.size) return inputFlows;
  for (const node of inputFlows) {
    if (Array.isArray(node.nodes)) node.nodes = node.nodes.filter((id) => !removed.has(id));
    if (Array.isArray(node.scope)) node.scope = node.scope.filter((id) => !removed.has(id));
    if (Array.isArray(node.wires)) node.wires = node.wires.map((wire) => wire.filter((id) => !removed.has(id)));
    if (Array.isArray(node.links)) node.links = node.links.filter((id) => !removed.has(id));
  }
  return inputFlows.filter((node) => !removed.has(node.id));
}

function routeLongNotificationTabWires(flows) {
  const byId = new Map(flows.map((node) => [node.id, node]));
  const affectedTabs = new Set([
    ...NOTIFICATION_MIGRATIONS.map(({ id }) => byId.get(id)?.z),
    ...INFRASTRUCTURE_CALLERS.map((id) => byId.get(id)?.z),
  ].filter(Boolean));
  const occupiedByTab = new Map();
  for (const tab of affectedTabs) {
    occupiedByTab.set(tab, flows.filter((node) => node.z === tab && node.type !== "group" && Number.isFinite(node.x) && Number.isFinite(node.y)));
  }
  const bounds = (node, gap = 12) => {
    const { width, height } = nodeDimensions(node);
    return { left: node.x - width / 2 - gap, right: node.x + width / 2 + gap, top: node.y - height / 2 - gap, bottom: node.y + height / 2 + gap };
  };
  const overlaps = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
  const findPoint = (endpoint, direction, id, name) => {
    const owner = endpoint.g ? byId.get(endpoint.g) : null;
    const candidates = [];
    for (const dx of [180, 220, 140, 260, 100, 300, 340, 60, 0]) {
      for (const dy of [0, 50, -50, 100, -100, 150, -150, 200, -200, 250, -250, 300, -300]) {
        if (Math.hypot(dx, dy) < 480) candidates.push({ x: endpoint.x + direction * dx, y: endpoint.y + dy });
      }
    }
    for (const candidate of candidates) {
      const probe = { id, type: direction > 0 ? "link out" : "link in", name, ...candidate };
      const box = bounds(probe);
      const physicalBox = bounds(probe, 0);
      if (candidate.x < 64 || candidate.y < 40) continue;
      if (owner && (physicalBox.left < owner.x + 12 || physicalBox.right > owner.x + owner.w - 12 || physicalBox.top < owner.y + 32 || physicalBox.bottom > owner.y + owner.h - 12)) continue;
      if (occupiedByTab.get(endpoint.z).some((node) => overlaps(box, bounds(node)))) continue;
      occupiedByTab.get(endpoint.z).push(probe);
      return candidate;
    }
    throw new Error(`Sem posição segura para encurtar ligação ${endpoint.id} (${endpoint.name ?? endpoint.type})`);
  };

  const routes = [];
  for (const source of flows.filter((node) => affectedTabs.has(node.z) && Array.isArray(node.wires))) {
    for (const [output, targets] of source.wires.entries()) {
      for (const [index, targetId] of targets.entries()) {
        const target = byId.get(targetId);
        if (!target || target.z !== source.z || !Number.isFinite(source.x) || !Number.isFinite(target.x)) continue;
        // A ligação para um link out já encerra a trilha visual local. Ela não
        // deve ganhar outro par de links, mesmo quando o grupo for reposicionado.
        if (source.type === "link in" || target.type === "link out") continue;
        const distance = Math.hypot(target.x - source.x, target.y - source.y);
        if (distance <= 500 && target.x >= source.x - 30) continue;
        routes.push({ source, target, output, index });
      }
    }
  }
  for (const { source, target, output, index } of routes) {
    const key = crypto.createHash("sha1").update(`${source.id}:${output}:${index}:${target.id}`).digest("hex").slice(0, 12);
    const outId = `notification_hub_wire_out_${key}`;
    const inId = `notification_hub_wire_in_${key}`;
    const route = { source: source.id, target: target.id, output };
    const outName = `Encurtar: ${source.name ?? source.type}`;
    const inName = `Continuar: ${target.name ?? target.type}`;
    let outPoint;
    let inPoint;
    try {
      outPoint = findPoint(source, 1, outId, outName);
      inPoint = findPoint(target, -1, inId, inName);
    } catch (error) {
      throw new Error(`${error.message}; rota ${source.id}:${output} -> ${target.id}`, { cause: error });
    }
    const out = { id: outId, type: "link out", z: source.z, ...(source.g ? { g: source.g } : {}), name: outName, mode: "link", links: [inId], ...outPoint, wires: [] };
    const input = { id: inId, type: "link in", z: target.z, ...(target.g ? { g: target.g } : {}), name: inName, links: [outId], ...inPoint, wires: [[target.id]] };
    // Runtime-only provenance lets a subsequent generator restore the direct
    // wire without persisting a custom property that Node-RED strips again.
    // Keeping it non-enumerable makes generator output byte-stable after the
    // editor has saved the approved flow.
    setRuntimeMetadata(out, "notification_hub_wire_route", route);
    setRuntimeMetadata(input, "notification_hub_wire_route", route);
    source.wires[output][index] = outId;
    flows.push(out, input);
    byId.set(outId, out); byId.set(inId, input);
    for (const node of [out, input]) {
      const owner = node.g ? byId.get(node.g) : null;
      if (owner?.type === "group" && !owner.nodes.includes(node.id)) owner.nodes.push(node.id);
    }
  }
  return flows;
}

export function refreshNotificationWireRoutes(inputFlows) {
  return routeLongNotificationTabWires(restoreGeneratedWireRoutes(inputFlows));
}

function applyBusinessCallerLayout(flows) {
  const byId = new Map(flows.map((node) => [node.id, node]));
  const migrationsByGroup = new Map();
  for (const migration of NOTIFICATION_MIGRATIONS) {
    const adapter = byId.get(migration.id);
    if (!adapter?.g) continue;
    const entries = migrationsByGroup.get(adapter.g) ?? [];
    entries.push({ migration, adapter });
    migrationsByGroup.set(adapter.g, entries);
  }

  for (const [groupId, entries] of migrationsByGroup) {
    const owner = byId.get(groupId);
    if (!owner || owner.type !== "group") continue;
    if (groupId === "43a2bc9c218353ae") {
      const fixed = new Map([
        ["vehicle_primary_manual_refresh_blocked_notification_v1__hub_call", [1160, 980]],
        ["vehicle_primary_refresh_notify_primary_v1__hub_call", [1650, 900]],
        ["vehicle_primary_refresh_notify_persistent_v1__hub_call", [1650, 1060]],
        ["vehicle_primary_refresh_dismiss_persistent_v1__hub_call", [1550, 1180]],
      ]);
      for (const [id, [x, y]] of fixed) {
        const candidate = byId.get(id);
        if (candidate) Object.assign(candidate, { x, y });
      }
      delete owner.notification_hub_layout_version;
      continue;
    }
    const generated = new Set(entries.flatMap(({ migration }) => [
      `${migration.id}__hub_call`,
      `${migration.id}__hub_result`,
    ]));
    const layoutAlreadyApplied = owner.notification_hub_layout_version === 1 ||
      entries.every(({ adapter }) => adapter.notification_hub_layout_version === 1);
    if (!layoutAlreadyApplied) {
      const columns = [...new Set(entries.map(({ adapter }) => Number(adapter.x ?? 0)))].sort((a, b) => a - b);
      for (const candidate of flows.filter((node) => node.g === groupId && !generated.has(node.id))) {
        const originalX = Number(candidate.x ?? 0);
        candidate.x = originalX + columns.filter((column) => column < originalX).length * 600;
      }
    }
    for (const { migration, adapter } of entries) {
      const call = byId.get(`${migration.id}__hub_call`);
      const result = byId.get(`${migration.id}__hub_result`);
      if (call) Object.assign(call, { x: Number(adapter.x ?? 0) + 280, y: adapter.y });
      if (result) Object.assign(result, { x: Number(adapter.x ?? 0) + 550, y: adapter.y });
      setRuntimeMetadata(adapter, "notification_hub_layout_version", 1);
    }
    setRuntimeMetadata(owner, "notification_hub_layout_version", 1);
    const members = flows.filter((node) => node.g === groupId && Number.isFinite(node.x) && Number.isFinite(node.y));
    owner.w = Math.max(Number(owner.w ?? 0), Math.ceil(Math.max(...members.map((node) => node.x + 160)) - Number(owner.x ?? 0)));
    owner.h = Math.max(Number(owner.h ?? 0), Math.ceil(Math.max(...members.map((node) => node.y + 40)) - Number(owner.y ?? 0)));
  }
  return flows;
}

function applyInfrastructureCallerLayout(flows) {
  const byId = new Map(flows.map((node) => [node.id, node]));
  const byGroup = new Map();
  for (const id of INFRASTRUCTURE_CALLERS) {
    const shared = byId.get(id);
    if (!shared?.g) continue;
    const ids = byGroup.get(shared.g) ?? [];
    ids.push(id);
    byGroup.set(shared.g, ids);
  }
  for (const [groupId, ids] of byGroup) {
    const owner = byId.get(groupId);
    if (!owner || owner.type !== "group") continue;
    const sorted = [...ids].sort();
    for (const [index, id] of sorted.entries()) {
      const shared = byId.get(id);
      const baseX = Number(shared.x ?? 0);
      const storedY = Number(shared.notification_hub_anchor_y);
      const baseY = Number.isFinite(storedY)
        ? storedY
        : sorted.length > 1
          ? Number(owner.y ?? 0) + 170 + index * 390
          : Number(shared.y ?? 0);
      setRuntimeMetadata(shared, "notification_hub_anchor_y", baseY);
      Object.assign(shared, { x: baseX, y: baseY });
      for (const [suffix, dx, dy] of [
        ["contract_gate", 300, 0], ["contract_reject", 300, 160],
        ["mobile_prepare", 600, -150], ["mobile_call", 880, -150],
        ["mobile_secondary_prepare", 600, -90], ["mobile_secondary_call", 880, -90],
        ["alexa_prepare", 600, -20], ["alexa_call", 880, -20],
        ["persistent_prepare", 600, 60], ["persistent_call", 880, 60],
        ["dismiss_gate", 600, 160], ["dismiss_prepare", 900, 160], ["dismiss_call", 1180, 160],
      ]) {
        const candidate = byId.get(`${id}__${suffix}`);
        if (candidate) Object.assign(candidate, { x: baseX + dx, y: baseY + dy });
      }
    }
    setRuntimeMetadata(owner, "notification_hub_layout_version", 1);
    const members = flows.filter((node) => node.g === groupId && Number.isFinite(node.x) && Number.isFinite(node.y));
    owner.w = Math.max(Number(owner.w ?? 0), Math.ceil(Math.max(...members.map((node) => node.x + 160)) - Number(owner.x ?? 0)));
    owner.h = Math.max(Number(owner.h ?? 0), Math.ceil(Math.max(...members.map((node) => node.y + 40)) - Number(owner.y ?? 0)));
  }
  return flows;
}

export function installNotificationHubs(inputFlows, options = {}) {
  const routeWires = options.routeWires ?? process.env.NODE_RED_NOTIFICATION_ROUTE_WIRES !== "0";
  inputFlows = restoreGeneratedWireRoutes(inputFlows);
  const hubTabs = new Set(Object.values(NOTIFICATION_HUBS).map(({ tab }) => tab));
  const legacyOwned = new Set(inputFlows.filter((node) => node.id === LEGACY_SUBFLOW || node.z === LEGACY_SUBFLOW).map((node) => node.id));
  const generatedCallerIds = new Set([
    ...NOTIFICATION_MIGRATIONS.flatMap(({ id }) => [`${id}__hub_call`, `${id}__hub_result`]),
    ...INFRASTRUCTURE_CALLERS.flatMap((id) => ["contract_gate", "contract_reject", "mobile_prepare", "mobile_call", "mobile_secondary_prepare", "mobile_secondary_call", "alexa_prepare", "alexa_call", "persistent_prepare", "persistent_call", "dismiss_gate", "dismiss_prepare", "dismiss_call"].map((suffix) => `${id}__${suffix}`)),
  ]);
  let flows = inputFlows.filter((node) => !hubTabs.has(node.id) && !hubTabs.has(node.z) && !legacyOwned.has(node.id));
  for (const node of flows) {
    if (Array.isArray(node.nodes)) node.nodes = node.nodes.filter((id) => !legacyOwned.has(id));
    if (Array.isArray(node.scope)) node.scope = node.scope.filter((id) => !legacyOwned.has(id));
    if (Array.isArray(node.wires)) node.wires = node.wires.map((wire) => wire.filter((id) => !legacyOwned.has(id)));
    if (Array.isArray(node.links)) node.links = node.links.filter((id) => !legacyOwned.has(id));
  }
  for (const migration of NOTIFICATION_MIGRATIONS) flows = migrateDirectCall(flows, migration);
  for (const id of INFRASTRUCTURE_CALLERS) flows = migrateInfrastructureCaller(flows, id);
  flows = applyBusinessCallerLayout(flows);
  flows = applyInfrastructureCallerLayout(flows);
  if (routeWires) flows = routeLongNotificationTabWires(flows);
  flows.push(...mobileHubNodes(), ...alexaHubNodes(), ...persistentHubNodes());

  const observerInput = flows.find((node) => node.id === OBSERVER_INPUT);
  const observerOutputs = [
    "notification_hub_mobile_observer_out",
    "notification_hub_alexa_observer_out",
    "notification_hub_persistent_observer_out",
  ];
  if (observerInput) observerInput.links = [...new Set([...(observerInput.links ?? []), ...observerOutputs])];

  const byId = new Map(flows.map((node) => [node.id, node]));
  for (const id of generatedCallerIds) {
    const node = byId.get(id);
    if (node?.g) {
      const owner = byId.get(node.g);
      if (owner?.type === "group" && !owner.nodes.includes(id)) owner.nodes.push(id);
    }
  }
  return flows;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  const sourcePath = path.resolve(process.argv[2] ?? path.resolve(here, "..", "flows.json"));
  const outputPath = path.resolve(process.argv[3] ?? sourcePath);
  const flows = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
  const migrated = installNotificationHubs(flows);
  fs.writeFileSync(outputPath, `${JSON.stringify(migrated, null, 4)}\n`);
  console.log(`Notification hubs installed in ${outputPath}`);
}
