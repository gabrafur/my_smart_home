#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";

const flows = JSON.parse(
  fs.readFileSync(new URL("../flows.json", import.meta.url), "utf8"),
);
const byId = new Map(flows.map((node) => [node.id, node]));
const LOCATION_POLICY = {
  version: 1,
  owner: "node_red",
  complete: true,
  near_home_radius_m: 700,
  location_fresh_minutes: 15,
  source_report_fresh_minutes: 75,
  recency_tie_seconds: 60,
  max_gps_accuracy_m: 100,
  vehicle_location_fresh_minutes: 30,
  movement_threshold_m: 250,
  home_radius_m: 100,
  arrival_recovery_minutes: 10,
  local_excursion_minutes: 90,
  arrival_dedupe_minutes: 10,
  primary_home_grace_minutes: 10,
  external_cycle_confirm_seconds: 60,
  wake_ring_refresh_delay_seconds: 45,
  wake_ring_refresh_repeat_seconds: 60,
  future_tolerance_seconds: 60,
  vehicle_signal_fresh_minutes: 5,
  vehicle_recovery_hours: 24,
};
const SECURITY_LIGHT_POLICY = {
  version: 1,
  owner: "node_red",
  complete: true,
  physical_fresh_seconds: 120,
  recovery_request_throttle_seconds: 30,
  off_grace_seconds: 90,
  backstop_minutes: 15,
  post_off_cooldown_minutes: 5,
  lifecycle_retention_hours: 24,
  deadline_slack_minutes: 1,
  unavailable_dedupe_seconds: 10,
  cooldown_max_minutes: 30,
};
let clock = Date.parse("2026-09-10T21:00:00.000Z");
const originalNow = Date.now;
Date.now = () => clock;

function memory(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    get: (key) => values.get(key),
    set: (key, value) => values.set(key, value),
    values,
  };
}

function runtimeGlobal(policyOverrides = {}) {
  return memory({
    location_policy_v1: { ...LOCATION_POLICY, ...policyOverrides },
    security_light_policy_v1: SECURITY_LIGHT_POLICY,
    publicBindings: {
      roles: {
        resident_primary: {
          source_alias: "example_primary",
          display_name: "Example Primary",
        },
        resident_secondary: {
          source_alias: "example_secondary",
          display_name: "Example Secondary",
        },
      },
    },
  });
}

function runSecurityArrival(message, flow, globalContext = runtimeGlobal()) {
  let msg = run("security_visual_arrival_facts", message, flow, globalContext);
  if (!msg._light_arrival.direction_and_arrival_valid) {
    msg = run("security_light_arrival_direction_blocked_v1", msg, flow, globalContext);
  } else {
    msg = run("security_visual_arrival_pending", msg, flow, globalContext);
    if (msg._light_arrival.logic_ready) {
      msg = run("security_visual_arrival_ready", msg, flow, globalContext);
    } else if (msg._light_arrival.recovery_needed && msg._light_arrival.recovery_allowed) {
      msg = run("security_visual_arrival_recovery", msg, flow, globalContext);
    } else if (msg._light_arrival.recovery_needed) {
      msg = run("security_visual_arrival_throttled", msg, flow, globalContext);
    } else {
      msg = run("security_visual_arrival_pending_only", msg, flow, globalContext);
    }
  }
  return run("62f77a1ad440639d", msg, flow, globalContext);
}

function runSecurityContext(message, flow, globalContext = runtimeGlobal()) {
  let msg = run("security_visual_context_cache", message, flow, globalContext);
  msg = run("security_visual_pending_validate", msg, flow, globalContext);
  if (msg._light_context.replay_ready) {
    msg = run("security_visual_replay_build", msg, flow, globalContext);
  }
  return run("48a5f40d806f6950", msg, flow, globalContext);
}

function run(id, msg, flow = memory(), globalContext = runtimeGlobal()) {
  const target = byId.get(id);
  assert(target?.type === "function", `Function node ausente: ${id}`);
  const execute = new Function(
    "msg",
    "node",
    "context",
    "flow",
    "global",
    "env",
    "setTimeout",
    "clearTimeout",
    target.func,
  );
  return execute(
    msg,
    { warn() {}, error() {}, log() {}, status() {} },
    {},
    flow,
    globalContext,
    { get: (key) => ({ HOME_LAT: "0", HOME_LON: "0", GATE_LAT: "0", GATE_LON: "0" })[key] },
    setTimeout,
    clearTimeout,
  );
}

function runVehicleLifecycle(message, flow = memory(), globalContext = runtimeGlobal()) {
  let msg = run("vehicle_visual_test_adapter", message, flow, globalContext);
  msg = run("vehicle_visual_normalize", msg, flow, globalContext);
  msg = run("vehicle_visual_movement", msg, flow, globalContext);
  msg = run("vehicle_visual_state_load", msg, flow, globalContext);
  const data = msg._vehicle;
  const near = data.location.ready && (
    (data.location.gate_distance_m !== null &&
      data.location.gate_distance_m <= data.policy.near_home_radius_m) ||
    (data.location.distance_m !== null &&
      data.location.distance_m <= data.policy.near_home_radius_m) ||
    (data.location.distance_m === null && data.location.gate_distance_m === null &&
      data.location.state === "home")
  );
  const away = data.location.ready && (data.location.distance_m !== null
    ? data.location.distance_m > data.policy.home_radius_m
    : data.location.state === "not_home");
  if (data.engine_on) {
    data.in_use = true;
    data.in_use_reason = "known_engine_on";
  } else if (data.engine_off) {
    data.in_use = false;
    data.in_use_reason = "known_engine_off";
  } else if (data.recovery.in_use === true && away) {
    data.in_use = true;
    data.in_use_reason = "persisted_trip_revalidated_by_fresh_away_location";
  } else if (data.lock_fresh && data.unlocked && near) {
    data.in_use = false;
    data.in_use_reason = "fresh_home_unlocked_engine_pending";
  }
  msg = run("vehicle_visual_arrival_facts", msg, flow, globalContext);
  if (msg._vehicle.facts.arrival_eligible) {
    msg = run("vehicle_visual_arrival_build", msg, flow, globalContext);
    msg = run("vehicle_visual_arrival_dedupe", msg, flow, globalContext);
  } else if (msg._vehicle.facts.blocked_candidate) {
    msg = run("vehicle_visual_blocked_build", msg, flow, globalContext);
  }
  msg = run("vehicle_visual_state_finalize", msg, flow, globalContext);
  msg = run("vehicle_visual_evidence_read", msg, flow, globalContext);
  if (msg._vehicle.evidence.awaiting && msg._vehicle.evidence.confirmed) {
    msg = run("vehicle_visual_evidence_confirm", msg, flow, globalContext);
  }
  return run("092625f2eb5cc156", msg, flow, globalContext);
}

function iso(ageMs = 0) {
  return new Date(clock - ageMs).toISOString();
}

function tracker(
  entityId,
  state,
  { ageMs = 0, accuracy = 10, distanceM = 1000, coordinates = true } = {},
) {
  const attributes = {
    gps_accuracy: String(accuracy),
    location_observed_at: iso(ageMs),
    source_reported_at: iso(Math.min(ageMs, 60_000)),
  };
  if (coordinates) {
    attributes.latitude = String(distanceM / 111_200);
    attributes.longitude = "0";
  }
  return {
    entity_id: entityId,
    state,
    attributes,
    last_changed: iso(ageMs),
    last_updated: iso(Math.min(ageMs, 60_000)),
  };
}

function input(primary, fallback, source = "refresh") {
  const homePrimary = tracker("device_tracker.mobile_secondary_source_1", "home", { distanceM: 20 });
  const homeFallback = tracker("device_tracker.mobile_secondary_source_2", "home", { distanceM: 20 });
  return {
    payload: {
      event: source === "refresh" ? "context_snapshot" : "location_update",
      source,
      trigger_entity: primary.entity_id,
      trigger_state: primary.state,
      trigger_prev_state: "not_home",
      resident_primary: primary,
      resident_primary_icloud: fallback,
      resident_secondary: homePrimary,
      resident_secondary_icloud: homeFallback,
    },
  };
}

function select(message, flow = memory(), globalContext = runtimeGlobal()) {
  const normalized = run("people_location_observation_v1", message, flow, globalContext);
  const selected = run("people_location_select_v1", normalized, flow, globalContext);
  return run("people_location_classify_near_home_v1", selected, flow, globalContext);
}

const primaryId = "device_tracker.mobile_primary_source_1";
const fallbackId = "device_tracker.mobile_primary_source_2";

{
  const controls = {
    near: byId.get("people_location_near_home_radius_v1"),
    home: byId.get("people_location_home_radius_v1"),
    localExcursion: byId.get("people_visual_local_excursion"),
  };
  assert.deepEqual(
    [controls.near.topic, controls.home.topic],
    ["near_home_radius_m", "home_radius_m"],
  );
  assert.deepEqual(
    [controls.near.payload, controls.home.payload],
    ["700", "100"],
  );
  assert.equal(controls.localExcursion.payload, "90");
  assert.equal(controls.localExcursion.topic, "local_excursion_minutes");
  assert.equal(byId.has("people_location_fast_refresh_radius_v1"), false);

  const policyContext = runtimeGlobal();
  const rejected = run(
    "people_location_policy_apply_v1",
    { topic: "near_home_radius_m", payload: 1600 },
    memory(),
    policyContext,
  );
  assert.equal(rejected, null);
  assert.equal(
    policyContext.get("location_policy_v1").near_home_radius_m,
    700,
    "um raio além do geofence técnico não pode substituir a política válida",
  );
}

{
  const legacyWakeRing = select(input(
    tracker(primaryId, "location_update_ring", { distanceM: 1450 }),
    tracker(fallbackId, "unavailable", { ageMs: 5 * 60_000, coordinates: false }),
    "resident_primary",
  ));
  assert.equal(
    legacyWakeRing.payload.trigger_state,
    "not_home",
    "o anel técnico de 1.500 m não pode antecipar near_home de 700 m",
  );
  const staleNamedZone = select(input(
    tracker(primaryId, "legacy_custom_zone", { distanceM: 1450 }),
    tracker(fallbackId, "unavailable", { ageMs: 5 * 60_000, coordinates: false }),
    "resident_primary",
  ));
  assert.equal(
    staleNamedZone.payload.trigger_state,
    "not_home",
    "um nome de zona bruto não pode escapar como estado canônico",
  );

  const defaultBoundary = select(input(
    tracker(primaryId, "location_update_ring", { distanceM: 800 }),
    tracker(fallbackId, "unavailable", { ageMs: 5 * 60_000, coordinates: false }),
    "resident_primary",
  ));
  assert.equal(defaultBoundary.payload.trigger_state, "not_home");

  const widerBoundary = select(input(
    tracker(primaryId, "location_update_ring", { distanceM: 800 }),
    tracker(fallbackId, "unavailable", { ageMs: 5 * 60_000, coordinates: false }),
    "resident_primary",
  ), memory(), runtimeGlobal({ near_home_radius_m: 900 }));
  assert.equal(widerBoundary.payload.trigger_state, "near_home");

  const widerHome = select(input(
    tracker(primaryId, "location_update_ring", { distanceM: 120 }),
    tracker(fallbackId, "unavailable", { ageMs: 5 * 60_000, coordinates: false }),
    "resident_primary",
  ), memory(), runtimeGlobal({ home_radius_m: 150 }));
  assert.equal(widerHome.payload.trigger_state, "home");
}

{
  const selected = select(input(
    tracker(primaryId, "location_update_ring", { ageMs: 3 * 24 * 60 * 60_000, accuracy: 4 }),
    tracker(fallbackId, "home", { accuracy: 25, distanceM: 20 }),
  ));
  assert.equal(selected._canonical_locations.resident_primary.selected.entity.entity_id, fallbackId);
  assert.equal(selected._canonical_locations.resident_primary.reason, "fresh_location");
}

{
  const flow = memory();
  const changed = iso();
  const vehicleMessage = (distanceM) => ({
    payload: {
      event: "location_update",
      source: "vehicle_primary",
      trigger_state: "location_update_ring",
      trigger_prev_state: "not_home",
      vehicle_primary: tracker(
        "device_tracker.vehicle_primary",
        "location_update_ring",
        { distanceM },
      ),
      vehicle_primary_engine: { state: "on", last_updated: changed },
      vehicle_primary_lock: { state: "locked", last_updated: changed },
      vehicle_primary_last_updated: { state: changed, last_updated: changed },
    },
  });
  const far = run(
    "vehicle_primary_classify_near_home_v1",
    vehicleMessage(800),
    flow,
  );
  assert.equal(far.payload.vehicle_primary.state, "not_home");
  runVehicleLifecycle(far, flow);
  clock += 61_000;
  const near = run(
    "vehicle_primary_classify_near_home_v1",
    vehicleMessage(650),
    flow,
  );
  assert.equal(near.payload.trigger_prev_state, "not_home");
  assert.equal(near.payload.trigger_state, "near_home");
  const result = runVehicleLifecycle(near, flow);
  assert.equal(result[1].payload.arrival_stage, "approach");
}

{
  const selected = select(input(
    tracker(primaryId, "location_update_ring", { accuracy: 999 }),
    tracker(fallbackId, "home", { accuracy: 10, distanceM: 20 }),
  ));
  assert.equal(selected._canonical_locations.resident_primary.selected.entity.entity_id, fallbackId);
  assert.equal(selected._canonical_locations.resident_primary.reason, "reliable_coordinates");
}

{
  const selected = select(input(
    tracker(primaryId, "not_home", { accuracy: 50 }),
    tracker(fallbackId, "home", { ageMs: 2 * 60_000, accuracy: 4, distanceM: 20 }),
  ));
  assert.equal(selected._canonical_locations.resident_primary.selected.entity.entity_id, primaryId);
}

{
  const selected = select(input(
    tracker(primaryId, "location_update_ring", { ageMs: 5_000, accuracy: 10 }),
    tracker(fallbackId, "home", { accuracy: 4, distanceM: 20 }),
  ));
  assert.equal(selected._canonical_locations.resident_primary.selected.entity.entity_id, fallbackId);
  assert.equal(selected._canonical_locations.resident_primary.reason, "better_accuracy_within_tie");
}

{
  const selected = select(input(
    tracker(primaryId, "home", { ageMs: 98 * 60_000, accuracy: 20, distanceM: 20 }),
    tracker(fallbackId, "unavailable", { ageMs: 55 * 60_000, coordinates: false }),
  ));
  assert.equal(selected._canonical_locations.resident_primary.selected.entity.entity_id, primaryId);
}

{
  const flow = memory();
  const before = select(input(
    tracker(primaryId, "not_home", { distanceM: 2000 }),
    tracker(fallbackId, "home", { ageMs: 5 * 60_000, distanceM: 20 }),
  ), flow);
  assert.equal(before.payload.event, "context_snapshot");
  clock += 30_000;
  const approaching = tracker(primaryId, "location_update_ring", { distanceM: 650 });
  const current = select(input(
    approaching,
    tracker(fallbackId, "home", { ageMs: 5 * 60_000, distanceM: 20 }),
    "resident_primary",
  ), flow);
  assert.equal(current.payload.trigger_prev_state, "not_home");
  assert.equal(current.payload.trigger_state, "near_home");
  assert.equal(current.payload.trigger_entity, "device_tracker.resident_primary_location");

  const published = run("people_location_publish_state_v1", structuredClone(current), flow);
  const primaryStateMessage = published[0].find(
    (message) => message.topic === "smart_home/location/resident_primary/state",
  );
  assert.equal(primaryStateMessage.payload, "near_home");
  const primaryState = JSON.parse(published[0].find(
    (message) => message.topic === "smart_home/location/resident_primary/attributes",
  ).payload);
  assert.equal(primaryState.decision_owner, "node_red");
  assert.equal(primaryState.state, "near_home");
  assert.equal(primaryState.raw_location_state, "location_update_ring");
  assert.equal(primaryState.home_radius_m, 100);
  assert.equal(primaryState.near_home_radius_m, 700);
  assert.equal(primaryState.selected_location_source, "Home Assistant App");
  assert.equal(primaryState.location_fresh_minutes, 15);
  assert.equal(primaryState.source_report_fresh_minutes, 75);
  assert.equal(primaryState.location_sources[0].position_fresh, true);
  assert.equal(primaryState.location_sources[0].reporting_fresh, true);
  assert.equal(primaryState.location_sources[0].reliable_coordinates, true);
}

{
  const stale = select(input(
    tracker(primaryId, "home", { ageMs: 25 * 60_000, distanceM: 20 }),
    tracker(fallbackId, "location_update_ring", { ageMs: 20 * 60_000, distanceM: 429 }),
    "resident_primary",
  ));
  const published = run("people_location_publish_state_v1", structuredClone(stale), memory());
  const stateMessage = published[0].find(
    (message) => message.topic === "smart_home/location/resident_primary/state",
  );
  const attributes = JSON.parse(published[0].find(
    (message) => message.topic === "smart_home/location/resident_primary/attributes",
  ).payload);
  assert.equal(stateMessage.payload, "unavailable");
  assert.equal(attributes.state, "unavailable");
  assert.equal(attributes.raw_location_state, "location_update_ring");
  assert.equal(attributes.location_fresh, false);
  assert.equal("latitude" in attributes, false);
  assert.equal("longitude" in attributes, false);
  assert.equal("gps_accuracy" in attributes, false);
}

{
  const people = byId.get("554cb653b2fa4504");
  const vehicle = byId.get("092625f2eb5cc156");
  const peopleClassifier = byId.get("people_location_classify_near_home_v1");
  const vehicleClassifier = byId.get("vehicle_primary_classify_near_home_v1");
  assert.doesNotMatch(people.func, /mergeTrackers|TRACKER_SELECTION_VERSION/);
  assert.ok(people.func.length < 4000, "finalizador de pessoas deve ser pequeno");
  assert.ok(vehicle.func.length < 4000, "finalizador do veículo deve ser pequeno");
  assert.match(byId.get("people_visual_normalize").func, /policy\.home_radius_m/);
  assert.match(byId.get("people_visual_facts").func, /external_cycle_confirm_seconds/);
  assert.match(byId.get("vehicle_visual_normalize").func, /location_policy_v1/);
  assert.match(byId.get("vehicle_visual_arrival_facts").func, /external_cycle_confirm_seconds/);
  assert.match(byId.get("vehicle_visual_movement").func, /movement_threshold_m/);
  assert.equal(byId.get("people_visual_decision").type, "switch");
  assert.equal(byId.get("vehicle_visual_engine_on").type, "switch");
  assert.equal(byId.get("vehicle_visual_evidence_confirmed").type, "switch");
  assert.match(peopleClassifier.func, /location_update_ring/);
  assert.match(vehicleClassifier.func, /location_update_ring/);
  assert.doesNotMatch(
    byId.get("402fd0cc609443b7").func,
    /people_fast_refresh_radius_m|FAST_REFRESH_RADIUS_M/,
  );
  assert.doesNotMatch(byId.get("402fd0cc609443b7").func, /nearest_distance_m <= 2000/);
  assert.equal(byId.get("4189bb901d6a15c4").outputOnlyOnStateChange, false);
  assert.equal(byId.get("bc70805a5fe2f35d").outputOnlyOnStateChange, false);
  assert.equal(byId.get("people_visual_external_confirm").topic, "external_cycle_confirm_seconds");
  assert.equal(byId.get("people_visual_external_confirm").payload, "60");
  assert.equal(byId.get("people_visual_wake_ring_delay").topic,
    "wake_ring_refresh_delay_seconds");
  assert.equal(byId.get("people_visual_wake_ring_delay").payload, "45");
  assert.equal(byId.get("people_visual_wake_ring_repeat").topic,
    "wake_ring_refresh_repeat_seconds");
  assert.equal(byId.get("people_visual_wake_ring_repeat").payload, "60");

  const flow = memory({ vehicle_primary_arrival_armed: true });
  const changed = iso();
  const rawVehicleResult = {
    payload: {
      event: "location_update",
      source: "vehicle_primary",
      trigger_state: "not_home",
      trigger_prev_state: "not_home",
      vehicle_primary: tracker("device_tracker.vehicle_primary", "not_home", { distanceM: 650 }),
      vehicle_primary_engine: { state: "on", last_updated: changed },
      vehicle_primary_lock: { state: "locked", last_updated: changed },
      vehicle_primary_last_updated: { state: changed, last_updated: changed },
    },
  };
  const classifiedVehicleResult = run(
    "vehicle_primary_classify_near_home_v1",
    rawVehicleResult,
    flow,
  );
  const vehicleResult = runVehicleLifecycle(classifiedVehicleResult, flow);
  assert.equal(vehicleResult[1].payload.arrival_stage, "approach");
  assert.equal(vehicleResult[0].payload.context.movement_threshold_m, 250);
}

{
  const flow = memory({
    people_arrival_armed: { resident_primary: true, resident_secondary: false },
  });
  select(input(
    tracker(primaryId, "not_home", { distanceM: 2000 }),
    tracker(fallbackId, "unavailable", { coordinates: false }),
    "resident_primary",
  ), flow);
  clock += 1000;
  let ring = select(input(
    tracker(primaryId, "location_update_ring", { distanceM: 1450 }),
    tracker(fallbackId, "unavailable", { coordinates: false }),
    "resident_primary",
  ), flow);
  assert.equal(ring.payload.trigger_state, "not_home",
    "anel técnico não pode se tornar near_home fora do raio canônico");
  assert.equal(ring.payload.trigger_raw_prev_state, "not_home");
  assert.equal(ring.payload.trigger_raw_state, "location_update_ring");
  assert.equal(ring.payload.event, "location_update",
    "entrada nova no anel precisa alcançar a decisão de sondas");
  ring = run("people_visual_test_adapter", ring, flow);
  ring = run("people_visual_normalize", ring, flow);
  ring = run("people_visual_state_load", ring, flow);
  ring = run("people_visual_facts", ring, flow);
  assert.equal(ring._people.facts.wake_ring_entry, true);
  assert.equal(ring._people.facts.external_cycle_confirmed, true);
  assert.equal(ring._people.facts.approach_entry, false,
    "anel técnico não pode publicar aproximação sozinho");
  const probes = run("people_visual_wake_ring_refresh_build", ring, flow);
  assert.equal(probes[0].delay, 45_000);
  assert.equal(probes[1].delay, 105_000);
  assert.deepEqual(probes.map((probe) => probe.payload.refresh_probe), [1, 2]);
  assert.ok(probes.every((probe) =>
    probe.payload.kind === "arrival_location_refresh" &&
    probe.payload.source === "resident_primary"));
  const noArrival = run("554cb653b2fa4504", structuredClone(ring), flow);
  assert.equal(noArrival[1], null,
    "anel fora de near_home não pode emitir contrato de chegada");
  const unarmed = structuredClone(ring);
  unarmed._people.facts.external_cycle_confirmed = false;
  assert.deepEqual(
    run("people_visual_wake_ring_refresh_build", unarmed, flow),
    [null, null],
    "anel sem ciclo externo confirmado não pode consultar localização",
  );
  const dryRunRing = structuredClone(ring);
  dryRunRing._people.test_mode = true;
  const dryRunProbes = run("people_visual_wake_ring_refresh_build", dryRunRing, flow);
  assert.ok(dryRunProbes.every((probe) =>
    probe.delay === 1 && probe.payload.simulated === true &&
    probe.payload.dispatched === false));

  clock += 1000;
  const repeatedRing = select(input(
    tracker(primaryId, "location_update_ring", { distanceM: 1400 }),
    tracker(fallbackId, "unavailable", { coordinates: false }),
    "resident_primary",
  ), flow);
  assert.equal(repeatedRing.payload.event, "context_update",
    "atualização dentro do mesmo anel não pode reagendar as duas sondas");
  assert.deepEqual(
    byId.get("people_visual_arrival_refresh_in").links.sort(),
    [
      "people_visual_wake_ring_first_out",
      "people_visual_wake_ring_second_out",
      "security_visual_people_refresh_out",
    ].sort(),
  );
}

{
  const flow = memory({
    people_arrival_armed: { resident_primary: true, resident_secondary: false },
  });
  select(input(
    tracker(primaryId, "not_home", { distanceM: 2000 }),
    tracker(fallbackId, "unavailable", { coordinates: false }),
    "resident_primary",
  ), flow);
  clock += 1000;
  let nearRing = select(input(
    tracker(primaryId, "location_update_ring", { distanceM: 650 }),
    tracker(fallbackId, "unavailable", { coordinates: false }),
    "resident_primary",
  ), flow);
  assert.equal(nearRing.payload.trigger_state, "near_home");
  nearRing = run("people_visual_test_adapter", nearRing, flow);
  nearRing = run("people_visual_normalize", nearRing, flow);
  nearRing = run("people_visual_state_load", nearRing, flow);
  nearRing = run("people_visual_facts", nearRing, flow);
  assert.equal(nearRing._people.facts.approach_entry, true,
    "posição atual dentro de 700 m deve continuar gerando aproximação");
  assert.equal(nearRing._people.facts.wake_ring_entry, false,
    "posição já canônica em near_home não precisa das sondas do anel");
}

{
  const sync = byId.get("555422f47d3a742b");
  assert.deepEqual(sync.wires, [["people_visual_vehicle_refresh_recheck"]]);
  assert.deepEqual(
    byId.get("people_visual_vehicle_refresh_recheck_in").wires,
    [["402fd0cc609443b7"]],
  );
  assert.equal(byId.get("402fd0cc609443b7").outputs, 2);
  assert.match(
    byId.get("people_visual_primary_icloud_update").data,
    /"role":"resident_primary","action":"refresh_location"/,
  );
  assert.match(
    byId.get("people_visual_secondary_icloud_update").data,
    /"role":"resident_secondary","action":"refresh_location"/,
  );
  const notificationTab = byId.get("resident_notifications_tab");
  assert.equal(
    flows.filter((node) => node.z === notificationTab.id && node.type === "server-state-changed").length,
    0,
  );
}

{
  assert.equal(byId.get("security_light_arrival_direction_gate_v1").type, "switch");
  assert.equal(byId.get("security_visual_arrival_logic_ready").type, "switch");
  assert.equal(byId.get("security_visual_replay_ready").type, "switch");
  assert.match(byId.get("security_visual_arrival_pending").func, /arrival_recovery_ms/);
  assert.match(byId.get("security_visual_pending_validate").func, /resident_left_approach_zone/);
  assert.doesNotMatch(byId.get("security_visual_pending_validate").func, /vehicle_left_approach_zone/);
  assert.doesNotMatch(byId.get("62f77a1ad440639d").func, /arrival_recovery_minutes/);
}

{
  const start = clock;
  const flow = memory({
    people_context_v1: {
      ready: true,
      resident_secondary: {
        ready: true,
        stale: false,
        state: "near_home",
        current_home: false,
        updated_at: start,
      },
    },
    vehicle_primary_context_v1: {
      ready: false,
      lighting_ready: false,
      engine_state_valid: false,
      engine_on: null,
      in_use: null,
      location: { ready: true, stale: false, state: "near_home" },
      updated_at: start,
    },
    sun_ready: true,
    sun_below_horizon: true,
    light_reconciled: true,
    security_light_physical_state: "off",
    security_light_physical_observed_at: start,
  });
  const prepared = runSecurityArrival({
    payload: {
      kind: "arrival",
      source: "resident_secondary",
      arrival_source_type: "person",
      arrival_stage: "approach",
      arrival_previous_state: "not_home",
      arrival_direction: "returning",
      external_cycle_confirmed: true,
      event_at: start,
    },
  }, flow);
  assert.equal(prepared[0], null);
  assert.equal(
    flow.get("security_light_pending_arrival_v1").expires_at,
    start + 90 * 60_000,
  );

  clock = start + 151_000;
  const recovered = runSecurityContext({
    payload: {
      kind: "vehicle_primary_context",
      updated_at: clock,
      context: {
        ready: true,
        lighting_ready: true,
        engine_state_valid: true,
        engine_on: true,
        in_use: true,
        location: { ready: true, stale: false, state: "near_home" },
        updated_at: clock,
      },
    },
  }, flow);
  assert(recovered[2], "a chegada deve sobreviver aos 150 s de recovery do Bluelink");
  assert.equal(recovered[2].payload.arrival_replayed_after_context_recovery, true);
}

{
  const published = run("vehicle_location_panel_publish_v1", {
    payload: {
      kind: "vehicle_primary_context",
      context: {
        current_location_since: clock - 60_000,
        movement_threshold_m: 250,
        location: {
          state: "home",
          latitude: 0,
          longitude: 0,
          gps_accuracy: 12,
          updated_at: clock,
          ready: true,
          stale: false,
        },
      },
    },
  });
  assert.equal(published[0].length, 3);
  const trackerMessage = published[0].find(
    (message) => message.topic === "smart_home/location/vehicle_primary/state",
  );
  assert(trackerMessage);
  assert.equal(trackerMessage.payload, "home");
  const trackerState = JSON.parse(published[0].find(
    (message) => message.topic === "smart_home/location/vehicle_primary/attributes",
  ).payload);
  assert.equal(trackerState.state, "home");
  assert.equal(trackerState.decision_owner, "node_red");
  assert.equal(trackerState.location_fresh, true);
  assert.equal(trackerState.latitude, 0);

  const stalePublished = run("vehicle_location_panel_publish_v1", {
    payload: {
      kind: "vehicle_primary_context",
      context: {
        current_location_since: clock - 60_000,
        movement_threshold_m: 250,
        location: {
          state: "not_home",
          latitude: null,
          longitude: null,
          gps_accuracy: 0,
          updated_at: clock,
          ready: false,
          stale: true,
        },
      },
    },
  });
  assert.equal(stalePublished[0].find(
    (message) => message.topic === "smart_home/location/vehicle_primary/state",
  ).payload, "unavailable");
  const staleTracker = JSON.parse(stalePublished[0].find(
    (message) => message.topic === "smart_home/location/vehicle_primary/attributes",
  ).payload);
  assert.equal(staleTracker.state, "unavailable");
  assert.equal("latitude" in staleTracker, false);
  assert.equal("longitude" in staleTracker, false);

  const oldParkedPublished = run("vehicle_location_panel_publish_v1", {
    payload: {
      kind: "vehicle_primary_context",
      context: {
        current_location_since: clock - 3_600_000,
        movement_threshold_m: 250,
        location: {
          state: "unavailable",
          latitude: null,
          longitude: null,
          gps_accuracy: null,
          updated_at: clock,
          ready: false,
          stale: true,
        },
        last_confirmed_location: {
          state: "home",
          latitude: 0,
          longitude: 0,
          gps_accuracy: 12,
          updated_at: clock - 3_600_000,
        },
      },
    },
  });
  assert.equal(oldParkedPublished[0].find(
    (message) => message.topic === "smart_home/location/vehicle_primary/state",
  ).payload, "home");
  const oldParkedTracker = JSON.parse(oldParkedPublished[0].find(
    (message) => message.topic === "smart_home/location/vehicle_primary/attributes",
  ).payload);
  assert.equal(oldParkedTracker.state, "home");
  assert.equal(oldParkedTracker.location_fresh, false);
  assert.equal(oldParkedTracker.latitude, 0);
  assert.equal(oldParkedTracker.longitude, 0);

  const discovery = run("people_location_build_discovery_v1", {});
  const discoveryByTopic = new Map(
    discovery[0].map((message) => [message.topic, JSON.parse(message.payload)]),
  );
  assert.equal(
    discoveryByTopic.get("homeassistant/device_tracker/resident_primary_location/config")
      ?.default_entity_id,
    "device_tracker.resident_primary_location",
  );
  assert.equal(
    discoveryByTopic.get("homeassistant/device_tracker/resident_primary_location/config")
      ?.name,
    null,
  );
  assert.equal(
    discoveryByTopic.get("homeassistant/device_tracker/resident_primary_location/config")
      ?.has_entity_name,
    true,
  );
  assert.equal(
    discoveryByTopic.get("homeassistant/device_tracker/resident_primary_location/config")
      ?.device?.name,
    "Example Primary",
  );
  assert.equal(
    discoveryByTopic.get("homeassistant/device_tracker/resident_primary_location/config")
      ?.json_attributes_topic,
    "smart_home/location/resident_primary/attributes",
  );
  assert.equal(
    "value_template" in discoveryByTopic.get(
      "homeassistant/device_tracker/resident_primary_location/config",
    ),
    false,
  );
  assert.equal(
    discoveryByTopic.get("homeassistant/device_tracker/resident_secondary_location/config")
      ?.default_entity_id,
    "device_tracker.resident_secondary_location",
  );
  assert.equal(
    discoveryByTopic.get("homeassistant/device_tracker/resident_secondary_location/config")
      ?.device?.name,
    "Example Secondary",
  );
  assert.equal(
    discoveryByTopic.get(
      "homeassistant/device_tracker/vehicle_primary_location_nodered/config",
    )?.default_entity_id,
    "device_tracker.vehicle_primary_location_nodered",
  );
  assert.equal(
    discoveryByTopic.get(
      "homeassistant/device_tracker/vehicle_primary_location_nodered/config",
    )?.json_attributes_topic,
    "smart_home/location/vehicle_primary/attributes",
  );
  assert.equal(
    discoveryByTopic.get(
      "homeassistant/device_tracker/vehicle_primary_location_nodered/config",
    )?.name,
    null,
  );
  assert.equal(
    discoveryByTopic.get(
      "homeassistant/device_tracker/vehicle_primary_location_nodered/config",
    )?.has_entity_name,
    true,
  );
  assert.equal(
    discoveryByTopic.get(
      "homeassistant/device_tracker/vehicle_primary_location_nodered/config",
    )?.device?.name,
    "Creta",
  );
  assert.equal(
    discoveryByTopic.get(
      "homeassistant/sensor/vehicle_primary_location_since_nodered/config",
    )?.default_entity_id,
    "sensor.vehicle_primary_location_since_nodered",
  );
}

{
  const locationComponent = fs.readFileSync(
    new URL("../../homeassistant/custom_components/public_bindings/__init__.py", import.meta.url),
    "utf8",
  );
  const locationHelpers = fs.readFileSync(
    new URL("../../homeassistant/custom_components/public_bindings/location.py", import.meta.url),
    "utf8",
  );
  const vehicleControls = fs.readFileSync(
    new URL("../../homeassistant/packages/vehicle_primary_controls.yaml", import.meta.url),
    "utf8",
  );
  const vehicleDashboard = fs.readFileSync(
    new URL("../../homeassistant/dashboards/vehicle_primary.yaml", import.meta.url),
    "utf8",
  );
  const locationDashboard = fs.readFileSync(
    new URL("../../homeassistant/dashboards/location.yaml", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(locationComponent, /select_best_location|selection_mode/);
  assert.doesNotMatch(locationHelpers, /select_best_location/);
  assert.doesNotMatch(vehicleControls, /0\.0023|vehicle_primary_current_location_since/);
  assert.match(vehicleDashboard, /sensor\.vehicle_primary_location_since_nodered/);
  assert.match(vehicleDashboard, /device_tracker\.vehicle_primary_location_nodered/);
  assert.doesNotMatch(vehicleDashboard, /states\.device_tracker\.vehicle_primary\s/);
  assert.match(locationDashboard, /source\.reporting_fresh/);
  assert.match(locationDashboard, /source\.position_fresh/);
  assert.doesNotMatch(locationDashboard, /report_age|gps_age|4500|10800|900/);
}

Date.now = originalNow;
console.log("canonical location flow: seleção, 700 m, recovery e painéis OK");
