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
  "people_location_to_normalizer_out_v1",
  "people_location_to_normalizer_in_v1",
  "people_location_notification_out_v1",
  "people_location_publish_state_v1",
  "people_location_mqtt_state_v1",
  "people_location_discovery_start_v1",
  "people_location_policy_publish_in_v1",
  "people_location_build_discovery_v1",
  "people_location_mqtt_discovery_v1",
  "vehicle_location_panel_group_v1",
  "vehicle_location_policy_in_v1",
  "vehicle_location_policy_status_v1",
  "vehicle_location_panel_in_v1",
  "vehicle_location_panel_publish_v1",
  "vehicle_location_panel_mqtt_v1",
  "light_location_policy_group_v1",
  "light_location_policy_in_v1",
  "light_location_policy_status_v1",
];
removeIds(generatedIds);

const policyApply = String.raw`const KEY = "location_policy_v1";
const PERSISTENT = "persistent";
const limits = {
    arrival_distance_m: { min: 50, max: 2000, integer: true },
    location_fresh_minutes: { min: 1, max: 120, integer: false },
    source_report_fresh_minutes: { min: 5, max: 1440, integer: false },
    recency_tie_seconds: { min: 0, max: 300, integer: false },
    max_gps_accuracy_m: { min: 5, max: 1000, integer: false },
    vehicle_location_fresh_minutes: { min: 5, max: 180, integer: false },
    movement_threshold_m: { min: 10, max: 2000, integer: true },
    arm_distance_m: { min: 20, max: 500, integer: true },
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
policy.updated_at = Date.now();
policy.complete = Object.keys(limits).every(
    (field) => Number.isFinite(Number(policy[field]))
);
global.set(KEY, policy, PERSISTENT);

node.status({
    fill: policy.complete ? "green" : "yellow",
    shape: policy.complete ? "dot" : "ring",
    text: policy.complete
        ? policy.arrival_distance_m + " m | desempate " +
          policy.recency_tie_seconds + " s | recovery " +
          policy.arrival_recovery_minutes + " min"
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
        arrival_distance_m: Number(policy.arrival_distance_m),
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
const device = {
    identifiers: ["nodered_canonical_location"],
    name: "Localização canônica Node-RED",
    manufacturer: "Node-RED"
};
const vehicleDevice = {
    identifiers: ["nodered_vehicle_primary_location"],
    name: "Creta",
    manufacturer: "Node-RED"
};
const messages = [];
for (const role of ["resident_primary", "resident_secondary"]) {
    const name = roles[role]?.source_alias ?? role;
    const baseTopic = "smart_home/location/" + role;
    messages.push({
        topic: "homeassistant/device_tracker/" + role + "_location/config",
        payload: JSON.stringify({
            name,
            object_id: role + "_location",
            default_entity_id: "device_tracker." + role + "_location",
            unique_id: "nodered_" + role + "_location",
            state_topic: baseTopic + "/state",
            json_attributes_topic: baseTopic + "/attributes",
            source_type: "gps",
            icon: "mdi:map-marker-account",
            device
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
    text: policy.arrival_distance_m + " m | recovery " +
        policy.arrival_recovery_minutes + " min"
});
return null;`;

const vehiclePanelPublish = String.raw`if (msg.payload?.kind !== "vehicle_primary_context") return null;
if (msg.payload?.test_mode === true || msg._location_test === true) return null;
const vehicleContext = msg.payload?.context ?? {};
const location = vehicleContext.location ?? {};
const locationSince = Number(vehicleContext.current_location_since);
const outputs = [];
const state = location.ready === true && location.stale !== true
    ? location.state
    : "unavailable";
const trackerPayload = {
    state,
    binding_role: "vehicle_primary",
    decision_owner: "node_red",
    location_observed_at: Number.isFinite(Number(location.updated_at))
        ? new Date(Number(location.updated_at)).toISOString()
        : null,
    location_fresh: location.ready === true && location.stale !== true,
    movement_threshold_m: Number(vehicleContext.movement_threshold_m)
};
if (
    location.ready === true &&
    location.stale !== true &&
    Number.isFinite(location.latitude) &&
    Number.isFinite(location.longitude)
) {
    trackerPayload.latitude = location.latitude;
    trackerPayload.longitude = location.longitude;
    if (Number.isFinite(location.gps_accuracy)) {
        trackerPayload.gps_accuracy = location.gps_accuracy;
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
  "people_location_arrival_distance_v1",
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
];
flows.push(
  group(policyGroup, PEOPLE_TAB, "0. Política canônica de localização — edite os números", policyNodes, 64, 59, 1182, 282),
  {
    id: "people_location_policy_help_v1",
    type: "comment",
    z: PEOPLE_TAB,
    g: policyGroup,
    name: "Duplo clique no número → altere → Deploy. Uma única política alimenta pessoas, veículo, iluminação e painéis.",
    x: 535,
    y: 100,
    w: 820,
    wires: [],
  },
  inject("people_location_arrival_distance_v1", policyGroup, "Raio de chegada — 700 m", "arrival_distance_m", 700, 230, 160),
  inject("people_location_fresh_minutes_v1", policyGroup, "Posição atual — 15 min", "location_fresh_minutes", 15, 230, 200),
  inject("people_location_source_report_minutes_v1", policyGroup, "Fonte ativa — 75 min", "source_report_fresh_minutes", 75, 230, 240),
  inject("people_location_recency_tie_seconds_v1", policyGroup, "Empate de recência — 60 s", "recency_tie_seconds", 60, 510, 160),
  inject("people_location_accuracy_v1", policyGroup, "Precisão máxima — 100 m", "max_gps_accuracy_m", 100, 510, 200),
  inject("people_location_vehicle_fresh_minutes_v1", policyGroup, "Posição do carro — 30 min", "vehicle_location_fresh_minutes", 30, 510, 240),
  inject("people_location_movement_threshold_v1", policyGroup, "Movimento do carro — 250 m", "movement_threshold_m", 250, 790, 160),
  inject("people_location_arm_distance_v1", policyGroup, "Armar fora de casa — 100 m", "arm_distance_m", 100, 790, 200),
  inject("people_location_recovery_minutes_v1", policyGroup, "Reter chegada — 10 min", "arrival_recovery_minutes", 10, 790, 240),
  {
    id: "people_location_values_route_out_v1",
    type: "link out",
    z: PEOPLE_TAB,
    g: policyGroup,
    name: "Valores da coluna esquerda → validador",
    mode: "link",
    links: ["people_location_values_route_in_v1"],
    x: 400,
    y: 300,
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
    x: 650,
    y: 300,
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
    x: 930,
    y: 300,
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
    x: 1050,
    y: 300,
    wires: [["people_location_policy_apply_v1"]],
  },
  functionNode("people_location_policy_apply_v1", PEOPLE_TAB, policyGroup, "Validar e salvar política única", policyApply, 1, 1050, 200, [["people_location_policy_out_v1"]]),
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
    x: 1195,
    y: 260,
    wires: [],
  },
);
for (const id of [
  "people_location_arrival_distance_v1",
  "people_location_fresh_minutes_v1",
  "people_location_source_report_minutes_v1",
]) {
  flows.find((node) => node.id === id).wires = [[
    "people_location_values_route_out_v1",
  ]];
}
for (const id of [
  "people_location_recency_tie_seconds_v1",
  "people_location_accuracy_v1",
  "people_location_vehicle_fresh_minutes_v1",
]) {
  flows.find((node) => node.id === id).wires = [[
    "people_location_values_route_middle_out_v1",
  ]];
}
for (const id of [
  "people_location_movement_threshold_v1",
  "people_location_arm_distance_v1",
  "people_location_recovery_minutes_v1",
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
    "people_location_to_normalizer_out_v1",
    "people_location_notification_out_v1",
    "people_location_publish_state_v1",
    "people_location_mqtt_state_v1",
    "people_location_discovery_start_v1",
    "people_location_policy_publish_in_v1",
    "people_location_build_discovery_v1",
    "people_location_mqtt_discovery_v1",
  ], 620, 379, 982, 302, { stroke: "#7d6ba8", fill: "#eee7f7", color: "#4b3d69" }),
  {
    id: "people_location_selection_help_v1",
    type: "comment",
    z: PEOPLE_TAB,
    g: selectionGroup,
    name: "Prioridade: atualidade → coordenadas confiáveis → diferença > 60 s → precisão → recência → estado válido",
    x: 1050,
    y: 420,
    w: 780,
    wires: [],
  },
  functionNode("people_location_observation_v1", PEOPLE_TAB, selectionGroup, "Normalizar as duas observações", normalizeObservations, 1, 780, 500, [["people_location_select_v1"]]),
  functionNode("people_location_select_v1", PEOPLE_TAB, selectionGroup, "Escolher fonte como o antigo mapa", selectLocation, 1, 1040, 500, [["people_location_to_normalizer_out_v1", "people_location_notification_out_v1", "people_location_publish_state_v1"]]),
  {
    id: "people_location_to_normalizer_out_v1",
    type: "link out",
    z: PEOPLE_TAB,
    g: selectionGroup,
    name: "Decisão canônica → presença e chegada",
    mode: "link",
    links: ["people_location_to_normalizer_in_v1"],
    x: 1255,
    y: 480,
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
    x: 1255,
    y: 520,
    wires: [],
  },
  functionNode("people_location_publish_state_v1", PEOPLE_TAB, selectionGroup, "Montar trackers canônicos", publishLocations, 1, 1170, 560, [["people_location_mqtt_state_v1"]]),
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
    x: 1450,
    y: 560,
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
    y: 620,
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
    y: 660,
    wires: [["people_location_build_discovery_v1"]],
  },
  functionNode("people_location_build_discovery_v1", PEOPLE_TAB, selectionGroup, "Cadastrar trackers e sensor do veículo", discovery, 1, 1120, 640, [["people_location_mqtt_discovery_v1"]]),
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
    x: 1440,
    y: 640,
    wires: [],
  },
);

const primaryEvent = requiredByName("iPhone resident_primary mudou de zona");
const secondaryEvent = requiredByName("iPhone resident_secondary mudou de zona");
const snapshot = requiredByName("Ler trackers de resident_primary e resident_secondary");
for (const node of [primaryEvent, secondaryEvent, snapshot]) {
  node.wires = [["people_location_observation_v1"]];
}

const peopleNormalizer = requiredByName("Normalizar pessoas e detectar transições");
if (!peopleNormalizer.func.includes("const LOCATION_POLICY = global.get")) {
  peopleNormalizer.func = replaceRequired(
    peopleNormalizer.func,
    /const ARM_DISTANCE_M = 100;[\s\S]*?const SOURCE_REPORT_FRESH_MS = 75 \* 60 \* 1000;/,
    `const LOCATION_POLICY = global.get("location_policy_v1", "persistent");
if (LOCATION_POLICY?.version !== 1 || LOCATION_POLICY?.complete !== true) {
    node.error("Política canônica de localização ausente", msg);
    return [null, null, null];
}
const ARM_DISTANCE_M = Number(LOCATION_POLICY.arm_distance_m);
const ARRIVAL_DISTANCE_M = Number(LOCATION_POLICY.arrival_distance_m);
const MAX_GPS_ACCURACY_M = Number(LOCATION_POLICY.max_gps_accuracy_m);
const LOCATION_FRESH_MS = Number(LOCATION_POLICY.location_fresh_minutes) * 60 * 1000;
const SOURCE_REPORT_FRESH_MS = Number(LOCATION_POLICY.source_report_fresh_minutes) * 60 * 1000;
const APPROACH_ZONE = "chegando";
const PRIMARY_HOME_GRACE_MS = 10 * 60 * 1000;`,
    "política do normalizador de pessoas",
  );
}
if (!peopleNormalizer.func.includes('const APPROACH_ZONE = "chegando";')) {
  peopleNormalizer.func = replaceRequired(
    peopleNormalizer.func,
    "const SOURCE_REPORT_FRESH_MS = Number(LOCATION_POLICY.source_report_fresh_minutes) * 60 * 1000;",
    `const SOURCE_REPORT_FRESH_MS = Number(LOCATION_POLICY.source_report_fresh_minutes) * 60 * 1000;
const APPROACH_ZONE = "chegando";
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

const normalizationGroup = flows.find((node) => node.id === peopleNormalizer.g);
if (!normalizationGroup) throw new Error("Grupo do normalizador ausente");
normalizationGroup.name = "3. Presença e chegada usando somente a decisão canônica";
normalizationGroup.x = 1640;
normalizationGroup.y = 419;
normalizationGroup.w = 542;
normalizationGroup.h = 222;
if (!normalizationGroup.nodes.includes("people_location_to_normalizer_in_v1")) {
  normalizationGroup.nodes.unshift("people_location_to_normalizer_in_v1");
}
flows.push({
  id: "people_location_to_normalizer_in_v1",
  type: "link in",
  z: PEOPLE_TAB,
  g: normalizationGroup.id,
  name: "Receber decisão canônica",
  links: ["people_location_to_normalizer_out_v1"],
  x: 1705,
  y: 520,
  wires: [[peopleNormalizer.id]],
});
peopleNormalizer.x = 1910;
peopleNormalizer.y = 520;
const peopleContextOut = requiredByName("Publicar contexto de pessoas v1");
const peopleArrivalOut = requiredByName("Publicar chegada de pessoa v1");
const recoveryOut = requiredByName("Tracker recuperado chegando → iluminação");
peopleContextOut.x = 2135;
peopleContextOut.y = 480;
peopleArrivalOut.x = 2135;
peopleArrivalOut.y = 520;
recoveryOut.x = 2135;
recoveryOut.y = 560;

const vehicleNormalizer = requiredByName("Normalizar vehicle_primary e detectar transições");
if (!vehicleNormalizer.func.includes("const LOCATION_POLICY = global.get")) {
  vehicleNormalizer.func = replaceRequired(
    vehicleNormalizer.func,
    /const ARM_DISTANCE_M = 100;[\s\S]*?const MOVEMENT_THRESHOLD_M = 250;/,
    `const LOCATION_POLICY = global.get("location_policy_v1", "persistent");
if (LOCATION_POLICY?.version !== 1 || LOCATION_POLICY?.complete !== true) {
    node.error("Política canônica de localização ausente", msg);
    return [null, null, null];
}
const ARM_DISTANCE_M = Number(LOCATION_POLICY.arm_distance_m);
const ARRIVAL_DISTANCE_M = Number(LOCATION_POLICY.arrival_distance_m);
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
if (
  !vehicleNormalizer.func.includes("ARRIVAL_DISTANCE_M = Number(LOCATION_POLICY.arrival_distance_m)") ||
  !vehicleNormalizer.func.includes("movement_threshold_m: MOVEMENT_THRESHOLD_M")
) {
  throw new Error("Política única não chegou ao normalizador do veículo");
}

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

const syncIn = requiredByName("Sincronizar trackers após refresh do vehicle_primary");
const refreshPrimary = requiredByName("Solicitar localização do iPhone resident_primary");
const refreshSecondary = requiredByName("Solicitar localização do iPhone resident_secondary");
syncIn.wires = [[refreshPrimary.id, refreshSecondary.id]];

// Reorganize os grupos existentes sem misturar a política e a seleção.
const eventGroup = flows.find((node) => node.id === primaryEvent.g);
if (eventGroup) {
  const dx = 64 - eventGroup.x;
  const dy = 379 - eventGroup.y;
  for (const id of eventGroup.nodes) {
    const node = flows.find((candidate) => candidate.id === id);
    if (node && Number.isFinite(node.x) && Number.isFinite(node.y)) {
      node.x += dx;
      node.y += dy;
    }
  }
  Object.assign(eventGroup, { x: 64, y: 379 });
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
  const targetY = groupName.startsWith("3.") ? 719 : 979;
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

fs.writeFileSync(outputPath, `${JSON.stringify(flows, null, 4)}\n`);
console.log("Seleção canônica de localização instalada em blocos no Node-RED.");
