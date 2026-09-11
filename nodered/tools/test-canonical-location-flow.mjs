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
  arrival_distance_m: 700,
  location_fresh_minutes: 15,
  source_report_fresh_minutes: 75,
  recency_tie_seconds: 60,
  max_gps_accuracy_m: 100,
  vehicle_location_fresh_minutes: 30,
  movement_threshold_m: 250,
  arm_distance_m: 100,
  arrival_recovery_minutes: 10,
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

function runtimeGlobal() {
  return memory({
    location_policy_v1: LOCATION_POLICY,
    publicBindings: {
      roles: {
        resident_primary: { source_alias: "Example Primary" },
        resident_secondary: { source_alias: "Example Secondary" },
      },
    },
  });
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

function select(message, flow = memory()) {
  const normalized = run("people_location_observation_v1", message, flow);
  return run("people_location_select_v1", normalized, flow);
}

const primaryId = "device_tracker.mobile_primary_source_1";
const fallbackId = "device_tracker.mobile_primary_source_2";

{
  const selected = select(input(
    tracker(primaryId, "chegando", { ageMs: 3 * 24 * 60 * 60_000, accuracy: 4 }),
    tracker(fallbackId, "home", { accuracy: 25, distanceM: 20 }),
  ));
  assert.equal(selected._canonical_locations.resident_primary.selected.entity.entity_id, fallbackId);
  assert.equal(selected._canonical_locations.resident_primary.reason, "fresh_location");
}

{
  const selected = select(input(
    tracker(primaryId, "chegando", { accuracy: 999 }),
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
    tracker(primaryId, "chegando", { ageMs: 5_000, accuracy: 10 }),
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
  const approaching = tracker(primaryId, "chegando", { distanceM: 650 });
  const current = select(input(
    approaching,
    tracker(fallbackId, "home", { ageMs: 5 * 60_000, distanceM: 20 }),
    "resident_primary",
  ), flow);
  assert.equal(current.payload.trigger_prev_state, "not_home");
  assert.equal(current.payload.trigger_state, "chegando");
  assert.equal(current.payload.trigger_entity, "device_tracker.resident_primary_location");

  const published = run("people_location_publish_state_v1", structuredClone(current), flow);
  const primaryStateMessage = published[0].find(
    (message) => message.topic === "smart_home/location/resident_primary/state",
  );
  assert.equal(primaryStateMessage.payload, "chegando");
  const primaryState = JSON.parse(published[0].find(
    (message) => message.topic === "smart_home/location/resident_primary/attributes",
  ).payload);
  assert.equal(primaryState.decision_owner, "node_red");
  assert.equal(primaryState.state, "chegando");
  assert.equal(primaryState.arrival_distance_m, 700);
  assert.equal(primaryState.selected_location_source, "Home Assistant App");
  assert.equal(primaryState.location_fresh_minutes, 15);
  assert.equal(primaryState.source_report_fresh_minutes, 75);
  assert.equal(primaryState.location_sources[0].position_fresh, true);
  assert.equal(primaryState.location_sources[0].reporting_fresh, true);
  assert.equal(primaryState.location_sources[0].reliable_coordinates, true);
}

{
  const people = byId.get("554cb653b2fa4504");
  const vehicle = byId.get("092625f2eb5cc156");
  assert.doesNotMatch(people.func, /mergeTrackers|TRACKER_SELECTION_VERSION/);
  assert.match(people.func, /LOCATION_POLICY\.arrival_distance_m/);
  assert.match(vehicle.func, /LOCATION_POLICY\.arrival_distance_m/);
  assert.match(vehicle.func, /LOCATION_POLICY\.movement_threshold_m/);

  const flow = memory({ vehicle_primary_arrival_armed: true });
  const changed = iso();
  const vehicleResult = run("092625f2eb5cc156", {
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
  }, flow);
  assert.equal(vehicleResult[1].payload.arrival_stage, "home");
  assert.equal(vehicleResult[0].payload.context.movement_threshold_m, 250);
}

{
  const sync = byId.get("555422f47d3a742b");
  assert.deepEqual(
    new Set(sync.wires[0]),
    new Set(["564fdc36031eaef8", "e0b7c0ecf1d8ee28"]),
  );
  const notificationTab = byId.get("resident_notifications_tab");
  assert.equal(
    flows.filter((node) => node.z === notificationTab.id && node.type === "server-state-changed").length,
    0,
  );
}

{
  const prepare = byId.get("62f77a1ad440639d").func;
  const merge = byId.get("48a5f40d806f6950").func;
  assert.match(prepare, /arrival_recovery_minutes/);
  assert.match(prepare, /while_vehicle_approaching/);
  assert.doesNotMatch(prepare, /SHORT_RECOVERY_TTL_MS/);
  assert.match(merge, /ARRIVAL_RECOVERY_TTL_MS/);
  assert.match(merge, /vehicle_left_approach_zone/);
}

{
  const start = clock;
  const flow = memory({
    people_context_v1: { ready: true },
    vehicle_primary_context_v1: {
      ready: false,
      lighting_ready: false,
      engine_state_valid: false,
      engine_on: null,
      in_use: null,
      location: { ready: true, stale: false, state: "chegando" },
      updated_at: start,
    },
    sun_ready: true,
    sun_below_horizon: true,
    light_reconciled: true,
    security_light_physical_state: "off",
    security_light_physical_observed_at: start,
  });
  const prepared = run("62f77a1ad440639d", {
    payload: {
      kind: "arrival",
      source: "vehicle_primary",
      arrival_source_type: "vehicle_primary",
      arrival_stage: "approach",
      event_at: start,
    },
  }, flow);
  assert.equal(prepared[0], null);
  assert.equal(
    flow.get("security_light_pending_arrival_v1").expires_at,
    start + 10 * 60_000,
  );

  clock = start + 151_000;
  const recovered = run("48a5f40d806f6950", {
    payload: {
      kind: "vehicle_primary_context",
      updated_at: clock,
      context: {
        ready: true,
        lighting_ready: true,
        engine_state_valid: true,
        engine_on: true,
        in_use: true,
        location: { ready: true, stale: false, state: "chegando" },
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
