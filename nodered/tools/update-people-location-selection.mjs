#!/usr/bin/env node

import fs from "node:fs";

const flowPath = new URL("../flows.json", import.meta.url);
const outputPath = process.env.NODE_RED_FLOW_OUTPUT
  ? new URL(`file://${process.env.NODE_RED_FLOW_OUTPUT}`)
  : flowPath;
const flows = JSON.parse(fs.readFileSync(flowPath, "utf8"));

const PEOPLE_TAB = "ea0a6aa0d24ff863";
const VEHICLE_TAB = "c22d8b12055e87f7";
const LIGHT_TAB = "6b7552efb85343f4";
const MQTT_BROKER = flows.find((node) => node.type === "mqtt-broker")?.id;

if (!MQTT_BROKER) throw new Error("Broker MQTT do Node-RED não encontrado");

function requiredByName(name) {
  const node = flows.find((candidate) => candidate.name === name);
  if (!node) throw new Error(`Nó obrigatório ausente: ${name}`);
  return node;
}

function requiredById(id) {
  const node = flows.find((candidate) => candidate.id === id);
  if (!node) throw new Error(`Nó obrigatório ausente: ${id}`);
  return node;
}

function removeIds(ids) {
  const wanted = new Set(ids);
  for (let index = flows.length - 1; index >= 0; index -= 1) {
    if (wanted.has(flows[index].id)) flows.splice(index, 1);
  }
}

function replaceRequired(source, pattern, replacement, label) {
  if (typeof pattern === "string") {
    if (!source.includes(pattern)) {
      if (source.includes(replacement)) return source;
      throw new Error(`Trecho ausente ao atualizar ${label}`);
    }
    return source.replace(pattern, replacement);
  }
  if (!pattern.test(source)) {
    if (typeof replacement === "string" && source.includes(replacement)) return source;
    throw new Error(`Trecho ausente ao atualizar ${label}`);
  }
  return source.replace(pattern, replacement);
}

function group(id, z, name, nodes, x, y, w, h, colors = {}) {
  return {
    id,
    type: "group",
    z,
    name,
    style: {
      label: true,
      "label-position": "nw",
      stroke: colors.stroke ?? "#5ca5d8",
      "stroke-opacity": "1",
      fill: colors.fill ?? "#d9edf7",
      "fill-opacity": "0.35",
      color: colors.color ?? "#1d4f72",
    },
    nodes,
    x,
    y,
    w,
    h,
  };
}

function functionNode(id, z, g, name, func, outputs, x, y, wires) {
  return {
    id,
    type: "function",
    z,
    g,
    name,
    func,
    outputs,
    timeout: 0,
    noerr: 0,
    initialize: "",
    finalize: "",
    libs: [],
    x,
    y,
    wires,
  };
}

function moveGroupTo(groupNode, x, y = groupNode.y) {
  const dx = x - groupNode.x;
  const dy = y - groupNode.y;
  for (const id of groupNode.nodes ?? []) {
    const node = flows.find((candidate) => candidate.id === id);
    if (node && Number.isFinite(node.x) && Number.isFinite(node.y)) {
      node.x += dx;
      node.y += dy;
    }
  }
  groupNode.x = x;
  groupNode.y = y;
}

function inject(id, g, name, topic, payload, x, y) {
  return {
    id,
    type: "inject",
    z: PEOPLE_TAB,
    g,
    name,
    props: [{ p: "payload" }, { p: "topic", vt: "str" }],
    repeat: "",
    crontab: "",
    once: true,
    onceDelay: "0.5",
    topic,
    payload: String(payload),
    payloadType: "num",
    x,
    y,
    wires: [["people_location_policy_apply_v1"]],
  };
}

const generatedIds = [
  "people_arrival_distance_group_v1",
  "people_arrival_distance_comment_v1",
  "people_arrival_distance_set_v1",
  "people_arrival_distance_apply_v1",
  "people_location_policy_group_v1",
  "people_location_policy_help_v1",
  "people_location_arrival_distance_v1",
  "people_location_near_home_radius_v1",
  "people_location_home_radius_v1",
  "people_location_fast_refresh_radius_v1",
  "people_location_fresh_minutes_v1",
  "people_location_source_report_minutes_v1",
  "people_location_recency_tie_seconds_v1",
  "people_location_accuracy_v1",
  "people_location_vehicle_fresh_minutes_v1",
  "people_location_movement_threshold_v1",
  "people_location_arm_distance_v1",
  "people_location_recovery_minutes_v1",
  "people_location_values_route_out_v1",
  "people_location_values_route_middle_out_v1",
  "people_location_values_route_right_out_v1",
  "people_location_values_route_in_v1",
  "people_location_policy_apply_v1",
  "people_location_policy_out_v1",
  "people_location_selection_group_v1",
  "people_location_selection_help_v1",
  "people_location_observation_v1",
  "people_location_select_v1",
  "people_location_classify_near_home_v1",
  "people_location_to_normalizer_out_v1",
  "people_location_to_normalizer_in_v1",
  "people_location_notification_out_v1",
  "people_location_publish_state_v1",
  "people_location_mqtt_state_v1",
  "people_location_discovery_start_v1",
  "people_location_policy_publish_in_v1",
  "people_location_build_discovery_v1",
  "people_location_mqtt_discovery_v1",
  "people_arrival_direction_note_v1",
  "people_arrival_departure_blocked_v1",
  "people_departure_approach_test_v1",
  "people_departure_bounce_home_test_v1",
  "vehicle_primary_arrival_direction_note_v1",
  "vehicle_primary_arrival_departure_blocked_v1",
  "vehicle_primary_classify_near_home_v1",
  "vehicle_primary_manual_blocked_route_out_v1",
  "vehicle_primary_manual_blocked_route_in_v1",
  "vehicle_primary_post_refresh_route_out_v1",
  "vehicle_primary_post_refresh_route_in_v1",
  "vehicle_location_panel_group_v1",
  "vehicle_location_policy_in_v1",
  "vehicle_location_policy_status_v1",
  "vehicle_location_panel_in_v1",
  "vehicle_location_panel_publish_v1",
  "vehicle_location_panel_mqtt_v1",
  "light_location_policy_group_v1",
  "light_location_policy_in_v1",
  "light_location_policy_status_v1",
  "light_arrival_replay_route_out_v1",
  "light_arrival_replay_gate_in_v1",
  "light_arrival_replay_debug_in_v1",
  "light_off_decision_route_out_v1",
  "light_off_decision_route_in_v1",
];
removeIds(generatedIds);

const policyApply = String.raw`const KEY = "location_policy_v1";
const PERSISTENT = "persistent";
const limits = {
    near_home_radius_m: { min: 50, max: 1500, integer: true },
    home_radius_m: { min: 20, max: 500, integer: true },
    people_fast_refresh_radius_m: { min: 100, max: 10000, integer: true },
    location_fresh_minutes: { min: 1, max: 120, integer: false },
    source_report_fresh_minutes: { min: 5, max: 1440, integer: false },
    recency_tie_seconds: { min: 0, max: 300, integer: false },
    max_gps_accuracy_m: { min: 5, max: 1000, integer: false },
    vehicle_location_fresh_minutes: { min: 5, max: 180, integer: false },
    movement_threshold_m: { min: 10, max: 2000, integer: true },
    arrival_recovery_minutes: { min: 3, max: 30, integer: false }
};

const key = String(msg.topic ?? "");
const rule = limits[key];
const value = Number(msg.payload);
if (
    !rule ||
    !Number.isFinite(value) ||
    value < rule.min ||
    value > rule.max ||
    (rule.integer && !Number.isInteger(value))
) {
    node.error(
        "Política de localização inválida: " +
        (key || "campo ausente") + "=" + msg.payload,
        msg
    );
    return null;
}

const previous = global.get(KEY, PERSISTENT);
const policy = previous?.version === 1
    ? { ...previous }
    : { version: 1, owner: "node_red" };
policy[key] = value;
delete policy.arrival_distance_m;
delete policy.arm_distance_m;
policy.updated_at = Date.now();
const allValuesPresent = Object.keys(limits).every(
    (field) => Number.isFinite(Number(policy[field]))
);
if (
    allValuesPresent &&
    (
        policy.near_home_radius_m <= policy.home_radius_m ||
        policy.people_fast_refresh_radius_m < policy.near_home_radius_m
    )
) {
    node.error(
        "Raios inválidos: home < near_home <= atualização acelerada",
        msg
    );
    return null;
}
policy.complete = allValuesPresent;
global.set(KEY, policy, PERSISTENT);

node.status({
    fill: policy.complete ? "green" : "yellow",
    shape: policy.complete ? "dot" : "ring",
    text: policy.complete
        ? "home " + policy.home_radius_m + " m | near_home " +
          policy.near_home_radius_m + " m | refresh ≤ " +
          policy.people_fast_refresh_radius_m + " m"
        : "aguardando todos os valores"
});

if (!policy.complete) return null;
msg.payload = { ...policy };
msg.topic = "location_policy_v1";
return msg;`;

const normalizeObservations = String.raw`const policy = global.get("location_policy_v1", "persistent");
if (policy?.version !== 1 || policy?.complete !== true) {
    node.error("Política canônica de localização ainda não está pronta", msg);
    return null;
}

if (msg._location_test === true || msg.payload?.test_mode === true) {
    return msg;
}

const definitions = {
    resident_primary: [
        [msg.payload?.resident_primary, "Home Assistant App"],
        [msg.payload?.resident_primary_icloud, "iCloud"]
    ],
    resident_secondary: [
        [msg.payload?.resident_secondary, "Home Assistant App"],
        [msg.payload?.resident_secondary_icloud, "iCloud"]
    ]
};
const futureToleranceMs = 60 * 1000;
const freshnessMs = Number(policy.location_fresh_minutes) * 60 * 1000;
const reportingFreshnessMs =
    Number(policy.source_report_fresh_minutes) * 60 * 1000;
const maximumAccuracy = Number(policy.max_gps_accuracy_m);

function timestamp(entity, attribute, fallback) {
    const value = Date.parse(
        entity?.attributes?.[attribute] ?? entity?.[fallback] ?? ""
    );
    return Number.isFinite(value) ? value : null;
}

function number(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}

function candidate(entry, index) {
    const [entity, label] = entry;
    if (!entity || typeof entity !== "object") return null;
    const observedAt = timestamp(entity, "location_observed_at", "last_changed");
    const reportedAt = timestamp(entity, "source_reported_at", "last_updated");
    const latitude = number(entity.attributes?.latitude);
    const longitude = number(entity.attributes?.longitude);
    const accuracy = number(entity.attributes?.gps_accuracy);
    const reliableCoordinates =
        latitude !== null &&
        longitude !== null &&
        (accuracy === null || accuracy <= maximumAccuracy);
    const fresh =
        observedAt !== null &&
        observedAt <= Date.now() + futureToleranceMs &&
        Date.now() - observedAt <= freshnessMs;
    const reportingFresh =
        reportedAt !== null &&
        reportedAt <= Date.now() + futureToleranceMs &&
        Date.now() - reportedAt <= reportingFreshnessMs;
    const state = String(entity.state ?? "");
    return {
        entity,
        index,
        label,
        state,
        state_valid: !["", "unknown", "unavailable"].includes(state),
        observed_at: observedAt,
        reported_at: reportedAt,
        latitude,
        longitude,
        accuracy,
        reliable_coordinates: reliableCoordinates,
        fresh,
        reporting_fresh: reportingFresh
    };
}

msg._location_candidates = {};
for (const [role, entries] of Object.entries(definitions)) {
    msg._location_candidates[role] = entries
        .map(candidate)
        .filter(Boolean);
}
msg._location_policy = { ...policy };
return msg;`;

const selectLocation = String.raw`if (msg._location_test === true || msg.payload?.test_mode === true) {
    return msg;
}

const policy = msg._location_policy;
if (policy?.version !== 1 || policy?.complete !== true) {
    node.error("Política canônica ausente na seleção", msg);
    return null;
}

const tieMs = Number(policy.recency_tie_seconds) * 1000;
const decisionKey = "canonical_location_decisions_v1";
const previousDecisions = flow.get(decisionKey, "persistent") ?? {};
const decisions = { ...previousDecisions };
msg._canonical_locations = {};
const rawTriggerEntity = msg.payload?.trigger_entity;
const rawPreviousState = msg.payload?.trigger_prev_state;

function accuracy(candidate) {
    return candidate.accuracy !== null && candidate.accuracy >= 0
        ? candidate.accuracy
        : Infinity;
}

function observed(candidate) {
    return candidate.observed_at ?? -Infinity;
}

function choose(candidates) {
    if (!Array.isArray(candidates) || candidates.length === 0) {
        return { selected: null, reason: "no_source" };
    }
    let selected = candidates[0];
    let reason = "first_source";
    for (const candidate of candidates.slice(1)) {
        if (selected.fresh !== candidate.fresh) {
            if (candidate.fresh) {
                selected = candidate;
                reason = "fresh_location";
            }
            continue;
        }
        if (selected.reliable_coordinates !== candidate.reliable_coordinates) {
            if (candidate.reliable_coordinates) {
                selected = candidate;
                reason = "reliable_coordinates";
            }
            continue;
        }
        const recencyDelta = observed(candidate) - observed(selected);
        if (Math.abs(recencyDelta) > tieMs) {
            if (recencyDelta > 0) {
                selected = candidate;
                reason = "materially_newer";
            }
            continue;
        }
        if (accuracy(selected) !== accuracy(candidate)) {
            if (accuracy(candidate) < accuracy(selected)) {
                selected = candidate;
                reason = "better_accuracy_within_tie";
            }
            continue;
        }
        if (observed(candidate) !== observed(selected)) {
            if (observed(candidate) > observed(selected)) {
                selected = candidate;
                reason = "newer_with_equal_accuracy";
            }
            continue;
        }
        if (selected.state_valid !== candidate.state_valid && candidate.state_valid) {
            selected = candidate;
            reason = "valid_state";
        }
    }
    return { selected, reason };
}

function signature(candidate) {
    if (!candidate) return null;
    return JSON.stringify([
        candidate.state,
        candidate.latitude,
        candidate.longitude,
        candidate.accuracy,
        candidate.observed_at
    ]);
}

for (const role of ["resident_primary", "resident_secondary"]) {
    const candidates = msg._location_candidates?.[role] ?? [];
    const result = choose(candidates);
    const selected = result.selected;
    const previous = previousDecisions[role];
    const canonicalPreviousState = previous?.state ?? (
        selected?.entity?.entity_id === rawTriggerEntity
            ? rawPreviousState
            : null
    );
    const currentSignature = signature(selected);
    const canonicalChanged = currentSignature !== previous?.signature;
    msg._canonical_locations[role] = {
        selected,
        candidates,
        reason: result.reason,
        canonical_changed: canonicalChanged,
        previous_state: canonicalPreviousState
    };
    msg.payload[role + "_selected"] = selected?.entity ?? null;
    decisions[role] = {
        signature: currentSignature,
        state: selected?.state ?? null,
        selected_index: selected?.index ?? null,
        observed_at: selected?.observed_at ?? null,
        updated_at: Date.now()
    };

    if (msg.payload?.source === role) {
        msg.payload.trigger_prev_state = canonicalPreviousState;
        msg.payload.trigger_state = selected?.state ?? null;
        msg.payload.trigger_entity = "device_tracker." + role + "_location";
        if (msg.payload.event === "location_update" && !canonicalChanged) {
            msg.payload.event = "context_update";
        }
    }
}

flow.set(decisionKey, decisions, "persistent");
const source = msg.payload?.source;
const sourceDecision = msg._canonical_locations[source];
node.status({
    fill: sourceDecision?.selected?.fresh ? "green" : "yellow",
    shape: sourceDecision?.selected ? "dot" : "ring",
    text: sourceDecision?.selected
        ? source + ": " + sourceDecision.selected.label +
          " (" + sourceDecision.reason + ")"
        : "nenhuma fonte utilizável"
});
return msg;`;

const classifyPeopleNearHome = String.raw`if (
    msg._location_test === true ||
    msg.payload?.test_mode === true
) {
    return msg;
}

const policy = msg._location_policy ??
    global.get("location_policy_v1", "persistent");
const homeRadiusM = Number(policy?.home_radius_m);
const nearHomeRadiusM = Number(policy?.near_home_radius_m);
if (
    policy?.version !== 1 ||
    policy?.complete !== true ||
    !Number.isFinite(homeRadiusM) ||
    !Number.isFinite(nearHomeRadiusM)
) {
    node.error("Raios canônicos de localização ausentes", msg);
    return null;
}

const HOME_LAT = Number(env.get("HOME_LAT"));
const HOME_LON = Number(env.get("HOME_LON"));
const GATE_LAT = Number(env.get("GATE_LAT"));
const GATE_LON = Number(env.get("GATE_LON"));
const HOME_KNOWN = Number.isFinite(HOME_LAT) && Number.isFinite(HOME_LON);
const GATE_KNOWN = Number.isFinite(GATE_LAT) && Number.isFinite(GATE_LON);
const WAKE_RING_STATE = "location_update_ring";
const KEY = "canonical_near_home_people_v1";
const PERSISTENT = "persistent";
const previous = flow.get(KEY, PERSISTENT) ?? {};
const next = { ...previous };

function distanceMeters(lat1, lon1, lat2, lon2) {
    const toRad = (value) => value * Math.PI / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(lat1)) *
        Math.cos(toRad(lat2)) *
        Math.sin(dLon / 2) ** 2;
    return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function rawFallback(state) {
    const value = String(state ?? "");
    if (["unknown", "unavailable"].includes(value)) return value;
    if (["home", "near_home", WAKE_RING_STATE].includes(value)) return value;
    return "not_home";
}

function classify(candidate) {
    if (!candidate) return null;
    const rawState = String(candidate.state ?? "unknown");
    let distanceHomeM = null;
    let distanceGateM = null;
    if (
        candidate.reliable_coordinates === true &&
        Number.isFinite(candidate.latitude) &&
        Number.isFinite(candidate.longitude)
    ) {
        if (HOME_KNOWN) {
            distanceHomeM = Math.round(distanceMeters(
                HOME_LAT,
                HOME_LON,
                candidate.latitude,
                candidate.longitude
            ));
        }
        if (GATE_KNOWN) {
            distanceGateM = Math.round(distanceMeters(
                GATE_LAT,
                GATE_LON,
                candidate.latitude,
                candidate.longitude
            ));
        }
    }
    const nearReference = [distanceHomeM, distanceGateM]
        .filter(Number.isFinite);
    const nearestM = nearReference.length > 0
        ? Math.min(...nearReference)
        : null;
    let state = rawFallback(rawState);
    if (distanceHomeM !== null && distanceHomeM <= homeRadiusM) {
        state = "home";
    } else if (nearestM !== null && nearestM <= nearHomeRadiusM) {
        state = "near_home";
    } else if (["home", "near_home", WAKE_RING_STATE].includes(rawState)) {
        state = "not_home";
    }
    const entity = {
        ...candidate.entity,
        state,
        attributes: {
            ...(candidate.entity?.attributes ?? {}),
            raw_location_state: rawState,
            canonical_distance_home_m: distanceHomeM,
            canonical_distance_gate_m: distanceGateM,
            home_radius_m: homeRadiusM,
            near_home_radius_m: nearHomeRadiusM,
            decision_owner: "node_red"
        }
    };
    return {
        ...candidate,
        entity,
        raw_state: rawState,
        state,
        distance_home_m: distanceHomeM,
        distance_gate_m: distanceGateM
    };
}

const changedRoles = [];
for (const role of ["resident_primary", "resident_secondary"]) {
    const decision = msg._canonical_locations?.[role];
    if (!decision) continue;
    const selected = classify(decision.selected);
    const previousState = previous[role]?.state ??
        rawFallback(decision.previous_state);
    const stateChanged = Boolean(
        selected &&
        previous[role]?.state &&
        selected.state !== previous[role].state
    );
    if (stateChanged) changedRoles.push(role);
    decision.selected = selected;
    decision.previous_state = previousState;
    decision.canonical_state_changed = stateChanged;
    msg.payload[role + "_selected"] = selected?.entity ?? null;
    next[role] = {
        state: selected?.state ?? null,
        raw_state: selected?.raw_state ?? null,
        observed_at: selected?.observed_at ?? null,
        updated_at: Date.now()
    };
    if (msg.payload?.source === role && selected) {
        msg.payload.trigger_prev_state = previousState;
        msg.payload.trigger_state = selected.state;
        msg.payload.trigger_entity = "device_tracker." + role + "_location";
        if (selected.state === previousState) {
            msg.payload.event = "context_update";
        }
    }
}

if (
    msg.payload?.event === "context_snapshot" &&
    changedRoles.length === 1
) {
    const role = changedRoles[0];
    const selected = msg._canonical_locations?.[role]?.selected;
    msg.payload.event = "location_update";
    msg.payload.source = role;
    msg.payload.trigger_prev_state = previous[role].state;
    msg.payload.trigger_state = selected.state;
    msg.payload.trigger_entity = "device_tracker." + role + "_location";
}

flow.set(KEY, next, PERSISTENT);
const source = msg.payload?.source;
const selected = msg._canonical_locations?.[source]?.selected;
node.status({
    fill: selected?.state === "near_home" ? "blue" : "green",
    shape: selected ? "dot" : "ring",
    text: selected
        ? source + ": " + selected.state +
          " (home " + homeRadiusM + " / near_home " + nearHomeRadiusM + " m)"
        : "snapshot canônico atualizado"
});
return msg;`;

const classifyVehicleNearHome = String.raw`if (
    msg._location_test === true ||
    msg.payload?.test_mode === true
) {
    return msg;
}

const policy = global.get("location_policy_v1", "persistent");
const homeRadiusM = Number(policy?.home_radius_m);
const nearHomeRadiusM = Number(policy?.near_home_radius_m);
const maxAccuracyM = Number(policy?.max_gps_accuracy_m);
if (
    policy?.version !== 1 ||
    policy?.complete !== true ||
    !Number.isFinite(homeRadiusM) ||
    !Number.isFinite(nearHomeRadiusM) ||
    !Number.isFinite(maxAccuracyM)
) {
    node.error("Raios canônicos do veículo ausentes", msg);
    return null;
}

const HOME_LAT = Number(env.get("HOME_LAT"));
const HOME_LON = Number(env.get("HOME_LON"));
const GATE_LAT = Number(env.get("GATE_LAT"));
const GATE_LON = Number(env.get("GATE_LON"));
const HOME_KNOWN = Number.isFinite(HOME_LAT) && Number.isFinite(HOME_LON);
const GATE_KNOWN = Number.isFinite(GATE_LAT) && Number.isFinite(GATE_LON);
const WAKE_RING_STATE = "location_update_ring";
const KEY = "canonical_near_home_vehicle_v1";
const PERSISTENT = "persistent";

function distanceMeters(lat1, lon1, lat2, lon2) {
    const toRad = (value) => value * Math.PI / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(lat1)) *
        Math.cos(toRad(lat2)) *
        Math.sin(dLon / 2) ** 2;
    return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function rawFallback(state) {
    const value = String(state ?? "");
    if (["unknown", "unavailable"].includes(value)) return value;
    if (["home", "near_home", WAKE_RING_STATE].includes(value)) return value;
    return "not_home";
}

const entity = msg.payload?.vehicle_primary;
if (!entity || typeof entity !== "object") return msg;
const attrs = entity.attributes ?? {};
const latitude = Number(attrs.latitude);
const longitude = Number(attrs.longitude);
const accuracy = Number(attrs.gps_accuracy);
const reliable =
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    (!Number.isFinite(accuracy) || accuracy <= maxAccuracyM);
const rawState = String(entity.state ?? "unknown");
let distanceHomeM = null;
let distanceGateM = null;
if (reliable && HOME_KNOWN) {
    distanceHomeM = Math.round(distanceMeters(
        HOME_LAT, HOME_LON, latitude, longitude
    ));
}
if (reliable && GATE_KNOWN) {
    distanceGateM = Math.round(distanceMeters(
        GATE_LAT, GATE_LON, latitude, longitude
    ));
}
const distances = [distanceHomeM, distanceGateM].filter(Number.isFinite);
const nearestM = distances.length > 0 ? Math.min(...distances) : null;
let state = rawFallback(rawState);
if (distanceHomeM !== null && distanceHomeM <= homeRadiusM) {
    state = "home";
} else if (nearestM !== null && nearestM <= nearHomeRadiusM) {
    state = "near_home";
} else if (["home", "near_home", WAKE_RING_STATE].includes(rawState)) {
    state = "not_home";
}

const previous = flow.get(KEY, PERSISTENT);
const previousState = previous?.state ?? rawFallback(msg.payload?.trigger_prev_state);
msg.payload.vehicle_primary = {
    ...entity,
    state,
    attributes: {
        ...attrs,
        raw_location_state: rawState,
        canonical_distance_home_m: distanceHomeM,
        canonical_distance_gate_m: distanceGateM,
        home_radius_m: homeRadiusM,
        near_home_radius_m: nearHomeRadiusM,
        decision_owner: "node_red"
    }
};
if (msg.payload?.event === "location_update") {
    msg.payload.trigger_prev_state = previousState;
    msg.payload.trigger_state = state;
    if (state === previousState) msg.payload.event = "context_update";
}
flow.set(KEY, {
    state,
    raw_state: rawState,
    observed_at: attrs.location_observed_at ?? entity.last_changed ?? null,
    updated_at: Date.now()
}, PERSISTENT);
node.status({
    fill: state === "near_home" ? "blue" : "green",
    shape: "dot",
    text: state + " (home " + homeRadiusM +
        " / near_home " + nearHomeRadiusM + " m)"
});
return msg;`;

const publishLocations = String.raw`if (msg._location_test === true || msg.payload?.test_mode === true) {
    return null;
}
const policy = msg._location_policy ?? {};
const outputs = [];
for (const role of ["resident_primary", "resident_secondary"]) {
    const decision = msg._canonical_locations?.[role];
    const selected = decision?.selected;
    if (!selected) continue;
    const locationSources = (decision.candidates ?? []).map((candidate) => ({
        name: candidate.label,
        last_updated: candidate.reported_at === null
            ? null
            : new Date(candidate.reported_at).toISOString(),
        location_observed_at: candidate.observed_at === null
            ? null
            : new Date(candidate.observed_at).toISOString(),
        position_fresh: candidate.fresh === true,
        reporting_fresh: candidate.reporting_fresh === true,
        reliable_coordinates: candidate.reliable_coordinates === true,
        gps_accuracy: candidate.accuracy
    }));
    const payload = {
        state: selected.state,
        raw_location_state: selected.raw_state ?? selected.state,
        selected_location_source: selected.label,
        location_sources: locationSources,
        binding_role: role,
        decision_owner: "node_red",
        selection_policy_version: 1,
        selection_reason: decision.reason,
        location_observed_at: selected.observed_at === null
            ? null
            : new Date(selected.observed_at).toISOString(),
        source_reported_at: selected.reported_at === null
            ? null
            : new Date(selected.reported_at).toISOString(),
        home_radius_m: Number(policy.home_radius_m),
        near_home_radius_m: Number(policy.near_home_radius_m),
        people_fast_refresh_radius_m:
            Number(policy.people_fast_refresh_radius_m),
        location_fresh_minutes: Number(policy.location_fresh_minutes),
        source_report_fresh_minutes:
            Number(policy.source_report_fresh_minutes)
    };
    if (
        selected.reliable_coordinates === true &&
        Number.isFinite(selected.latitude) &&
        Number.isFinite(selected.longitude)
    ) {
        payload.latitude = selected.latitude;
        payload.longitude = selected.longitude;
        if (Number.isFinite(selected.accuracy)) {
            payload.gps_accuracy = selected.accuracy;
        }
        payload.source_type = "gps";
    }
    const baseTopic = "smart_home/location/" + role;
    outputs.push({
        topic: baseTopic + "/state",
        payload: String(selected.state ?? "unknown"),
        qos: "1",
        retain: true
    });
    outputs.push({
        topic: baseTopic + "/attributes",
        payload: JSON.stringify(payload),
        qos: "1",
        retain: true
    });
}
return [outputs];`;

const discovery = String.raw`const bindings = global.get("publicBindings") ?? {};
const roles = bindings.roles ?? {};
const vehicleDevice = {
    identifiers: ["nodered_vehicle_primary_location"],
    name: "Creta",
    manufacturer: "Node-RED"
};
const messages = [];
for (const role of ["resident_primary", "resident_secondary"]) {
    const displayName = roles[role]?.display_name ??
        roles[role]?.source_alias ?? role;
    const residentDevice = {
        identifiers: ["nodered_" + role + "_location"],
        name: displayName,
        manufacturer: "Node-RED"
    };
    const baseTopic = "smart_home/location/" + role;
    messages.push({
        topic: "homeassistant/device_tracker/" + role + "_location/config",
        payload: JSON.stringify({
            name: null,
            has_entity_name: true,
            object_id: role + "_location",
            default_entity_id: "device_tracker." + role + "_location",
            unique_id: "nodered_" + role + "_location",
            state_topic: baseTopic + "/state",
            json_attributes_topic: baseTopic + "/attributes",
            source_type: "gps",
            icon: "mdi:map-marker-account",
            device: residentDevice
        }),
        qos: "1",
        retain: true
    });
}
const vehicleBaseTopic = "smart_home/location/vehicle_primary";
messages.push({
    topic: "homeassistant/device_tracker/vehicle_primary_location_nodered/config",
    payload: JSON.stringify({
        name: null,
        has_entity_name: true,
        object_id: "vehicle_primary_location_nodered",
        default_entity_id: "device_tracker.vehicle_primary_location_nodered",
        unique_id: "nodered_vehicle_primary_location",
        state_topic: vehicleBaseTopic + "/state",
        json_attributes_topic: vehicleBaseTopic + "/attributes",
        source_type: "gps",
        icon: "mdi:car-connected",
        device: vehicleDevice
    }),
    qos: "1",
    retain: true
});
const vehicleTopic = "smart_home/location/vehicle_primary/current_since";
messages.push({
    topic: "homeassistant/sensor/vehicle_primary_location_since_nodered/config",
    payload: JSON.stringify({
        name: "Vehicle primary current location since",
        object_id: "vehicle_primary_location_since_nodered",
        default_entity_id: "sensor.vehicle_primary_location_since_nodered",
        unique_id: "nodered_vehicle_primary_location_since",
        state_topic: vehicleTopic,
        value_template: "{{ value_json.location_since }}",
        json_attributes_topic: vehicleTopic,
        device_class: "timestamp",
        icon: "mdi:map-marker-check-outline",
        device: vehicleDevice
    }),
    qos: "1",
    retain: true
});
return [messages];`;

const policyStatus = String.raw`const policy = msg.payload;
if (
    msg.topic !== "location_policy_v1" ||
    policy?.version !== 1 ||
    policy?.complete !== true
) {
    node.error("Contrato da política de localização inválido", msg);
    return null;
}
node.status({
    fill: "green",
    shape: "dot",
    text: "home " + policy.home_radius_m + " m | near_home " +
        policy.near_home_radius_m + " m"
});
return null;`;

const vehiclePanelPublish = String.raw`if (msg.payload?.kind !== "vehicle_primary_context") return null;
if (msg.payload?.test_mode === true || msg._location_test === true) return null;
const vehicleContext = msg.payload?.context ?? {};
const location = vehicleContext.location ?? {};
const lastConfirmed = vehicleContext.last_confirmed_location ?? {};
const fallbackReady =
    typeof lastConfirmed.state === "string" &&
    !["", "unknown", "unavailable"].includes(lastConfirmed.state) &&
    Number.isFinite(Number(lastConfirmed.latitude)) &&
    Number.isFinite(Number(lastConfirmed.longitude));
const panelLocation = location.ready === true || !fallbackReady
    ? location
    : lastConfirmed;
const locationSince = Number(vehicleContext.current_location_since);
const outputs = [];
const state = location.ready === true || fallbackReady
    ? panelLocation.state
    : "unavailable";
const trackerPayload = {
    state,
    binding_role: "vehicle_primary",
    decision_owner: "node_red",
    location_observed_at: Number.isFinite(Number(panelLocation.updated_at))
        ? new Date(Number(panelLocation.updated_at)).toISOString()
        : null,
    location_fresh: location.ready === true && location.stale !== true,
    movement_threshold_m: Number(vehicleContext.movement_threshold_m),
    home_radius_m: Number(vehicleContext.home_radius_m),
    near_home_radius_m: Number(vehicleContext.near_home_radius_m),
    people_fast_refresh_radius_m:
        Number(vehicleContext.people_fast_refresh_radius_m)
};
if (
    (location.ready === true || fallbackReady) &&
    Number.isFinite(Number(panelLocation.latitude)) &&
    Number.isFinite(Number(panelLocation.longitude))
) {
    trackerPayload.latitude = Number(panelLocation.latitude);
    trackerPayload.longitude = Number(panelLocation.longitude);
    if (Number.isFinite(Number(panelLocation.gps_accuracy))) {
        trackerPayload.gps_accuracy = Number(panelLocation.gps_accuracy);
    }
    trackerPayload.source_type = "gps";
}
outputs.push({
    topic: "smart_home/location/vehicle_primary/state",
    payload: state,
    qos: "1",
    retain: true
});
outputs.push({
    topic: "smart_home/location/vehicle_primary/attributes",
    payload: JSON.stringify(trackerPayload),
    qos: "1",
    retain: true
});
if (Number.isFinite(locationSince) && locationSince > 0) {
    outputs.push({
        topic: "smart_home/location/vehicle_primary/current_since",
        payload: JSON.stringify({
            location_since: new Date(locationSince).toISOString(),
            location_state: state,
            movement_threshold_m: Number(vehicleContext.movement_threshold_m),
            home_radius_m: Number(vehicleContext.home_radius_m),
            near_home_radius_m: Number(vehicleContext.near_home_radius_m),
            decision_owner: "node_red"
        }),
        qos: "1",
        retain: true
    });
}
return [outputs];`;

const policyGroup = "people_location_policy_group_v1";
const policyNodes = [
  "people_location_policy_help_v1",
  "people_location_near_home_radius_v1",
  "people_location_home_radius_v1",
  "people_location_fast_refresh_radius_v1",
  "people_location_fresh_minutes_v1",
  "people_location_source_report_minutes_v1",
  "people_location_recency_tie_seconds_v1",
  "people_location_accuracy_v1",
  "people_location_vehicle_fresh_minutes_v1",
  "people_location_movement_threshold_v1",
  "people_location_recovery_minutes_v1",
  "people_location_values_route_out_v1",
  "people_location_values_route_middle_out_v1",
  "people_location_values_route_right_out_v1",
  "people_location_values_route_in_v1",
  "people_location_policy_apply_v1",
  "people_location_policy_out_v1",
];
flows.push(
  group(policyGroup, PEOPLE_TAB, "0. Política canônica de localização — edite os números", policyNodes, 64, 59, 1290, 322),
  {
    id: "people_location_policy_help_v1",
    type: "comment",
    z: PEOPLE_TAB,
    g: policyGroup,
    name: "Duplo clique no número → altere → Deploy. Uma única política alimenta pessoas, veículo, iluminação e painéis.",
    x: 660,
    y: 100,
    w: 820,
    wires: [],
  },
  inject("people_location_near_home_radius_v1", policyGroup, "Raio near_home (m)", "near_home_radius_m", 700, 250, 160),
  inject("people_location_home_radius_v1", policyGroup, "Raio home (m)", "home_radius_m", 100, 250, 200),
  inject("people_location_fast_refresh_radius_v1", policyGroup, "Raio refresh rápido (m)", "people_fast_refresh_radius_m", 2000, 250, 240),
  inject("people_location_fresh_minutes_v1", policyGroup, "Posição atual — 15 min", "location_fresh_minutes", 15, 550, 160),
  inject("people_location_source_report_minutes_v1", policyGroup, "Fonte ativa — 75 min", "source_report_fresh_minutes", 75, 550, 200),
  inject("people_location_vehicle_fresh_minutes_v1", policyGroup, "Posição do carro — 30 min", "vehicle_location_fresh_minutes", 30, 550, 240),
  inject("people_location_recovery_minutes_v1", policyGroup, "Reter chegada — 10 min", "arrival_recovery_minutes", 10, 550, 280),
  inject("people_location_recency_tie_seconds_v1", policyGroup, "Empate de recência — 60 s", "recency_tie_seconds", 60, 850, 160),
  inject("people_location_accuracy_v1", policyGroup, "Precisão máxima — 100 m", "max_gps_accuracy_m", 100, 850, 200),
  inject("people_location_movement_threshold_v1", policyGroup, "Movimento do carro — 250 m", "movement_threshold_m", 250, 850, 240),
  {
    id: "people_location_values_route_out_v1",
    type: "link out",
    z: PEOPLE_TAB,
    g: policyGroup,
    name: "Valores da coluna esquerda → validador",
    mode: "link",
    links: ["people_location_values_route_in_v1"],
    x: 430,
    y: 340,
    wires: [],
  },
  {
    id: "people_location_values_route_middle_out_v1",
    type: "link out",
    z: PEOPLE_TAB,
    g: policyGroup,
    name: "Valores da coluna central → validador",
    mode: "link",
    links: ["people_location_values_route_in_v1"],
    x: 710,
    y: 340,
    wires: [],
  },
  {
    id: "people_location_values_route_right_out_v1",
    type: "link out",
    z: PEOPLE_TAB,
    g: policyGroup,
    name: "Valores da coluna direita → validador",
    mode: "link",
    links: ["people_location_values_route_in_v1"],
    x: 990,
    y: 340,
    wires: [],
  },
  {
    id: "people_location_values_route_in_v1",
    type: "link in",
    z: PEOPLE_TAB,
    g: policyGroup,
    name: "Receber valores da política",
    links: [
      "people_location_values_route_out_v1",
      "people_location_values_route_middle_out_v1",
      "people_location_values_route_right_out_v1",
    ],
    x: 1110,
    y: 340,
    wires: [["people_location_policy_apply_v1"]],
  },
  functionNode("people_location_policy_apply_v1", PEOPLE_TAB, policyGroup, "Validar e salvar política única", policyApply, 1, 1220, 220, [["people_location_policy_out_v1"]]),
  {
    id: "people_location_policy_out_v1",
    type: "link out",
    z: PEOPLE_TAB,
    g: policyGroup,
    name: "Política única → todos os consumidores",
    mode: "link",
    links: [
      "people_location_policy_publish_in_v1",
      "vehicle_location_policy_in_v1",
      "light_location_policy_in_v1",
    ],
    x: 1300,
    y: 300,
    wires: [],
  },
);
for (const id of [
  "people_location_near_home_radius_v1",
  "people_location_home_radius_v1",
  "people_location_fast_refresh_radius_v1",
]) {
  flows.find((node) => node.id === id).wires = [[
    "people_location_values_route_out_v1",
  ]];
}
for (const id of [
  "people_location_fresh_minutes_v1",
  "people_location_source_report_minutes_v1",
  "people_location_vehicle_fresh_minutes_v1",
  "people_location_recovery_minutes_v1",
]) {
  flows.find((node) => node.id === id).wires = [[
    "people_location_values_route_middle_out_v1",
  ]];
}
for (const id of [
  "people_location_recency_tie_seconds_v1",
  "people_location_accuracy_v1",
  "people_location_movement_threshold_v1",
]) {
  flows.find((node) => node.id === id).wires = [[
    "people_location_values_route_right_out_v1",
  ]];
}

const selectionGroup = "people_location_selection_group_v1";
flows.push(
  group(selectionGroup, PEOPLE_TAB, "2. Seleção canônica e publicação para o Home Assistant", [
    "people_location_selection_help_v1",
    "people_location_observation_v1",
    "people_location_select_v1",
    "people_location_classify_near_home_v1",
    "people_location_to_normalizer_out_v1",
    "people_location_notification_out_v1",
    "people_location_publish_state_v1",
    "people_location_mqtt_state_v1",
    "people_location_discovery_start_v1",
    "people_location_policy_publish_in_v1",
    "people_location_build_discovery_v1",
    "people_location_mqtt_discovery_v1",
  ], 620, 419, 1390, 302, { stroke: "#7d6ba8", fill: "#eee7f7", color: "#4b3d69" }),
  {
    id: "people_location_selection_help_v1",
    type: "comment",
    z: PEOPLE_TAB,
    g: selectionGroup,
    name: "Prioridade: atualidade → coordenadas confiáveis → diferença > 60 s → precisão → recência → estado válido",
    x: 1050,
    y: 460,
    w: 780,
    wires: [],
  },
  functionNode("people_location_observation_v1", PEOPLE_TAB, selectionGroup, "Normalizar as duas observações", normalizeObservations, 1, 780, 540, [["people_location_select_v1"]]),
  functionNode("people_location_select_v1", PEOPLE_TAB, selectionGroup, "Escolher fonte como o antigo mapa", selectLocation, 1, 1090, 540, [["people_location_classify_near_home_v1"]]),
  functionNode("people_location_classify_near_home_v1", PEOPLE_TAB, selectionGroup, "Aplicar raios home e near_home", classifyPeopleNearHome, 1, 1420, 540, [["people_location_to_normalizer_out_v1", "people_location_notification_out_v1", "people_location_publish_state_v1"]]),
  {
    id: "people_location_to_normalizer_out_v1",
    type: "link out",
    z: PEOPLE_TAB,
    g: selectionGroup,
    name: "Decisão canônica → presença e chegada",
    mode: "link",
    links: ["people_location_to_normalizer_in_v1"],
    x: 1690,
    y: 520,
    wires: [],
  },
  {
    id: "people_location_notification_out_v1",
    type: "link out",
    z: PEOPLE_TAB,
    g: selectionGroup,
    name: "Decisão canônica → avisos",
    mode: "link",
    links: ["resident_notifications_canonical_in_v1"],
    x: 1690,
    y: 560,
    wires: [],
  },
  functionNode("people_location_publish_state_v1", PEOPLE_TAB, selectionGroup, "Montar trackers canônicos", publishLocations, 1, 1590, 600, [["people_location_mqtt_state_v1"]]),
  {
    id: "people_location_mqtt_state_v1",
    type: "mqtt out",
    z: PEOPLE_TAB,
    g: selectionGroup,
    name: "Publicar decisão para mapa e painéis",
    topic: "",
    qos: "1",
    retain: "true",
    respTopic: "",
    contentType: "application/json",
    userProps: "",
    correl: "",
    expiry: "",
    broker: MQTT_BROKER,
    x: 1880,
    y: 600,
    wires: [],
  },
  {
    id: "people_location_discovery_start_v1",
    type: "inject",
    z: PEOPLE_TAB,
    g: selectionGroup,
    name: "Registrar entidades canônicas no startup",
    props: [{ p: "payload" }],
    repeat: "",
    crontab: "",
    once: true,
    onceDelay: "1",
    topic: "",
    payload: "",
    payloadType: "date",
    x: 830,
    y: 660,
    wires: [["people_location_build_discovery_v1"]],
  },
  {
    id: "people_location_policy_publish_in_v1",
    type: "link in",
    z: PEOPLE_TAB,
    g: selectionGroup,
    name: "Política alterada → republicar cadastro",
    links: ["people_location_policy_out_v1"],
    x: 705,
    y: 700,
    wires: [["people_location_build_discovery_v1"]],
  },
  functionNode("people_location_build_discovery_v1", PEOPLE_TAB, selectionGroup, "Cadastrar trackers e sensor do veículo", discovery, 1, 1120, 680, [["people_location_mqtt_discovery_v1"]]),
  {
    id: "people_location_mqtt_discovery_v1",
    type: "mqtt out",
    z: PEOPLE_TAB,
    g: selectionGroup,
    name: "Publicar cadastros MQTT",
    topic: "",
    qos: "1",
    retain: "true",
    respTopic: "",
    contentType: "application/json",
    userProps: "",
    correl: "",
    expiry: "",
    broker: MQTT_BROKER,
    x: 1450,
    y: 680,
    wires: [],
  },
);

const primaryEvent = requiredById("4189bb901d6a15c4");
const secondaryEvent = requiredById("bc70805a5fe2f35d");
const snapshot = requiredByName("Ler trackers de resident_primary e resident_secondary");
for (const node of [primaryEvent, secondaryEvent]) {
  node.name = node.name.replace("mudou de zona", "atualizou localização");
  node.outputOnlyOnStateChange = false;
}
for (const node of [primaryEvent, secondaryEvent, snapshot]) {
  node.wires = [["people_location_observation_v1"]];
}

const peopleNormalizer = requiredByName("Normalizar pessoas e detectar transições");
peopleNormalizer.func = peopleNormalizer.func
  .replaceAll("ARRIVAL_DISTANCE_M", "NEAR_HOME_RADIUS_M")
  .replaceAll("arrival_distance_m", "near_home_radius_m")
  .replaceAll("ARM_DISTANCE_M", "HOME_RADIUS_M")
  .replaceAll("arm_distance_m", "home_radius_m")
  .replaceAll("isArrivalHome(", "isNearHome(");
if (!peopleNormalizer.func.includes("const LOCATION_POLICY = global.get")) {
  peopleNormalizer.func = replaceRequired(
    peopleNormalizer.func,
    /const HOME_RADIUS_M = 100;[\s\S]*?const SOURCE_REPORT_FRESH_MS = 75 \* 60 \* 1000;/,
    `const LOCATION_POLICY = global.get("location_policy_v1", "persistent");
if (LOCATION_POLICY?.version !== 1 || LOCATION_POLICY?.complete !== true) {
    node.error("Política canônica de localização ausente", msg);
    return [null, null, null];
}
const HOME_RADIUS_M = Number(LOCATION_POLICY.home_radius_m);
const NEAR_HOME_RADIUS_M = Number(LOCATION_POLICY.near_home_radius_m);
const MAX_GPS_ACCURACY_M = Number(LOCATION_POLICY.max_gps_accuracy_m);
const LOCATION_FRESH_MS = Number(LOCATION_POLICY.location_fresh_minutes) * 60 * 1000;
const SOURCE_REPORT_FRESH_MS = Number(LOCATION_POLICY.source_report_fresh_minutes) * 60 * 1000;
const APPROACH_ZONE = "near_home";
const PRIMARY_HOME_GRACE_MS = 10 * 60 * 1000;`,
    "política do normalizador de pessoas",
  );
}
if (!peopleNormalizer.func.includes('const APPROACH_ZONE = "near_home";')) {
  peopleNormalizer.func = replaceRequired(
    peopleNormalizer.func,
    "const SOURCE_REPORT_FRESH_MS = Number(LOCATION_POLICY.source_report_fresh_minutes) * 60 * 1000;",
    `const SOURCE_REPORT_FRESH_MS = Number(LOCATION_POLICY.source_report_fresh_minutes) * 60 * 1000;
const APPROACH_ZONE = "near_home";
const PRIMARY_HOME_GRACE_MS = 10 * 60 * 1000;`,
    "constantes de chegada de pessoas",
  );
}
peopleNormalizer.func = peopleNormalizer.func.replace(
  /const TRACKER_SELECTION_VERSION = \d+;[\s\S]*?\n\}\n\n(?=function awayEvidence)/,
  "",
);
peopleNormalizer.func = peopleNormalizer.func.replace(
  `function position(primary, fallback) {
    const selected = mergeTrackers(
        primary,
        fallback
    );`,
  `function position(selected, primary, fallback) {`,
);
peopleNormalizer.func = peopleNormalizer.func
  .replace(
    `    const anyTrackerHome =
        primaryHome(primary) ||
        primaryHome(fallback);
    const anyTrackerAway =
        awayEvidence(primary) ||
        awayEvidence(fallback);`,
    `    const anyTrackerHome = primaryHome(selected);
    const anyTrackerAway = awayEvidence(selected);`,
  )
  .replace("        primary_home: primaryHome(primary),", "        primary_home: primaryHome(selected),")
  .replace("        primary_home_for_ms: homeForMs(primary)", "        primary_home_for_ms: homeForMs(selected)")
  .replace(
    `const resident_primary = position(
    msg.payload?.resident_primary,
    msg.payload?.resident_primary_icloud
);`,
    `const resident_primary = position(
    msg.payload?.resident_primary_selected,
    msg.payload?.resident_primary,
    msg.payload?.resident_primary_icloud
);`,
  )
  .replace(
    `const resident_secondary = position(
    msg.payload?.resident_secondary,
    msg.payload?.resident_secondary_icloud
);`,
    `const resident_secondary = position(
    msg.payload?.resident_secondary_selected,
    msg.payload?.resident_secondary,
    msg.payload?.resident_secondary_icloud
);`,
  );
if (!peopleNormalizer.func.includes("msg.payload.resident_primary_selected =")) {
  peopleNormalizer.func = replaceRequired(
    peopleNormalizer.func,
    "    };\n}\n\n/*\n * Durante um teste",
    `    };
    msg.payload.resident_primary_selected = msg.payload.resident_primary;
    msg.payload.resident_secondary_selected = msg.payload.resident_secondary;
}

/*
 * Durante um teste`,
    "seleção sintética de testes",
  );
}
if (
  peopleNormalizer.func.includes("mergeTrackers(") ||
  !peopleNormalizer.func.includes("msg.payload?.resident_primary_selected")
) {
  throw new Error("Normalizador ainda contém decisão duplicada de tracker");
}
if (!peopleNormalizer.func.includes("people_fast_refresh_radius_m:")) {
  peopleNormalizer.func = replaceRequired(
    peopleNormalizer.func,
    `const peopleContext = {
    resident_primary,
    resident_secondary,`,
    `const peopleContext = {
    resident_primary,
    resident_secondary,
    home_radius_m: HOME_RADIUS_M,
    near_home_radius_m: NEAR_HOME_RADIUS_M,
    people_fast_refresh_radius_m:
        Number(LOCATION_POLICY.people_fast_refresh_radius_m),`,
    "raios canônicos no contexto das pessoas",
  );
}

const peopleArrivalCycleV2 = String.raw`/* ================================
 * ARMAMENTO DO CICLO EXTERNO
 * ================================ */

let armed =
    ctxGet(
        ARMED_KEY
    );

if (!validObject(armed)) {
    armed =
        validObject(
            recovery
                .arrival_armed
        )
            ? recovery
                .arrival_armed
            : {};
}

armed = {
    resident_primary:
        armed.resident_primary === true,

    resident_secondary:
        armed.resident_secondary === true
};

/*
 * Distância sozinha não arma chegada: durante a saída a pessoa cruza 100 m
 * ainda dentro de "near_home" e o GPS pode oscilar de volta para "home".
 * Somente um estado canônico externo ao par home/near_home comprova que houve
 * um ciclo fora de casa. O predecessor externo preserva chegadas que saltam
 * diretamente para home ou near_home.
 */
function externalArrivalCycleEvidence(state) {
    return (
        validZoneState(state) &&
        !["home", APPROACH_ZONE].includes(state)
    );
}

for (
    const [
        name,
        item
    ]
    of Object.entries(
        people
    )
) {
    if (
        item?.ready === true &&
        externalArrivalCycleEvidence(item.state)
    ) {
        armed[name] = true;
    }
}

/* A borda externa → near_home já traz sentido de retorno pela própria zona.
 * Ela pode armar e publicar no mesmo evento. Uma borda externa → home não
 * recebe esse atalho: precisa de observação externa anterior e, assim, um
 * salto isolado de GPS durante a saída permanece bloqueado. */
if (
    isLocationEvent &&
    sourcePosition?.ready === true &&
    triggerState === APPROACH_ZONE &&
    sourcePosition.current_home !== true &&
    externalArrivalCycleEvidence(triggerPrevState)
) {
    armed[source] = true;
}

/* ================================
 * DETECÇÃO DE CHEGADA
 * ================================ */

let arrival = null;
let lightingOnlyArrival = null;
let blockedArrival = null;
let departureTransition = false;
let staleCatchUp = false;

if (
    isLocationEvent &&
    sourcePosition?.ready ===
    true &&
    triggerPrevValid
) {
    const approachEntry =
        triggerState ===
        APPROACH_ZONE &&
        triggerPrevState ===
        "not_home" &&
        sourcePosition.current_home !== true;

    departureTransition =
        triggerPrevState === "home" &&
        triggerState !== "home";

    if (departureTransition) {
        armed[source] = false;
    }

    staleCatchUp =
        !approachEntry &&
        sourcePosition
            .primary_home ===
        true &&
        typeof sourcePosition
            .primary_home_for_ms ===
        "number" &&
        sourcePosition
            .primary_home_for_ms >
        PRIMARY_HOME_GRACE_MS;

    const externalCycleConfirmed =
        armed[source] === true;

    if (
        !departureTransition &&
        !staleCatchUp &&
        externalCycleConfirmed &&
        (
            approachEntry ||
            isNearHome(
                sourcePosition
            )
        )
    ) {
        arrival = {
            _location_test:
                TEST_MODE,

            _location_test_case:
                TEST_MODE
                    ? (msg._location_test_case ?? null)
                    : undefined,

            payload: {
                contract:
                    "security.arrival.v1",

                kind:
                    "arrival",

                source,

                arriving: [
                    source
                ],

                arrival_source_type:
                    "person",

                arrival_stage:
                    approachEntry
                        ? "approach"
                        : "home",

                arrival_previous_state:
                    triggerPrevState,

                arrival_direction:
                    "returning",

                external_cycle_confirmed:
                    true,

                event_at:
                    sourcePosition
                        .updated_at ??
                    Date.now(),

                refresh_cycle_id:
                    msg.payload?.refresh_cycle_id
            }
        };
    }

    if (
        !approachEntry &&
        isNearHome(
            sourcePosition
        )
    ) {
        armed[source] =
            false;
    }
}


/*
 * Recovery de tracker só continua elegível quando o ciclo externo já havia
 * sido comprovado antes de unknown/unavailable. Sem isso, o mesmo salto pode
 * ser apenas uma oscilação durante a saída.
 */
if (
    isLocationEvent &&
    sourcePosition?.ready === true &&
    triggerState === APPROACH_ZONE &&
    ["unknown", "unavailable"].includes(triggerPrevState) &&
    sourcePosition.current_home !== true &&
    armed[source] === true
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
            arrival_direction: "returning",
            external_cycle_confirmed: true,
            illumination_only: true,
            event_at: sourcePosition.updated_at ?? Date.now(),
            refresh_cycle_id: msg.payload?.refresh_cycle_id
        }
    };
}

const directionalTransitionCandidate =
    isLocationEvent &&
    sourcePosition?.ready === true &&
    triggerState !== triggerPrevState &&
    ["home", APPROACH_ZONE].includes(triggerState);

if (
    !arrival &&
    !lightingOnlyArrival &&
    directionalTransitionCandidate
) {
    blockedArrival = {
        _location_test: TEST_MODE,
        _location_test_case: TEST_MODE
            ? (msg._location_test_case ?? null)
            : undefined,
        payload: {
            contract: "security.arrival-direction.v1",
            kind: "arrival_blocked",
            source,
            trigger_state: triggerState,
            trigger_prev_state: triggerPrevState,
            direction_reason: departureTransition
                ? "departure_from_home"
                : armed[source] !== true
                    ? "external_cycle_not_confirmed"
                    : staleCatchUp
                        ? "stale_home_catchup"
                        : "transition_not_arrival_eligible",
            simulated: TEST_MODE,
            dispatched: false,
            event_at: sourcePosition.updated_at ?? Date.now()
        }
    };
}

`;

peopleNormalizer.func = replaceRequired(
  peopleNormalizer.func,
  /\/\* ================================\n \* ARMAMENTO(?: DO CICLO EXTERNO)?\n \* ================================ \*\/[\s\S]*?(?=\/\* ================================\n \* SNAPSHOT \/ REFRESH)/,
  peopleArrivalCycleV2,
  "ciclo externo e direção da chegada de pessoas",
);
peopleNormalizer.func = replaceRequired(
  peopleNormalizer.func,
  /\/\*\n \* OUTPUT 1 = contexto normal[\s\S]*?return \[msg, arrival, lightingOnlyArrival\];/,
  `/*
 * OUTPUT 1 = contexto normal
 * OUTPUT 2 = retorno confirmado
 * OUTPUT 3 = recovery de tracker com ciclo externo confirmado
 * OUTPUT 4 = saída/rebote bloqueado, sem efeitos
 */
return [msg, arrival, lightingOnlyArrival, blockedArrival];`,
  "saídas visíveis de direção das pessoas",
);
if (!peopleNormalizer.func.includes("external_cycle_confirmed")) {
  throw new Error("Guard de ciclo externo das pessoas não foi instalado");
}

const normalizationGroup = flows.find((node) => node.id === peopleNormalizer.g);
if (!normalizationGroup) throw new Error("Grupo do normalizador ausente");
normalizationGroup.name = "3. Presença e chegada usando somente a decisão canônica";
moveGroupTo(normalizationGroup, 2050, 419);
normalizationGroup.w = 762;
normalizationGroup.h = 242;
if (!normalizationGroup.nodes.includes("people_location_to_normalizer_in_v1")) {
  normalizationGroup.nodes.unshift("people_location_to_normalizer_in_v1");
}
for (const id of [
  "people_arrival_direction_note_v1",
  "people_arrival_departure_blocked_v1",
]) {
  if (!normalizationGroup.nodes.includes(id)) normalizationGroup.nodes.push(id);
}
flows.push({
  id: "people_location_to_normalizer_in_v1",
  type: "link in",
  z: PEOPLE_TAB,
  g: normalizationGroup.id,
  name: "Receber decisão canônica",
  links: ["people_location_to_normalizer_out_v1"],
  x: 2125,
  y: 520,
  wires: [[peopleNormalizer.id]],
});
peopleNormalizer.x = 2380;
peopleNormalizer.y = 520;
const peopleContextOut = requiredById("487984b3aaa29663");
const peopleArrivalOut = requiredById("397c6032b3dad342");
const recoveryOut = requiredById("people_lighting_tracker_recovery_arrival_out");
peopleNormalizer.outputs = 4;
peopleNormalizer.wires = [
  [peopleContextOut.id],
  [peopleArrivalOut.id],
  [recoveryOut.id],
  ["people_arrival_departure_blocked_v1"],
];
peopleContextOut.x = 2760;
peopleContextOut.y = 480;
peopleArrivalOut.name = "RETORNO confirmado → publicar chegada v1";
peopleArrivalOut.x = 2760;
peopleArrivalOut.y = 520;
recoveryOut.name = "RECOVERY armado → iluminação";
recoveryOut.x = 2760;
recoveryOut.y = 560;
flows.push(
  {
    id: "people_arrival_direction_note_v1",
    type: "comment",
    z: PEOPLE_TAB,
    g: normalizationGroup.id,
    name: "SAÍDA home→near_home bloqueia; RETORNO exige passagem por not_home/zona externa",
    info: "O raio near_home configurado decide a chegada somente depois de um ciclo externo confirmado. Um rebote near_home→home durante a saída termina no bloco BLOQUEADO e nunca alcança iluminação, alarme ou notificações.",
    x: 2420,
    y: 460,
    wires: [],
  },
  functionNode(
    "people_arrival_departure_blocked_v1",
    PEOPLE_TAB,
    normalizationGroup.id,
    "BLOQUEADO: saída/rebote (sem efeitos)",
    String.raw`const result = {
    version: 1,
    simulated: true,
    dispatched: false,
    source: msg.payload?.source,
    reason: msg.payload?.direction_reason,
    blocked_at: Date.now()
};
flow.set(
    msg._location_test === true
        ? "people_last_blocked_arrival_v1__test"
        : "people_last_blocked_arrival_v1",
    result
);
node.status({
    fill: "grey",
    shape: "ring",
    text: "bloqueado: " + String(result.reason ?? "direção inválida")
});
node.log?.(
    "PEOPLE_ARRIVAL_BLOCKED source=" + String(result.source) +
    " reason=" + String(result.reason) +
    " dispatched=false"
);
return null;`,
    0,
    2660,
    620,
    [],
  ),
);

const vehicleNormalizer = requiredByName("Normalizar vehicle_primary e detectar transições");
vehicleNormalizer.func = vehicleNormalizer.func
  .replaceAll("ARRIVAL_DISTANCE_M", "NEAR_HOME_RADIUS_M")
  .replaceAll("arrival_distance_m", "near_home_radius_m")
  .replaceAll("ARM_DISTANCE_M", "HOME_RADIUS_M")
  .replaceAll("arm_distance_m", "home_radius_m")
  .replaceAll("isArrivalHome(", "isNearHome(");
if (!vehicleNormalizer.func.includes("const LOCATION_POLICY = global.get")) {
  vehicleNormalizer.func = replaceRequired(
    vehicleNormalizer.func,
    /const HOME_RADIUS_M = 100;[\s\S]*?const MOVEMENT_THRESHOLD_M = 250;/,
    `const LOCATION_POLICY = global.get("location_policy_v1", "persistent");
if (LOCATION_POLICY?.version !== 1 || LOCATION_POLICY?.complete !== true) {
    node.error("Política canônica de localização ausente", msg);
    return [null, null, null];
}
const HOME_RADIUS_M = Number(LOCATION_POLICY.home_radius_m);
const NEAR_HOME_RADIUS_M = Number(LOCATION_POLICY.near_home_radius_m);
const MAX_GPS_ACCURACY_M = Number(LOCATION_POLICY.max_gps_accuracy_m);
const MOVEMENT_THRESHOLD_M = Number(LOCATION_POLICY.movement_threshold_m);`,
    "política do normalizador do veículo",
  );
  vehicleNormalizer.func = vehicleNormalizer.func.replace(
    "const LOCATION_FRESH_MS = 30 * 60 * 1000;",
    "const LOCATION_FRESH_MS = Number(LOCATION_POLICY.vehicle_location_fresh_minutes) * 60 * 1000;",
  );
}
if (!vehicleNormalizer.func.includes("current_location_since:")) {
  vehicleNormalizer.func = replaceRequired(
    vehicleNormalizer.func,
    "const vehicleContext = {\n    location: vehicle_primary,",
    `const currentLocationObservation = ctxGet(
    LOCATION_OBSERVATION_KEY,
    PERSISTENT
);
const vehicleContext = {
    location: vehicle_primary,
    current_location_since:
        Number(currentLocationObservation?.updated_at ?? 0) || null,
    movement_threshold_m: MOVEMENT_THRESHOLD_M,`,
    "timestamp canônico do veículo",
  );
}
if (!vehicleNormalizer.func.includes("last_confirmed_location:")) {
  vehicleNormalizer.func = replaceRequired(
    vehicleNormalizer.func,
    "    movement_threshold_m: MOVEMENT_THRESHOLD_M,",
    `    movement_threshold_m: MOVEMENT_THRESHOLD_M,
    last_confirmed_location: currentLocationObservation
        ? { ...currentLocationObservation }
        : null,`,
    "última localização confirmada para o painel",
  );
}
if (!vehicleNormalizer.func.includes("near_home_radius_m: NEAR_HOME_RADIUS_M")) {
  vehicleNormalizer.func = replaceRequired(
    vehicleNormalizer.func,
    "    movement_threshold_m: MOVEMENT_THRESHOLD_M,",
    `    movement_threshold_m: MOVEMENT_THRESHOLD_M,
    home_radius_m: HOME_RADIUS_M,
    near_home_radius_m: NEAR_HOME_RADIUS_M,
    people_fast_refresh_radius_m:
        Number(LOCATION_POLICY.people_fast_refresh_radius_m),`,
    "raios canônicos no contexto do veículo",
  );
}
vehicleNormalizer.func = vehicleNormalizer.func.replace(
  "home: vehicle_primary.ready ? isNearHome(vehicle_primary) : null,",
  `home: vehicle_primary.ready ? isArmingHome(vehicle_primary) : null,
    near_home:
        vehicle_primary.ready
            ? isNearHome(vehicle_primary) && !isArmingHome(vehicle_primary)
            : null,`,
);
if (
  !vehicleNormalizer.func.includes("NEAR_HOME_RADIUS_M = Number(LOCATION_POLICY.near_home_radius_m)") ||
  !vehicleNormalizer.func.includes("movement_threshold_m: MOVEMENT_THRESHOLD_M")
) {
  throw new Error("Política única não chegou ao normalizador do veículo");
}

const vehicleArrivalCycleV2 = String.raw`let armed = ctxGet(ARMED_KEY);
if (typeof armed !== "boolean") armed = recovery.arrival_armed === true;

function externalArrivalCycleEvidence(state) {
    return validZoneState(state) && !["home", APPROACH_ZONE].includes(state);
}

if (vehicle_primary.ready === true && externalArrivalCycleEvidence(vehicle_primary.state)) {
    armed = true;
}
if (
    isLocationEvent &&
    vehicle_primary.ready === true &&
    triggerState === APPROACH_ZONE &&
    vehicle_primary.current_home !== true &&
    externalArrivalCycleEvidence(triggerPrevState)
) {
    armed = true;
}
let arrival = null;
let blockedArrival = null;
if (isLocationEvent && vehicle_primary.ready === true && triggerPrevValid) {
    const approachEntry = triggerState === APPROACH_ZONE && triggerPrevState !== APPROACH_ZONE && triggerPrevState !== "home";
    const departureTransition = triggerPrevState === "home" && triggerState !== "home";
    if (departureTransition) armed = false;
    const staleCatchUp = !approachEntry && vehicle_primary.primary_home === true && typeof vehicle_primary.primary_home_for_ms === "number" && vehicle_primary.primary_home_for_ms > PRIMARY_HOME_GRACE_MS;
    if (!departureTransition && !staleCatchUp && (approachEntry || isNearHome(vehicle_primary)) && armed) {
        arrival = { payload: {
            contract: "security.arrival.v1", kind: "arrival", source: "vehicle_primary", arriving: ["vehicle_primary"],
            arrival_source_type: "vehicle_primary", arrival_stage: approachEntry ? "approach" : "home",
            arrival_direction: "returning", external_cycle_confirmed: true,
            request_vehicle_primary_wake: approachEntry, event_at: vehicle_primary.updated_at ?? Date.now(),
            refresh_cycle_id: msg.payload?.refresh_cycle_id,
        } };
    }
    if (!arrival && triggerState !== triggerPrevState && ["home", APPROACH_ZONE].includes(triggerState)) {
        blockedArrival = {
            _location_test: TEST_MODE,
            _location_test_case: TEST_MODE ? (msg._location_test_case ?? null) : undefined,
            payload: {
                contract: "security.arrival-direction.v1",
                kind: "arrival_blocked",
                source: "vehicle_primary",
                trigger_state: triggerState,
                trigger_prev_state: triggerPrevState,
                direction_reason: departureTransition
                    ? "departure_from_home"
                    : armed !== true
                        ? "external_cycle_not_confirmed"
                        : staleCatchUp
                            ? "stale_home_catchup"
                            : "transition_not_arrival_eligible",
                simulated: TEST_MODE,
                dispatched: false,
                event_at: vehicle_primary.updated_at ?? Date.now()
            }
        };
    }
    if (!approachEntry && isNearHome(vehicle_primary)) armed = false;
} else if (isArmingHome(vehicle_primary)) {
    armed = false;
}`;

vehicleNormalizer.func = replaceRequired(
  vehicleNormalizer.func,
  /let armed = ctxGet\(ARMED_KEY\);[\s\S]*?(?=\nif \(arrival\) \{)/,
  vehicleArrivalCycleV2,
  "ciclo externo e direção da chegada do veículo",
);
vehicleNormalizer.func = replaceRequired(
  vehicleNormalizer.func,
  "return [msg, arrival, recoveryRequest];",
  "return [msg, arrival, recoveryRequest, blockedArrival];",
  "saída bloqueada do veículo",
);
if (!vehicleNormalizer.func.includes("external_cycle_confirmed")) {
  throw new Error("Guard de ciclo externo do veículo não foi instalado");
}

const vehicleNormalizationGroup = flows.find(
  (node) => node.id === vehicleNormalizer.g,
);
if (!vehicleNormalizationGroup) throw new Error("Grupo do normalizador do veículo ausente");
const vehicleClassifierId = "vehicle_primary_classify_near_home_v1";
for (const node of flows) {
  if (!Array.isArray(node.wires)) continue;
  node.wires = node.wires.map((output) =>
    Array.isArray(output)
      ? output.map((target) =>
          target === vehicleNormalizer.id || target === vehicleClassifierId
            ? vehicleClassifierId
            : target)
      : output,
  );
}
for (const id of [
  vehicleClassifierId,
  "vehicle_primary_arrival_direction_note_v1",
  "vehicle_primary_arrival_departure_blocked_v1",
]) {
  if (!vehicleNormalizationGroup.nodes.includes(id)) vehicleNormalizationGroup.nodes.push(id);
}
Object.assign(vehicleNormalizationGroup, { x: 734, y: 139, w: 850, h: 322 });
const vehicleContextRoute = requiredById("c298447a6a2e3cef");
const vehicleArrivalRoute = requiredById("2aa1b0c2907d4017");
const vehicleActionRoute = requiredById("67d24b1f56447c94");
vehicleNormalizer.x = 1250;
for (const route of [vehicleContextRoute, vehicleArrivalRoute, vehicleActionRoute]) {
  route.x = 1515;
}
vehicleArrivalRoute.name = "RETORNO confirmado → publicar chegada v1";
vehicleActionRoute.name = "RETORNO confirmado → ações do veículo";
vehicleNormalizer.outputs = 4;
vehicleNormalizer.wires = [
  [vehicleContextRoute.id],
  [vehicleArrivalRoute.id, vehicleActionRoute.id],
  [vehicleNormalizer.wires?.[2]?.[0]].filter(Boolean),
  ["vehicle_primary_arrival_departure_blocked_v1"],
];
flows.push(
  functionNode(
    vehicleClassifierId,
    VEHICLE_TAB,
    vehicleNormalizationGroup.id,
    "Classificar home / near_home",
    classifyVehicleNearHome,
    1,
    850,
    240,
    [[vehicleNormalizer.id]],
  ),
  {
    id: "vehicle_primary_arrival_direction_note_v1",
    type: "comment",
    z: VEHICLE_TAB,
    g: vehicleNormalizationGroup.id,
    name: "SAÍDA bloqueada; RETORNO só após estado externo",
    info: "O veículo não arma chegada apenas por cruzar 100 m. home→near_home e o rebote near_home→home ficam visíveis no terminal bloqueado.",
    x: 1190,
    y: 340,
    wires: [],
  },
  functionNode(
    "vehicle_primary_arrival_departure_blocked_v1",
    VEHICLE_TAB,
    vehicleNormalizationGroup.id,
    "BLOQUEADO: saída/rebote do veículo",
    String.raw`const result = {
    version: 1,
    simulated: true,
    dispatched: false,
    reason: msg.payload?.direction_reason,
    blocked_at: Date.now()
};
flow.set(
    msg._location_test === true
        ? "vehicle_primary_last_blocked_arrival_v1__test"
        : "vehicle_primary_last_blocked_arrival_v1",
    result
);
node.status({ fill: "grey", shape: "ring", text: "bloqueado: " + String(result.reason ?? "direção inválida") });
node.log?.("VEHICLE_PRIMARY_ARRIVAL_BLOCKED reason=" + String(result.reason) + " dispatched=false");
return null;`,
    0,
    1390,
    400,
    [],
  ),
);

const vehicleContextOut = requiredByName("Publicar contexto do vehicle_primary v1");
if (!vehicleContextOut.links.includes("vehicle_location_panel_in_v1")) {
  vehicleContextOut.links.push("vehicle_location_panel_in_v1");
}
flows.push(
  group("vehicle_location_panel_group_v1", VEHICLE_TAB, "Dados canônicos de localização para painéis", [
    "vehicle_location_policy_in_v1",
    "vehicle_location_policy_status_v1",
    "vehicle_location_panel_in_v1",
    "vehicle_location_panel_publish_v1",
    "vehicle_location_panel_mqtt_v1",
  ], 1940, 579, 922, 242, { stroke: "#5ca5d8", fill: "#d9edf7", color: "#1d4f72" }),
  {
    id: "vehicle_location_policy_in_v1",
    type: "link in",
    z: VEHICLE_TAB,
    g: "vehicle_location_panel_group_v1",
    name: "Receber política única de localização",
    links: ["people_location_policy_out_v1"],
    x: 2025,
    y: 660,
    wires: [["vehicle_location_policy_status_v1"]],
  },
  functionNode("vehicle_location_policy_status_v1", VEHICLE_TAB, "vehicle_location_panel_group_v1", "Confirmar raio e movimento compartilhados", policyStatus, 0, 2290, 660, []),
  {
    id: "vehicle_location_panel_in_v1",
    type: "link in",
    z: VEHICLE_TAB,
    g: "vehicle_location_panel_group_v1",
    name: "Receber contexto de localização do veículo",
    links: [vehicleContextOut.id],
    x: 2025,
    y: 740,
    wires: [["vehicle_location_panel_publish_v1"]],
  },
  functionNode("vehicle_location_panel_publish_v1", VEHICLE_TAB, "vehicle_location_panel_group_v1", "Publicar local atual desde", vehiclePanelPublish, 1, 2300, 740, [["vehicle_location_panel_mqtt_v1"]]),
  {
    id: "vehicle_location_panel_mqtt_v1",
    type: "mqtt out",
    z: VEHICLE_TAB,
    g: "vehicle_location_panel_group_v1",
    name: "Enviar localização do veículo ao painel",
    topic: "",
    qos: "1",
    retain: "true",
    respTopic: "",
    contentType: "application/json",
    userProps: "",
    correl: "",
    expiry: "",
    broker: MQTT_BROKER,
    x: 2670,
    y: 740,
    wires: [],
  },
);

flows.push(
  group("light_location_policy_group_v1", LIGHT_TAB, "Política canônica recebida da localização", [
    "light_location_policy_in_v1",
    "light_location_policy_status_v1",
  ], 1510, 1019, 602, 142, { stroke: "#5ca5d8", fill: "#d9edf7", color: "#1d4f72" }),
  {
    id: "light_location_policy_in_v1",
    type: "link in",
    z: LIGHT_TAB,
    g: "light_location_policy_group_v1",
    name: "Receber raio e retenção de chegada",
    links: ["people_location_policy_out_v1"],
    x: 1605,
    y: 1100,
    wires: [["light_location_policy_status_v1"]],
  },
  functionNode("light_location_policy_status_v1", LIGHT_TAB, "light_location_policy_group_v1", "Confirmar política da iluminação", policyStatus, 0, 1900, 1100, []),
);

const peopleRefreshDecider = requiredByName("Atualizar iPhones agora?");
if (!peopleRefreshDecider.func.includes("people_fast_refresh_radius_m")) {
  peopleRefreshDecider.func = replaceRequired(
    peopleRefreshDecider.func,
    "if (msg.payload?.kind !== \"refresh_command\") return null;",
    `if (msg.payload?.kind !== "refresh_command") return null;

const LOCATION_POLICY = global.get("location_policy_v1", "persistent");
const FAST_REFRESH_RADIUS_M = Number(
    LOCATION_POLICY?.people_fast_refresh_radius_m
);
if (
    LOCATION_POLICY?.version !== 1 ||
    LOCATION_POLICY?.complete !== true ||
    !Number.isFinite(FAST_REFRESH_RADIUS_M)
) {
    node.error("Raio de refresh rápido ausente", msg);
    return null;
}`,
    "raio do refresh adaptativo das pessoas",
  );
  peopleRefreshDecider.func = replaceRequired(
    peopleRefreshDecider.func,
    /peopleContext\.nearest_distance_m\s*<=\s*\d+/,
    "peopleContext.nearest_distance_m <= FAST_REFRESH_RADIUS_M",
    "limite do refresh adaptativo das pessoas",
  );
}

const lightDecisionGroup = requiredById("32a89192d93735b1");
const lightMergeContext = requiredById("48a5f40d806f6950");
const lightArrivalReplayOut = "light_arrival_replay_route_out_v1";
const lightArrivalGateIn = "light_arrival_replay_gate_in_v1";
const lightArrivalDebugIn = "light_arrival_replay_debug_in_v1";
for (const id of [
  lightArrivalReplayOut,
  lightArrivalGateIn,
  lightArrivalDebugIn,
]) {
  if (!lightDecisionGroup.nodes.includes(id)) lightDecisionGroup.nodes.push(id);
}
lightMergeContext.wires[2] = [lightArrivalReplayOut];
flows.push(
  {
    id: lightArrivalReplayOut,
    type: "link out",
    z: LIGHT_TAB,
    g: lightDecisionGroup.id,
    name: "Replay de chegada → rotas",
    mode: "link",
    links: [lightArrivalGateIn, lightArrivalDebugIn],
    x: 720,
    y: 220,
    wires: [],
  },
  {
    id: lightArrivalGateIn,
    type: "link in",
    z: LIGHT_TAB,
    g: lightDecisionGroup.id,
    name: "Replay → validar direção",
    links: [lightArrivalReplayOut],
    x: 500,
    y: 240,
    wires: [["security_light_arrival_direction_gate_v1"]],
  },
  {
    id: lightArrivalDebugIn,
    type: "link in",
    z: LIGHT_TAB,
    g: lightDecisionGroup.id,
    name: "Replay → debug",
    links: [lightArrivalReplayOut],
    x: 1130,
    y: 180,
    wires: [["1bdb8c52397de8a9"]],
  },
);

const lightOffGroup = requiredById("a610d085d27ea80d");
const lightOffDecision = requiredById("374d4e39be0a30ac");
const lightOffRouteOut = "light_off_decision_route_out_v1";
const lightOffRouteIn = "light_off_decision_route_in_v1";
for (const id of [lightOffRouteOut, lightOffRouteIn]) {
  if (!lightOffGroup.nodes.includes(id)) lightOffGroup.nodes.push(id);
}
lightOffDecision.wires[0] = [lightOffRouteOut];
flows.push(
  {
    id: lightOffRouteOut,
    type: "link out",
    z: LIGHT_TAB,
    g: lightOffGroup.id,
    name: "Pode desligar → rota final",
    mode: "link",
    links: [lightOffRouteIn],
    x: 960,
    y: 580,
    wires: [],
  },
  {
    id: lightOffRouteIn,
    type: "link in",
    z: LIGHT_TAB,
    g: lightOffGroup.id,
    name: "Receber decisão de desligar",
    links: [lightOffRouteOut],
    x: 1030,
    y: 540,
    wires: [["84d450933e67b8c1"]],
  },
);

const syncIn = requiredByName("Sincronizar trackers após refresh do vehicle_primary");
const refreshPrimary = requiredByName("Solicitar localização do iPhone resident_primary");
const refreshSecondary = requiredByName("Solicitar localização do iPhone resident_secondary");
syncIn.wires = [[refreshPrimary.id, refreshSecondary.id]];

// Reorganize os grupos existentes sem misturar a política e a seleção.
const eventGroup = flows.find((node) => node.id === primaryEvent.g);
if (eventGroup) {
  const dx = 64 - eventGroup.x;
  const dy = 419 - eventGroup.y;
  for (const id of eventGroup.nodes) {
    const node = flows.find((candidate) => candidate.id === id);
    if (node && Number.isFinite(node.x) && Number.isFinite(node.y)) {
      node.x += dx;
      node.y += dy;
    }
  }
  Object.assign(eventGroup, { x: 64, y: 419 });
  eventGroup.name = "1. Eventos das duas fontes por residente";
}
const observerGroup = flows.find((node) => node.type === "group" && node.z === PEOPLE_TAB && node.name?.startsWith("Observabilidade global"));
if (observerGroup) {
  const dx = 2100 - observerGroup.x;
  for (const id of observerGroup.nodes) {
    const node = flows.find((candidate) => candidate.id === id);
    if (node && Number.isFinite(node.x)) node.x += dx;
  }
  observerGroup.x = 2100;
}
for (const groupName of ["3. Refresh adaptativo dos iPhones", "4. Testes manuais — estado compartilhado/cumulativo"]) {
  const existing = flows.find((node) => node.type === "group" && node.z === PEOPLE_TAB && node.name === groupName);
  if (!existing) continue;
  const targetY = groupName.startsWith("3.") ? 759 : 1019;
  const dx = 64 - existing.x;
  const dy = targetY - existing.y;
  for (const id of existing.nodes) {
    const node = flows.find((candidate) => candidate.id === id);
    if (node && Number.isFinite(node.x) && Number.isFinite(node.y)) {
      node.x += dx;
      node.y += dy;
    }
  }
  existing.x = 64;
  existing.y = targetY;
}

const peopleTestCoordinator = requiredByName("Iniciar teste pelo coordenador");
if (!peopleTestCoordinator.func.includes('"people_last_blocked_arrival_v1__test"')) {
  peopleTestCoordinator.func = replaceRequired(
    peopleTestCoordinator.func,
    '    "security_people_test_clock"',
    '    "security_people_test_clock",\n    "people_last_blocked_arrival_v1__test"',
    "reset do teste de direção de pessoas",
  );
}
if (!peopleTestCoordinator.func.includes("resident_primary_departure_approach")) {
  peopleTestCoordinator.func = replaceRequired(
    peopleTestCoordinator.func,
    '    resident_primary_unavailable_approach: { source: "resident_primary", state: "near_home", prev: "unavailable" }',
    '    resident_primary_unavailable_approach: { source: "resident_primary", state: "near_home", prev: "unavailable" },\n    resident_primary_departure_approach: { source: "resident_primary", state: "near_home", prev: "home" },\n    resident_primary_departure_bounce_home: { source: "resident_primary", state: "home", prev: "near_home" }',
    "casos manuais de saída e rebote",
  );
}

const peopleTestGroup = flows.find((node) => node.id === "6e71dbc937fe5669");
const peopleTestRoute = flows.find(
  (node) => node.id === "people_tracker_recovery_tests_out_v1",
);
if (!peopleTestGroup || !peopleTestRoute) {
  throw new Error("Grupo/rota dos testes manuais de pessoas ausente");
}
const departureTestNodes = [
  {
    id: "people_departure_approach_test_v1",
    name: "NEG SAÍDA 1/2: home → near_home",
    testCase: "resident_primary_departure_approach",
    y: 1640,
  },
  {
    id: "people_departure_bounce_home_test_v1",
    name: "NEG SAÍDA 2/2: near_home → home (rebote)",
    testCase: "resident_primary_departure_bounce_home",
    y: 1680,
  },
];
for (const testNode of departureTestNodes) {
  flows.push({
    id: testNode.id,
    type: "inject",
    z: PEOPLE_TAB,
    g: peopleTestGroup.id,
    name: testNode.name,
    props: [{ p: "test_case", v: testNode.testCase, vt: "str" }],
    repeat: "",
    crontab: "",
    once: false,
    onceDelay: 0.1,
    topic: "",
    x: 590,
    y: testNode.y,
    wires: [[peopleTestRoute.id]],
  });
  if (!peopleTestGroup.nodes.includes(testNode.id)) {
    peopleTestGroup.nodes.push(testNode.id);
  }
}
peopleTestGroup.h = Math.max(peopleTestGroup.h, 782);

const vehicleRefreshConfigGroup = flows.find(
  (node) => node.id === "vehicle_primary_refresh_config_group_v1",
);
const vehicleRefreshPolicyGroup = flows.find(
  (node) => node.id === "vehicle_primary_refresh_policy_group_v1",
);
if (!vehicleRefreshConfigGroup || !vehicleRefreshPolicyGroup) {
  throw new Error("Grupos visuais da política de refresh do veículo ausentes");
}
moveGroupTo(vehicleRefreshConfigGroup, 1640, 259);
moveGroupTo(vehicleRefreshPolicyGroup, 2230, 259);

const vehicleRefreshExecutionGroup = requiredById("43a2bc9c218353ae");
const vehicleRefreshCoordinator = requiredById("b33e117e55bdb5ed");
const manualBlockedRouteOut = "vehicle_primary_manual_blocked_route_out_v1";
const manualBlockedRouteIn = "vehicle_primary_manual_blocked_route_in_v1";
const postRefreshRouteOut = "vehicle_primary_post_refresh_route_out_v1";
const postRefreshRouteIn = "vehicle_primary_post_refresh_route_in_v1";
for (const id of [
  manualBlockedRouteOut,
  manualBlockedRouteIn,
  postRefreshRouteOut,
  postRefreshRouteIn,
]) {
  if (!vehicleRefreshExecutionGroup.nodes.includes(id)) {
    vehicleRefreshExecutionGroup.nodes.push(id);
  }
}
vehicleRefreshCoordinator.wires[2] = [manualBlockedRouteOut];
const waitForVehicleEvidence = requiredById("7a99920b093547ea");
waitForVehicleEvidence.wires = [[postRefreshRouteOut]];
flows.push(
  {
    id: manualBlockedRouteOut,
    type: "link out",
    z: VEHICLE_TAB,
    g: vehicleRefreshExecutionGroup.id,
    name: "Bloqueio manual → aviso",
    mode: "link",
    links: [manualBlockedRouteIn],
    x: 520,
    y: 740,
    wires: [],
  },
  {
    id: manualBlockedRouteIn,
    type: "link in",
    z: VEHICLE_TAB,
    g: vehicleRefreshExecutionGroup.id,
    name: "Receber bloqueio manual",
    links: [manualBlockedRouteOut],
    x: 650,
    y: 940,
    wires: [["vehicle_primary_manual_refresh_blocked_notification_v1"]],
  },
  {
    id: postRefreshRouteOut,
    type: "link out",
    z: VEHICLE_TAB,
    g: vehicleRefreshExecutionGroup.id,
    name: "Bluelink concluído → rechecagem",
    mode: "link",
    links: [postRefreshRouteIn],
    x: 1740,
    y: 700,
    wires: [],
  },
  {
    id: postRefreshRouteIn,
    type: "link in",
    z: VEHICLE_TAB,
    g: vehicleRefreshExecutionGroup.id,
    name: "Receber rechecagem pós-refresh",
    links: [postRefreshRouteOut],
    x: 1160,
    y: 780,
    wires: [["ba55143f392aa361"]],
  },
);

fs.writeFileSync(outputPath, `${JSON.stringify(flows, null, 4)}\n`);
console.log("Seleção canônica de localização instalada em blocos no Node-RED.");
