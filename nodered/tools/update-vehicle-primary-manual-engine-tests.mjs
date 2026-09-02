#!/usr/bin/env node

import fs from "node:fs";

const flowInputUrl = new URL("../flows.json", import.meta.url);
const flowOutputUrl = process.env.NODE_RED_FLOW_OUTPUT
  ? new URL(`file://${process.env.NODE_RED_FLOW_OUTPUT}`)
  : flowInputUrl;
const flows = JSON.parse(fs.readFileSync(flowInputUrl, "utf8"));
const byId = new Map(flows.map((node) => [node.id, node]));

function functionSource(name) {
  return fs.readFileSync(
    new URL(`./functions/${name}`, import.meta.url),
    "utf8",
  ).trim();
}

function required(id) {
  const node = byId.get(id);
  if (!node) throw new Error(`Node obrigatório ausente: ${id}`);
  return node;
}

const ids = {
  tab: "c22d8b12055e87f7",
  group: "5df25064f701ecd2",
  reset: "9501b32f01ed802b",
  away: "20a89bc078d6a334",
  approach: "49dc11be70882a24",
  home: "193c69b1cb25c7a8",
  invalidHome: "4d9e01c687686429",
  invalidApproach: "96ae64baab3b1964",
  coordinator: "3ad83e8d6897b983",
  output: "2ff281276fc1d020",
  gate: "276ba50ad0e36bab",
  prepareArrival: "62f77a1ad440639d",
  mergeContext: "48a5f40d806f6950",
  checkInactive: "87b2f8eb75cb6359",
  markActive: "354c9839bfca592f",
  reconcile: "a0a4977052d1ce06",
  lightTab: "6b7552efb85343f4",
  lightOnGroup: "95e7527bc7a0a9a1",
  lightManualTest: "2f8ac8be8e84a548",
  lightManualOut: "556814a7d5379621",
  lightManualIn: "d2cc7a5873776be0",
  dryRunTerminal: "light_full_dry_run_terminal_v1",
  unavailableDryOut: "light_unavailable_test_dry_run_out_v1",
  unavailableDryIn: "light_unavailable_test_dry_run_in_v1",
  availableOut: "light_available_to_output_out_v1",
  availableIn: "light_available_to_output_in_v1",
  unavailableProdOut: "light_unavailable_to_output_out_v1",
  unavailableProdIn: "light_unavailable_to_output_in_v1",
  dryTerminalOut: "light_test_to_terminal_out_v1",
  dryTerminalIn: "light_test_to_terminal_in_v1",
  obsoleteUnavailableTerminalOut: "light_unavailable_test_terminal_out_v1",
  obsoleteUnavailableTerminalIn: "light_unavailable_test_terminal_in_v1",
  notifyOnPrimary: "2818bf202b397612",
  notifyOnSecondary: "light_notify_on_secondary",
  notifyUnavailablePrimary: "04007cc1732f60c9",
  notifyUnavailableSecondary: "light_notify_unavailable_secondary",
  help: "vehicle_primary_manual_engine_test_help_v1",
  engineOn: "vehicle_primary_manual_engine_on_test_v1",
  engineOff: "vehicle_primary_manual_engine_off_test_v1",
  bypassGroup: "security_light_engine_bypass_group_v1",
  bypassStartup: "security_light_engine_bypass_startup_v1",
  bypassCommand: "security_light_engine_bypass_command_v1",
  bypassFunction: "security_light_engine_bypass_function_v1",
  bypassMqttOut: "security_light_engine_bypass_mqtt_out_v1",
  bypassReevaluateOut: "security_light_engine_bypass_reevaluate_out_v1",
  bypassReevaluateIn: "security_light_engine_bypass_reevaluate_in_v1",
  bypassTestOn: "security_light_engine_bypass_test_on_v1",
  bypassTestOff: "security_light_engine_bypass_test_off_v1",
};

const alarmIds = {
  tab: "1f468eaeef0733dd",
  group: "alarm_arrival_full_flow_group",
  validateArrival: "20b07bd3484da8f9",
  prepareTest: "99644e301cd49e45",
  validateConfirmation: "815c14ef3c054b25",
  reset: "21fc99c1d8f413ec",
  resetDebug: "2a1f01bdc7abea28",
  obsoleteTestDebug: "7644234006ff0290",
  obsoleteClearPrimary: "40ab3b2f97adac58",
  obsoleteClearSecondary: "b502fda3391bb41f",
  routeTestOut: "alarm_arrival_test_route_out_v1",
  routeTestIn: "alarm_arrival_test_route_in_v1",
  simulateConfirmation: "alarm_arrival_test_simulate_confirmation_v1",
  confirmationOut: "alarm_arrival_test_confirmation_out_v1",
  confirmationIn: "alarm_arrival_test_confirmation_in_v1",
  dryRunTerminal: "alarm_arrival_test_dry_run_terminal_v1",
};

const group = required(ids.group);
const coordinator = required(ids.coordinator);

/*
 * Mantém o canvas aprovado como benchmark e aplica a margem esquerda padrão
 * sem alterar o espaçamento relativo entre grupos/nós.
 */
const LIGHT_LEFT_MARGIN = 64;
const lightCanvasItems = flows.filter(
  (node) => node.z === ids.lightTab && Number.isFinite(node.x),
);
const lightGroups = lightCanvasItems.filter((node) => node.type === "group");
const currentLightMargin = Math.min(...lightGroups.map((node) => node.x));
const lightShiftX = Math.max(0, LIGHT_LEFT_MARGIN - currentLightMargin);
if (lightShiftX > 0) {
  for (const node of lightCanvasItems) node.x += lightShiftX;
}

function upsert(node) {
  const existing = byId.get(node.id);
  if (existing) {
    Object.assign(existing, node);
    return existing;
  }
  flows.push(node);
  byId.set(node.id, node);
  return node;
}

function removeNodes(idsToRemove) {
  const removeSet = new Set(idsToRemove);
  for (let index = flows.length - 1; index >= 0; index -= 1) {
    if (!removeSet.has(flows[index].id)) continue;
    byId.delete(flows[index].id);
    flows.splice(index, 1);
  }
  for (const node of flows) {
    if (Array.isArray(node.nodes)) {
      node.nodes = node.nodes.filter((id) => !removeSet.has(id));
    }
    if (Array.isArray(node.links)) {
      node.links = node.links.filter((id) => !removeSet.has(id));
    }
    if (Array.isArray(node.wires)) {
      node.wires = node.wires.map((output) =>
        Array.isArray(output)
          ? output.filter((id) => !removeSet.has(id))
          : output,
      );
    }
  }
}

function inject(id, name, testCase, y) {
  return {
    id,
    type: "inject",
    z: ids.tab,
    g: ids.group,
    name,
    props: [{ p: "test_case", v: testCase, vt: "str" }],
    repeat: "",
    crontab: "",
    once: false,
    onceDelay: 0.1,
    topic: "",
    x: 400,
    y,
    wires: [[ids.coordinator]],
  };
}

upsert({
  id: ids.help,
  type: "comment",
  z: ids.tab,
  g: ids.group,
  name: "1) RESETAR  2) escolher motor ON/OFF  3) executar 1/3 → 2/3 → 3/3",
  info: "O motor sintético é cumulativo: os passos de localização preservam o último estado ON/OFF escolhido. Todo o cenário usa test_mode e não altera as entidades reais do veículo.",
  x: 820,
  y: 1120,
  wires: [],
});

upsert(inject(ids.engineOn, "Motor sintético do vehicle_primary → ON", "vehicle_primary_engine_on", 1160));
upsert(inject(ids.engineOff, "Motor sintético do vehicle_primary → OFF", "vehicle_primary_engine_off", 1200));

for (const [id, y] of [
  [ids.reset, 1120],
  [ids.away, 1260],
  [ids.approach, 1300],
  [ids.home, 1340],
  [ids.invalidHome, 1400],
  [ids.invalidApproach, 1440],
]) {
  const node = required(id);
  node.x = 400;
  node.y = y;
}

coordinator.x = 820;
coordinator.y = 1300;
required(ids.output).x = 1110;
required(ids.output).y = 1300;

coordinator.func = `const SHARED_TEST_KEY = "security_location_test_state_v1";

const TEST_KEYS = [
    "security_vehicle_primary_recovery_v1__test",
    "vehicle_primary_arrival_armed__test",
    "vehicle_primary_in_use__test",
    "vehicle_primary_context_v1__test",
    "security_vehicle_primary_recovery_logged__test",
    "security_vehicle_primary_ready_logged__test",
    "security_vehicle_primary_test_clock"
];

const CASES = {
    vehicle_primary_engine_on: { engine: "on" },
    vehicle_primary_engine_off: { engine: "off" },
    vehicle_primary_away: { state: "not_home", prev: "home" },
    vehicle_primary_approach: { state: "chegando", prev: "not_home" },
    vehicle_primary_home: { state: "home", prev: "chegando" },
    vehicle_primary_invalid_home: { state: "home", prev: "unknown" },
    vehicle_primary_invalid_approach: { state: "chegando", prev: "unavailable" }
};

function baseline(now = Date.now()) {
    return {
        version: 1,
        resident_primary: "home",
        resident_secondary: "home",
        vehicle_primary: "home",
        vehicle_primary_engine: "off",
        vehicle_primary_lock: "locked",
        observed_at: now,
        transitions: {}
    };
}

if (msg.test_case === "reset") {
    const now = Date.now();
    const resetState = baseline(now);
    resetState.reset_at = now;
    global.set(SHARED_TEST_KEY, resetState);

    for (const key of TEST_KEYS) {
        flow.set(key, undefined);
    }

    msg._location_test = true;
    msg._location_test_case = "reset";
    msg._location_test_reset = true;
    msg.payload = {
        kind: "test_reset",
        test_mode: true,
        test_case: "reset"
    };
    msg.topic = "security_context_refresh_test";

    node.status({
        fill: "blue",
        shape: "dot",
        text: "teste compartilhado resetado | motor=OFF"
    });

    return msg;
}

const test = CASES[msg.test_case];
if (!test) {
    node.warn(
        "Caso de teste do vehicle_primary desconhecido: " +
        String(msg.test_case)
    );
    return null;
}

let state = global.get(SHARED_TEST_KEY);
if (!state || state.version !== 1) {
    state = baseline();
}

const now = Math.max(
    Date.now(),
    Number(state.observed_at || 0) + 1
);

/*
 * Estado sintético cumulativo:
 * - ON/OFF altera somente o motor;
 * - os passos de localização preservam o motor escolhido;
 * - pessoas e trava também são preservadas.
 */
if (Object.hasOwn(test, "state")) {
    state.vehicle_primary = test.state;
}
if (Object.hasOwn(test, "engine")) {
    state.vehicle_primary_engine = test.engine;
}
state.observed_at = now;
state.transitions = Object.hasOwn(test, "state")
    ? {
        vehicle_primary: {
            domain: "vehicle_primary",
            source: "vehicle_primary",
            state: test.state,
            prev: test.prev,
            test_case: msg.test_case,
            at: now
        }
    }
    : {};

global.set(SHARED_TEST_KEY, state);

msg._location_test = true;
msg._location_test_case = msg.test_case;
msg.payload = {
    kind: "refresh_tick",
    test_mode: true,
    test_case: msg.test_case,
    test_state: {
        resident_primary: state.resident_primary,
        resident_secondary: state.resident_secondary,
        vehicle_primary: state.vehicle_primary,
        vehicle_primary_engine: state.vehicle_primary_engine,
        vehicle_primary_lock: state.vehicle_primary_lock
    }
};
msg.topic = "security_context_refresh_test";

const locationText = Object.hasOwn(test, "state")
    ? test.prev + " → " + test.state
    : "localização=" + state.vehicle_primary;

node.status({
    fill: state.vehicle_primary_engine === "on" ? "green" : "grey",
    shape: "dot",
    text:
        "vehicle_primary: " + locationText +
        " | motor=" + state.vehicle_primary_engine.toUpperCase()
});

return msg;`;

const gate = required(ids.gate);
gate.func = `/*
 * Regra física v11:
 * o refletor só pode ser ligado quando o vehicle_primary está efetivamente em uso
 * E o motor atual foi observado ligado/running.
 *
 * Uma chegada pode preceder a atualização do motor na integração. Nesse caso,
 * preserva o evento por até 2 minutos para replay quando surgir ON atual.
 *
 * Em test_mode o nó apresenta o resultado e continua pelo mesmo caminho
 * lógico. A separação real/simulado ocorre somente na fronteira de despacho.
 */
const TEST_MODE =
    msg._location_test === true ||
    msg.payload?.test_mode === true;

const PENDING_ARRIVAL_TTL_MS =
    2 * 60 * 1000;

function contextKey(base) {
    return TEST_MODE
        ? base + "__test"
        : base;
}

function preserveArrivalForEngineOn() {
    if (msg.payload?.kind !== "arrival") {
        return false;
    }

    const now = Date.now();
    const pendingKey = contextKey(
        "security_light_pending_arrival_v1"
    );

    const originalQueuedAt = Number(
        msg.payload?.arrival_originally_queued_at ?? now
    );

    const queuedAt =
        Number.isFinite(originalQueuedAt) &&
        originalQueuedAt > 0 &&
        originalQueuedAt <= now + 60 * 1000
            ? originalQueuedAt
            : now;

    const eventAt = Number(
        msg.payload?.event_at ??
        msg.payload?.updated_at ??
        now
    );

    const existing = flow.get(pendingKey);
    const existingEventAt = Number(
        existing?.event_at ?? 0
    );

    if (
        existing &&
        Number.isFinite(existingEventAt) &&
        existingEventAt > eventAt
    ) {
        return true;
    }

    flow.set(pendingKey, {
        version: 1,
        queued_at: queuedAt,
        expires_at:
            queuedAt + PENDING_ARRIVAL_TTL_MS,
        event_at: eventAt,
        wait_reason:
            "vehicle_engine_on_after_arrival",
        message: {
            ...msg,
            payload: {
                ...(msg.payload ?? {})
            }
        }
    });

    return true;
}

if (
    msg.payload?.vehicle_primary_in_use !== true ||
    msg.payload?.vehicle_primary_engine_on !== true ||
    msg.payload?.vehicle_primary_engine_state_valid !== true
) {
    node.status({
        fill: "yellow",
        shape: "ring",
        text: preserveArrivalForEngineOn()
            ? (
                TEST_MODE
                    ? "TESTE: aguardando motor ON — chegada preservada"
                    : "aguardando motor ON — chegada preservada"
            )
            : (
                TEST_MODE
                    ? "TESTE: bloqueado — motor OFF"
                    : "vehicle_primary sem motor ON atual"
            )
    });
    return null;
}

if (TEST_MODE) {
    node.status({
        fill: "green",
        shape: "dot",
        text: "TESTE: gate aprovado — continuando dry-run"
    });
    msg.payload.simulated = true;
    msg.payload.dispatched = false;
} else {
    const lifecycle =
        flow.get(
            "security_light_lifecycle_v1",
            "persistent"
        ) ?? {};

    const until =
        Number(
            lifecycle.cooldown_until ?? 0
        );

    if (
        Number.isFinite(until) &&
        Date.now() < until
    ) {
        node.status({
            fill: "grey",
            shape: "ring",
            text: "iluminação em cooldown"
        });
        return null;
    }
}

msg.payload.vehicle_primary_gate =
    "fresh_engine_on";

return msg;`;

const mergeContext = required(ids.mergeContext);
const canonicalMergeAlreadyInstalled =
  mergeContext.func.includes('pending.retention === "while_approaching"');
if (!canonicalMergeAlreadyInstalled) {
const previousReplayGate = `const replayReady =
    pending &&
    vehicle_primaryLightingReady &&
    flow.get("sun_ready") === true;`;
const delayedEngineReplayGate = `const vehicle_primaryReadyForArrival =
    vehicle_primaryLightingReady &&
    vehicle_primary.in_use === true &&
    vehicle_primary.engine_on === true &&
    vehicle_primary.engine_state_valid === true &&
    vehicle_primary.engine_stale !== true;

const replayReady =
    pending &&
    vehicle_primaryReadyForArrival &&
    flow.get("sun_ready") === true;`;

if (!mergeContext.func.includes(delayedEngineReplayGate)) {
  if (!mergeContext.func.includes(previousReplayGate)) {
    throw new Error("Gate de replay da chegada pendente não encontrado");
  }
  mergeContext.func = mergeContext.func.replace(previousReplayGate, delayedEngineReplayGate);
}

const previousTestReset = `if (
    TEST_MODE &&
    msg._location_test_reset === true
) {
    flow.set(
        contextKey("security_light_pending_arrival_v1"),
        null
    );
}`;
const previousFullTestReset = `if (
    TEST_MODE &&
    msg._location_test_reset === true
) {
    for (const base of [
        "security_light_pending_arrival_v1",
        "security_light_lifecycle_v1",
        "security_light_last_dry_run_v1"
    ]) {
        flow.set(contextKey(base), null);
    }
}`;
const fullTestReset = `if (
    TEST_MODE &&
    msg._location_test_reset === true
) {
    for (const base of [
        "security_light_pending_arrival_v1",
        "security_light_lifecycle_v1",
        "security_light_last_dry_run_v1",
        "security_light_turn_on_notification_latch_v1"
    ]) {
        flow.set(contextKey(base), null);
    }
}`;
if (!mergeContext.func.includes(fullTestReset)) {
  if (mergeContext.func.includes(previousFullTestReset)) {
    mergeContext.func = mergeContext.func.replace(previousFullTestReset, fullTestReset);
  } else if (mergeContext.func.includes(previousTestReset)) {
    mergeContext.func = mergeContext.func.replace(previousTestReset, fullTestReset);
  } else {
    throw new Error("Reset do cenário sintético de iluminação não encontrado");
  }
}
}

/*
 * As funções canônicas ficam em arquivos próprios para que os testes unitários
 * executem exatamente o mesmo código que será gravado no flow versionado.
 */
required(ids.prepareArrival).func = functionSource(
  "security-light-prepare-arrival.js",
);
gate.func = functionSource("security-light-vehicle-gate.js");
mergeContext.func = functionSource("security-light-merge-context.js");

const checkInactive = required(ids.checkInactive);
if (!checkInactive.func.includes("security_light_turn_on_notification_latch_v1")) {
  checkInactive.func = checkInactive.func.replace(
    "const now = Date.now();",
    `const now = Date.now();
const TEST_MODE =
    msg._location_test === true ||
    msg.payload?.test_mode === true;
const NOTIFICATION_LATCH_KEY =
    "security_light_turn_on_notification_latch_v1";

function contextKey(base) {
    return TEST_MODE ? base + "__test" : base;
}

function ctxGet(base, store) {
    const key = contextKey(base);
    return TEST_MODE || !store
        ? flow.get(key)
        : flow.get(key, store);
}

function ctxSet(base, value, store) {
    const key = contextKey(base);
    return TEST_MODE || !store
        ? flow.set(key, value)
        : flow.set(key, value, store);
}`,
  );

  const lifecycleMarker = `const lifecycle =
    flow.get("security_light_lifecycle_v1", "persistent") ?? {};`;
  const latchGuard = `${lifecycleMarker}

const notificationLatch =
    ctxGet(NOTIFICATION_LATCH_KEY, "persistent") ?? {};

if (notificationLatch.latched === true) {
    node.status({
        fill: "blue",
        shape: "dot",
        text: "aviso de acendimento já reservado; aguardando OFF"
    });
    return [null, null, null];
}`;
  if (!checkInactive.func.includes(lifecycleMarker)) {
    throw new Error("Lifecycle do gate de disponibilidade não encontrado");
  }
  checkInactive.func = checkInactive.func.replace(lifecycleMarker, latchGuard);

  const unavailableCommit = `flow.set(unavailableDecisionKey, {
    key: decisionKey,
    at: now,
    state: stateLabel
});`;
  const unavailableLatch = `ctxSet(
    NOTIFICATION_LATCH_KEY,
    {
        version: 1,
        latched: true,
        reason: "would_turn_on_actuator_unavailable",
        latched_at: now,
        arrival_key: msg.payload?.arrival_key ?? null,
        reflector_state: stateLabel
    },
    "persistent"
);

${unavailableCommit}`;
  if (!checkInactive.func.includes(unavailableCommit)) {
    throw new Error("Commit de indisponibilidade do refletor não encontrado");
  }
  checkInactive.func = checkInactive.func.replace(unavailableCommit, unavailableLatch);
  checkInactive.func = checkInactive.func.replace(
    "return [null, msg];",
    `return TEST_MODE
    ? [null, null, msg]
    : [null, msg, null];`,
  );
}
if (!checkInactive.func.includes('msg.payload.message = "[TESTE] " +')) {
  checkInactive.func = checkInactive.func.replace(
    'node.status({\n    fill: "red",',
    `if (TEST_MODE) {
    msg.payload.message = "[TESTE] " + msg.payload.message;
}

node.status({
    fill: "red",`,
  );
}
checkInactive.outputs = 3;
checkInactive.func = checkInactive.func.replaceAll(
  "return [null, null];",
  "return [null, null, null];",
);
checkInactive.wires = [
  [ids.availableOut],
  [ids.unavailableProdOut],
  [ids.unavailableDryOut],
];

removeNodes([
  ids.obsoleteUnavailableTerminalOut,
  ids.obsoleteUnavailableTerminalIn,
]);

upsert({
  id: ids.availableOut,
  type: "link out",
  z: ids.lightTab,
  g: checkInactive.g,
  name: "Refletor disponível → saída",
  mode: "link",
  links: [ids.availableIn],
  x: 1640,
  y: 240,
  wires: [],
});

upsert({
  id: ids.availableIn,
  type: "link in",
  z: ids.lightTab,
  g: ids.lightOnGroup,
  name: "Receber refletor disponível",
  links: [ids.availableOut],
  x: 1845,
  y: 160,
  wires: [[ids.markActive]],
});

upsert({
  id: ids.unavailableProdOut,
  type: "link out",
  z: ids.lightTab,
  g: checkInactive.g,
  name: "Refletor indisponível → avisos",
  mode: "link",
  links: [ids.unavailableProdIn],
  x: 1640,
  y: 320,
  wires: [],
});

upsert({
  id: ids.unavailableProdIn,
  type: "link in",
  z: ids.lightTab,
  g: ids.lightOnGroup,
  name: "Receber avisos de indisponibilidade",
  links: [ids.unavailableProdOut],
  x: 1845,
  y: 260,
  wires: [[
    ids.notifyUnavailablePrimary,
    "d710ac9de2f98569",
    ids.notifyUnavailableSecondary,
  ]],
});

upsert({
  id: ids.unavailableDryOut,
  type: "link out",
  z: ids.lightTab,
  g: checkInactive.g,
  name: "Erro simulado → terminal dry-run",
  mode: "link",
  links: [ids.unavailableDryIn],
  x: 1640,
  y: 380,
  wires: [],
});

upsert({
  id: ids.unavailableDryIn,
  type: "link in",
  z: ids.lightTab,
  g: ids.lightOnGroup,
  name: "Receber erro simulado seguro",
  links: [ids.unavailableDryOut],
  x: 1845,
  y: 380,
  wires: [[ids.dryTerminalOut]],
});

upsert({
  id: ids.dryTerminalOut,
  type: "link out",
  z: ids.lightTab,
  g: ids.lightOnGroup,
  name: "Teste → terminal dry-run",
  mode: "link",
  links: [ids.dryTerminalIn],
  x: 2320,
  y: 400,
  wires: [],
});

upsert({
  id: ids.dryTerminalIn,
  type: "link in",
  z: ids.lightTab,
  g: ids.lightOnGroup,
  name: "Receber terminal dry-run",
  links: [ids.dryTerminalOut],
  x: 2680,
  y: 400,
  wires: [[ids.dryRunTerminal]],
});

const lightDecisionGroup = required(checkInactive.g);
for (const nodeId of [ids.availableOut, ids.unavailableProdOut, ids.unavailableDryOut]) {
  if (!lightDecisionGroup.nodes.includes(nodeId)) lightDecisionGroup.nodes.push(nodeId);
}

const reconcile = required(ids.reconcile);
if (!reconcile.func.includes("security_light_turn_on_notification_latch_v1")) {
  reconcile.func = reconcile.func.replace(
    "const now = Date.now();",
    `const now = Date.now();
const NOTIFICATION_LATCH_KEY =
    "security_light_turn_on_notification_latch_v1";`,
  );
  const acceptedPhysicalMarker =
    '        flow.set("security_light_last_unavailable_state", null);';
  const latchByPhysicalState = `${acceptedPhysicalMarker}

        if (state === "on") {
            flow.set(
                NOTIFICATION_LATCH_KEY,
                {
                    version: 1,
                    latched: true,
                    reason: "physical_on",
                    latched_at: now
                },
                "persistent"
            );
        } else {
            flow.set(
                NOTIFICATION_LATCH_KEY,
                null,
                "persistent"
            );
        }`;
  if (!reconcile.func.includes(acceptedPhysicalMarker)) {
    throw new Error("Reconciliação de estado físico do refletor não encontrada");
  }
  reconcile.func = reconcile.func.replace(
    acceptedPhysicalMarker,
    latchByPhysicalState,
  );
}

const markActive = required(ids.markActive);
markActive.func = `const now = Date.now();
const TEST_MODE =
    msg._location_test === true ||
    msg.payload?.test_mode === true;

function contextKey(base) {
    return TEST_MODE ? base + "__test" : base;
}

function ctxGet(base, store) {
    const key = contextKey(base);
    return TEST_MODE || !store
        ? flow.get(key)
        : flow.get(key, store);
}

function ctxSet(base, value, store) {
    const key = contextKey(base);
    return TEST_MODE || !store
        ? flow.set(key, value)
        : flow.set(key, value, store);
}

const lifecycle =
    ctxGet("security_light_lifecycle_v1", "persistent") ??
    { version: 1 };
const physicalObservedAt = Number(
    flow.get("security_light_physical_observed_at") ?? 0
);
const physicalFresh =
    Number.isFinite(physicalObservedAt) &&
    physicalObservedAt <= now + 60 * 1000 &&
    now - physicalObservedAt <= 2 * 60 * 1000;
const people =
    flow.get(contextKey("people_context_v1")) ?? {};
const vehicle_primary =
    flow.get(contextKey("vehicle_primary_context_v1")) ?? {};
const ready =
    people.ready === true &&
    vehicle_primary.ready === true &&
    flow.get("sun_ready") === true &&
    flow.get("light_reconciled") === true &&
    physicalFresh;

if (
    !ready ||
    flow.get("security_light_physical_state") !== "off" ||
    lifecycle.active_by_arrival === true
) {
    return null;
}

const arrivalKey = msg.payload?.arrival_key;
const lastArrivalAt = Number(
    lifecycle.last_arrival_at ?? 0
);
if (
    arrivalKey &&
    lifecycle.last_arrival_key === arrivalKey &&
    lastArrivalAt <= now + 60 * 1000 &&
    now - lastArrivalAt < 10 * 60 * 1000
) {
    return null;
}

lifecycle.version = 1;
lifecycle.active_by_arrival = true;
lifecycle.on_since = now;
lifecycle.force_off_at = now + 15 * 60 * 1000;
lifecycle.pending_off_at = null;
lifecycle.pending_off_reason = null;
lifecycle.pending_off_source = null;
lifecycle.last_arrival_key = arrivalKey ?? null;
lifecycle.last_arrival_at = now;
lifecycle.updated_at = now;
ctxSet("security_light_lifecycle_v1", lifecycle, "persistent");
ctxSet(
    "security_light_turn_on_notification_latch_v1",
    {
        version: 1,
        latched: true,
        reason: "turn_on_dispatched",
        latched_at: now,
        arrival_key: arrivalKey ?? null
    },
    "persistent"
);

msg.delay = 15 * 60 * 1000;
msg.payload.deadline_type = "backstop";
msg.payload.deadline_at = lifecycle.force_off_at;
msg.payload.reason = TEST_MODE
    ? "test_arrival_with_vehicle_primary_engine_on_after_dark"
    : "arrival_with_vehicle_primary_engine_on_after_dark";

if (TEST_MODE) {
    msg.payload.simulated = true;
    msg.payload.dispatched = false;
    node.status({
        fill: "green",
        shape: "dot",
        text: "TESTE: lifecycle criado — despacho simulado"
    });
    return [null, msg];
}

return [msg, null];`;
markActive.outputs = 2;
markActive.wires = [
  [
    "f863fcd77744a4da",
    "9f047ccb2ce2c3aa",
    "2818bf202b397612",
    "light_notify_on_secondary",
  ],
  [ids.dryTerminalOut],
];
markActive.func = functionSource("security-light-mark-active.js");

for (const [nodeId, role] of [
  [ids.notifyOnPrimary, "mobile_primary"],
  [ids.notifyOnSecondary, "mobile_secondary"],
  [ids.notifyUnavailablePrimary, "mobile_primary"],
  [ids.notifyUnavailableSecondary, "mobile_secondary"],
]) {
  const notification = required(nodeId);
  notification.data = notification.data
    .replace(/"action":"notify_[23]"/, '"action":"notify_actionable"')
    .replace(
      /"role":"mobile_(?:primary|secondary)"/,
      `"role":"${role}"`,
    );
}

upsert({
  id: ids.dryRunTerminal,
  type: "function",
  z: ids.lightTab,
  g: ids.lightOnGroup,
  name: "TESTE FINAL: ações simuladas — nenhum dispositivo acionado",
  func: `const unavailable =
    msg.payload?.actuator_available === false;

const notificationDeliveryRequested = false;

const actions = unavailable
    ? []
    : [
        "switch.turn_on:refletor",
        "notify:resident_primary",
        "notify:resident_secondary",
        "schedule:backstop_15min"
    ];

const result = {
    version: 1,
    simulated: true,
    dispatched: false,
    actions,
    notification_delivery_requested: notificationDeliveryRequested,
    notification_recipients: [],
    source: msg.payload?.source ?? "manual",
    arrival_stage: msg.payload?.arrival_stage ?? "manual",
    completed_at: Date.now()
};

flow.set(
    "security_light_last_dry_run_v1__test",
    result
);

node.status({
    fill: "green",
    shape: "dot",
    text:
        "TESTE FINAL: " + actions.length +
        " ações simuladas; " +
        "0 dispositivos"
});

node.warn(
    "LIGHT_DRY_RUN_COMPLETE source=" + result.source +
    " stage=" + result.arrival_stage +
    " actions=" + actions.length +
    " notification_delivery_requested=" +
        String(notificationDeliveryRequested) +
    " dispatched=false"
);

return null;`,
  outputs: 0,
  timeout: "",
  noerr: 0,
  initialize: "",
  finalize: "",
  libs: [],
  x: 2850,
  y: 400,
  wires: [],
});

const lightOnGroup = required(ids.lightOnGroup);
if (!lightOnGroup.nodes.includes(ids.dryRunTerminal)) {
  lightOnGroup.nodes.push(ids.dryRunTerminal);
}
if (!lightOnGroup.nodes.includes(ids.unavailableDryIn)) {
  lightOnGroup.nodes.push(ids.unavailableDryIn);
}
for (const nodeId of [
  ids.availableIn,
  ids.unavailableProdIn,
  ids.dryTerminalOut,
  ids.dryTerminalIn,
]) {
  if (!lightOnGroup.nodes.includes(nodeId)) lightOnGroup.nodes.push(nodeId);
}

const manualTest = required(ids.lightManualTest);
manualTest.name = "Teste manual: simular ações finais (sem dispositivos)";
manualTest.props = [{ p: "payload" }];
manualTest.payload = JSON.stringify({
  kind: "manual_action_dry_run",
  test_mode: true,
  simulated: true,
  dispatched: false,
  source: "manual",
  arrival_stage: "manual",
});
manualTest.payloadType = "json";

required(ids.lightManualOut).name = "Teste → terminal dry-run";
const manualIn = required(ids.lightManualIn);
manualIn.name = "Receber teste manual seguro";
manualIn.wires = [[ids.dryRunTerminal]];

const lightTab = required(ids.lightTab);
lightTab.info = "Orquestra a decisão e o lifecycle do refletor a partir de contratos de alto nível. A intenção de chegada de uma pessoa permanece válida enquanto ela continuar em chegando com localização recente, inclusive se o anoitecer ocorrer depois do primeiro evento. O gate aceita motor ON atual ou, exclusivamente quando o dado do motor estiver stale/inválido, o bypass manual persistente exposto no painel vehicle_primary. Um motor OFF atual e confiável nunca é ignorado. Testes sintéticos atravessam todos os gates e o lifecycle; refletor, timers e notificações terminam em dry-run sem qualquer efeito residencial.";

upsert({
  id: ids.bypassGroup,
  type: "group",
  z: ids.lightTab,
  name: "6. Bypass manual do motor (somente telemetria não confiável)",
  style: {
    label: true,
    "label-position": "nw",
    stroke: "#c8a951",
    "stroke-opacity": "1",
    fill: "none",
    color: "#a4a4a4",
  },
  nodes: [
    ids.bypassStartup,
    ids.bypassCommand,
    ids.bypassFunction,
    ids.bypassMqttOut,
    ids.bypassReevaluateOut,
    ids.bypassTestOn,
    ids.bypassTestOff,
  ],
  x: 64,
  y: 1019,
  w: 1362,
  h: 282,
});

upsert({
  id: ids.bypassStartup,
  type: "inject",
  z: ids.lightTab,
  g: ids.bypassGroup,
  name: "Publicar chave e restaurar estado no startup",
  props: [{ p: "payload" }],
  repeat: "",
  crontab: "",
  once: true,
  onceDelay: 1,
  topic: "",
  payload: "STARTUP",
  payloadType: "str",
  x: 300,
  y: 1080,
  wires: [[ids.bypassFunction]],
});

upsert({
  id: ids.bypassCommand,
  type: "mqtt in",
  z: ids.lightTab,
  g: ids.bypassGroup,
  name: "Comando da chave no painel vehicle_primary",
  topic: "homeassistant/vehicle_primary/engine_bypass/set",
  qos: "1",
  datatype: "utf8",
  broker: "721c47f31046b8bc",
  nl: false,
  rap: true,
  rh: 0,
  inputs: 0,
  x: 300,
  y: 1140,
  wires: [[ids.bypassFunction]],
});

upsert({
  id: ids.bypassTestOn,
  type: "inject",
  z: ids.lightTab,
  g: ids.bypassGroup,
  name: "TESTE: bypass ON (isolado)",
  props: [{ p: "payload" }],
  repeat: "",
  crontab: "",
  once: false,
  onceDelay: 0.1,
  topic: "",
  payload: JSON.stringify({
    requested_state: "ON",
    test_mode: true,
    test_case: "engine_bypass_on",
  }),
  payloadType: "json",
  x: 260,
  y: 1200,
  wires: [[ids.bypassFunction]],
});

upsert({
  id: ids.bypassTestOff,
  type: "inject",
  z: ids.lightTab,
  g: ids.bypassGroup,
  name: "TESTE: bypass OFF (isolado)",
  props: [{ p: "payload" }],
  repeat: "",
  crontab: "",
  once: false,
  onceDelay: 0.1,
  topic: "",
  payload: JSON.stringify({
    requested_state: "OFF",
    test_mode: true,
    test_case: "engine_bypass_off",
  }),
  payloadType: "json",
  x: 260,
  y: 1260,
  wires: [[ids.bypassFunction]],
});

upsert({
  id: ids.bypassFunction,
  type: "function",
  z: ids.lightTab,
  g: ids.bypassGroup,
  name: "Persistir bypass e limitar uso ao dado não confiável",
  func: functionSource("security-light-engine-bypass.js"),
  outputs: 2,
  timeout: "",
  noerr: 0,
  initialize: "",
  finalize: "",
  libs: [],
  x: 710,
  y: 1140,
  wires: [[ids.bypassMqttOut], [ids.bypassReevaluateOut]],
});

upsert({
  id: ids.bypassMqttOut,
  type: "mqtt out",
  z: ids.lightTab,
  g: ids.bypassGroup,
  name: "Publicar discovery e estado da chave",
  topic: "",
  qos: "",
  retain: "",
  respTopic: "",
  contentType: "",
  userProps: "",
  correl: "",
  expiry: "",
  broker: "721c47f31046b8bc",
  x: 1080,
  y: 1100,
  wires: [],
});

upsert({
  id: ids.bypassReevaluateOut,
  type: "link out",
  z: ids.lightTab,
  g: ids.bypassGroup,
  name: "Bypass alterado → reavaliar chegada",
  mode: "link",
  links: [ids.bypassReevaluateIn],
  x: 1135,
  y: 1180,
  wires: [],
});

upsert({
  id: ids.bypassReevaluateIn,
  type: "link in",
  z: ids.lightTab,
  g: required(ids.mergeContext).g,
  name: "Receber alteração do bypass",
  links: [ids.bypassReevaluateOut],
  x: 520,
  y: 360,
  wires: [[ids.mergeContext]],
});

const decisionGroup = required(required(ids.mergeContext).g);
if (!decisionGroup.nodes.includes(ids.bypassReevaluateIn)) {
  decisionGroup.nodes.push(ids.bypassReevaluateIn);
}

/*
 * O mesmo evento sintético de chegada também alcança o fluxo de confirmação
 * do alarme. Mantém toda a validação de token, mas simula a interação mobile e
 * encerra antes de qualquer notificação, limpeza de notificação ou desarme.
 */
removeNodes([
  alarmIds.obsoleteTestDebug,
  alarmIds.obsoleteClearPrimary,
  alarmIds.obsoleteClearSecondary,
]);

const alarmValidateArrival = required(alarmIds.validateArrival);
alarmValidateArrival.wires[1] = [alarmIds.routeTestOut];

upsert({
  id: alarmIds.routeTestOut,
  type: "link out",
  z: alarmIds.tab,
  g: alarmIds.group,
  name: "TESTE validado → preparar confirmação",
  mode: "link",
  links: [alarmIds.routeTestIn],
  x: 650,
  y: 260,
  wires: [],
});

upsert({
  id: alarmIds.routeTestIn,
  type: "link in",
  z: alarmIds.tab,
  g: alarmIds.group,
  name: "Receber chegada de TESTE validada",
  links: [alarmIds.routeTestOut],
  x: 980,
  y: 240,
  wires: [[alarmIds.prepareTest]],
});

required(alarmIds.prepareTest).wires = [[alarmIds.simulateConfirmation]];

upsert({
  id: alarmIds.simulateConfirmation,
  type: "function",
  z: alarmIds.tab,
  g: alarmIds.group,
  name: "Simular entrega e confirmação mobile",
  func: `if (
    msg._location_test !== true ||
    msg.alarm_arrival_test !== true ||
    typeof msg.confirm_action !== "string"
) {
    node.status({
        fill: "red",
        shape: "ring",
        text: "mensagem fora do contrato de TESTE"
    });
    return null;
}

msg.payload = {
    event: {
        action: msg.confirm_action
    },
    test_mode: true,
    simulated: true,
    dispatched: false
};

msg.alarm_arrival_test_notification = {
    simulated: true,
    dispatched: false
};

node.status({
    fill: "yellow",
    shape: "dot",
    text: "TESTE: confirmação mobile simulada"
});

return msg;`,
  outputs: 1,
  timeout: "",
  noerr: 0,
  initialize: "",
  finalize: "",
  libs: [],
  x: 1480,
  y: 220,
  wires: [[alarmIds.confirmationOut]],
});

upsert({
  id: alarmIds.confirmationOut,
  type: "link out",
  z: alarmIds.tab,
  g: alarmIds.group,
  name: "Confirmação simulada → validador",
  mode: "link",
  links: [alarmIds.confirmationIn],
  x: 1740,
  y: 240,
  wires: [],
});

upsert({
  id: alarmIds.confirmationIn,
  type: "link in",
  z: alarmIds.tab,
  g: alarmIds.group,
  name: "Receber confirmação simulada",
  links: [alarmIds.confirmationOut],
  x: 300,
  y: 340,
  wires: [[alarmIds.validateConfirmation]],
});

const alarmValidateConfirmation = required(alarmIds.validateConfirmation);
alarmValidateConfirmation.wires[1] = [alarmIds.dryRunTerminal];

upsert({
  id: alarmIds.dryRunTerminal,
  type: "function",
  z: alarmIds.tab,
  g: alarmIds.group,
  name: "TESTE FINAL: notificação e desarme simulados",
  func: `if (
    msg._location_test !== true ||
    msg.alarm_arrival_test !== true
) {
    return null;
}

const result = {
    version: 1,
    simulated: true,
    dispatched: false,
    result: msg.alarm_arrival_test_result ?? "ignorado",
    actions: [
        "notify_actionable:resident_primary",
        "notify_actionable:resident_secondary",
        "mobile_app_confirmation",
        "alarm_disarm"
    ],
    source: msg.arrival_source ?? "manual",
    stage: msg.arrival_stage ?? "manual",
    completed_at: Date.now()
};

flow.set("alarm_arrival_last_dry_run_v1", result);

node.status({
    fill: "green",
    shape: "dot",
    text: "TESTE FINAL: 4 ações simuladas; 0 dispositivos"
});

node.warn(
    "ALARM_ARRIVAL_DRY_RUN_COMPLETE source=" + result.source +
    " stage=" + result.stage +
    " result=" + result.result +
    " actions=4 dispatched=false"
);

return null;`,
  outputs: 0,
  timeout: "",
  noerr: 0,
  initialize: "",
  finalize: "",
  libs: [],
  x: 950,
  y: 400,
  wires: [],
});

const alarmReset = required(alarmIds.reset);
if (!alarmReset.func.includes('flow.set("alarm_arrival_last_dry_run_v1", null);')) {
  alarmReset.func = alarmReset.func.replace(
    "flow.set(TEST_PENDING_KEY, null);",
    'flow.set(TEST_PENDING_KEY, null);\nflow.set("alarm_arrival_last_dry_run_v1", null);',
  );
}
alarmReset.wires = [[alarmIds.resetDebug]];

const alarmGroup = required(alarmIds.group);
for (const nodeId of [
  alarmIds.routeTestOut,
  alarmIds.routeTestIn,
  alarmIds.simulateConfirmation,
  alarmIds.confirmationOut,
  alarmIds.confirmationIn,
  alarmIds.dryRunTerminal,
]) {
  if (!alarmGroup.nodes.includes(nodeId)) alarmGroup.nodes.push(nodeId);
}

required(alarmIds.tab).info = "Solicita confirmação por notificação acionável antes de desarmar o alarme quando resident_primary, resident_secondary ou o vehicle_primary estão chegando. Testes percorrem validação, pendência e confirmação, mas simulam toda interação mobile e terminam em dry-run sem notificação nem desarme.\n\nv11: produção preserva pendência e cooldown somente após o Home Assistant aceitar ao menos uma notificação; chamadas ficam enfileiradas durante reconexão.";


group.name = "4. Testes manuais — motor e localização sintéticos/cumulativos";
group.nodes = [
  ids.reset,
  ids.engineOn,
  ids.engineOff,
  ids.away,
  ids.approach,
  ids.home,
  ids.invalidHome,
  ids.invalidApproach,
  ids.help,
  ids.coordinator,
  ids.output,
];
group.x = 184;
group.y = 1079;
group.w = 968;
group.h = 402;

const tab = required(ids.tab);
tab.info = "Normaliza estado/localização do vehicle_primary, mantém vehicle_primary_in_use, detecta chegada e controla refresh/viagens.\n\nv13: a chegada pessoal em chegando permanece pendente enquanto a localização estiver recente; após escurecer, o replay aceita motor ON atual ou bypass manual somente para telemetria do motor não confiável. Testes atravessam iluminacao_seguranca até o terminal dry-run, sem acionar dispositivos.";

fs.writeFileSync(flowOutputUrl, `${JSON.stringify(flows, null, 4)}\n`);
console.log("Controles manuais ON/OFF do vehicle_primary atualizados.");
