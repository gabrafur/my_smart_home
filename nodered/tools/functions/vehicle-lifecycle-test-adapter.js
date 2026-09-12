const TEST_MODE = msg._location_test === true || msg.payload?.test_mode === true;
if (!TEST_MODE || msg.payload?.event !== "context_snapshot") return msg;
if (msg._location_test_reset === true) {
    for (const key of [
        "security_vehicle_primary_recovery_v1__test",
        "vehicle_primary_arrival_armed__test",
        "vehicle_primary_in_use__test",
        "vehicle_primary_context_v1__test",
        "security_vehicle_primary_recovery_logged__test",
        "security_vehicle_primary_ready_logged__test",
        "vehicle_primary_location_observation_v1__test",
        "security_vehicle_primary_test_clock",
        "security_vehicle_primary_refresh_v1__test"
    ]) flow.set(key, undefined);
}
const SHARED = "security_location_test_state_v1";
let shared = global.get(SHARED);
if (!shared || shared.version !== 1) {
    shared = {
        version: 1,
        resident_primary: "home",
        resident_secondary: "home",
        vehicle_primary: "home",
        vehicle_primary_engine: "off",
        vehicle_primary_lock: "locked",
        observed_at: Date.now(),
        transitions: {}
    };
    global.set(SHARED, shared);
}
const observedAt = Math.max(Date.now(), Number(shared.observed_at || 0));
const timestamp = new Date(observedAt).toISOString();
const entity = (entity_id, state, attributes = {}) => ({
    entity_id, state, attributes, last_changed: timestamp, last_updated: timestamp
});
const transition = shared.transitions?.vehicle_primary;
const active = transition?.domain === "vehicle_primary" &&
    transition?.test_case === msg._location_test_case &&
    msg._location_test_reset !== true;
const refreshCycleId = msg.payload?.refresh_cycle_id;
msg.payload = {
    event: active ? "location_update" : "context_snapshot",
    source: active ? "vehicle_primary" : "refresh",
    refresh_cycle_id: refreshCycleId,
    trigger_entity: active ? "device_tracker.vehicle_primary" : undefined,
    trigger_state: active ? transition.state : undefined,
    trigger_prev_state: active ? transition.prev : undefined,
    vehicle_primary: entity("device_tracker.vehicle_primary", shared.vehicle_primary,
        { gps_accuracy: 20 }),
    vehicle_primary_engine: entity("binary_sensor.vehicle_primary_engine",
        shared.vehicle_primary_engine),
    vehicle_primary_lock: entity("lock.vehicle_primary_door_lock",
        shared.vehicle_primary_lock),
    vehicle_primary_last_updated: entity("sensor.vehicle_primary_last_updated_at", timestamp)
};
return msg;
