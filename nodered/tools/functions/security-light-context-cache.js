const testMode = msg._location_test === true || msg.payload?.test_mode === true;
const testCase = msg._location_test_case ?? msg.payload?.test_case ?? null;
const locationPolicy = global.get("location_policy_v1", "persistent");
const lightPolicy = global.get("security_light_policy_v1", "persistent");
if (locationPolicy?.version !== 1 || locationPolicy?.complete !== true ||
    lightPolicy?.version !== 1 || lightPolicy?.complete !== true) {
    node.error("iluminacao_seguranca: política canônica ausente", msg);
    return null;
}
const suffix = testMode ? "__test" : "";
const get = (name, store) => testMode || !store
    ? flow.get(name + suffix) : flow.get(name, store);
const set = (name, value, store) => testMode || !store
    ? flow.set(name + suffix, value) : flow.set(name, value, store);
if (testMode && msg._location_test_reset === true) {
    for (const name of ["security_light_pending_arrival_v1", "security_light_lifecycle_v1",
        "security_light_arrival_watch_v1", "security_light_local_excursion_v1",
        "security_light_last_dry_run_v1", "security_light_turn_on_notification_latch_v1",
        "security_light_engine_bypass_enabled", "security_light_engine_bypass_automatic",
        "security_light_engine_communication_failed"]) set(name, null, "persistent");
}
const kind = msg.payload?.kind;
const now = Date.now();
const futureMs = Number(locationPolicy.future_tolerance_seconds) * 1000;
const incomingAt = Number(msg.payload?.updated_at ?? msg.payload?.context?.updated_at ?? 0);
let accepted = true;
const updateCache = (name) => {
    const old = get(name);
    const oldAt = Number(old?.updated_at ?? 0);
    if (incomingAt > now + futureMs || (old && incomingAt && oldAt && incomingAt < oldAt)) {
        node.warn(`iluminacao_seguranca: snapshot${testMode ? " [TESTE]" : ""} fora de ordem ou no futuro; descartado`);
        return false;
    }
    if (!old || (incomingAt && (!oldAt || incomingAt > oldAt))) {
        set(name, msg.payload.context);
        return true;
    }
    if (!incomingAt) {
        node.warn("iluminacao_seguranca: snapshot sem timestamp; cache atual preservado");
        return false;
    }
    if (incomingAt === oldAt && JSON.stringify(old) !== JSON.stringify(msg.payload.context)) {
        set(name, msg.payload.context);
        return true;
    }
    return false;
};
if (kind === "people_context") accepted = updateCache("people_context_v1");
if (kind === "vehicle_primary_context") accepted = updateCache("vehicle_primary_context_v1");
if (kind === "sun_context") flow.set("sun_below_horizon", msg.payload.sun_below_horizon === true);
if (kind === "engine_bypass_context" && typeof msg.payload?.communication_failed === "boolean") {
    set("security_light_engine_communication_failed", msg.payload.communication_failed, "persistent");
}
const people = get("people_context_v1") ?? {};
const vehicle = get("vehicle_primary_context_v1") ?? {};
const lifecycle = get("security_light_lifecycle_v1", "persistent") ?? {};
const bypassEnabled = get("security_light_engine_bypass_enabled", "persistent") === true;
const bypassAutomatic = get("security_light_engine_bypass_automatic", "persistent") === true;
const communicationFailed = vehicle.engine_communication_failed === true ||
    get("security_light_engine_communication_failed", "persistent") === true || bypassAutomatic;
const engineKnown = vehicle.engine_state_valid === true;
const engineAllowed = vehicle.in_use === true && vehicle.engine_on === true &&
    engineKnown && !communicationFailed;
const bypassAllowed = bypassEnabled && communicationFailed;
msg._light_context = {
    test_mode: testMode, test_case: testCase, kind, now, future_ms: futureMs,
    location_policy: locationPolicy, policy: lightPolicy, accepted,
    people, vehicle, lifecycle, bypass_enabled: bypassEnabled,
    bypass_allowed: bypassAllowed, communication_failed: communicationFailed,
    engine_allowed: engineAllowed, sun_ready: flow.get("sun_ready") === true,
    dark: flow.get("sun_below_horizon") === true,
    original_payload: { ...(msg.payload ?? {}) }
};
return msg;
