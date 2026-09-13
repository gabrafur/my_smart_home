#!/usr/bin/env node

import fs from "node:fs";
import { installNotificationHubs } from "./install-notification-hubs.mjs";

const flowUrl = new URL("../flows.json", import.meta.url);
const flows = JSON.parse(fs.readFileSync(flowUrl, "utf8"));
const byName = (name) => flows.find((node) => node.name === name);
const byId = (id) => flows.find((node) => node.id === id);

function required(name) {
  const node = byName(name);
  if (!node) throw new Error(`Node obrigatório ausente: ${name}`);
  return node;
}

function requiredId(id) {
  const node = byId(id);
  if (!node) throw new Error(`Node obrigatório ausente: ${id}`);
  return node;
}

function removeSection(source, start, end) {
  const startAt = source.indexOf(start);
  if (startAt < 0) return source;
  const endAt = source.indexOf(end, startAt + start.length);
  if (endAt < 0) throw new Error(`Fim de seção ausente: ${end}`);
  return source.slice(0, startAt) + source.slice(endAt);
}

function removeIds(ids) {
  const unwanted = new Set(ids);
  for (let index = flows.length - 1; index >= 0; index -= 1) {
    if (unwanted.has(flows[index].id)) flows.splice(index, 1);
  }
}

function removeFromGroup(group, ids) {
  const unwanted = new Set(ids);
  group.nodes = group.nodes.filter((id) => !unwanted.has(id));
}

const PEOPLE_LIGHTING_RECOVERY_OUT =
  "people_lighting_tracker_recovery_arrival_out";
const LIGHT_ARRIVAL_IN = "cf9bc321e0ec89f9";

removeIds([PEOPLE_LIGHTING_RECOVERY_OUT]);

const people = required("Normalizar pessoas e detectar transições");
people.func = people.func
  .replace('const RESIDENT_SECONDARY_NOTIFY_KEY = "resident_secondary_approaching_resident_primary_notified";\n', "")
  .replace('const RESIDENT_SECONDARY_AWAY_CYCLE_KEY = "resident_secondary_approaching_confirmed_away_cycle";\n', "")
  .replace('        "resident_secondary_approaching_resident_primary_notified__test",\n', "")
  .replace('        "resident_secondary_approaching_confirmed_away_cycle__test",\n', "");
people.func = removeSection(
  people.func,
  "/* ================================\n * CONTEXTO resident_secondary",
  "/* ================================\n * ARMAMENTO",
);
people.func = removeSection(
  people.func,
  "/* ================================\n * NOTIFICAÇÃO resident_secondary",
  "/* ================================\n * DETECÇÃO DE CHEGADA",
);
people.func = removeSection(
  people.func,
  "recovery.resident_secondary_notified =",
  "recovery.updated_at =",
);
people.func = people.func.replace(
  /\n    if \(notification\?\.payload\) \{[\s\S]*?\n    \}\n(?=\})/,
  "",
);
people.func = people.func.replace(
  /const approachEntry =\n\s*triggerState ===\n\s*APPROACH_ZONE &&\n\s*triggerPrevState !==\n\s*APPROACH_ZONE &&\n\s*triggerPrevState !==\n\s*"home" &&/,
  `const approachEntry =
        triggerState ===
        APPROACH_ZONE &&
        triggerPrevState ===
        "not_home" &&`,
);
if (!people.func.includes("let lightingOnlyArrival = null;")) {
  people.func = people.func.replace(
    "let arrival = null;",
    "let arrival = null;\nlet lightingOnlyArrival = null;",
  );
}
if (!people.func.includes("arrival_previous_state:")) {
  people.func = people.func.replace(
    "arrival_stage:\n                    approachEntry\n                        ? \"approach\"\n                        : \"home\",",
    "arrival_stage:\n                    approachEntry\n                        ? \"approach\"\n                        : \"home\",\n\n                arrival_previous_state:\n                    triggerPrevState,",
  );
}
const snapshotSection = "/* ================================\n * SNAPSHOT / REFRESH";
if (!people.func.includes("illumination_only: true")) {
  const snapshotAt = people.func.indexOf(snapshotSection);
  if (snapshotAt < 0) throw new Error("Seção de snapshot de pessoas ausente");
  const lightingOnlyBlock = `/*
 * Exceção estrita da iluminação: unknown/unavailable → near_home pode indicar que o
 * tracker recuperou diretamente já dentro da zona. Não publica na saída de
 * chegada geral (alarme); o gate físico posterior ainda exige motor ON atual.
 */
if (
    isLocationEvent &&
    sourcePosition?.ready === true &&
    triggerState === APPROACH_ZONE &&
    ["unknown", "unavailable"].includes(triggerPrevState) &&
    sourcePosition.current_home !== true
) {
    lightingOnlyArrival = {
        _location_test: TEST_MODE,
        _location_test_case: TEST_MODE
            ? (msg._location_test_case ?? null)
            : undefined,
        payload: {
            contract: "security.arrival.v1",
            kind: "arrival",
            source,
            arriving: [source],
            arrival_source_type: "person",
            arrival_stage: "approach",
            arrival_previous_state: triggerPrevState,
            illumination_only: true,
            event_at: sourcePosition.updated_at ?? Date.now(),
            refresh_cycle_id: msg.payload?.refresh_cycle_id
        }
    };
}

`;
  people.func = people.func.slice(0, snapshotAt) + lightingOnlyBlock + people.func.slice(snapshotAt);
}
const persistenceSection = "/* ================================\n * PERSISTÊNCIA";
if (!people.func.includes("lighting_tracker_recovery_approach")) {
  const persistenceAt = people.func.indexOf(persistenceSection);
  if (persistenceAt < 0) throw new Error("Seção de persistência de pessoas ausente");
  const lightingDedupe = `if (lightingOnlyArrival) {
    const eventAt = sourcePosition?.updated_at ?? Date.now();
    const key = [
        "lighting_tracker_recovery_approach",
        source,
        eventAt
    ].join(":");

    if (recovery.recent_arrivals[key]) {
        lightingOnlyArrival = null;
    } else {
        recovery.recent_arrivals[key] = Date.now();
    }
}

`;
  people.func = people.func.slice(0, persistenceAt) + lightingDedupe + people.func.slice(persistenceAt);
}
const outputComment = people.func.indexOf("/*\n * OUTPUT 1 = contexto normal");
if (outputComment >= 0) {
  const hasDirectionGuard = people.func.includes("let blockedArrival = null;");
  people.func = people.func.slice(0, outputComment) +
    (hasDirectionGuard
      ? "/*\n * OUTPUT 1 = contexto normal\n * OUTPUT 2 = retorno confirmado\n * OUTPUT 3 = recovery de tracker com ciclo externo confirmado\n * OUTPUT 4 = saída/rebote bloqueado, sem efeitos\n */\nreturn [msg, arrival, lightingOnlyArrival, blockedArrival];\n"
      : "/*\n * OUTPUT 1 = contexto normal\n * OUTPUT 2 = chegada geral\n * OUTPUT 3 = unknown/unavailable → near_home somente para iluminação\n */\nreturn [msg, arrival, lightingOnlyArrival];\n");
}
const hasDirectionGuard = people.func.includes("let blockedArrival = null;");
people.outputs = hasDirectionGuard ? 4 : 3;
people.wires = [
  people.wires[0] ?? [],
  people.wires[1] ?? [],
  [PEOPLE_LIGHTING_RECOVERY_OUT],
  ...(hasDirectionGuard ? [people.wires[3] ?? []] : []),
];

const peopleContextGroup = flows.find(
  (node) =>
    node.type === "group" &&
    node.z === people.z &&
    Array.isArray(node.nodes) &&
    node.nodes.includes(people.id),
);
if (!peopleContextGroup) throw new Error("Grupo do normalizador de pessoas ausente");
removeFromGroup(peopleContextGroup, [PEOPLE_LIGHTING_RECOVERY_OUT]);
peopleContextGroup.nodes.push(PEOPLE_LIGHTING_RECOVERY_OUT);
peopleContextGroup.h = 202;

const lightArrivalIn = requiredId(LIGHT_ARRIVAL_IN);
lightArrivalIn.links = [
  ...new Set([
    ...(lightArrivalIn.links ?? []).filter(
      (id) => id !== PEOPLE_LIGHTING_RECOVERY_OUT,
    ),
    PEOPLE_LIGHTING_RECOVERY_OUT,
  ]),
];

flows.push({
  id: PEOPLE_LIGHTING_RECOVERY_OUT,
  type: "link out",
  z: people.z,
  g: peopleContextGroup.id,
  name: "Tracker recuperado near_home → iluminação",
  mode: "link",
  links: [LIGHT_ARRIVAL_IN],
  x: 1195,
  y: 220,
  wires: [],
});

const coordinator = flows.find((node) => node.name === "Coordenar snapshot e refresh");
if (coordinator) {
coordinator.func = coordinator.func
  .replace('const NOTIFICATION_TTL_MS = 10 * 60 * 1000;\n', "")
  .replace('const PENDING_NOTIFICATION_KEY = "security_pending_resident_secondary_notification_v1";\n', "")
  .replace('const PERSISTENT = "persistent";\n', "")
  .replace('    ctxSet(PENDING_NOTIFICATION_KEY, undefined, PERSISTENT);\n', "");
coordinator.func = removeSection(
  coordinator.func,
  "function enrichNotification(payload, vehicle_primary) {",
  "function newPending(cycle, options = {}) {",
);
const legacyQueueStart = coordinator.func.indexOf("    let notification = null;\n    let queued = ctxGet(PENDING_NOTIFICATION_KEY, PERSISTENT);");
if (legacyQueueStart >= 0) {
  const legacyKindStart = coordinator.func.indexOf(
    '}\n\nif (kind === "resident_secondary_approach_notification") {',
    legacyQueueStart,
  );
  if (legacyKindStart < 0) throw new Error("Bloco legado de aviso não encontrado");
  coordinator.func = coordinator.func.slice(0, legacyQueueStart) +
    "    return refresh ? [null, refresh] : null;\n" +
    coordinator.func.slice(legacyKindStart);
}
const legacyKindStart = coordinator.func.indexOf('if (kind === "resident_secondary_approach_notification") {');
if (legacyKindStart >= 0) {
  const finalReturn = coordinator.func.lastIndexOf("\nreturn null;");
  if (finalReturn < legacyKindStart) throw new Error("Retorno final do coordenador ausente");
  coordinator.func = coordinator.func.slice(0, legacyKindStart) + coordinator.func.slice(finalReturn + 1);
}
coordinator.outputs = 2;
coordinator.wires = coordinator.wires.slice(0, 2);

const oldPeopleLink = "4fb2fbdfe36fa899";
const oldContextLink = "9acb4f732a4847b7";
const oldNotify = "32f1180d9ab2d2de";
const oldTest = "93c16cfc3f3b3856";
removeIds([oldPeopleLink, oldContextLink, oldNotify, oldTest]);
removeFromGroup(peopleContextGroup, [oldPeopleLink]);
const contextContractGroup = required("2. Contratos de domínio");
removeFromGroup(contextContractGroup, [oldContextLink]);
Object.assign(contextContractGroup, { x: 404, y: 359, w: 157, h: 142 });
const contextOutputGroup = flows.find((node) =>
  node.type === "group" &&
  ["3. Comandos e notificações", "3. Comandos"].includes(node.name),
);
if (!contextOutputGroup) throw new Error("Grupo de comandos de contexto ausente");
removeFromGroup(contextOutputGroup, [oldNotify, oldTest]);
contextOutputGroup.name = "3. Comandos";
Object.assign(contextOutputGroup, { x: 734, y: 379, w: 322, h: 82 });
const contextTab = flows.find((node) => node.type === "tab" && node.label === "contexto_chegadas");
if (!contextTab) throw new Error("Tab contexto_chegadas ausente");
contextTab.info = "Coordena snapshots e a política conjunta de presença sem interpretar GPS. As notificações entre residentes ficam no tab notificacoes_chegadas_residentes.\n\nRecovery forçado preservado entre ciclos e proteção contra corrida entre tick periódico e recovery imediato.";
}

const ids = {
  tab: "resident_notifications_tab",
  triggerGroup: "resident_notifications_triggers_group",
  decisionGroup: "resident_notifications_decision_group",
  outputGroup: "resident_notifications_output_group",
  testGroup: "resident_notifications_test_group",
  note: "resident_notifications_note",
  primaryEvent: "resident_notifications_primary_event",
  secondaryEvent: "resident_notifications_secondary_event",
  prepare: "resident_notifications_prepare",
  primaryNotify: "resident_notifications_notify_primary",
  secondaryNotify: "resident_notifications_notify_secondary",
  testPrimary: "resident_notifications_test_primary",
  testSecondary: "resident_notifications_test_secondary",
  testCycleIn: "resident_notifications_test_cycle_in",
  testAdapter: "resident_notifications_test_adapter",
  testEventOut: "resident_notifications_test_event_out",
  testEventIn: "resident_notifications_test_event_in",
  dryRunOut: "resident_notifications_dry_run_out",
  dryRunIn: "resident_notifications_dry_run_in",
  dryRunTerminal: "resident_notifications_dry_run_terminal",
  deliveryAck: "resident_notifications_delivery_ack",
  canonicalIn: "resident_notifications_canonical_in_v1",
};
removeIds(Object.values(ids));

const prepareFunction = String.raw`const APPROACH_ZONE = "near_home";
const RECOVERY_KEY = "resident_approach_notification_recovery_v1";
const PERSISTENT = "persistent";
const DEDUPE_TTL_MS = 10 * 60 * 1000;
const MAX_EVENT_AGE_MS = 15 * 60 * 1000;
const FUTURE_TOLERANCE_MS = 60 * 1000;
const TEST_MODE =
    msg._location_test === true ||
    msg.payload?.test_mode === true;
const NOTIFICATION_DELIVERY_UNDER_TEST =
    TEST_MODE &&
    msg.payload?.notification_delivery_under_test === true;
const ACTIVE_RECOVERY_KEY = TEST_MODE
    ? RECOVERY_KEY + "__test"
    : RECOVERY_KEY;

const residents = {
    resident_primary: {
        recipient: "resident_secondary"
    },
    resident_secondary: {
        recipient: "resident_primary"
    }
};

function privateDisplayName(role) {
    const alias = global.get("publicBindings")
        ?.roles?.[role]?.source_alias;

    if (typeof alias !== "string") return role;

    const words = alias
        .trim()
        .split(/[\s_-]+/u)
        .filter(Boolean);

    if (
        words.length === 0 ||
        words.some((word) =>
            !/^[\p{L}\p{M}.'’]+$/u.test(word)
        )
    ) {
        return role;
    }

    return words
        .map((word) =>
            word.charAt(0).toLocaleUpperCase("pt-BR") +
            word.slice(1)
        )
        .join(" ");
}

function validZoneState(value) {
    return typeof value === "string" &&
        !["", "unknown", "unavailable"].includes(value);
}

function persist(value) {
    value.updated_at = Date.now();
    return TEST_MODE
        ? flow.set(ACTIVE_RECOVERY_KEY, value)
        : flow.set(ACTIVE_RECOVERY_KEY, value, PERSISTENT);
}

if (TEST_MODE && msg.payload?.event === "test_reset") {
    flow.set(ACTIVE_RECOVERY_KEY, null);
    flow.set(
        "resident_notifications_last_test_delivery_v1__test",
        null
    );
    flow.set(
        "resident_notifications_last_dry_run_v1__test",
        null
    );
    return null;
}

const source = msg.payload?.source;
const resident = residents[source];
const current = msg.payload?.trigger_state;
const previous = msg.payload?.trigger_prev_state;

if (!resident || !validZoneState(current) || !validZoneState(previous)) {
    return null;
}

const canonicalObservedAt = Number(
    msg._canonical_locations?.[source]?.selected?.observed_at
);
const parsedEventAt = Date.parse(msg.payload?.observed_at ?? "");
const eventAt = Number.isFinite(canonicalObservedAt)
    ? canonicalObservedAt
    : Number.isFinite(parsedEventAt)
        ? parsedEventAt
        : Date.now();
if (
    eventAt > Date.now() + FUTURE_TOLERANCE_MS ||
    Date.now() - eventAt > MAX_EVENT_AGE_MS
) {
    node.warn("notificacoes_chegadas_residentes: evento antigo ou futuro descartado");
    return null;
}

let recovery = TEST_MODE
    ? flow.get(ACTIVE_RECOVERY_KEY)
    : flow.get(ACTIVE_RECOVERY_KEY, PERSISTENT);
if (!recovery || recovery.version !== 1 || typeof recovery.residents !== "object") {
    recovery = { version: 1, residents: {} };
}

const state = recovery.residents[source] ?? {
    notified: false,
    away_cycle: false,
    last_notification_key: null,
    last_notification_at: 0
};

if (current === "not_home") {
    state.notified = false;
    if (previous !== "not_home") {
        state.away_cycle = true;
    }
    recovery.residents[source] = state;
    persist(recovery);
    return null;
}

if (current === "home") {
    state.away_cycle = false;
    recovery.residents[source] = state;
    persist(recovery);
    return null;
}

const enteringApproach =
    current === APPROACH_ZONE &&
    previous === "not_home";

const notificationKey = [source, current, eventAt].join(":");
const duplicate =
    state.last_notification_key === notificationKey &&
    Number.isFinite(state.last_notification_at) &&
    Date.now() - state.last_notification_at < DEDUPE_TTL_MS;

if (
    !enteringApproach ||
    state.notified === true ||
    duplicate
) {
    recovery.residents[source] = state;
    persist(recovery);
    return null;
}

state.notified = true;
state.last_notification_key = notificationKey;
state.last_notification_at = Date.now();
recovery.residents[source] = state;
persist(recovery);

msg.payload = {
    contract: "security.resident-approach-notification.v1",
    kind: "resident_approach_notification",
    source,
    recipient: resident.recipient,
    notification_key: notificationKey,
    event_at: eventAt,
    message: privateDisplayName(source) + " está perto de casa."
};

if (TEST_MODE) {
    msg.payload.test_mode = true;
    msg.payload.message = "[TESTE] " + msg.payload.message;
    msg.payload.notification_delivery_under_test =
        NOTIFICATION_DELIVERY_UNDER_TEST;
    msg.payload.simulated =
        !NOTIFICATION_DELIVERY_UNDER_TEST;
    msg.payload.dispatched = false;
}

if (TEST_MODE && !NOTIFICATION_DELIVERY_UNDER_TEST) {
    return [null, null, null, null, msg];
}

if (resident.recipient === "resident_primary") {
    return TEST_MODE
        ? [null, null, msg, null]
        : [msg, null, null, null];
}

return TEST_MODE
    ? [null, null, null, msg, null]
    : [null, msg, null, null];`;

const testAdapterFunction = String.raw`const SHARED_TEST_KEY =
    "security_location_test_state_v1";

if (
    msg._location_test_reset === true ||
    msg.payload?.kind === "test_reset"
) {
    msg._location_test = true;
    msg.payload = {
        event: "test_reset",
        test_mode: true
    };
    return msg;
}

const directSource = msg.test_source;
const shared = global.get(SHARED_TEST_KEY) ?? {};
const transition = shared.transitions?.people;
const source = directSource ?? transition?.source;

if (![
    "resident_primary",
    "resident_secondary"
].includes(source)) {
    return null;
}

const current = directSource
    ? "near_home"
    : transition?.state;
const previous = directSource
    ? "not_home"
    : transition?.prev;
const eventAt = directSource
    ? Date.now()
    : Number(transition?.at ?? shared.observed_at ?? Date.now());

if (
    typeof current !== "string" ||
    typeof previous !== "string"
) {
    return null;
}

const primaryState = directSource
    ? (source === "resident_primary" ? current : "not_home")
    : shared.resident_primary;
const secondaryState = directSource
    ? (source === "resident_secondary" ? current : "not_home")
    : shared.resident_secondary;

msg._location_test = true;
msg.payload = {
    event: "location_update",
    test_mode: true,
    notification_delivery_under_test:
        Boolean(directSource),
    source,
    trigger_state: current,
    trigger_prev_state: previous,
    observed_at: new Date(eventAt).toISOString(),
    resident_primary_source_1: primaryState,
    resident_primary_source_2: primaryState,
    resident_secondary_source_1: secondaryState,
    resident_secondary_source_2: secondaryState
};

return msg;`;

const dryRunFunction = String.raw`if (
    msg._location_test !== true ||
    msg.payload?.test_mode !== true
) {
    return null;
}

const result = {
    version: 1,
    simulated: true,
    dispatched: false,
    source: msg.payload.source,
    recipient: msg.payload.recipient,
    message: msg.payload.message,
    completed_at: Date.now()
};

flow.set(
    "resident_notifications_last_dry_run_v1__test",
    result
);

node.status({
    fill: "green",
    shape: "dot",
    text:
        "TESTE FINAL: aviso para " +
        result.recipient +
        " simulado; 0 dispositivos"
});

node.warn(
    "RESIDENT_NOTIFICATION_DRY_RUN_COMPLETE source=" +
    result.source +
    " recipient=" + result.recipient +
    " dispatched=false"
);

return null;`;

const deliveryAckFunction = String.raw`const TEST_MODE =
    msg._location_test === true ||
    msg.payload?.test_mode === true;

if (TEST_MODE) {
    msg.payload.simulated = false;
    msg.payload.dispatched = true;

    const result = {
        version: 1,
        simulated: false,
        dispatched: true,
        source: msg.payload.source,
        recipient: msg.payload.recipient,
        message: msg.payload.message,
        completed_at: Date.now()
    };

    flow.set(
        "resident_notifications_last_test_delivery_v1__test",
        result
    );

    node.status({
        fill: "green",
        shape: "dot",
        text:
            "TESTE FINAL: push para " +
            result.recipient +
            " enviado"
    });

    node.warn(
        "RESIDENT_NOTIFICATION_TEST_DISPATCHED source=" +
        result.source +
        " recipient=" + result.recipient +
        " dispatched=true"
    );

    return null;
}

node.status({
    fill: "green",
    shape: "dot",
    text: "notificação de chegada enviada"
});

return null;`;

function group(id, name, nodes, x, y, w, h, stroke) {
  return {
    id, type: "group", z: ids.tab, name,
    style: { label: true, "label-position": "nw", stroke, "stroke-opacity": "1", fill: "none", color: "#a4a4a4" },
    nodes, x, y, w, h,
  };
}

const notifyTemplate = flows.find((node) => node.type === "api-call-service" && node.action === "public_bindings.call");
if (!notifyTemplate) throw new Error("Template público de notificação ausente");

const notifyBase = {
  ...structuredClone(notifyTemplate),
  z: ids.tab, g: ids.outputGroup,
  dataType: "jsonata", action: "public_bindings.call",
  domain: "public_bindings", service: "call", entityId: [],
  floorId: [], areaId: [], deviceId: [], labelId: [],
  outputProperties: [], queue: "all", blockInputOverrides: true,
  wires: [[]],
};

const testCycleOut = requiredId("bc2afbce89f5a9d5");
if (!testCycleOut.links.includes(ids.testCycleIn)) {
  testCycleOut.links.push(ids.testCycleIn);
}

flows.push(
  { id: ids.tab, type: "tab", label: "notificacoes_chegadas_residentes", disabled: false, info: "Avisa cada residente quando o outro entra na zona near_home segundo a decisão canônica publicada por localizacao_pessoas. Funciona 24 horas por dia. Testes vindos de localizacao_pessoas terminam em dry-run; somente os botões dedicados desta aba testam a entrega de push marcada como TESTE.", env: [] },
  group(ids.triggerGroup, "1. Decisão canônica de localização", [ids.note, ids.canonicalIn], 64, 79, 432, 202, "#3f7cb5"),
  group(ids.decisionGroup, "2. Validar aproximação e deduplicar", [ids.prepare, ids.testEventIn, ids.dryRunOut], 499, 124, 337, 197, "#7d6ba8"),
  group(ids.outputGroup, "3. Entrega real explícita ou dry-run", [ids.primaryNotify, ids.secondaryNotify, ids.deliveryAck, ids.dryRunIn, ids.dryRunTerminal], 894, 119, 742, 222, "#4d9a6a"),
  group(ids.testGroup, "4. Testes manuais — envia push marcado TESTE", [ids.testPrimary, ids.testSecondary, ids.testCycleIn, ids.testAdapter, ids.testEventOut], 434, 359, 607, 202, "#a87932"),
  { id: ids.note, type: "comment", z: ids.tab, g: ids.triggerGroup, name: "Sem restrição de horário", info: "Somente a transição canônica not_home → near_home é avaliada. Nenhum tracker bruto entra nesta aba.", x: 250, y: 120, wires: [] },
  { id: ids.canonicalIn, type: "link in", z: ids.tab, g: ids.triggerGroup, name: "Receber decisão canônica de localização", links: ["people_location_notification_out_v1"], x: 160, y: 200, wires: [[ids.prepare]] },
  { id: ids.prepare, type: "function", z: ids.tab, g: ids.decisionGroup, name: "Preparar avisos de aproximação", func: prepareFunction, outputs: 5, timeout: "", noerr: 0, initialize: "", finalize: "", libs: [], x: 640, y: 180, wires: [[ids.primaryNotify], [ids.secondaryNotify], [ids.primaryNotify], [ids.secondaryNotify], [ids.dryRunOut]] },
  { id: ids.testEventIn, type: "link in", z: ids.tab, g: ids.decisionGroup, name: "Receber transição sintética", links: [ids.testEventOut], x: 560, y: 240, wires: [[ids.prepare]] },
  { id: ids.dryRunOut, type: "link out", z: ids.tab, g: ids.decisionGroup, name: "Teste de localização → dry-run", mode: "link", links: [ids.dryRunIn], x: 780, y: 280, wires: [] },
  { ...notifyBase, id: ids.primaryNotify, name: "Avisar resident_primary: resident_secondary se aproxima", data: '{"role":"mobile_primary","action":"notify_actionable","data":{"title":payload.test_mode=true ? "Casa inteligente — TESTE" : "Casa inteligente","message":payload.message}}', x: 1130, y: 160, wires: [[ids.deliveryAck]] },
  { ...notifyBase, id: ids.secondaryNotify, name: "Avisar resident_secondary: resident_primary se aproxima", data: '{"role":"mobile_secondary","action":"notify_actionable","data":{"title":payload.test_mode=true ? "Casa inteligente — TESTE" : "Casa inteligente","message":payload.message}}', x: 1130, y: 220, wires: [[ids.deliveryAck]] },
  { id: ids.deliveryAck, type: "function", z: ids.tab, g: ids.outputGroup, name: "Confirmar entrega da notificação", func: deliveryAckFunction, outputs: 0, timeout: "", noerr: 0, initialize: "", finalize: "", libs: [], x: 1480, y: 190, wires: [] },
  { id: ids.dryRunIn, type: "link in", z: ids.tab, g: ids.outputGroup, name: "Receber teste sem entrega", links: [ids.dryRunOut], x: 970, y: 280, wires: [[ids.dryRunTerminal]] },
  { id: ids.dryRunTerminal, type: "function", z: ids.tab, g: ids.outputGroup, name: "TESTE FINAL: aviso simulado — nenhum push", func: dryRunFunction, outputs: 0, timeout: "", noerr: 0, initialize: "", finalize: "", libs: [], x: 1300, y: 280, wires: [] },
  { id: ids.testPrimary, type: "inject", z: ids.tab, g: ids.testGroup, name: "Teste: simular aviso para resident_primary", props: [{ p: "test_source", v: "resident_secondary", vt: "str" }, { p: "_location_test", v: "true", vt: "bool" }], repeat: "", crontab: "", once: false, onceDelay: 0.1, topic: "", x: 650, y: 400, wires: [[ids.testAdapter]] },
  { id: ids.testSecondary, type: "inject", z: ids.tab, g: ids.testGroup, name: "Teste: simular aviso para resident_secondary", props: [{ p: "test_source", v: "resident_primary", vt: "str" }, { p: "_location_test", v: "true", vt: "bool" }], repeat: "", crontab: "", once: false, onceDelay: 0.1, topic: "", x: 650, y: 460, wires: [[ids.testAdapter]] },
  { id: ids.testCycleIn, type: "link in", z: ids.tab, g: ids.testGroup, name: "Receber teste de localização", links: [testCycleOut.id], x: 505, y: 520, wires: [[ids.testAdapter]] },
  { id: ids.testAdapter, type: "function", z: ids.tab, g: ids.testGroup, name: "Montar transição sintética de residente", func: testAdapterFunction, outputs: 1, timeout: "", noerr: 0, initialize: "", finalize: "", libs: [], x: 780, y: 520, wires: [[ids.testEventOut]] },
  { id: ids.testEventOut, type: "link out", z: ids.tab, g: ids.testGroup, name: "Transição sintética → validação", mode: "link", links: [ids.testEventIn], x: 1000, y: 520, wires: [] },
);

const peopleTestCoordinator = required("Iniciar teste pelo coordenador");
if (!peopleTestCoordinator.func.includes("resident_primary_unknown_approach")) {
  peopleTestCoordinator.func = peopleTestCoordinator.func.replace(
    'resident_secondary_invalid_approach: { source: "resident_secondary", state: "near_home", prev: "unavailable" }',
    'resident_secondary_invalid_approach: { source: "resident_secondary", state: "near_home", prev: "unavailable" },\n    resident_primary_unknown_approach: { source: "resident_primary", state: "near_home", prev: "unknown" },\n    resident_secondary_unknown_approach: { source: "resident_secondary", state: "near_home", prev: "unknown" },\n    resident_primary_unavailable_approach: { source: "resident_primary", state: "near_home", prev: "unavailable" }',
  );
}

const recoveryTestNodes = [
  {
    id: "people_primary_unknown_approach_test_v1",
    name: "resident_primary unknown → near_home (motor ON)",
    testCase: "resident_primary_unknown_approach",
    y: 1340,
  },
  {
    id: "people_secondary_unknown_approach_test_v1",
    name: "resident_secondary unknown → near_home (motor ON)",
    testCase: "resident_secondary_unknown_approach",
    y: 1440,
  },
  {
    id: "people_primary_unavailable_approach_test_v1",
    name: "resident_primary unavailable → near_home (motor ON)",
    testCase: "resident_primary_unavailable_approach",
    y: 1520,
  },
];

const recoveryTestRoute = {
  out: "people_tracker_recovery_tests_out_v1",
  in: "people_tracker_recovery_tests_in_v1",
};

removeIds([
  ...recoveryTestNodes.map((node) => node.id),
  recoveryTestRoute.out,
  recoveryTestRoute.in,
]);
const peopleTestGroup = required("4. Testes manuais — estado compartilhado/cumulativo");
removeFromGroup(peopleTestGroup, [
  ...recoveryTestNodes.map((node) => node.id),
  recoveryTestRoute.out,
  recoveryTestRoute.in,
]);

const secondaryUnavailableTest = requiredId("d1611f90020ade33");
secondaryUnavailableTest.name =
  "resident_secondary unavailable → near_home (motor ON)";

for (const testNode of recoveryTestNodes) {
  flows.push({
    id: testNode.id,
    type: "inject",
    z: people.z,
    g: peopleTestGroup.id,
    name: testNode.name,
    props: [{ p: "test_case", v: testNode.testCase, vt: "str" }],
    repeat: "",
    crontab: "",
    once: false,
    onceDelay: 0.1,
    topic: "",
    x: 700,
    y: testNode.y,
    wires: [[recoveryTestRoute.out]],
  });
  peopleTestGroup.nodes.push(testNode.id);
}

flows.push(
  {
    id: recoveryTestRoute.out,
    type: "link out",
    z: people.z,
    g: peopleTestGroup.id,
    name: "Recovery de tracker → coordenador",
    mode: "link",
    links: [recoveryTestRoute.in],
    x: 860,
    y: 1600,
    wires: [],
  },
  {
    id: recoveryTestRoute.in,
    type: "link in",
    z: people.z,
    g: peopleTestGroup.id,
    name: "Receber teste de recovery do tracker",
    links: [recoveryTestRoute.out],
    x: 570,
    y: 1180,
    wires: [[peopleTestCoordinator.id]],
  },
);
peopleTestGroup.nodes.push(recoveryTestRoute.out, recoveryTestRoute.in);
peopleTestGroup.h = 782;

fs.writeFileSync(flowUrl, `${JSON.stringify(installNotificationHubs(flows), null, 4)}\n`);
console.log("Notificações recíprocas de aproximação movidas para fluxo independente.");
