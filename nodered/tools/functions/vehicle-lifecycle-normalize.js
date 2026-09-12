const policy = global.get("location_policy_v1", "persistent");
if (policy?.version !== 1 || policy?.complete !== true) {
    node.error("Política canônica de localização ausente", msg);
    return null;
}
const TEST_MODE = msg._location_test === true || msg.payload?.test_mode === true;
const futureMs = Number(policy.future_tolerance_seconds) * 1000;
const freshMs = Number(policy.vehicle_location_fresh_minutes) * 60000;
const signalMs = Number(policy.vehicle_signal_fresh_minutes) * 60000;
const observedAt = (entity) => {
    const preferred = Date.parse(entity?.attributes?.location_observed_at ?? "");
    if (Number.isFinite(preferred)) return preferred;
    const value = Date.parse(entity?.last_updated ?? entity?.last_changed ?? "");
    return Number.isFinite(value) ? value : null;
};
const fresh = (entity, ttl) => {
    const value = observedAt(entity);
    return value !== null && value <= Date.now() + futureMs && Date.now() - value <= ttl;
};
const raw = msg.payload?.vehicle_primary ?? {};
const attrs = raw.attributes ?? {};
const state = raw.state;
const validState = typeof state === "string" && !["", "unknown", "unavailable"].includes(state);
const updatedAt = observedAt(raw);
const latitude = Number(attrs.latitude);
const longitude = Number(attrs.longitude);
const accuracy = Number(attrs.gps_accuracy);
const distanceHome = Number(attrs.canonical_distance_home_m);
const distanceGate = Number(attrs.canonical_distance_gate_m);
const location = {
    entity_id: raw.entity_id,
    state,
    latitude: Number.isFinite(latitude) ? latitude : null,
    longitude: Number.isFinite(longitude) ? longitude : null,
    gps_accuracy: Number.isFinite(accuracy) ? accuracy : null,
    location_reliable: Number.isFinite(latitude) && Number.isFinite(longitude),
    state_valid: validState && fresh(raw, freshMs),
    updated_at: updatedAt,
    stale: !fresh(raw, freshMs),
    ready: validState && fresh(raw, freshMs),
    distance_m: Number.isFinite(distanceHome) ? distanceHome : null,
    gate_distance_m: Number.isFinite(distanceGate) ? distanceGate : null,
    primary_home: Number.isFinite(distanceHome)
        ? distanceHome <= Number(policy.home_radius_m) : state === "home",
    primary_home_for_ms: Number.isFinite(Date.parse(raw.last_changed ?? ""))
        ? Date.now() - Date.parse(raw.last_changed) : null
};
const engineState = msg.payload?.vehicle_primary_engine?.state;
const lockState = msg.payload?.vehicle_primary_lock?.state;
const engineKnown = ["on", "running", "off", "stopped", "idle"].includes(engineState);
const engineOn = ["on", "running"].includes(engineState);
const engineOff = ["off", "stopped", "idle"].includes(engineState);
const engineFresh = fresh(msg.payload?.vehicle_primary_engine, signalMs);
const lockFresh = fresh(msg.payload?.vehicle_primary_lock, signalMs);
const refreshKey = TEST_MODE
    ? "security_vehicle_primary_refresh_v1__test" : "security_vehicle_primary_refresh_v1";
const refreshState = TEST_MODE ? flow.get(refreshKey) : flow.get(refreshKey, "persistent") ?? {};
const failureClasses = ["integration_unavailable", "provider_backoff", "authentication",
    "timeout", "no_fresh_data", "api_error"];
const engineCommunicationFailed = typeof refreshState?.engine_communication_failed === "boolean"
    ? refreshState.engine_communication_failed
    : failureClasses.includes(refreshState?.last_failure_class);
const telemetryAt = Date.parse(msg.payload?.vehicle_primary_last_updated?.state ?? "");
msg._vehicle = {
    test_mode: TEST_MODE,
    policy,
    location,
    engine_state: engineState,
    engine_on: engineOn,
    engine_off: engineOff,
    engine_known: engineKnown,
    engine_fresh: engineFresh,
    engine_communication_failed: engineCommunicationFailed,
    engine_updated_at: observedAt(msg.payload?.vehicle_primary_engine),
    lock_state: lockState,
    lock_fresh: lockFresh,
    lock_updated_at: observedAt(msg.payload?.vehicle_primary_lock),
    unlocked: lockFresh && lockState === "unlocked",
    telemetry_updated_at: Number.isFinite(telemetryAt) ? telemetryAt : null,
    is_location_event: msg.payload?.event === "location_update",
    event: msg.payload?.event,
    reason: msg.payload?.reason,
    trigger_entity: msg.payload?.trigger_entity,
    trigger_state: msg.payload?.trigger_state,
    trigger_prev_state: msg.payload?.trigger_prev_state,
    refresh_cycle_id: msg.payload?.refresh_cycle_id
};
return msg;
