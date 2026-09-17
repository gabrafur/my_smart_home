#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";

const flows = JSON.parse(fs.readFileSync(new URL("../flows.json", import.meta.url), "utf8"));
const byId = new Map(flows.map((node) => [node.id, node]));
const TAB = "resident_notifications_tab";

function resolvedWireTargets(id, output = 0) {
  return (byId.get(id)?.wires?.[output] ?? []).flatMap((targetId) => {
    const routeOut = byId.get(targetId);
    const generatedRoute = routeOut?.notification_hub_wire_route ||
      /^notification_hub_wire_out_[a-f0-9]{12}$/.test(routeOut?.id ?? "");
    if (!generatedRoute) return [targetId];
    assert.equal(routeOut.type, "link out");
    assert.equal(routeOut.links?.length, 1);
    const routeIn = byId.get(routeOut.links[0]);
    assert.equal(routeIn?.type, "link in");
    assert.deepEqual(routeIn.links, [routeOut.id]);
    return routeIn.wires?.[0] ?? [];
  });
}

function getFunction(id) {
  const flowNode = byId.get(id);
  assert.equal(flowNode?.type, "function", `function ausente: ${id}`);
  return new Function("msg", "flow", "node", "global", flowNode.func);
}

function context(initial = {}) {
  const stores = {
    default: new Map(Object.entries(initial.default ?? {})),
    persistent: new Map(Object.entries(initial.persistent ?? {})),
  };
  return {
    stores,
    get(key, store = "default") { return stores[store].get(key); },
    set(key, value, store = "default") { stores[store].set(key, structuredClone(value)); },
  };
}

function nodeMock() {
  return {
    errors: [], warnings: [], statuses: [],
    error(value) { this.errors.push(String(value)); },
    warn(value) { this.warnings.push(String(value)); },
    status(value) { this.statuses.push(value); },
  };
}

const tab = byId.get(TAB);
assert.equal(tab?.label, "notificacoes_chegadas_residentes");
const tabNodes = flows.filter((node) => node.z === TAB);
assert.ok(tabNodes.length >= 60);
assert.equal(tabNodes.filter((node) => node.type === "server-state-changed").length, 0);
assert.match(tab.info, /security\.arrival\.v1/);
assert.match(tab.info, /resident_primary → mobile_secondary; resident_secondary → mobile_primary/);
assert.match(tab.info, /somente o botão explicitamente marcado envia um push TESTE/);

for (const id of [
  "resident_notifications_policy_switch",
  "resident_notifications_contract_switch",
  "resident_notifications_kind_switch",
  "resident_notifications_policy_available",
  "resident_notifications_direction_switch",
  "resident_notifications_cycle_switch",
  "resident_notifications_stage_switch",
  "resident_notifications_home_confirmation_test_switch",
  "resident_notifications_home_confirmation_source",
  "resident_notifications_home_confirmation_result",
  "resident_notifications_source_switch",
  "resident_notifications_event_time_switch",
  "resident_notifications_future_switch",
  "resident_notifications_stale_switch",
  "resident_notifications_duplicate_switch",
  "resident_notifications_test_gate",
  "resident_notifications_recipient_switch",
  "resident_notifications_retry_switch",
]) assert.equal(byId.get(id)?.type, "switch", `decisão visual ausente: ${id}`);

const policyControls = [
  ["resident_notifications_policy_dedupe", "dedupe_ttl_ms", "600000"],
  ["resident_notifications_policy_age", "max_event_age_ms", "900000"],
  ["resident_notifications_policy_future", "future_tolerance_ms", "60000"],
  ["resident_notifications_policy_retry", "service_retry_seconds", "60"],
  ["resident_notifications_policy_home_stable", "home_confirmation_seconds", "90"],
  ["resident_notifications_policy_home_window", "home_confirmation_window_seconds", "300"],
  ["resident_notifications_policy_home_recheck", "home_confirmation_recheck_seconds", "30"],
];
assert.match(byId.get("resident_notifications_config_group")?.name ?? "", /PARÂMETROS AJUSTÁVEIS/);
for (const [id, topic, payload] of policyControls) {
  const control = byId.get(id);
  assert.equal(control?.props.find((item) => item.p === "topic")?.v, topic);
  assert.equal(control?.props.find((item) => item.p === "payload")?.v, payload);
  assert.deepEqual(resolvedWireTargets(id), ["resident_notifications_policy_join"]);
}

const peopleOut = byId.get("people_location_notification_out_v1");
const canonicalIn = byId.get("resident_notifications_canonical_in_v1");
const peopleFinalizer = byId.get("554cb653b2fa4504");
const peopleClassifier = byId.get("people_location_classify_near_home_v1");
assert.ok(peopleOut.links.includes(canonicalIn.id));
assert.ok(canonicalIn.links.includes(peopleOut.id));
assert.ok(canonicalIn.links.includes("light_arrival_replay_route_out_v1"));
assert.ok(byId.get("light_arrival_replay_route_out_v1").links.includes(canonicalIn.id));
assert.ok(canonicalIn.links.includes("resident_notifications_test_event_out"));
assert.ok(byId.get("resident_notifications_test_event_out").links.includes(canonicalIn.id));
assert.deepEqual(byId.get("resident_notifications_event_in").links, ["resident_notifications_canonical_out"]);
assert.ok(peopleFinalizer.wires[1].includes(peopleOut.id), "avisos devem receber apenas retorno confirmado");
assert.ok(!peopleClassifier.wires.flat().includes(peopleOut.id), "classificação bruta não pode decidir aviso");
assert.equal(byId.get("resident_notifications_home_confirmation_primary")?.entity_id,
  "device_tracker.resident_primary_location");
assert.equal(byId.get("resident_notifications_home_confirmation_secondary")?.entity_id,
  "device_tracker.resident_secondary_location");

const validatePolicy = getFunction("resident_notifications_policy_validate");
const storePolicy = getFunction("resident_notifications_policy_store");
const loadPolicy = getFunction("resident_notifications_policy_load");
const normalize = getFunction("resident_notifications_prepare");
const prepareHome = getFunction("resident_notifications_home_confirmation_prepare");
const testHomeState = getFunction("resident_notifications_home_confirmation_test_state");
const evaluateHome = getFunction("resident_notifications_home_confirmation_evaluate");
const migrateState = getFunction("resident_notifications_state_migrate");
const readState = getFunction("resident_notifications_state_read");
const reserve = getFunction("resident_notifications_state_write");
const buildMessage = getFunction("resident_notifications_message_build");
const acknowledge = getFunction("resident_notifications_delivery_ack");
const failDelivery = getFunction("resident_notifications_delivery_failure");
const dryRun = getFunction("resident_notifications_dry_run_terminal");
const flow = context();
const mock = nodeMock();
const privateBindings = context({
  default: {
    publicBindings: {
      roles: {
        resident_primary: { source_alias: "example_primary" },
        resident_secondary: { source_alias: "example_secondary" },
      },
    },
  },
});
const NOW = Date.parse("2026-09-12T01:00:00.000Z");
let clock = NOW;
const originalNow = Date.now;
Date.now = () => clock;

const defaults = {
  dedupe_ttl_ms: 600000,
  max_event_age_ms: 900000,
  future_tolerance_ms: 60000,
  service_retry_seconds: 60,
  home_confirmation_seconds: 90,
  home_confirmation_window_seconds: 300,
  home_confirmation_recheck_seconds: 30,
};
let message = validatePolicy({ payload: defaults }, flow, mock, {});
assert.equal(message.policy_valid, true);
assert.equal(storePolicy(message, flow, mock, {}), null);
message = loadPolicy({}, flow, mock, {});
assert.equal(message.policy_available, true);
assert.deepEqual(message.policy, { version: 3, ...defaults });

for (const payload of [
  { ...defaults, dedupe_ttl_ms: 59999 },
  { ...defaults, dedupe_ttl_ms: 3600001 },
  { ...defaults, max_event_age_ms: 59999 },
  { ...defaults, future_tolerance_ms: -1 },
  { ...defaults, future_tolerance_ms: 300001 },
  { ...defaults, service_retry_seconds: 9 },
  { ...defaults, service_retry_seconds: 601 },
  { ...defaults, home_confirmation_seconds: 29 },
  { ...defaults, home_confirmation_seconds: 301 },
  { ...defaults, home_confirmation_window_seconds: 89 },
  { ...defaults, home_confirmation_window_seconds: 901 },
  { ...defaults, home_confirmation_recheck_seconds: 9 },
  { ...defaults, home_confirmation_recheck_seconds: 61 },
  { ...defaults, home_confirmation_seconds: 120, home_confirmation_window_seconds: 90 },
  { ...defaults, home_confirmation_seconds: 30, home_confirmation_recheck_seconds: 30 },
  { ...defaults, max_event_age_ms: 60000, future_tolerance_ms: 60000 },
]) assert.equal(validatePolicy({ payload }, flow, mock, {}).policy_valid, false);
assert.equal(validatePolicy({ payload: { ...defaults, dedupe_ttl_ms: 60000, max_event_age_ms: 60000, future_tolerance_ms: 0, service_retry_seconds: 10 } }, flow, mock, {}).policy_valid, true);
assert.equal(validatePolicy({ payload: { ...defaults, dedupe_ttl_ms: 3600000, max_event_age_ms: 3600000, future_tolerance_ms: 300000, service_retry_seconds: 600 } }, flow, mock, {}).policy_valid, true);
assert.deepEqual(loadPolicy({}, flow, mock, {}).policy, { version: 3, ...defaults }, "inválidos não substituem a última política");

function arrival(source, stage = "approach", offset = 0, testMode = false, overrides = {}) {
  return {
    _location_test: testMode,
    policy: { version: 3, ...defaults },
    payload: {
      contract: "security.arrival.v1",
      kind: "arrival",
      source,
      arriving: [source],
      arrival_source_type: "person",
      arrival_stage: stage,
      arrival_previous_state: "not_home",
      arrival_direction: "returning",
      external_cycle_confirmed: true,
      event_at: NOW + offset,
      test_mode: testMode,
      ...overrides,
    },
  };
}

function recipient(msg, role) {
  msg.resident_recipient = role;
  return msg;
}

const sourceSwitch = byId.get("resident_notifications_source_switch");
const stageSwitch = byId.get("resident_notifications_stage_switch");
assert.deepEqual(stageSwitch.wires[0], ["resident_notifications_confirmation_bypass_out"]);
assert.deepEqual(stageSwitch.wires[1], ["resident_notifications_confirmation_bypass_out"]);
assert.deepEqual(stageSwitch.wires[2], ["resident_notifications_home_candidate_out"]);
assert.deepEqual(byId.get("resident_notifications_home_confirmation_result").wires[0],
  ["resident_notifications_home_confirmation_confirmed_out"]);
assert.deepEqual(sourceSwitch.wires[0], ["resident_notifications_recipient_secondary"]);
assert.deepEqual(sourceSwitch.wires[1], ["resident_notifications_recipient_primary"]);
assert.ok(
  !sourceSwitch.wires[0].includes("resident_notifications_recipient_primary"),
  "resident_primary não pode receber a própria chegada",
);
assert.ok(
  !sourceSwitch.wires[1].includes("resident_notifications_recipient_secondary"),
  "resident_secondary não pode receber a própria chegada",
);

message = recipient(normalize(arrival("resident_secondary"), flow, mock, {}), "resident_primary");
assert.equal(message.arrival_contract_valid, true);
assert.equal(message.arrival_kind_valid, true);
assert.equal(message.arrival_returning, true);
assert.equal(message.arrival_external_cycle_confirmed, true);
assert.equal(message.arrival_cycle_confirmed, true);
assert.equal(message.arrival_event_time_valid, true);
assert.equal(message.event_at, NOW);
message = readState(message, flow, mock, {});
assert.equal(message.notification_duplicate, false);
message = reserve(message, flow, mock, {});
message = buildMessage(message, flow, mock, privateBindings);
assert.equal(message.payload.recipient, "resident_primary");
assert.equal(message.payload.message, "Example Secondary está chegando em casa.");
assert.equal(message.payload.dispatched, false);
assert.equal(acknowledge(message, flow, mock, {}), null);

let primaryApproach = recipient(
  normalize(arrival("resident_primary", "approach", 500), flow, mock, {}),
  "resident_secondary",
);
primaryApproach = readState(primaryApproach, flow, mock, {});
assert.equal(primaryApproach.notification_duplicate, false);
primaryApproach = reserve(primaryApproach, flow, mock, {});
primaryApproach = buildMessage(primaryApproach, flow, mock, privateBindings);
assert.equal(primaryApproach.payload.recipient, "resident_secondary");
assert.equal(primaryApproach.payload.message, "Example Primary está chegando em casa.");
assert.equal(acknowledge(primaryApproach, flow, mock, {}), null);
const crossRecipientState = flow.get("resident_notification_delivery_v4", "persistent");
assert.equal(crossRecipientState.deliveries["resident_primary:resident_primary"], undefined);
assert.equal(crossRecipientState.deliveries["resident_primary:resident_secondary"].accepted_key, "resident_primary:approach:" + (NOW + 500));

const persisted = structuredClone(flow.get("resident_notification_delivery_v4", "persistent"));
const restarted = context({ persistent: { resident_notification_delivery_v4: persisted } });
let repeated = readState(recipient(normalize(arrival("resident_secondary"), restarted, mock, {}), "resident_primary"), restarted, mock, {});
assert.equal(repeated.notification_duplicate, true, "aceite deve sobreviver ao restart");

const legacy = context({ persistent: { resident_notification_delivery_v3: {
  version: 3,
  residents: { resident_secondary: {
    accepted_key: repeated.notification_key,
    accepted_at: NOW,
    pending_key: null,
    pending_at: 0,
  } },
} } });
let migrated = recipient(normalize(arrival("resident_secondary"), legacy, mock, {}), "resident_primary");
migrated = migrateState(migrated, legacy, mock, {});
migrated = readState(
  migrated,
  legacy, mock, {},
);
assert.equal(migrated.notification_duplicate, true, "recibo v3 deve migrar para o destinatário original");
assert.equal(migrated.notification_delivery_state.version, 4);
assert.equal(
  readState(recipient(normalize(arrival("resident_secondary"), legacy, mock, {}), "resident_secondary"), legacy, mock, {}).notification_duplicate,
  false,
  "migração não pode inventar aceite para destinatário que não existia no v3",
);

const directHomeFlow = context({ persistent: {
  resident_notifications_policy_v3: { version: 3, ...defaults },
} });
let directHome = recipient(normalize(arrival("resident_secondary", "home", 1000), directHomeFlow, mock, {}), "resident_primary");
assert.equal(directHome.arrival_stage, "home");
directHome = prepareHome(directHome, directHomeFlow, mock, {});
clock = NOW + 91_000;
directHome.home_confirmation_entity = {
  state: "home",
  last_changed: new Date(NOW + 1000).toISOString(),
  attributes: {
    location_fresh: true,
    location_observed_at: new Date(NOW + 1000).toISOString(),
  },
};
directHome.home_confirmation_state = "home";
directHome = evaluateHome(directHome, directHomeFlow, mock, {});
assert.equal(directHome.home_confirmation_result, "confirmed");
directHome = readState(directHome, directHomeFlow, mock, {});
assert.equal(directHome.notification_duplicate, false, "not_home → home deve avisar");
directHome = reserve(directHome, directHomeFlow, mock, {});
directHome = buildMessage(directHome, directHomeFlow, mock, privateBindings);
assert.equal(directHome.payload.message, "Example Secondary chegou em casa.");

clock = NOW;
let bouncedHome = prepareHome(
  normalize(arrival("resident_secondary", "home"), directHomeFlow, mock, {}),
  directHomeFlow, mock, {},
);
bouncedHome.home_confirmation_state = "near_home";
bouncedHome.home_confirmation_entity = {
  state: "near_home",
  last_changed: new Date(clock).toISOString(),
  attributes: { location_fresh: true, location_observed_at: new Date(clock).toISOString() },
};
bouncedHome = evaluateHome(bouncedHome, directHomeFlow, mock, {});
assert.equal(bouncedHome.home_confirmation_result, "retry",
  "rebote imediato para near_home não pode afirmar chegada");
clock = NOW + 60_000;
bouncedHome.home_confirmation_state = "home";
bouncedHome.home_confirmation_entity = {
  state: "home",
  last_changed: new Date(clock - 30_000).toISOString(),
  attributes: { location_fresh: true, location_observed_at: new Date(clock).toISOString() },
};
bouncedHome = evaluateHome(bouncedHome, directHomeFlow, mock, {});
assert.equal(bouncedHome.home_confirmation_result, "retry",
  "HOME por apenas 30 s ainda não pode afirmar chegada");
clock = NOW + 151_000;
bouncedHome.home_confirmation_entity.last_changed = new Date(clock - 91_000).toISOString();
bouncedHome.home_confirmation_entity.attributes.location_observed_at =
  new Date(clock).toISOString();
bouncedHome = evaluateHome(bouncedHome, directHomeFlow, mock, {});
assert.equal(bouncedHome.home_confirmation_result, "confirmed",
  "HOME fresco e contínuo deve confirmar a chegada dentro da janela");

clock = NOW;
let departedHome = prepareHome(
  normalize(arrival("resident_secondary", "home"), directHomeFlow, mock, {}),
  directHomeFlow, mock, {},
);
departedHome.home_confirmation_state = "not_home";
departedHome.home_confirmation_entity = {
  state: "not_home",
  last_changed: new Date(clock).toISOString(),
  attributes: { location_fresh: true, location_observed_at: new Date(clock).toISOString() },
};
departedHome = evaluateHome(departedHome, directHomeFlow, mock, {});
assert.equal(departedHome.home_confirmation_result, "rejected",
  "retorno para not_home deve encerrar a confirmação sem aviso");

function confirmationCase({
  state = "home",
  checkedAfter = 90_000,
  stableFor = 90_000,
  observedAfter = checkedAfter,
  fresh = true,
  eventOffset = 0,
}) {
  clock = NOW;
  let candidate = prepareHome(
    normalize(arrival("resident_secondary", "home", eventOffset),
      directHomeFlow, mock, {}),
    directHomeFlow, mock, {},
  );
  clock = NOW + checkedAfter;
  candidate.home_confirmation_state = state;
  candidate.home_confirmation_entity = {
    state,
    last_changed: new Date(clock - stableFor).toISOString(),
    attributes: {
      location_fresh: fresh,
      location_observed_at: new Date(NOW + observedAfter).toISOString(),
    },
  };
  return evaluateHome(candidate, directHomeFlow, mock, {})
    .home_confirmation_result;
}

const confirmationBacktest = [
  ["HOME fresco por 90 s", {}, "confirmed"],
  ["HOME fresco no limite de 300 s", { checkedAfter: 300_000, stableFor: 90_000 }, "confirmed"],
  ["HOME somente após expirar a janela", { checkedAfter: 301_000, stableFor: 90_000 }, "rejected"],
  ["HOME sem frescor", { fresh: false }, "retry"],
  ["HOME com observação anterior ao evento", { observedAfter: -1 }, "retry"],
  ["near_home durante a janela", { state: "near_home", stableFor: 0 }, "retry"],
  ["unavailable durante a janela", { state: "unavailable", stableFor: 0 }, "retry"],
  ["unknown depois da janela", { state: "unknown", checkedAfter: 301_000, stableFor: 0 }, "rejected"],
  ["retorno explícito a not_home", { state: "not_home", checkedAfter: 10_000, stableFor: 0 }, "rejected"],
  ["evento além da tolerância futura", { eventOffset: 60_001, checkedAfter: 0, stableFor: 90_000, observedAfter: 60_001 }, "rejected"],
  ["evento mais velho que a idade máxima", { eventOffset: -900_001, checkedAfter: 0, stableFor: 90_000, observedAfter: 0 }, "rejected"],
];
for (const [name, options, expected] of confirmationBacktest) {
  assert.equal(confirmationCase(options), expected, name);
}

let localReturn = recipient(normalize(arrival(
  "resident_secondary",
  "local_return",
  2000,
  false,
  {
    arrival_previous_state: "near_home",
    arrival_direction: "returning_local_excursion",
    external_cycle_confirmed: false,
    local_excursion_return: true,
  },
), flow, mock, {}), "resident_primary");
assert.equal(localReturn.arrival_returning, true);
assert.equal(localReturn.arrival_external_cycle_confirmed, true);
assert.equal(localReturn.arrival_cycle_confirmed, true);
assert.equal(localReturn.arrival_local_return_valid, true);
localReturn = readState(localReturn, flow, mock, {});
assert.equal(localReturn.notification_duplicate, false,
  "retorno local em near_home deve gerar um novo aviso");
localReturn = reserve(localReturn, flow, mock, {});
localReturn = buildMessage(localReturn, flow, mock, privateBindings);
assert.equal(localReturn.payload.message, "Example Secondary está chegando em casa.");
assert.equal(acknowledge(localReturn, flow, mock, {}), null);

let localReturnHome = recipient(normalize(arrival(
  "resident_secondary", "home", 2500,
), flow, mock, {}), "resident_primary");
localReturnHome = readState(localReturnHome, flow, mock, {});
assert.equal(localReturnHome.notification_duplicate, true,
  "home posterior ao aviso em near_home não deve repetir a mesma chegada");

for (const [overrides, field] of [
  [{ contract: "other.v1" }, "arrival_contract_valid"],
  [{ kind: "departure" }, "arrival_kind_valid"],
  [{ arrival_source_type: "vehicle_primary" }, "arrival_kind_valid"],
  [{ arrival_direction: "leaving" }, "arrival_returning"],
  [{ external_cycle_confirmed: false }, "arrival_external_cycle_confirmed"],
  [{ event_at: "invalid" }, "arrival_event_time_valid"],
]) assert.equal(normalize(arrival("resident_primary", "approach", 0, false, overrides), flow, mock, {})[field], false);
assert.ok(NOW - normalize(arrival("resident_primary", "approach", -900001), flow, mock, {}).event_at > defaults.max_event_age_ms);
assert.ok(normalize(arrival("resident_primary", "approach", 60001), flow, mock, {}).event_at > NOW + defaults.future_tolerance_ms);
assert.equal(NOW - normalize(arrival("resident_primary", "approach", -900000), flow, mock, {}).event_at, defaults.max_event_age_ms);
assert.equal(normalize(arrival("resident_primary", "approach", 60000), flow, mock, {}).event_at, NOW + defaults.future_tolerance_ms);

let failed = recipient(normalize(arrival("resident_primary", "approach", 2000), flow, mock, {}), "resident_secondary");
failed = readState(failed, flow, mock, {});
failed = reserve(failed, flow, mock, {});
failed = failDelivery(failed, flow, mock, {});
assert.equal(failed.notification_retry_allowed, true);
assert.equal(failed.notification_retry_count, 1);
assert.equal(failed.delay, 60000);
assert.equal(flow.get("resident_notification_delivery_v4", "persistent").deliveries["resident_primary:resident_secondary"].pending_key, null);
failed.notification_retry_count = 2;
failed = failDelivery(failed, flow, mock, {});
assert.equal(failed.notification_retry_allowed, false, "terceira falha deve encerrar retries");

clock = NOW + 5000;
let synthetic = recipient(normalize(arrival("resident_primary", "home", 5000, true), flow, mock, {}), "resident_secondary");
synthetic = prepareHome(synthetic, flow, mock, {});
synthetic = testHomeState(synthetic, flow, mock, {});
synthetic = evaluateHome(synthetic, flow, mock, {});
assert.equal(synthetic.home_confirmation_result, "confirmed");
synthetic = readState(synthetic, flow, mock, {});
synthetic = reserve(synthetic, flow, mock, {});
synthetic = buildMessage(synthetic, flow, mock, privateBindings);
assert.equal(synthetic.payload.message, "[TESTE] Example Primary chegou em casa.");
assert.equal(synthetic.payload.simulated, true);
assert.equal(dryRun(synthetic, flow, mock, {}), null);
assert.equal(flow.get("resident_notifications_last_dry_run_v2__test")["resident_primary:resident_secondary"].dispatched, false);
assert.equal(readState(recipient(normalize(arrival("resident_primary", "home", 5000, true), flow, mock, {}), "resident_secondary"), flow, mock, {}).notification_duplicate, true);

for (const [id, resident] of [["resident_notifications_notify_primary", "resident_primary"], ["resident_notifications_notify_secondary", "resident_secondary"]]) {
  const adapter = byId.get(id);
  assert.equal(adapter.type, "change");
  const contract = adapter.rules.map((rule) => String(rule.to ?? "")).join("\n");
  assert.match(contract, /"title":"Casa inteligente"/);
  assert.match(contract, /"tag":_notification_hub_context\.payload\.notification_key/);
  assert.match(contract, /"sound":"default"/);
  assert.match(contract, /"interruption-level":"time-sensitive"/);
  assert.match(contract, new RegExp(`"recipients":\\["${resident}"\\]`));
  assert.doesNotMatch(contract, /notification_delivery_under_test/);
  assert.deepEqual(byId.get(`${id}__hub_call`).links, ["notification_hub_mobile_in"]);
}
assert.match(byId.get("resident_notifications_delivery_ack").name, /aceite do Home Assistant/);
const deliveryTest = byId.get("resident_notifications_test_notify_secondary");
assert.equal(deliveryTest.type, "change");
const deliveryTestContract = deliveryTest.rules.map((rule) => String(rule.to ?? "")).join("\n");
assert.match(deliveryTestContract, /"recipients":\["resident_secondary"\]/);
assert.doesNotMatch(deliveryTestContract, /resident_primary/);
assert.match(deliveryTestContract, /"title":"TESTE/);
assert.match(deliveryTestContract, /"delivery_under_test":true/);
assert.match(deliveryTestContract, /"interruption-level":"time-sensitive"/);
assert.deepEqual(byId.get("resident_notifications_test_notify_secondary__hub_call").links, ["notification_hub_mobile_in"]);
assert.deepEqual(
  byId.get("resident_notifications_test_delivery_secondary").wires,
  [["resident_notifications_test_notify_secondary"]],
);
assert.deepEqual(
  byId.get("resident_notifications_test_delivery_secondary").props,
  [{ p: "payload" }],
);
assert.equal(
  byId.get("resident_notifications_test_delivery_secondary").payload,
  "TESTE — confirmação do push de chegada para o celular.",
);
assert.equal(byId.get("resident_notifications_test_delivery_secondary").payloadType, "str");
for (const id of [
  "resident_notifications_test_primary",
  "resident_notifications_test_home",
  "resident_notifications_test_secondary",
  "resident_notifications_test_direction",
  "resident_notifications_test_unavailable",
  "resident_notifications_test_stale",
  "resident_notifications_test_future",
  "resident_notifications_test_duplicate",
]) assert.deepEqual(resolvedWireTargets(id), ["resident_notifications_test_adapter"]);
assert.deepEqual(byId.get("resident_notifications_test_gate").wires[0], ["resident_notifications_dry_run_out"]);
assert.equal((byId.get("resident_notifications_dry_run_terminal").wires ?? []).flat().length, 0);
assert.deepEqual(byId.get("resident_notifications_delivery_catch").scope.sort(), ["resident_notifications_notify_primary__hub_call", "resident_notifications_notify_secondary__hub_call"].sort());
assert.deepEqual(byId.get("resident_notifications_delivery_ack").wires, []);

const maxFunctionSize = Math.max(...tabNodes.filter((node) => node.type === "function").map((node) => node.func.length));
assert.ok(maxFunctionSize < 1500, `JavaScript residual grande: ${maxFunctionSize}`);

Date.now = originalNow;
console.log(`Resident notification tests passed, including ${confirmationBacktest.length} adversarial HOME cases.`);
