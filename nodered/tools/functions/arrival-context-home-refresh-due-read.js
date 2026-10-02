const testMode = msg._location_test === true || msg.payload?.test_mode === true;
const pendingKey = testMode ? "resident_home_refresh_v2__test" : "resident_home_refresh_v2";
const legacyKey = testMode ? "resident_home_refresh_v1__test" : "resident_home_refresh_v1";
const get = (key) => testMode ? flow.get(key) : flow.get(key, "persistent");
const set = (key, value) => testMode
    ? flow.set(key, value)
    : flow.set(key, value, "persistent");
let pendingState = get(pendingKey);
if (pendingState?.version !== 2 || !pendingState.residents) {
    const legacy = get(legacyKey);
    pendingState = { version: 2, residents: {} };
    if (legacy?.version === 1 &&
        ["resident_primary", "resident_secondary"].includes(legacy.source)) {
        pendingState.residents[legacy.source] = legacy;
    }
    if (Object.keys(pendingState.residents).length) set(pendingKey, pendingState);
    set(legacyKey, undefined);
}
const testNow = Number(msg.payload?.test_now);
const monitorNow = Number(msg.monitor_now);
msg._location_test = testMode;
msg.home_refresh_due_base = {
    pending_key: pendingKey,
    pending_state: pendingState,
    now: testMode && Number.isFinite(testNow) ? testNow
        : Number.isFinite(monitorNow) ? monitorNow : Date.now(),
    people: flow.get(testMode ? "people_context_v1__test" : "people_context_v1") ?? {},
    vehicle: flow.get(testMode ? "vehicle_primary_context_v1__test" : "vehicle_primary_context_v1") ?? {}
};
const base = msg.home_refresh_due_base;
const policy = global.get("location_policy_v1", "persistent") ?? {};
base.engine_at = Number(base.vehicle.telemetry_updated_at ?? base.vehicle.engine_updated_at);
base.engine_fresh = base.engine_at > 0 &&
    base.engine_at <= base.now + Number(policy.future_tolerance_seconds) * 1000 &&
    base.now - base.engine_at <= Number(policy.vehicle_signal_fresh_minutes) * 60000 &&
    base.vehicle.engine_communication_failed !== true;
return msg;
