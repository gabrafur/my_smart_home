import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import jsonata from "jsonata";

import {
  NOTIFICATION_HUBS,
  NOTIFICATION_MIGRATIONS,
  RETIRED_NOTIFICATION_IDS,
  INFRASTRUCTURE_SECONDARY_CALLERS,
  installNotificationHubs,
  restoreGeneratedWireRoutes,
} from "./install-notification-hubs.mjs";

const sourceFlows = JSON.parse(fs.readFileSync(new URL("../flows.json", import.meta.url), "utf8"));
const sourceById = new Map(sourceFlows.map((candidate) => [candidate.id, candidate]));
for (const id of ["2818bf202b397612", "light_notify_on_secondary"]) {
  const payloadRule = sourceById.get(id)?.rules?.find((rule) => rule.p === "payload");
  assert.match(payloadRule?.to ?? "", /actuator_confirmation_pending/,
    `${id}: flows.json precisa preservar a mensagem de confirmação pendente`);
}
const migrated = installNotificationHubs(structuredClone(sourceFlows));
const repeated = installNotificationHubs(structuredClone(migrated));
assert.deepEqual(repeated, migrated, "o gerador dos hubs precisa ser idempotente");
const runtimeRoundTrip = structuredClone(migrated);
for (const candidate of runtimeRoundTrip) {
  if (candidate.type === "group") delete candidate.notification_hub_layout_version;
}
const afterRuntimeRoundTrip = installNotificationHubs(structuredClone(runtimeRoundTrip));
assert.deepEqual(
  afterRuntimeRoundTrip,
  runtimeRoundTrip,
  "a serialização do Node-RED não pode reaplicar deslocamento nem metadado visual dos hubs",
);

const orphanRouteOut = "notification_hub_wire_out_123456789abc";
const orphanRouteIn = "notification_hub_wire_in_123456789abc";
const orphanRouteFixture = [
  { id: "route-tab", type: "tab", label: "route" },
  { id: "route-group", type: "group", z: "route-tab", nodes: [orphanRouteOut, orphanRouteIn, "route-target"] },
  { id: orphanRouteOut, type: "link out", z: "route-tab", g: "route-group", links: [orphanRouteIn], wires: [] },
  { id: orphanRouteIn, type: "link in", z: "route-tab", g: "route-group", links: [orphanRouteOut], wires: [["route-target"]] },
  { id: "route-target", type: "function", z: "route-tab", g: "route-group", wires: [[]] },
];
const restoredOrphanRoute = restoreGeneratedWireRoutes(structuredClone(orphanRouteFixture));
assert.equal(restoredOrphanRoute.some((candidate) => candidate.id === orphanRouteOut), false);
assert.equal(restoredOrphanRoute.some((candidate) => candidate.id === orphanRouteIn), false);
assert.deepEqual(restoredOrphanRoute.find((candidate) => candidate.id === "route-group").nodes, ["route-target"]);

const orphanWithoutTarget = structuredClone(orphanRouteFixture);
orphanWithoutTarget.find((candidate) => candidate.id === orphanRouteIn).wires = [[]];
const restoredOrphanWithoutTarget = restoreGeneratedWireRoutes(orphanWithoutTarget);
assert.equal(restoredOrphanWithoutTarget.some((candidate) => candidate.id === orphanRouteOut), false);
assert.equal(restoredOrphanWithoutTarget.some((candidate) => candidate.id === orphanRouteIn), false);
assert.deepEqual(
  restoredOrphanWithoutTarget.find((candidate) => candidate.id === "route-group").nodes,
  ["route-target"],
);

const byId = new Map(migrated.map((node) => [node.id, node]));
assert.equal(byId.size, migrated.length, "IDs duplicados após instalar os hubs");
const node = (id) => {
  const value = byId.get(id);
  assert.ok(value, `node ausente: ${id}`);
  return value;
};

for (const [channel, expectedLabel] of [
  ["mobile", "hub_notificacoes_moveis"],
  ["alexa", "hub_notificacoes_alexa"],
  ["persistent", "hub_notificacoes_persistentes_ha"],
]) {
  assert.equal(node(NOTIFICATION_HUBS[channel].tab).type, "tab");
  assert.equal(node(NOTIFICATION_HUBS[channel].tab).label, expectedLabel);
  assert.equal(node(NOTIFICATION_HUBS[channel].input).type, "link in");
}

const expectedEffects = new Map([
  ["notification_hub_mobile_primary_simple", [NOTIFICATION_HUBS.mobile.tab, "public_bindings.call", "all", /"role":"mobile_primary","action":"notify_3"/]],
  ["notification_hub_mobile_secondary_simple", [NOTIFICATION_HUBS.mobile.tab, "public_bindings.call", "all", /"role":"mobile_secondary","action":"notify_2"/]],
  ["notification_hub_mobile_primary_actionable", [NOTIFICATION_HUBS.mobile.tab, "public_bindings.call", "all", /"role":"mobile_primary","action":"notify_actionable"/]],
  ["notification_hub_mobile_secondary_actionable", [NOTIFICATION_HUBS.mobile.tab, "public_bindings.call", "all", /"role":"mobile_secondary","action":"notify_actionable"/]],
  ["notification_hub_mobile_primary_background", [NOTIFICATION_HUBS.mobile.tab, "public_bindings.call", "first", /"role":"mobile_primary","action":"notify_3"/]],
  ["notification_hub_mobile_secondary_background", [NOTIFICATION_HUBS.mobile.tab, "public_bindings.call", "first", /"role":"mobile_secondary","action":"notify_2"/]],
  ["notification_hub_alexa_service", [NOTIFICATION_HUBS.alexa.tab, "public_bindings.call", "all", /"role":"mobile_primary","action":"notify"/]],
  ["notification_hub_persistent_create_queued", [NOTIFICATION_HUBS.persistent.tab, "persistent_notification.create", "all", /notification_id/]],
  ["notification_hub_persistent_create_immediate", [NOTIFICATION_HUBS.persistent.tab, "persistent_notification.create", "none", /notification_id/]],
  ["notification_hub_persistent_dismiss_queued", [NOTIFICATION_HUBS.persistent.tab, "persistent_notification.dismiss", "all", /notification_id/]],
  ["notification_hub_persistent_dismiss_immediate", [NOTIFICATION_HUBS.persistent.tab, "persistent_notification.dismiss", "none", /notification_id/]],
]);

const notificationEffects = migrated.filter((candidate) => {
  if (candidate.type !== "api-call-service") return false;
  if (String(candidate.action ?? "").startsWith("persistent_notification.")) return true;
  return candidate.action === "public_bindings.call" && /"action":"notify/.test(String(candidate.data ?? ""));
});
assert.deepEqual(
  notificationEffects.map(({ id }) => id).sort(),
  [...expectedEffects.keys()].sort(),
  "toda saída real deve existir exclusivamente dentro dos três hubs",
);
for (const [id, [tab, action, queue, dataPattern]] of expectedEffects) {
  const effect = node(id);
  assert.equal(effect.z, tab, `${id}: tab canônico incorreto`);
  assert.equal(effect.action, action, `${id}: serviço alterado`);
  assert.equal(effect.queue, queue, `${id}: política de fila alterada`);
  assert.match(effect.data, dataPattern, `${id}: binding/metadata incorreto`);
}

const dashboardAlexaEvent = node("notification_hub_alexa_dashboard_event");
assert.equal(dashboardAlexaEvent.type, "server-events");
assert.equal(dashboardAlexaEvent.eventType, "alexa_text_announcement_requested");
assert.deepEqual(dashboardAlexaEvent.wires, [["notification_hub_alexa_dashboard_request"]]);
assert.deepEqual(
  node("notification_hub_alexa_dashboard_call").links,
  [NOTIFICATION_HUBS.alexa.input],
  "o painel deve atravessar a entrada canônica do hub Alexa",
);

assert.equal(NOTIFICATION_MIGRATIONS.length, 38, "a matriz explícita deve cobrir os 38 efeitos ativos fora do subflow legado");
assert.equal(new Set(NOTIFICATION_MIGRATIONS.map(({ id }) => id)).size, 38);
for (const id of RETIRED_NOTIFICATION_IDS) {
  for (const suffix of ["", "__hub_call", "__hub_result"]) {
    assert.equal(byId.has(id + suffix), false, `não reativar canal removido: ${id + suffix}`);
    assert.equal(sourceById.has(id + suffix), false);
  }
}
for (const migration of NOTIFICATION_MIGRATIONS) {
  const adapter = node(migration.id);
  const call = node(`${migration.id}__hub_call`);
  assert.equal(adapter.type, "change", `${migration.id}: o efeito antigo deve virar adaptador visual`);
  assert.equal(call.type, "link call", `${migration.id}: chamada canônica ausente`);
  assert.deepEqual(call.links, [NOTIFICATION_HUBS[migration.channel].input]);
  const contract = adapter.rules.find((rule) => rule.p === "notification");
  assert.ok(contract, `${migration.id}: contrato msg.notification ausente`);
  assert.match(contract.to, new RegExp(`"source":"${migration.source}"`));
  if (migration.channel === "mobile") {
    assert.match(contract.to, new RegExp(`"recipients":\\["${migration.recipient}"\\]`));
    assert.doesNotMatch(contract.to, /broadcast|"all"|"both"/i);
  }
  if (migration.channel === "alexa") {
    assert.match(contract.to, /"targets":\["voice_assistant_primary"\]/);
  }
}

for (const callerId of [
  "vpn_monitor_notify_dispatch",
  "internet_notify_down",
  "internet_notify_recovery",
  "zigbee_notify_effect",
  "tuya_notify_effect",
]) {
  assert.equal(node(callerId).type, "change", `${callerId}: subflow monolítico legado ainda presente`);
  const contractGate = node(`${callerId}__contract_gate`);
  assert.equal(contractGate.type, "switch");
  assert.ok(await jsonata(contractGate.property).evaluate({ _notification_hub_shared: { title: "Título", message: "Mensagem", id: "incidente" } }));
  for (const incomplete of [
    { message: "Mensagem", id: "incidente" },
    { title: "Título", id: "incidente" },
    { title: "Título", message: "Mensagem" },
  ]) assert.equal(await jsonata(contractGate.property).evaluate({ _notification_hub_shared: incomplete }), false,
    `${callerId}: contrato incompleto precisa bloquear todos os canais`);
  assert.deepEqual(contractGate.wires[1], [`${callerId}__contract_reject`]);
  const mobileContract = node(`${callerId}__mobile_prepare`).rules.find((rule) => rule.p === "notification").to;
  assert.match(mobileContract, /"recipients":\["resident_primary"\]/);
  if (INFRASTRUCTURE_SECONDARY_CALLERS.includes(callerId)) {
    const mobileSecondaryContract = node(`${callerId}__mobile_secondary_prepare`).rules.find((rule) => rule.p === "notification").to;
    assert.match(mobileSecondaryContract, /"recipients":\["resident_secondary"\]/);
    assert.doesNotMatch(mobileSecondaryContract, /broadcast|"all"|"both"/i);
    assert.deepEqual(node(`${callerId}__mobile_secondary_call`).links, [NOTIFICATION_HUBS.mobile.input]);
  } else {
    assert.equal(byId.has(`${callerId}__mobile_secondary_prepare`), false);
    assert.equal(byId.has(`${callerId}__mobile_secondary_call`), false);
  }
  assert.doesNotMatch(mobileContract, /broadcast|"all"|"both"/i);
  assert.deepEqual(node(`${callerId}__mobile_call`).links, [NOTIFICATION_HUBS.mobile.input]);
  assert.equal(byId.has(`${callerId}__alexa_call`), false);
  assert.deepEqual(node(`${callerId}__persistent_call`).links, [NOTIFICATION_HUBS.persistent.input]);
  assert.deepEqual(node(`${callerId}__dismiss_call`).links, [NOTIFICATION_HUBS.persistent.input]);
}
assert.equal(byId.has("infra_notify_all_mobiles"), false, "subflow monolítico precisa ser removido");
const rejectedInfrastructure = executeFunction("notification-hub-infrastructure-reject.js", { payload: "preservado" });
assert.equal(rejectedInfrastructure.result, null);
assert.match(rejectedInfrastructure.warnings[0], /título, mensagem ou id ausente/);

for (const filename of [
  "configure-garage-gate-flow.mjs",
  "fix-actionable-notification-bindings.mjs",
  "fix-external-lighting-confirmation.mjs",
  "fix-external-lighting-sunset-recovery.mjs",
  "harden-alarm-arrival-notifications.mjs",
  "install-alarm-arrival-flow.mjs",
  "install-alarm-house-flow.mjs",
  "install-codex-alert-flows.mjs",
  "install-git-backup-flow.mjs",
  "install-internet-monitor-flow.mjs",
  "install-local-ai-rtx-recovery-flow.mjs",
  "install-resident-notifications-flow.mjs",
  "install-storage-health-flow.mjs",
  "install-tuya-monitor-flow.mjs",
  "install-vehicle-primary-dashboard-controls.mjs",
  "install-vpn-monitor-flow.mjs",
  "install-zigbee-monitor-flow.mjs",
  "migrate-notification-bindings.mjs",
  "organize-raspberry-pi-cooling-flow.mjs",
  "update-people-location-selection.mjs",
  "update-resident-approach-notifications.mjs",
  "update-vehicle-primary-manual-engine-tests.mjs",
]) {
  const generator = fs.readFileSync(new URL(filename, import.meta.url), "utf8");
  const finalizesInline = /JSON\.stringify\(installNotificationHubs\(/.test(generator);
  const finalizesBeforeReconciliation = /const desired = installNotificationHubs\(/.test(generator) &&
    /reconcileGeneratedFlows\(originalFlows, desired,/.test(generator);
  const finalizesIsolatedTab = /const installed = installNotificationHubs\(/.test(generator) &&
    /structuredClone\(next\.filter/.test(generator);
  assert.ok(finalizesInline || finalizesBeforeReconciliation || finalizesIsolatedTab,
    `${filename}: gerador pode reintroduzir saída direta sem o finalizador canônico`);
}

// Metadata e contratos de confirmação são literais e precisam atravessar a migração.
const contractText = (id) => node(id).rules.find((rule) => rule.p === "notification").to;
for (const token of ["notification_tag", "confirm_action", "cancel_action", '"Ligar"', '"Não ligar"']) {
  assert.match(contractText("ext_send_recovery_mobile"), new RegExp(token));
}
for (const id of ["3b95712a74512929", "370622ddaaf3fcab"]) {
  for (const token of ["notification_tag", "confirm_action", "cancel_action", "confirm_action_title", "cancel_action_title"]) {
    assert.match(contractText(id), new RegExp(token));
  }
}
for (const id of ["resident_notifications_notify_primary", "resident_notifications_notify_secondary"]) {
  assert.match(contractText(id), /notification_key/);
  assert.match(contractText(id), /"sound":"default"/);
  assert.match(contractText(id), /"interruption-level":"time-sensitive"/);
}
assert.match(contractText("resident_notifications_test_notify_secondary"), /"recipients":\["resident_secondary"\]/);
assert.doesNotMatch(contractText("resident_notifications_test_notify_secondary"), /resident_primary/);
assert.match(contractText("global_observer_notify_primary"), /"recipients":\["resident_primary"\]/);

const functionSources = migrated
  .filter((candidate) => candidate.type === "function" &&
    candidate.id !== "alarm_arrival_test_dry_run_terminal_v1" &&
    !Object.values(NOTIFICATION_HUBS).some(({ tab }) => tab === candidate.z))
  .map((candidate) => String(candidate.func ?? ""))
  .join("\n");
assert.doesNotMatch(functionSources, /persistent_notification\.(?:create|dismiss)|mobile_app|notify_actionable|notify_[23]/,
  "Function Node de negócio não pode esconder uma saída de notificação");

function executeFunction(filename, msg) {
  const code = fs.readFileSync(new URL(`./functions/${filename}`, import.meta.url), "utf8");
  const warnings = [];
  const store = new Map();
  const sandbox = {
    msg: structuredClone(msg),
    node: { status() {}, warn: (value) => warnings.push(value), error() {}, log() {} },
    flow: { get: (key) => store.get(key), set: (key, value) => store.set(key, value) },
    Date, Set, Object, Array, String, JSON,
  };
  const result = vm.runInNewContext(`(function () { ${code}\n})()`, sandbox);
  return { result, msg: sandbox.msg, warnings, store };
}

const validMobile = (recipients) => executeFunction("notification-hub-mobile-validate.js", {
  payload: "mensagem",
  notification: { source: "test", recipients, profile: "simple" },
});
for (const recipients of [["resident_primary"], ["resident_secondary"], ["resident_primary", "resident_secondary"]]) {
  const result = validMobile(recipients).result;
  assert.ok(result[0], `contrato válido rejeitado: ${recipients.join(",")}`);
  assert.equal(result[1], null);
}
for (const invalid of [
  { payload: "mensagem", notification: { source: "test", profile: "simple" } },
  { payload: "mensagem", notification: { source: "test", recipients: [], profile: "simple" } },
  { payload: "mensagem", notification: { source: "test", recipients: ["all"], profile: "simple" } },
  { payload: "mensagem", notification: { source: "test", recipients: ["resident_primary", "resident_primary"], profile: "simple" } },
]) {
  const result = executeFunction("notification-hub-mobile-validate.js", invalid).result;
  assert.equal(result[0], null, "contrato móvel inseguro foi aceito");
  assert.ok(result[1], "rejeição móvel precisa ser observável");
}
const background = executeFunction("notification-hub-mobile-validate.js", {
  payload: "request_location_update",
  notification: { source: "test", recipients: ["resident_primary"], profile: "background_command" },
});
assert.ok(background.result[0]);
const forbiddenBackground = executeFunction("notification-hub-mobile-validate.js", {
  payload: "mensagem arbitrária",
  notification: { source: "test", recipients: ["resident_primary"], profile: "background_command" },
});
assert.equal(forbiddenBackground.result[0], null);

const primaryFailureInPair = executeFunction("notification-hub-mobile-leg-failure.js", {
  notification: { recipients: ["resident_primary", "resident_secondary"] },
  _notification_hub_recipient: "resident_primary",
  error: { message: "primary unavailable" },
});
assert.ok(primaryFailureInPair.result[0], "falha no primeiro destinatário deve tentar o segundo");
assert.equal(primaryFailureInPair.result[1], null);
assert.equal(primaryFailureInPair.msg._notification_hub_recipient, "resident_secondary");
assert.equal(primaryFailureInPair.msg._notification_hub_prior_failure, "primary unavailable");
assert.equal(primaryFailureInPair.msg.error, undefined);
const secondaryFailureInPair = executeFunction("notification-hub-mobile-leg-failure.js", {
  notification: { recipients: ["resident_primary", "resident_secondary"] },
  _notification_hub_recipient: "resident_secondary",
  error: { message: "secondary unavailable" },
});
assert.equal(secondaryFailureInPair.result[0], null);
assert.ok(secondaryFailureInPair.result[1], "falha no segundo destinatário deve concluir uma única vez");
assert.deepEqual(node("notification_hub_mobile_service_catch").wires, [["notification_hub_mobile_leg_failure"]]);
assert.deepEqual(node("notification_hub_mobile_leg_failure").wires, [["notification_hub_mobile_pair_retry_out"], ["notification_hub_mobile_failure"]]);
assert.equal(node("notification_hub_mobile_after_service").wires.length, 3);

const alexaValid = executeFunction("notification-hub-alexa-validate.js", {
  payload: "anúncio",
  notification: { source: "test", targets: ["voice_assistant_primary"], mode: "announce" },
});
assert.ok(alexaValid.result[0]);
const alexaBroadcast = executeFunction("notification-hub-alexa-validate.js", {
  payload: "anúncio",
  notification: { source: "test", targets: ["all"], mode: "announce" },
});
assert.equal(alexaBroadcast.result[0], null);
const alexaTooLong = executeFunction("notification-hub-alexa-validate.js", {
  payload: "x".repeat(256),
  notification: { source: "test", targets: ["voice_assistant_primary"], mode: "announce" },
});
assert.equal(alexaTooLong.result[0], null);

const dashboardAlexa = executeFunction("notification-hub-alexa-dashboard-request.js", {
  payload: { message: "  Olá pela Alexa  ", origin: "manual_test" },
  _notification_hub_dashboard_test: true,
});
assert.equal(dashboardAlexa.result.payload, "Olá pela Alexa");
assert.equal(dashboardAlexa.result.notification.source, "chat_dashboard");
assert.equal(dashboardAlexa.result.notification.mode, "announce");
assert.equal(dashboardAlexa.result.notification.targets[0], "voice_assistant_primary");
assert.equal(dashboardAlexa.result.notification.test_mode, true);
assert.equal(dashboardAlexa.result._notification_hub_dashboard_test, undefined);
const dashboardAlexaHomeAssistantEvent = executeFunction("notification-hub-alexa-dashboard-request.js", {
  payload: {
    event_type: "alexa_text_announcement_requested",
    event: { message: "  Mensagem real do Home Assistant  ", origin: "chat_dashboard" },
    origin: "LOCAL",
  },
});
assert.equal(dashboardAlexaHomeAssistantEvent.result.payload, "Mensagem real do Home Assistant");
assert.equal(dashboardAlexaHomeAssistantEvent.result.notification.source, "chat_dashboard");
assert.equal(dashboardAlexaHomeAssistantEvent.result.notification.test_mode, undefined);
assert.equal(
  dashboardAlexaHomeAssistantEvent.result._notification_hub_context.payload.event_type,
  "alexa_text_announcement_requested",
);
const dashboardAlexaEmpty = executeFunction("notification-hub-alexa-dashboard-request.js", {
  payload: { message: "   " },
});
const rejectedDashboardAlexa = executeFunction(
  "notification-hub-alexa-validate.js",
  dashboardAlexaEmpty.result,
);
assert.equal(rejectedDashboardAlexa.result[0], null);

const persistentCreate = executeFunction("notification-hub-persistent-validate.js", {
  payload: "mensagem",
  notification: { source: "test", operation: "create", delivery: "queued", notification_id: "stable", title: "Título" },
});
assert.ok(persistentCreate.result[0]);
const persistentDismiss = executeFunction("notification-hub-persistent-validate.js", {
  payload: "",
  notification: { source: "test", operation: "dismiss", delivery: "immediate", notification_id: "stable" },
});
assert.ok(persistentDismiss.result[0]);

// O resfriamento conserva apenas o celular principal e o alerta persistente.
assert.match(contractText("rpi_emergency_cooling_push_primary"), /"recipients":\["resident_primary"\]/);
assert.deepEqual(node("349bc099633fee5d__hub_call").links, [NOTIFICATION_HUBS.persistent.input]);

console.log(`Notification hubs: ${NOTIFICATION_MIGRATIONS.length} efeitos migrados, ${notificationEffects.length} saídas canônicas, fail-closed validado`);
