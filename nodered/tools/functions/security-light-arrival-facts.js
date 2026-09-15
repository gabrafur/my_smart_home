if (msg.payload?.kind !== "arrival") return null;
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
const now = Date.now();
const futureMs = Number(locationPolicy.future_tolerance_seconds) * 1000;
const vehicle = get("vehicle_primary_context_v1") ?? {};
const people = get("people_context_v1") ?? {};
const lifecycle = get("security_light_lifecycle_v1", "persistent") ?? {};
const physical = flow.get("security_light_physical_state") ?? "unknown";
const observedAt = Number(flow.get("security_light_physical_observed_at") ?? 0);
const physicalFresh = Number.isFinite(observedAt) && observedAt <= now + futureMs &&
    now - observedAt <= Number(lightPolicy.physical_fresh_seconds) * 1000;
const source = msg.payload?.source;
const stage = msg.payload?.arrival_stage;
const residentArrival = ["resident_primary", "resident_secondary"].includes(source);
const resident = people[source];
const residentObservedAt = Number(resident?.updated_at);
const residentCurrent = resident?.ready === true && resident?.stale !== true &&
    Number.isFinite(residentObservedAt) && residentObservedAt > 0 &&
    residentObservedAt <= now + futureMs &&
    now - residentObservedAt <= Number(locationPolicy.location_fresh_minutes) * 60000;
const previousState = msg.payload?.arrival_previous_state;
const previousAway = typeof previousState === "string" &&
    !["", "home", "near_home", "unknown", "unavailable"].includes(previousState);
const recoveredAway = msg.payload?.illumination_only === true &&
    ["unknown", "unavailable"].includes(previousState) &&
    msg.payload?.external_cycle_confirmed === true;
const residentApproachValid =
    residentArrival &&
    stage === "approach" &&
    (previousAway || recoveredAway) &&
    residentCurrent &&
    resident?.state === "near_home" &&
    resident?.current_home !== true;
const bypassEnabled = get("security_light_engine_bypass_enabled", "persistent") === true;
const bypassAutomatic = get("security_light_engine_bypass_automatic", "persistent") === true;
const engineKnown = vehicle.engine_state_valid === true;
const communicationFailed = vehicle.engine_communication_failed === true || bypassAutomatic;
const engineKnownOff = engineKnown && vehicle.engine_on === false && !communicationFailed;
const bypassAllowed = bypassEnabled && communicationFailed;
const trustedEngine = engineKnown && !communicationFailed;
const vehicleLightingReady = trustedEngine && residentArrival;
const vehicleDecisionReady = engineKnownOff || vehicleLightingReady || bypassAllowed;
const sunReady = flow.get("sun_ready") === true;
const eventAt = Number(msg.payload?.event_at ?? msg.payload?.updated_at ?? now);
const queuedCandidate = Number(msg.payload?.arrival_originally_queued_at ?? now);
const queuedAt = Number.isFinite(queuedCandidate) && queuedCandidate > 0 &&
    queuedCandidate <= now + futureMs ? queuedCandidate : now;
const lastRecoveryAt = Number(get("security_light_last_recovery_request_at") ?? 0);
const recoveryThrottleMs = Number(lightPolicy.recovery_request_throttle_seconds) * 1000;
msg._light_arrival = {
    test_mode: testMode,
    test_case: testCase,
    location_policy: locationPolicy,
    policy: lightPolicy,
    future_ms: futureMs,
    now,
    source,
    stage,
    event_at: eventAt,
    queued_at: queuedAt,
    vehicle,
    people,
    lifecycle,
    physical,
    physical_fresh: physicalFresh,
    light_reconciled: flow.get("light_reconciled") === true,
    resident_arrival: residentArrival,
    resident_approach_valid: residentApproachValid,
    bypass_enabled: bypassEnabled,
    bypass_allowed: bypassAllowed,
    engine_communication_failed: communicationFailed,
    engine_unreliable: communicationFailed,
    vehicle_lighting_ready: vehicleLightingReady,
    logic_ready: sunReady && vehicleDecisionReady,
    sun_ready: sunReady,
    dark: flow.get("sun_below_horizon") === true,
    direction_valid: msg.payload?.arrival_direction === "returning" &&
        msg.payload?.external_cycle_confirmed === true,
    recovery_needed: !vehicleLightingReady && !bypassAllowed,
    recovery_allowed: !Number.isFinite(lastRecoveryAt) || lastRecoveryAt <= 0 ||
        now - lastRecoveryAt >= recoveryThrottleMs,
    arrival_recovery_ms: Number(locationPolicy.arrival_recovery_minutes) * 60000
};
return msg;
