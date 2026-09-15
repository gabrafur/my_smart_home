const data = msg._vehicle;
const key = (name) => data.test_mode ? name + "__test" : name;
const set = (name, value, store) => data.test_mode || !store
    ? flow.set(key(name), value) : flow.set(key(name), value, store);
set("vehicle_primary_in_use", data.in_use);
set("vehicle_primary_arrival_armed", data.armed);
data.recovery.arrival_armed = data.armed;
data.recovery.external_since = data.external_since;
if (data.in_use !== null) {
    data.recovery.in_use = data.in_use;
    data.recovery.last_confirmed_at = Date.now();
}
data.recovery.in_use_reason = data.in_use_reason;
if (data.in_use !== null) data.recovery.trip_active = data.in_use === true && data.facts.away;
if (data.recovery.trip_active && !Number.isFinite(data.recovery.trip_started_at)) {
    data.recovery.trip_started_at = Date.now();
}
if (data.in_use === false) data.recovery.trip_started_at = null;
data.recovery.updated_at = Date.now();
set("security_vehicle_primary_recovery_v1", data.recovery, "persistent");
data.context = {
    location: data.location,
    current_location_since: Number(data.location_observation?.updated_at ?? 0) || null,
    movement_threshold_m: Number(data.policy.movement_threshold_m),
    home_radius_m: Number(data.policy.home_radius_m),
    near_home_radius_m: Number(data.policy.near_home_radius_m),
    last_confirmed_location: data.location_observation ? { ...data.location_observation } : null,
    telemetry_updated_at: data.telemetry_updated_at,
    telemetry_timestamp_future: data.telemetry_timestamp_future,
    cache_scanned_at: data.cache_scanned_at,
    cache_timestamp_future: data.cache_timestamp_future,
    distance_home_m: data.location.distance_m,
    home: data.location.ready ? data.facts.home : null,
    near_home: data.location.ready ? data.facts.near_home && !data.facts.home : null,
    away: data.location.ready ? data.facts.away : null,
    approaching_home: data.arrival?.payload?.arrival_stage === "approach",
    arrived_home: data.arrival?.payload?.arrival_stage === "home",
    engine_on: data.engine_on,
    engine_state: data.engine_state,
    engine_state_valid: data.engine_known,
    engine_stale: !data.engine_fresh,
    engine_communication_failed: data.engine_communication_failed,
    engine_updated_at: data.engine_updated_at,
    lock_state: data.lock_state,
    unlocked: data.unlocked,
    lock_state_valid: data.lock_fresh && ["locked", "unlocked"].includes(data.lock_state),
    lock_stale: !data.lock_fresh,
    lock_updated_at: data.lock_updated_at,
    in_use: data.in_use,
    in_use_pending: data.in_use === null,
    in_use_reason: data.in_use_reason,
    trip_active: data.in_use === true && data.recovery.trip_active === true,
    trip_started_at: data.recovery.trip_started_at ?? null,
    state_valid: data.location.state_valid,
    ready: data.location.ready && data.in_use !== null,
    lighting_ready: data.location.ready && data.engine_known && !data.engine_communication_failed,
    stale: data.location.stale || data.in_use === null,
    updated_at: Math.max(...[data.location.updated_at, data.engine_updated_at,
        data.lock_updated_at].filter(Number.isFinite), 0),
    arrival_armed: data.armed
};
return msg;
