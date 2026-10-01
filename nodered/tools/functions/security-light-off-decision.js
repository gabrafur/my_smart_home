const LOCATION_POLICY = global.get("location_policy_v1", "persistent");
const LIGHT_POLICY = global.get("security_light_policy_v1", "persistent");
if (LOCATION_POLICY?.version !== 1 || LOCATION_POLICY?.complete !== true ||
    LIGHT_POLICY?.version !== 1 || LIGHT_POLICY?.complete !== true) {
    node.error("iluminacao_seguranca: política canônica ausente", msg);
    return null;
}
const FUTURE_TOLERANCE_MS = Number(LOCATION_POLICY.future_tolerance_seconds) * 1000;
const PHYSICAL_FRESH_MS = Number(LIGHT_POLICY.physical_fresh_seconds) * 1000;
const TEST_MODE = msg._location_test === true || msg.payload?.test_mode === true;
const contextKey = (base) => TEST_MODE ? `${base}__test` : base;
const lifecycleKey = contextKey("security_light_lifecycle_v1");
const lifecycle = TEST_MODE
    ? flow.get(lifecycleKey) ?? {}
    : flow.get(lifecycleKey, "persistent") ?? {};
const now = Date.now();
const vehicle = flow.get(contextKey("vehicle_primary_context_v1")) ?? {};
const physicalObservedAt = Number(flow.get(contextKey("security_light_physical_observed_at")) ?? 0);
const physicalFresh = Number.isFinite(physicalObservedAt) &&
    physicalObservedAt <= now + FUTURE_TOLERANCE_MS &&
    now - physicalObservedAt <= PHYSICAL_FRESH_MS;
const ready = flow.get(contextKey("sun_ready")) === true && flow.get(contextKey("light_reconciled")) === true &&
    physicalFresh;
if (lifecycle.active_by_arrival !== true || !ready) return null;

const acceptedVehicleContext = msg._light_context?.kind === "vehicle_primary_context" &&
    msg._light_context?.accepted === true;
if (!acceptedVehicleContext) return null;
const evidence = offEvidence(vehicle, lifecycle, LOCATION_POLICY, now);
const communicationFailed = vehicle.engine_communication_failed === true || (TEST_MODE
    ? flow.get("security_light_engine_communication_failed__test")
    : flow.get("security_light_engine_communication_failed", "persistent")) === true;
if (!evidence.valid || communicationFailed) {
    lifecycle.pending_off_at = null;
    lifecycle.pending_off_reason = null;
    lifecycle.pending_off_source = null;
    lifecycle.updated_at = now;
    if (TEST_MODE) flow.set(lifecycleKey, lifecycle);
    else flow.set(lifecycleKey, lifecycle, "persistent");
    const reason = communicationFailed ? "engine_communication_failed" : evidence.reason;
    const signature = reason + ":" + evidence.observed_at;
    if (flow.get(contextKey("security_light_off_diagnostic")) !== signature) {
        flow.set(contextKey("security_light_off_diagnostic"), signature);
        node.log?.("SECURITY_LIGHT_OFF_BLOCKED " + JSON.stringify({ reason,
            engine_observed_at: evidence.observed_at, engine_age_ms: evidence.age_ms,
            on_since: lifecycle.on_since, simulated: TEST_MODE, dispatched: false }));
    }
    return null;
}
if (Number.isFinite(lifecycle.pending_off_at)) return null;
lifecycle.pending_off_at = now + Number(LIGHT_POLICY.off_grace_seconds) * 1000;
lifecycle.pending_off_reason = "vehicle_primary_motor_off_confirmado";
lifecycle.pending_off_source = "vehicle_primary";
lifecycle.updated_at = now;
if (TEST_MODE) flow.set(lifecycleKey, lifecycle);
else flow.set(lifecycleKey, lifecycle, "persistent");
msg.payload.off_reason = lifecycle.pending_off_reason;
msg.payload.deadline_type = "confirmed_off";
msg.payload.deadline_at = lifecycle.pending_off_at;
msg.payload.activation_at = lifecycle.on_since;
msg.delay = lifecycle.pending_off_at - now;
node.log?.("SECURITY_LIGHT_OFF_SCHEDULED " + JSON.stringify({ reason: msg.payload.off_reason,
    deadline_at: lifecycle.pending_off_at, engine_observed_at: evidence.observed_at,
    engine_age_ms: evidence.age_ms, simulated: TEST_MODE, dispatched: false }));
return msg;
