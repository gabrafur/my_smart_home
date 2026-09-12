const TEST_MODE = msg._location_test === true || msg.payload?.test_mode === true;
if (!TEST_MODE || msg.payload?.event !== "context_snapshot") return msg;
if (msg._location_test_reset === true) {
    for (const key of [
        "security_people_recovery_v1__test",
        "people_arrival_armed__test",
        "people_context_v1__test",
        "security_people_ready_logged__test",
        "security_people_test_clock"
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
const tracker = (entity_id, state) => ({
    entity_id,
    state,
    attributes: { gps_accuracy: 20 },
    last_changed: timestamp,
    last_updated: timestamp
});
const transition = shared.transitions?.people;
const active = transition?.domain === "people" &&
    transition?.test_case === msg._location_test_case &&
    msg._location_test_reset !== true;
const source = active ? transition.source : "refresh";
const refreshCycleId = msg.payload?.refresh_cycle_id;
msg.payload = {
    event: active ? "location_update" : "context_snapshot",
    source,
    refresh_cycle_id: refreshCycleId,
    trigger_entity: active
        ? "device_tracker." + (source === "resident_primary"
            ? "mobile_primary_source_1" : "mobile_secondary_source_1")
        : undefined,
    trigger_state: active ? transition.state : undefined,
    trigger_prev_state: active ? transition.prev : undefined,
    resident_primary: tracker("device_tracker.mobile_primary_source_1", shared.resident_primary),
    resident_primary_icloud: tracker("device_tracker.mobile_primary_source_2", shared.resident_primary),
    resident_secondary: tracker("device_tracker.mobile_secondary_source_1", shared.resident_secondary),
    resident_secondary_icloud: tracker("device_tracker.mobile_secondary_source_2", shared.resident_secondary)
};
msg.payload.resident_primary_selected = msg.payload.resident_primary;
msg.payload.resident_secondary_selected = msg.payload.resident_secondary;
return msg;
