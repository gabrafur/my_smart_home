const LOCATION_POLICY = global.get("location_policy_v1", "persistent");
const LIGHT_POLICY = global.get("security_light_policy_v1", "persistent");
if (LOCATION_POLICY?.version !== 1 || LOCATION_POLICY?.complete !== true ||
    LIGHT_POLICY?.version !== 1 || LIGHT_POLICY?.complete !== true) {
    node.error("iluminacao_seguranca: política canônica ausente", msg);
    return null;
}
const FUTURE_TOLERANCE_MS = Number(LOCATION_POLICY.future_tolerance_seconds) * 1000;
const PHYSICAL_FRESH_MS = Number(LIGHT_POLICY.physical_fresh_seconds) * 1000;
const key = "security_light_lifecycle_v1";
const TEST_MODE = msg._location_test === true || msg.payload?.test_mode === true;
const contextKey = (base) => TEST_MODE ? `${base}__test` : base;
const lifecycle = flow.get(key, "persistent") ?? {};
const now = Date.now();
const type = msg.payload?.deadline_type ?? "immediate";

if (msg.payload?.recovered === true) {
    const scheduled = flow.get("security_light_recovery_scheduled") ?? {};
    delete scheduled[type];
    flow.set("security_light_recovery_scheduled", scheduled);
}
if (lifecycle.active_by_arrival !== true) return null;

/* O backstop é uma garantia do atuador que já foi ligado pela automação.
 * Ele não depende do frescor de pessoas, veículo ou sol para desligar. */
if (type === "backstop") {
    const forceOffAt = Number(lifecycle.force_off_at);
    if (Number.isFinite(forceOffAt) && now < forceOffAt) return null;
} else {
    const physical = flow.get("security_light_physical_state");
    const physicalObservedAt = Number(flow.get("security_light_physical_observed_at") ?? 0);
    const physicalFresh = Number.isFinite(physicalObservedAt) &&
        physicalObservedAt <= now + FUTURE_TOLERANCE_MS &&
        now - physicalObservedAt <= PHYSICAL_FRESH_MS;
    const vehicleContext = flow.get(contextKey("vehicle_primary_context_v1")) ?? {};
    const ready = flow.get("light_reconciled") === true && physicalFresh &&
        type === "immediate" && vehicleContext.ready === true &&
        vehicleContext.engine_state_valid === true &&
        vehicleContext.engine_on === false && vehicleContext.unlocked === true;
    if (!ready || physical !== "on") return null;
}

lifecycle.active_by_arrival = false;
lifecycle.on_since = null;
lifecycle.force_off_at = null;
lifecycle.pending_off_at = null;
lifecycle.pending_off_reason = null;
lifecycle.pending_off_source = null;
lifecycle.vehicle_refresh_at = null;
lifecycle.vehicle_refresh_reason = null;
lifecycle.vehicle_refresh_source = null;
lifecycle.cooldown_until = now + Number(LIGHT_POLICY.post_off_cooldown_minutes) * 60000;
lifecycle.updated_at = now;
flow.set(key, lifecycle, "persistent");
msg.payload.off_reason = msg.payload.off_reason ?? msg.payload.reason ?? type;
if (type === "backstop") {
    msg.payload.backstop_forced = true;
    node.warn("iluminacao_seguranca: backstop venceu; desligamento obrigatório enviado");
}
return msg;
