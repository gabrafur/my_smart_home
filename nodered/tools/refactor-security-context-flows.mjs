#!/usr/bin/env node

import fs from "node:fs";

const flowUrl = new URL("../flows.json", import.meta.url);
const flows = JSON.parse(fs.readFileSync(flowUrl, "utf8"));
// This is a one-time migration from the legacy combined tab. Once recovery
// state exists, regenerating from the embedded pre-recovery templates would
// silently remove hardening. Make repeat execution idempotent and safe.
const recoveryAware = flows.some((node) => node.id === "people_normalize" && node.func?.includes("security_people_recovery_v1"));
if (recoveryAware) {
  console.log("Flows de segurança já incluem recovery; nenhuma alteração aplicada.");
  process.exit(0);
}
const old = new Map(flows.map((node) => [node.id, structuredClone(node)]));
const SECURITY_TAB = "2fd40fd570e6f37a";
const PEOPLE_TAB = "security_people_tab";
const CRETA_TAB = "security_creta_tab";
const CONTEXT_TAB = "security_context_tab";
const generatedFallback = {
  sec_gabriel_location_changed: "people_gabriel_event",
  sec_valeria_location_changed: "people_valeria_event",
  sec_creta_location_changed: "creta_location_event",
  sec_creta_lock_context_changed: "creta_lock_event",
  sec_engine_off_changed: "creta_engine_off_event",
  sec_creta_locked_changed: "creta_unlock_event",
  sec_refresh_context_snapshot: "people_snapshot",
  sec_request_gabriel_location: "people_refresh_gabriel",
  sec_request_valeria_location: "people_refresh_valeria",
  sec_force_refresh_creta: "creta_force_refresh",
  sec_refresh_creta_entities: "creta_update_entities",
  sec_refresh_creta_trip_info: "creta_trip_refresh",
  sec_refresh_every_10min: "context_tick",
  sec_notify_valeria_approaching: "context_notify_valeria",
  "249963a6cd6c247a": "context_test_notification",
  sec_sun_changed: "light_sun_event",
  sec_check_dark: "light_check_dark",
  sec_check_reflector_inactive: "light_check_inactive",
  sec_mark_reflector_active: "light_mark_active",
  sec_reflector_turn_on: "light_turn_on",
  "29a4e3c0935e2805": "light_notify_on",
  sec_auto_off_delay: "light_auto_off",
  sec_auto_off_event: "light_timeout",
  sec_arrival_off_grace: "light_off_grace",
  sec_turn_off_if_active: "light_turn_off_if_active",
  sec_reflector_turn_off: "light_turn_off",
  "965afc02b5d9e809": "light_manual_test",
};

function clone(id, changes) {
  const node = old.get(id) ?? old.get(generatedFallback[id]);
  if (!node) throw new Error(`Node de origem ausente: ${id}`);
  return Object.assign(structuredClone(node), changes);
}

function tab(id, label, info) {
  return { id, type: "tab", label, disabled: false, info, env: [] };
}

function group(id, z, name, nodes, x, y, w, h, stroke) {
  return {
    id, type: "group", z, name,
    style: { label: true, "label-position": "nw", stroke, "stroke-opacity": "1", fill: "none", color: "#a4a4a4" },
    nodes, x, y, w, h,
  };
}

function comment(id, z, g, name, info, x, y, w = 300) {
  return { id, type: "comment", z, g, name, info, x, y, wires: [], width: w };
}

function functionNode(id, z, g, name, func, outputs, x, y, wires) {
  return { id, type: "function", z, g, name, func, outputs, timeout: "", noerr: 0, initialize: "", finalize: "", libs: [], x, y, wires };
}

function linkIn(id, z, g, name, links, x, y, wires) {
  return { id, type: "link in", z, g, name, links, x, y, wires };
}

function linkOut(id, z, g, name, links, x, y) {
  return { id, type: "link out", z, g, name, mode: "link", links, x, y, wires: [] };
}

function rawEvent(source, event = "location_update") {
  const entity = source === "gabriel"
    ? "device_tracker.iphone_de_gabriel_furlan"
    : source === "valeria"
      ? "device_tracker.iphone_de_valeria"
      : "device_tracker.creta_location";
  const common = [
    `"event": "${event}"`,
    `"source": "${source}"`,
    `"trigger_entity": $entity().entity_id`,
    `"trigger_state": $entity().state`,
    `"trigger_prev_state": $prevEntity().state`,
  ];
  const domain = source === "creta"
    ? [
        `"creta": $entities("device_tracker.creta_location")`,
        `"creta_engine": $entities("binary_sensor.creta_engine")`,
        `"creta_lock": $entities("lock.creta_door_lock")`,
      ]
    : [
        `"gabriel": $entities("device_tracker.iphone_de_gabriel_furlan")`,
        `"gabriel_icloud": $entities("device_tracker.iphonegabrielfurlan")`,
        `"valeria": $entities("device_tracker.iphone_de_valeria")`,
        `"valeria_icloud": $entities("device_tracker.iphone_de_valeria_2")`,
      ];
  return `(\n  {\n    ${[...common, ...domain].join(",\n    ")}\n  }\n)`;
}

const peopleNormalize = String.raw`
const HOME_LAT = Number(env.get("HOME_LAT"));
const HOME_LON = Number(env.get("HOME_LON"));
const GATE_LAT = Number(env.get("GATE_LAT"));
const GATE_LON = Number(env.get("GATE_LON"));
const HOME_KNOWN = Number.isFinite(HOME_LAT) && Number.isFinite(HOME_LON);
const GATE_KNOWN = Number.isFinite(GATE_LAT) && Number.isFinite(GATE_LON);
const ARM_DISTANCE_M = 100;
const ARRIVAL_DISTANCE_M = 300;
const MAX_GPS_ACCURACY_M = 100;
const APPROACH_ZONE = "chegando";
const PRIMARY_HOME_GRACE_MS = 10 * 60 * 1000;
const ARMED_KEY = "people_arrival_armed";
const VALERIA_NOTIFY_KEY = "valeria_approaching_gabriel_notified";
const VALERIA_AWAY_CYCLE_KEY = "valeria_approaching_confirmed_away_cycle";

function distanceMeters(lat1, lon1, lat2, lon2) {
    const toRad = (value) => value * Math.PI / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
function reliableCoords(entity) {
    const attrs = entity?.attributes ?? {};
    const lat = Number(attrs.latitude);
    const lon = Number(attrs.longitude);
    const accuracy = Number(attrs.gps_accuracy);
    const hasCoords = Number.isFinite(lat) && Number.isFinite(lon);
    const hasAccuracy = Number.isFinite(accuracy);
    return hasCoords && (!hasAccuracy || accuracy <= MAX_GPS_ACCURACY_M) ? { lat, lon } : null;
}
function primaryHome(entity) {
    const coords = reliableCoords(entity);
    if (HOME_KNOWN && coords) return distanceMeters(HOME_LAT, HOME_LON, coords.lat, coords.lon) <= ARM_DISTANCE_M;
    const accuracy = Number(entity?.attributes?.gps_accuracy);
    if (Number.isFinite(accuracy) && accuracy > MAX_GPS_ACCURACY_M) return false;
    return entity?.state === "home";
}
function homeForMs(entity) {
    const changedAt = Date.parse(entity?.last_changed ?? "");
    return Number.isFinite(changedAt) ? Date.now() - changedAt : null;
}
function mergeTrackers(primary, fallback) {
    const primaryCoords = reliableCoords(primary);
    const fallbackCoords = reliableCoords(fallback);
    if (HOME_KNOWN && primaryCoords && fallbackCoords) {
        const primaryDistance = distanceMeters(HOME_LAT, HOME_LON, primaryCoords.lat, primaryCoords.lon);
        const fallbackDistance = distanceMeters(HOME_LAT, HOME_LON, fallbackCoords.lat, fallbackCoords.lon);
        return fallbackDistance > primaryDistance ? fallback : primary;
    }
    if (primaryCoords) return primary;
    if (fallbackCoords) return fallback;
    if (primary?.state === "home" && fallback?.state === "not_home") return fallback;
    return primary;
}
function position(primary, fallback) {
    const selected = mergeTrackers(primary, fallback);
    const attrs = selected?.attributes ?? {};
    const coords = reliableCoords(selected);
    const accuracy = Number(attrs.gps_accuracy);
    const state = selected?.state;
    const validState = typeof state === "string" && !["unknown", "unavailable", ""].includes(state);
    return {
        entity_id: selected?.entity_id,
        state,
        latitude: coords?.lat ?? null,
        longitude: coords?.lon ?? null,
        gps_accuracy: Number.isFinite(accuracy) ? accuracy : null,
        location_reliable: Boolean(coords),
        state_valid: validState && (Boolean(coords) || ["home", "not_home", APPROACH_ZONE].includes(state)),
        distance_m: HOME_KNOWN && coords ? Math.round(distanceMeters(HOME_LAT, HOME_LON, coords.lat, coords.lon)) : null,
        gate_distance_m: GATE_KNOWN && coords ? Math.round(distanceMeters(GATE_LAT, GATE_LON, coords.lat, coords.lon)) : null,
        primary_home: primaryHome(primary),
        any_tracker_home: primaryHome(primary) || primaryHome(fallback),
        primary_home_for_ms: homeForMs(primary),
    };
}
function isAway(item) {
    if (item?.distance_m !== null) return item.distance_m > ARM_DISTANCE_M;
    return item?.state === "not_home";
}
function isArmingHome(item) {
    if (item?.distance_m !== null) return item.distance_m <= ARM_DISTANCE_M;
    if (item?.gps_accuracy !== null && item.gps_accuracy > MAX_GPS_ACCURACY_M) return false;
    return item?.state === "home";
}
function isArrivalHome(item) {
    if (item?.gate_distance_m !== null && item.gate_distance_m <= ARRIVAL_DISTANCE_M) return true;
    if (item?.distance_m !== null) return item.distance_m <= ARRIVAL_DISTANCE_M;
    if (item?.gps_accuracy !== null && item.gps_accuracy > MAX_GPS_ACCURACY_M) return false;
    return item?.state === "home";
}

const gabriel = position(msg.payload?.gabriel, msg.payload?.gabriel_icloud);
const valeria = position(msg.payload?.valeria, msg.payload?.valeria_icloud);
const people = { gabriel, valeria };
const source = msg.payload?.source;
const sourcePosition = people[source];
const triggerState = msg.payload?.trigger_state;
const triggerPrevState = msg.payload?.trigger_prev_state;
const isLocationEvent = msg.payload?.event === "location_update";
const armed = flow.get(ARMED_KEY) ?? {};

for (const [name, item] of Object.entries(people)) {
    if (isAway(item)) armed[name] = true;
}

let notification = null;
if (isLocationEvent && source === "valeria") {
    if (triggerState === "not_home" && (triggerPrevState === APPROACH_ZONE || triggerPrevState === "home")) {
        flow.set(VALERIA_AWAY_CYCLE_KEY, true);
    }
    const confirmedAwayCycle = flow.get(VALERIA_AWAY_CYCLE_KEY) === true;
    const approachForNotification = triggerState === APPROACH_ZONE && triggerPrevState !== APPROACH_ZONE && triggerPrevState !== "home" && (valeria.any_tracker_home !== true || confirmedAwayCycle);
    if (triggerState === "not_home" || (valeria.distance_m !== null && valeria.distance_m > 1000)) flow.set(VALERIA_NOTIFY_KEY, false);
    if (triggerState === "home") flow.set(VALERIA_AWAY_CYCLE_KEY, false);
    if (approachForNotification && flow.get(VALERIA_NOTIFY_KEY) !== true) {
        flow.set(VALERIA_NOTIFY_KEY, true);
        notification = { payload: { contract: "security.person-arrival-notification.v1", kind: "valeria_approach_notification", valeria_distance_m: valeria.distance_m } };
    }
}

let arrival = null;
if (isLocationEvent && sourcePosition) {
    const approachEntry = triggerState === APPROACH_ZONE && triggerPrevState !== APPROACH_ZONE && triggerPrevState !== "home" && sourcePosition.any_tracker_home !== true;
    const leavingHome = triggerPrevState === "home";
    const staleCatchUp = !approachEntry && sourcePosition.primary_home === true && typeof sourcePosition.primary_home_for_ms === "number" && sourcePosition.primary_home_for_ms > PRIMARY_HOME_GRACE_MS;
    if (!leavingHome && !staleCatchUp && (approachEntry || isArrivalHome(sourcePosition)) && armed[source]) {
        arrival = { payload: {
            contract: "security.arrival.v1", kind: "arrival", source, arriving: [source],
            arrival_source_type: "person", arrival_stage: approachEntry ? "approach" : "home",
        } };
    }
    if (!approachEntry && isArrivalHome(sourcePosition)) armed[source] = false;
}

if (!isLocationEvent) {
    for (const [name, item] of Object.entries(people)) {
        if (isArmingHome(item)) armed[name] = false;
    }
}
flow.set(ARMED_KEY, armed);

const distances = Object.values(people).map((item) => item.distance_m).filter((value) => value !== null);
const peopleContext = {
    gabriel, valeria,
    anyone_away: Object.values(people).some(isAway),
    nearest_distance_m: distances.length ? Math.min(...distances) : null,
    state_valid: gabriel.state_valid && valeria.state_valid,
    arrival_armed: { ...armed },
};
flow.set("people_context_v1", peopleContext);

msg.payload = {
    contract: "security.people-context.v1", kind: "people_context", context: peopleContext,
    source, trigger_entity: msg.payload?.trigger_entity, trigger_state: triggerState,
    trigger_prev_state: triggerPrevState,
    confirmed_home_transition: isLocationEvent && triggerState === "home" && triggerPrevState !== undefined && triggerPrevState !== "home",
    refresh_cycle_id: msg.payload?.refresh_cycle_id,
};
return [msg, arrival, notification];
`;

const cretaNormalize = String.raw`
const HOME_LAT = Number(env.get("HOME_LAT"));
const HOME_LON = Number(env.get("HOME_LON"));
const GATE_LAT = Number(env.get("GATE_LAT"));
const GATE_LON = Number(env.get("GATE_LON"));
const HOME_KNOWN = Number.isFinite(HOME_LAT) && Number.isFinite(HOME_LON);
const GATE_KNOWN = Number.isFinite(GATE_LAT) && Number.isFinite(GATE_LON);
const ARM_DISTANCE_M = 100;
const ARRIVAL_DISTANCE_M = 300;
const MAX_GPS_ACCURACY_M = 100;
const APPROACH_ZONE = "chegando";
const PRIMARY_HOME_GRACE_MS = 10 * 60 * 1000;
const ARMED_KEY = "creta_arrival_armed";
const IN_USE_KEY = "creta_in_use";

function distanceMeters(lat1, lon1, lat2, lon2) {
    const toRad = (value) => value * Math.PI / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
function reliableCoords(entity) {
    const attrs = entity?.attributes ?? {};
    const lat = Number(attrs.latitude);
    const lon = Number(attrs.longitude);
    const accuracy = Number(attrs.gps_accuracy);
    const hasCoords = Number.isFinite(lat) && Number.isFinite(lon);
    const hasAccuracy = Number.isFinite(accuracy);
    return hasCoords && (!hasAccuracy || accuracy <= MAX_GPS_ACCURACY_M) ? { lat, lon } : null;
}
function primaryHome(entity) {
    const coords = reliableCoords(entity);
    if (HOME_KNOWN && coords) return distanceMeters(HOME_LAT, HOME_LON, coords.lat, coords.lon) <= ARM_DISTANCE_M;
    const accuracy = Number(entity?.attributes?.gps_accuracy);
    if (Number.isFinite(accuracy) && accuracy > MAX_GPS_ACCURACY_M) return false;
    return entity?.state === "home";
}
function homeForMs(entity) {
    const changedAt = Date.parse(entity?.last_changed ?? "");
    return Number.isFinite(changedAt) ? Date.now() - changedAt : null;
}
function position(entity) {
    const attrs = entity?.attributes ?? {};
    const coords = reliableCoords(entity);
    const accuracy = Number(attrs.gps_accuracy);
    const state = entity?.state;
    const validState = typeof state === "string" && !["unknown", "unavailable", ""].includes(state);
    return {
        entity_id: entity?.entity_id, state,
        latitude: coords?.lat ?? null, longitude: coords?.lon ?? null,
        gps_accuracy: Number.isFinite(accuracy) ? accuracy : null,
        location_reliable: Boolean(coords),
        state_valid: validState && (Boolean(coords) || ["home", "not_home", APPROACH_ZONE].includes(state)),
        distance_m: HOME_KNOWN && coords ? Math.round(distanceMeters(HOME_LAT, HOME_LON, coords.lat, coords.lon)) : null,
        gate_distance_m: GATE_KNOWN && coords ? Math.round(distanceMeters(GATE_LAT, GATE_LON, coords.lat, coords.lon)) : null,
        primary_home: primaryHome(entity), primary_home_for_ms: homeForMs(entity),
    };
}
function isAway(item) {
    if (item?.distance_m !== null) return item.distance_m > ARM_DISTANCE_M;
    return item?.state === "not_home";
}
function isArmingHome(item) {
    if (item?.distance_m !== null) return item.distance_m <= ARM_DISTANCE_M;
    if (item?.gps_accuracy !== null && item.gps_accuracy > MAX_GPS_ACCURACY_M) return false;
    return item?.state === "home";
}
function isArrivalHome(item) {
    if (item?.gate_distance_m !== null && item.gate_distance_m <= ARRIVAL_DISTANCE_M) return true;
    if (item?.distance_m !== null) return item.distance_m <= ARRIVAL_DISTANCE_M;
    if (item?.gps_accuracy !== null && item.gps_accuracy > MAX_GPS_ACCURACY_M) return false;
    return item?.state === "home";
}

const creta = position(msg.payload?.creta);
const engineState = msg.payload?.creta_engine?.state;
const lockState = msg.payload?.creta_lock?.state;
const engineOn = engineState === "on";
const unlocked = lockState === "unlocked";
let inUse = flow.get(IN_USE_KEY) === true;
if (engineOn) inUse = true;
if (!engineOn && (unlocked || primaryHome(msg.payload?.creta))) inUse = false;
flow.set(IN_USE_KEY, inUse);

let armed = flow.get(ARMED_KEY) === true;
if (isAway(creta)) armed = true;
const isLocationEvent = msg.payload?.event === "location_update";
const triggerState = msg.payload?.trigger_state;
const triggerPrevState = msg.payload?.trigger_prev_state;
let arrival = null;
if (isLocationEvent) {
    const approachEntry = triggerState === APPROACH_ZONE && triggerPrevState !== APPROACH_ZONE && triggerPrevState !== "home";
    const leavingHome = triggerPrevState === "home";
    const staleCatchUp = !approachEntry && creta.primary_home === true && typeof creta.primary_home_for_ms === "number" && creta.primary_home_for_ms > PRIMARY_HOME_GRACE_MS;
    if (!leavingHome && !staleCatchUp && (approachEntry || isArrivalHome(creta)) && armed) {
        arrival = { payload: {
            contract: "security.arrival.v1", kind: "arrival", source: "creta", arriving: ["creta"],
            arrival_source_type: "creta", arrival_stage: approachEntry ? "approach" : "home",
            request_creta_wake: approachEntry,
        } };
    }
    if (!approachEntry && isArrivalHome(creta)) armed = false;
} else if (isArmingHome(creta)) {
    armed = false;
}
flow.set(ARMED_KEY, armed);

const vehicleContext = {
    location: creta,
    distance_home_m: creta.distance_m,
    home: isArrivalHome(creta), away: isAway(creta), approaching_home: arrival?.payload?.arrival_stage === "approach",
    arrived_home: arrival?.payload?.arrival_stage === "home",
    engine_on: engineOn, engine_state_valid: ["on", "off"].includes(engineState),
    lock_state: lockState, unlocked, lock_state_valid: ["locked", "unlocked"].includes(lockState),
    in_use: inUse, state_valid: creta.state_valid, arrival_armed: armed,
};
flow.set("creta_context_v1", vehicleContext);
msg.payload = {
    contract: "security.creta-context.v1", kind: "creta_context", context: vehicleContext,
    event: msg.payload?.event, reason: msg.payload?.reason, source: "creta",
    trigger_entity: msg.payload?.trigger_entity, trigger_state: triggerState, trigger_prev_state: triggerPrevState,
    confirmed_home_transition: isLocationEvent && triggerState === "home" && triggerPrevState !== undefined && triggerPrevState !== "home",
    refresh_cycle_id: msg.payload?.refresh_cycle_id,
};
return [msg, arrival];
`;

const peopleRefresh = String.raw`
const peopleContext = flow.get("people_context_v1");
if (!peopleContext || msg.payload?.kind !== "refresh_command") return null;
const anyoneAway = msg.payload.anyone_away === true;
const interval = peopleContext.nearest_distance_m !== null && peopleContext.nearest_distance_m <= 2000 ? 30 * 1000 : 60 * 1000;
const last = flow.get("people_last_refresh_ts") ?? 0;
if (!anyoneAway || Date.now() - last < interval) return null;
// Mantem o comportamento anterior: o timestamp e otimista; falha custa no maximo um ciclo.
flow.set("people_last_refresh_ts", Date.now());
return msg;
`;

const cretaRefresh = String.raw`
const vehicleContext = flow.get("creta_context_v1");
if (!vehicleContext || msg.payload?.kind !== "refresh_command") return null;
const INTERVAL_MS = 15 * 60 * 1000;
const hour = new Date().getHours();
const enabled = msg.payload.anyone_away === true || (hour >= 7 && hour < 22);
const last = flow.get("creta_last_force_refresh_ts") ?? 0;
return enabled && Date.now() - last >= INTERVAL_MS ? [msg, msg] : null;
`;

const contextCoordinator = String.raw`
const kind = msg.payload?.kind;
if (kind === "refresh_tick") {
    const cycle = (flow.get("refresh_cycle_seq") ?? 0) + 1;
    flow.set("refresh_cycle_seq", cycle);
    flow.set("refresh_pending", { cycle, people: false, creta: false, emitted: false });
    msg.payload = { contract: "security.snapshot-request.v1", kind: "snapshot_request", refresh_cycle_id: cycle };
    return [msg, null, null];
}
if (kind === "people_context" || kind === "creta_context") {
    const domain = kind === "people_context" ? "people" : "creta";
    flow.set(domain + "_context_v1", msg.payload.context);
    const pending = flow.get("refresh_pending");
    if (pending && msg.payload.refresh_cycle_id === pending.cycle) {
        pending[domain] = true;
        if (pending.people && pending.creta && !pending.emitted) {
            pending.emitted = true;
            flow.set("refresh_pending", pending);
            const people = flow.get("people_context_v1");
            const creta = flow.get("creta_context_v1");
            return [null, { payload: {
                contract: "security.refresh-command.v1", kind: "refresh_command",
                refresh_cycle_id: pending.cycle,
                anyone_away: people?.anyone_away === true || creta?.away === true,
            } }, null];
        }
        flow.set("refresh_pending", pending);
    }
    return null;
}
if (kind === "valeria_approach_notification") {
    const creta = flow.get("creta_context_v1");
    const byCar = creta?.arrival_armed === true && creta?.distance_home_m !== null && creta.distance_home_m <= 1500;
    msg.payload.by_car = byCar;
    msg.payload.creta_distance_m = creta?.distance_home_m ?? null;
    msg.payload.message = byCar ? "Valéria está chegando de carro." : "Valéria está chegando.";
    return [null, null, msg];
}
return null;
`;

const lightMergeContext = String.raw`
const kind = msg.payload?.kind;
if (kind === "people_context") flow.set("people_context_v1", msg.payload.context);
if (kind === "creta_context") flow.set("creta_context_v1", msg.payload.context);
if (kind === "sun_context") flow.set("sun_below_horizon", msg.payload.sun_below_horizon === true);
const creta = flow.get("creta_context_v1") ?? {};
msg.payload = {
    event: msg.payload?.event ?? "context_update",
    reason: msg.payload?.reason,
    source: msg.payload?.source,
    trigger_state: msg.payload?.trigger_state,
    trigger_prev_state: msg.payload?.trigger_prev_state,
    confirmed_home_transition: msg.payload?.confirmed_home_transition === true,
    creta_engine_on: creta.engine_on === true,
    creta_unlocked: creta.unlocked === true,
    creta_in_use: creta.in_use === true,
    active: flow.get("refletor_portao_carros_active_by_arrival") === true,
};
return msg;
`;

const lightPrepareArrival = String.raw`
if (msg.payload?.kind !== "arrival") return null;
const creta = flow.get("creta_context_v1") ?? {};
msg.payload.sun_below_horizon = flow.get("sun_below_horizon") === true;
msg.payload.creta_in_use = creta.in_use === true;
msg.payload.creta_engine_on = creta.engine_on === true;
msg.payload.active = flow.get("refletor_portao_carros_active_by_arrival") === true;
return msg;
`;

const lightGate = String.raw`
if (msg.payload?.creta_in_use !== true) return null;
const suppressedUntil = flow.get("refletor_suppressed_until") ?? 0;
if (Date.now() < suppressedUntil) return null;
msg.payload.creta_gate = msg.payload.creta_engine_on === true ? "engine_on" : "creta_in_use_latched";
return msg;
`;

const lightEvaluateOff = String.raw`
const ARRIVAL_OFF_GRACE_MS = 90 * 1000;
if (msg.payload?.active !== true) return null;
const vehicleEventCanStop = msg.payload.event === "turn_off" || msg.payload.event === "location_update";
if (vehicleEventCanStop && msg.payload.creta_engine_on === false && msg.payload.creta_unlocked === true) {
    msg.payload.off_reason = "creta_desligado_e_destravado";
    return [msg, null];
}
if (msg.payload.confirmed_home_transition !== true) return null;
msg.payload.off_reason = "chegada_confirmada_" + (msg.payload.source ?? "?");
const activatedAt = flow.get("refletor_activated_at");
const elapsed = typeof activatedAt === "number" ? Date.now() - activatedAt : ARRIVAL_OFF_GRACE_MS;
msg.delay = Math.max(0, ARRIVAL_OFF_GRACE_MS - elapsed);
return [null, msg];
`;

const replacedTabs = new Set([SECURITY_TAB, PEOPLE_TAB, CRETA_TAB, CONTEXT_TAB]);
const remaining = flows.filter((node) => !replacedTabs.has(node.id) && !replacedTabs.has(node.z));
const alarmArrival = remaining.find((node) => node.id === "alarm_arrival_in");
const alarmArrivalComment = remaining.find((node) => node.id === "alarm_arrival_comment");
if (alarmArrivalComment) {
  alarmArrivalComment.info = "A chegada vem dos contratos security.arrival.v1 publicados por localizacao_pessoas e contexto_creta. Esses domínios validam zona, direção, distância, precisão e trackers congelados; o desarme só é solicitado após confirmação no Home Assistant.";
}

const nodes = [];

// localizacao_pessoas
nodes.push(tab(PEOPLE_TAB, "localizacao_pessoas", "Normaliza os trackers dos iPhones, detecta chegada de pessoas e publica security.people-context.v1."));
nodes.push(group("grp_people_events", PEOPLE_TAB, "1. Eventos dos iPhones", ["people_comment", "people_gabriel_event", "people_valeria_event", "people_snapshot_in", "people_snapshot"], 34, 59, 382, 302, "#3f7cb5"));
nodes.push(group("grp_people_context", PEOPLE_TAB, "2. Normalização, presença e chegada", ["people_normalize", "people_context_out", "people_arrival_out", "people_notify_candidate_out"], 454, 99, 702, 222, "#7d6ba8"));
nodes.push(group("grp_people_refresh", PEOPLE_TAB, "3. Refresh adaptativo dos iPhones", ["people_refresh_in", "people_refresh_decide", "people_refresh_gabriel", "people_refresh_valeria", "people_creta_sync_in", "people_update_entities"], 34, 419, 922, 242, "#4d9a6a"));
nodes.push(comment("people_comment", PEOPLE_TAB, "grp_people_events", "Contrato: GPS bruto entra; contexto normalizado sai", "Estados unknown/unavailable nunca viram chegada. HOME_LAT/HOME_LON e GATE_LAT/GATE_LON vêm do ambiente; sem coordenadas, usa-se o estado de zona como fallback.", 210, 100, 330));
nodes.push(clone("sec_gabriel_location_changed", { id: "people_gabriel_event", z: PEOPLE_TAB, g: "grp_people_events", name: "iPhone Gabriel mudou de zona", outputProperties: [{ property: "payload", propertyType: "msg", value: rawEvent("gabriel"), valueType: "jsonata" }], x: 210, y: 180, wires: [["people_normalize"]] }));
nodes.push(clone("sec_valeria_location_changed", { id: "people_valeria_event", z: PEOPLE_TAB, g: "grp_people_events", name: "iPhone Valéria mudou de zona", outputProperties: [{ property: "payload", propertyType: "msg", value: rawEvent("valeria"), valueType: "jsonata" }], x: 210, y: 240, wires: [["people_normalize"]] }));
nodes.push(linkIn("people_snapshot_in", PEOPLE_TAB, "grp_people_events", "Solicitar snapshot de pessoas", ["context_snapshot_request_out"], 95, 300, [["people_snapshot"]]));
nodes.push(clone("sec_refresh_context_snapshot", { id: "people_snapshot", z: PEOPLE_TAB, g: "grp_people_events", name: "Ler trackers de Gabriel e Valéria", entity_id: "device_tracker.iphone_de_gabriel_furlan", outputProperties: [{ property: "payload", propertyType: "msg", value: `(\n  {\n    "event": "context_snapshot",\n    "source": "refresh",\n    "refresh_cycle_id": payload.refresh_cycle_id,\n    "gabriel": $entities("device_tracker.iphone_de_gabriel_furlan"),\n    "gabriel_icloud": $entities("device_tracker.iphonegabrielfurlan"),\n    "valeria": $entities("device_tracker.iphone_de_valeria"),\n    "valeria_icloud": $entities("device_tracker.iphone_de_valeria_2")\n  }\n)`, valueType: "jsonata" }], x: 270, y: 300, wires: [["people_normalize"]] }));
nodes.push(functionNode("people_normalize", PEOPLE_TAB, "grp_people_context", "Normalizar pessoas e detectar transições", peopleNormalize, 3, 650, 200, [["people_context_out"], ["people_arrival_out"], ["people_notify_candidate_out"]]));
nodes.push(linkOut("people_context_out", PEOPLE_TAB, "grp_people_context", "Publicar contexto de pessoas v1", ["context_people_in", "light_people_context_in"], 1085, 160));
nodes.push(linkOut("people_arrival_out", PEOPLE_TAB, "grp_people_context", "Publicar chegada de pessoa v1", ["light_arrival_in", "alarm_arrival_in"], 1085, 220));
nodes.push(linkOut("people_notify_candidate_out", PEOPLE_TAB, "grp_people_context", "Publicar candidato de aviso da Valéria", ["context_person_event_in"], 1085, 280));
nodes.push(linkIn("people_refresh_in", PEOPLE_TAB, "grp_people_refresh", "Política conjunta de refresh", ["context_refresh_command_out"], 95, 490, [["people_refresh_decide"]]));
nodes.push(functionNode("people_refresh_decide", PEOPLE_TAB, "grp_people_refresh", "Atualizar iPhones agora?", peopleRefresh, 1, 280, 490, [["people_refresh_gabriel", "people_refresh_valeria"]]));
nodes.push(clone("sec_request_gabriel_location", { id: "people_refresh_gabriel", z: PEOPLE_TAB, g: "grp_people_refresh", name: "Solicitar localização do iPhone Gabriel", x: 650, y: 460, wires: [[]] }));
nodes.push(clone("sec_request_valeria_location", { id: "people_refresh_valeria", z: PEOPLE_TAB, g: "grp_people_refresh", name: "Solicitar localização do iPhone Valéria", x: 650, y: 520, wires: [[]] }));
nodes.push(linkIn("people_creta_sync_in", PEOPLE_TAB, "grp_people_refresh", "Sincronizar trackers após refresh do Creta", ["creta_refresh_people_sync_out"], 180, 600, [["people_update_entities"]]));
nodes.push(clone("sec_refresh_creta_entities", { id: "people_update_entities", z: PEOPLE_TAB, g: "grp_people_refresh", name: "Atualizar entidades dos iPhones", data: `{"entity_id":["device_tracker.iphone_de_gabriel_furlan","device_tracker.iphone_de_valeria"]}`, x: 650, y: 600, wires: [[]] }));

// contexto_creta
nodes.push(tab(CRETA_TAB, "contexto_creta", "Normaliza estado/localização do Creta, mantém creta_in_use, detecta chegada e controla refresh/viagens."));
nodes.push(group("grp_creta_events", CRETA_TAB, "1. Eventos e snapshot do Creta", ["creta_comment", "creta_location_event", "creta_lock_event", "creta_engine_off_event", "creta_unlock_event", "creta_snapshot_in", "creta_snapshot"], 34, 59, 442, 422, "#3f7cb5"));
nodes.push(group("grp_creta_context", CRETA_TAB, "2. Estado do veículo, viagem e chegada", ["creta_normalize", "creta_context_out", "creta_arrival_out", "creta_arrival_actions_out"], 514, 99, 682, 282, "#7d6ba8"));
nodes.push(group("grp_creta_actions", CRETA_TAB, "3. Refresh do veículo e viagens", ["creta_refresh_in", "creta_refresh_decide", "creta_refresh_people_sync_out", "creta_arrival_actions_in", "creta_arrival_actions", "creta_force_refresh", "creta_refresh_ack", "creta_update_entities", "creta_trip_refresh"], 34, 539, 1122, 282, "#4d9a6a"));
nodes.push(comment("creta_comment", CRETA_TAB, "grp_creta_events", "Contrato: entidades do veículo entram; contexto Creta v1 sai", "creta_in_use é uma trava de domínio: liga quando o motor é visto ligado e só solta com motor desligado mais carro em casa ou porta destravada.", 240, 100, 380));
nodes.push(clone("sec_creta_location_changed", { id: "creta_location_event", z: CRETA_TAB, g: "grp_creta_events", name: "Creta mudou de zona", outputProperties: [{ property: "payload", propertyType: "msg", value: rawEvent("creta"), valueType: "jsonata" }], x: 230, y: 180, wires: [["creta_normalize"]] }));
nodes.push(clone("sec_creta_lock_context_changed", { id: "creta_lock_event", z: CRETA_TAB, g: "grp_creta_events", name: "Estado da trava do Creta mudou", outputProperties: [{ property: "payload", propertyType: "msg", value: `(\n  {"event":"context_update","source":"creta","creta":$entities("device_tracker.creta_location"),"creta_engine":$entities("binary_sensor.creta_engine"),"creta_lock":$entities("lock.creta_door_lock")}\n)`, valueType: "jsonata" }], x: 230, y: 240, wires: [["creta_normalize"]] }));
nodes.push(clone("sec_engine_off_changed", { id: "creta_engine_off_event", z: CRETA_TAB, g: "grp_creta_events", name: "Motor desligado por 5 s", outputProperties: [{ property: "payload", propertyType: "msg", value: `(\n  {"event":"turn_off","reason":"creta_engine_off","source":"creta","creta":$entities("device_tracker.creta_location"),"creta_engine":$entities("binary_sensor.creta_engine"),"creta_lock":$entities("lock.creta_door_lock")}\n)`, valueType: "jsonata" }], x: 230, y: 300, wires: [["creta_normalize"]] }));
nodes.push(clone("sec_creta_locked_changed", { id: "creta_unlock_event", z: CRETA_TAB, g: "grp_creta_events", name: "Porta destravada por 5 s", outputProperties: [{ property: "payload", propertyType: "msg", value: `(\n  {"event":"turn_off","reason":"creta_unlocked","source":"creta","creta":$entities("device_tracker.creta_location"),"creta_engine":$entities("binary_sensor.creta_engine"),"creta_lock":$entities("lock.creta_door_lock")}\n)`, valueType: "jsonata" }], x: 230, y: 360, wires: [["creta_normalize"]] }));
nodes.push(linkIn("creta_snapshot_in", CRETA_TAB, "grp_creta_events", "Solicitar snapshot do Creta", ["context_snapshot_request_out"], 95, 420, [["creta_snapshot"]]));
nodes.push(clone("sec_refresh_context_snapshot", { id: "creta_snapshot", z: CRETA_TAB, g: "grp_creta_events", name: "Ler localização, motor e trava", entity_id: "device_tracker.creta_location", outputProperties: [{ property: "payload", propertyType: "msg", value: `(\n  {"event":"context_snapshot","source":"refresh","refresh_cycle_id":payload.refresh_cycle_id,"creta":$entities("device_tracker.creta_location"),"creta_engine":$entities("binary_sensor.creta_engine"),"creta_lock":$entities("lock.creta_door_lock")}\n)`, valueType: "jsonata" }], x: 290, y: 420, wires: [["creta_normalize"]] }));
nodes.push(functionNode("creta_normalize", CRETA_TAB, "grp_creta_context", "Normalizar Creta e detectar transições", cretaNormalize, 2, 700, 220, [["creta_context_out"], ["creta_arrival_out", "creta_arrival_actions_out"]]));
nodes.push(linkOut("creta_context_out", CRETA_TAB, "grp_creta_context", "Publicar contexto do Creta v1", ["context_creta_in", "light_creta_context_in"], 1125, 160));
nodes.push(linkOut("creta_arrival_out", CRETA_TAB, "grp_creta_context", "Publicar chegada do Creta v1", ["light_arrival_in", "alarm_arrival_in"], 1125, 220));
nodes.push(linkOut("creta_arrival_actions_out", CRETA_TAB, "grp_creta_context", "Chegada -> ações do veículo", ["creta_arrival_actions_in"], 1125, 300));
nodes.push(linkIn("creta_refresh_in", CRETA_TAB, "grp_creta_actions", "Política conjunta de refresh", ["context_refresh_command_out"], 95, 640, [["creta_refresh_decide"]]));
nodes.push(functionNode("creta_refresh_decide", CRETA_TAB, "grp_creta_actions", "Forçar refresh do Creta agora?", cretaRefresh, 2, 300, 640, [["creta_force_refresh", "creta_update_entities"], ["creta_refresh_people_sync_out"]]));
nodes.push(linkOut("creta_refresh_people_sync_out", CRETA_TAB, "grp_creta_actions", "Refresh Creta -> sincronizar trackers", ["people_creta_sync_in"], 520, 660));
nodes.push(linkIn("creta_arrival_actions_in", CRETA_TAB, "grp_creta_actions", "Receber chegada para ações", ["creta_arrival_actions_out"], 95, 760, [["creta_arrival_actions"]]));
nodes.push(functionNode("creta_arrival_actions", CRETA_TAB, "grp_creta_actions", "Acordar carro e fechar viagem", `const wake = msg.payload?.request_creta_wake === true ? msg : null;\nreturn [wake, msg];`, 2, 300, 760, [["creta_force_refresh"], ["creta_trip_refresh"]]));
nodes.push(clone("sec_force_refresh_creta", { id: "creta_force_refresh", z: CRETA_TAB, g: "grp_creta_actions", name: "Forçar refresh do Creta", x: 600, y: 600, wires: [["creta_refresh_ack"]] }));
nodes.push(functionNode("creta_refresh_ack", CRETA_TAB, "grp_creta_actions", "Confirmar refresh bem-sucedido", `flow.set("creta_last_force_refresh_ts", Date.now());\nreturn null;`, 1, 900, 600, [[]]));
nodes.push(clone("sec_refresh_creta_entities", { id: "creta_update_entities", z: CRETA_TAB, g: "grp_creta_actions", name: "Atualizar entidades do Creta", data: `{"entity_id":["device_tracker.creta_location","binary_sensor.creta_engine","lock.creta_door_lock"]}`, x: 600, y: 700, wires: [[]] }));
nodes.push(clone("sec_refresh_creta_trip_info", { id: "creta_trip_refresh", z: CRETA_TAB, g: "grp_creta_actions", name: "Atualizar viagens do dia após chegada", x: 650, y: 780, wires: [[]] }));

// contexto_chegadas
nodes.push(tab(CONTEXT_TAB, "contexto_chegadas", "Coordena snapshots e política conjunta sem interpretar GPS; enriquece apenas o aviso da Valéria."));
nodes.push(group("grp_context_tick", CONTEXT_TAB, "1. Ciclo periódico", ["context_comment", "context_tick", "context_coordinator", "context_snapshot_request_out"], 34, 59, 862, 222, "#3f7cb5"));
nodes.push(group("grp_context_inputs", CONTEXT_TAB, "2. Contratos de domínio", ["context_people_in", "context_creta_in", "context_person_event_in"], 34, 339, 362, 222, "#7d6ba8"));
nodes.push(group("grp_context_outputs", CONTEXT_TAB, "3. Comandos e notificações", ["context_refresh_command_out", "context_notify_valeria", "context_test_notification"], 674, 339, 482, 222, "#4d9a6a"));
nodes.push(comment("context_comment", CONTEXT_TAB, "grp_context_tick", "Orquestração sem GPS bruto", "O ciclo espera os dois snapshots do mesmo refresh_cycle_id. Só então calcula anyone_away e publica um comando; cada domínio mantém seu próprio cooldown.", 230, 100, 390));
nodes.push(clone("sec_refresh_every_10min", { id: "context_tick", z: CONTEXT_TAB, g: "grp_context_tick", name: "Reavaliar contextos a cada 30 s", topic: "security_context_refresh", payload: `{"kind":"refresh_tick"}`, payloadType: "json", x: 230, y: 200, wires: [["context_coordinator"]] }));
nodes.push(functionNode("context_coordinator", CONTEXT_TAB, "grp_context_tick", "Coordenar snapshot e refresh", contextCoordinator, 3, 500, 200, [["context_snapshot_request_out"], ["context_refresh_command_out"], ["context_notify_valeria"]]));
nodes.push(linkOut("context_snapshot_request_out", CONTEXT_TAB, "grp_context_tick", "Solicitar snapshots dos domínios", ["people_snapshot_in", "creta_snapshot_in"], 800, 200));
nodes.push(linkIn("context_people_in", CONTEXT_TAB, "grp_context_inputs", "Receber contexto de pessoas v1", ["people_context_out"], 180, 400, [["context_coordinator"]]));
nodes.push(linkIn("context_creta_in", CONTEXT_TAB, "grp_context_inputs", "Receber contexto do Creta v1", ["creta_context_out"], 180, 460, [["context_coordinator"]]));
nodes.push(linkIn("context_person_event_in", CONTEXT_TAB, "grp_context_inputs", "Receber candidato de aviso da Valéria", ["people_notify_candidate_out"], 180, 520, [["context_coordinator"]]));
nodes.push(linkOut("context_refresh_command_out", CONTEXT_TAB, "grp_context_outputs", "Publicar política conjunta de refresh", ["people_refresh_in", "creta_refresh_in"], 900, 400));
nodes.push(clone("sec_notify_valeria_approaching", { id: "context_notify_valeria", z: CONTEXT_TAB, g: "grp_context_outputs", name: "Avisar Gabriel: Valéria se aproxima", x: 850, y: 480, wires: [[]] }));
nodes.push(clone("249963a6cd6c247a", { id: "context_test_notification", z: CONTEXT_TAB, g: "grp_context_outputs", name: "Teste manual: aviso de aproximação", payload: `{"message":"Teste manual: Valéria está chegando."}`, x: 820, y: 540, wires: [["context_notify_valeria"]] }));

// iluminacao_seguranca simplificada
nodes.push(tab(SECURITY_TAB, "iluminacao_seguranca", "Orquestra exclusivamente a decisão e o ciclo de vida do refletor a partir de contratos de alto nível."));
nodes.push(group("grp_light_inputs", SECURITY_TAB, "1. Contextos e eventos de alto nível", ["light_comment", "light_people_context_in", "light_creta_context_in", "light_arrival_in", "light_sun_event"], 34, 59, 402, 342, "#3f7cb5"));
nodes.push(group("grp_light_decision", SECURITY_TAB, "2. Atualizar estado e decidir", ["light_merge_context", "light_prepare_arrival", "light_check_dark", "light_check_creta_in_use", "light_check_inactive"], 474, 99, 1002, 242, "#7d6ba8"));
nodes.push(group("grp_light_on", SECURITY_TAB, "3. Ligar, notificar e proteger por timeout", ["light_mark_active", "light_turn_on", "light_notify_on", "light_auto_off", "light_timeout", "light_timeout_route_out", "light_manual_action_in"], 1514, 59, 922, 342, "#4d9a6a"));
nodes.push(group("grp_light_off", SECURITY_TAB, "4. Cinco condições independentes de desligamento", ["light_timeout_route_in", "light_evaluate_off", "light_off_grace", "light_turn_off_if_active", "light_turn_off"], 474, 459, 1282, 202, "#c27c4c"));
nodes.push(group("grp_light_tests", SECURITY_TAB, "5. Testes manuais", ["light_manual_test", "light_manual_action_out"], 1834, 499, 522, 122, "#777777"));
nodes.push(comment("light_comment", SECURITY_TAB, "grp_light_inputs", "Contrato da iluminação", "Esta aba não lê GPS, trackers, motor ou trava diretamente. Ela consome security.people-context.v1, security.creta-context.v1 e security.arrival.v1.", 230, 100, 340));
nodes.push(linkIn("light_people_context_in", SECURITY_TAB, "grp_light_inputs", "Contexto de pessoas v1", ["people_context_out"], 95, 200, [["light_merge_context"]]));
nodes.push(linkIn("light_creta_context_in", SECURITY_TAB, "grp_light_inputs", "Contexto do Creta v1", ["creta_context_out"], 95, 260, [["light_merge_context"]]));
nodes.push(linkIn("light_arrival_in", SECURITY_TAB, "grp_light_inputs", "Chegada processada v1", ["people_arrival_out", "creta_arrival_out"], 95, 320, [["light_prepare_arrival"]]));
nodes.push(clone("sec_sun_changed", { id: "light_sun_event", z: SECURITY_TAB, g: "grp_light_inputs", name: "Luminosidade mudou", outputInitially: true, outputProperties: [{ property: "payload", propertyType: "msg", value: `(\n  {"contract":"security.sun-context.v1","kind":"sun_context","sun_below_horizon":$entity().state="below_horizon","source":"sun"}\n)`, valueType: "jsonata" }], x: 220, y: 380, wires: [["light_merge_context"]] }));
nodes.push(functionNode("light_merge_context", SECURITY_TAB, "grp_light_decision", "Atualizar contexto de alto nível", lightMergeContext, 1, 560, 180, [["light_evaluate_off"]]));
nodes.push(functionNode("light_prepare_arrival", SECURITY_TAB, "grp_light_decision", "Montar decisão de acendimento", lightPrepareArrival, 1, 560, 280, [["light_check_dark"]]));
nodes.push(clone("sec_check_dark", { id: "light_check_dark", z: SECURITY_TAB, g: "grp_light_decision", name: "Ambiente está escuro?", x: 800, y: 280, wires: [["light_check_creta_in_use"]] }));
nodes.push(functionNode("light_check_creta_in_use", SECURITY_TAB, "grp_light_decision", "Creta está em uso?", lightGate, 1, 1040, 280, [["light_check_inactive"]]));
nodes.push(clone("sec_check_reflector_inactive", { id: "light_check_inactive", z: SECURITY_TAB, g: "grp_light_decision", name: "Refletor está inativo?", x: 1320, y: 280, wires: [["light_mark_active"]] }));
nodes.push(clone("sec_mark_reflector_active", { id: "light_mark_active", z: SECURITY_TAB, g: "grp_light_on", name: "Marcar refletor ativo por chegada", x: 1700, y: 200, wires: [["light_turn_on", "light_auto_off", "light_notify_on"]] }));
nodes.push(clone("sec_reflector_turn_on", { id: "light_turn_on", z: SECURITY_TAB, g: "grp_light_on", name: "Ligar refletor do portão", x: 2050, y: 120, wires: [[]] }));
nodes.push(clone("29a4e3c0935e2805", { id: "light_notify_on", z: SECURITY_TAB, g: "grp_light_on", name: "Avisar moradores: refletor ligado", x: 2050, y: 200, wires: [[]] }));
nodes.push(clone("sec_auto_off_delay", { id: "light_auto_off", z: SECURITY_TAB, g: "grp_light_on", name: "Aguardar backstop de 15 min", x: 2050, y: 280, wires: [["light_timeout"]] }));
nodes.push(clone("sec_auto_off_event", { id: "light_timeout", z: SECURITY_TAB, g: "grp_light_on", name: "Solicitar desligamento por timeout", x: 2050, y: 360, wires: [["light_timeout_route_out"]] }));
nodes.push(linkOut("light_timeout_route_out", SECURITY_TAB, "grp_light_on", "Timeout -> desligamento", ["light_timeout_route_in"], 2350, 360));
nodes.push(linkIn("light_manual_action_in", SECURITY_TAB, "grp_light_on", "Receber teste manual", ["light_manual_action_out"], 1850, 80, [["light_turn_on", "light_notify_on"]]));
nodes.push(linkIn("light_timeout_route_in", SECURITY_TAB, "grp_light_off", "Receber timeout de 15 min", ["light_timeout_route_out"], 650, 500, [["light_turn_off_if_active"]]));
nodes.push(functionNode("light_evaluate_off", SECURITY_TAB, "grp_light_off", "Alguma condição de desligamento ocorreu?", lightEvaluateOff, 2, 620, 580, [["light_turn_off_if_active"], ["light_off_grace"]]));
nodes.push(clone("sec_arrival_off_grace", { id: "light_off_grace", z: SECURITY_TAB, g: "grp_light_off", name: "Respeitar carência de 90 s", x: 850, y: 620, wires: [["light_turn_off_if_active"]] }));
nodes.push(clone("sec_turn_off_if_active", { id: "light_turn_off_if_active", z: SECURITY_TAB, g: "grp_light_off", name: "Desativar somente se foi ligado por chegada", x: 1100, y: 560, wires: [["light_turn_off"]] }));
nodes.push(clone("sec_reflector_turn_off", { id: "light_turn_off", z: SECURITY_TAB, g: "grp_light_off", name: "Desligar refletor do portão", x: 1450, y: 560, wires: [[]] }));
nodes.push(clone("965afc02b5d9e809", { id: "light_manual_test", z: SECURITY_TAB, g: "grp_light_tests", name: "Teste manual: ligar refletor e avisar", x: 2000, y: 560, wires: [["light_manual_action_out"]] }));
nodes.push(linkOut("light_manual_action_out", SECURITY_TAB, "grp_light_tests", "Teste -> ações do refletor", ["light_manual_action_in"], 2280, 560));

// O link de chegada do alarme precisa listar os novos produtores.
if (alarmArrival) alarmArrival.links = ["people_arrival_out", "creta_arrival_out"];

const result = [...remaining, ...nodes];
const ids = new Set();
for (const node of result) {
  if (ids.has(node.id)) throw new Error(`ID duplicado: ${node.id}`);
  ids.add(node.id);
}
fs.writeFileSync(flowUrl, `${JSON.stringify(result, null, 4)}\n`);
console.log("Flows de segurança separados em pessoas, Creta, contexto e iluminação.");
