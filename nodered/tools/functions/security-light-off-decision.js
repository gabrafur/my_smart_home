const LOCATION_POLICY = global.get("location_policy_v1", "persistent");
const LIGHT_POLICY = global.get("security_light_policy_v1", "persistent");
if (LOCATION_POLICY?.version !== 1 || LOCATION_POLICY?.complete !== true ||
    LIGHT_POLICY?.version !== 1 || LIGHT_POLICY?.complete !== true) {
    node.error("iluminacao_seguranca: política canônica ausente", msg);
    return null;
}
const FUTURE_TOLERANCE_MS = Number(LOCATION_POLICY.future_tolerance_seconds) * 1000;
const PHYSICAL_FRESH_MS = Number(LIGHT_POLICY.physical_fresh_seconds) * 1000;
const HOME_CONFIRMATION_MS = Number(LIGHT_POLICY.off_grace_seconds) * 1000;
const TEST_MODE = msg._location_test === true || msg.payload?.test_mode === true;
const contextKey = (base) => TEST_MODE ? `${base}__test` : base;
const lifecycleKey = contextKey("security_light_lifecycle_v1");
const lifecycle = TEST_MODE
    ? flow.get(lifecycleKey) ?? {}
    : flow.get(lifecycleKey, "persistent") ?? {};
const now = Date.now();
const people = flow.get(contextKey("people_context_v1")) ?? {};
const vehicle = flow.get(contextKey("vehicle_primary_context_v1")) ?? {};
const physicalObservedAt = Number(flow.get("security_light_physical_observed_at") ?? 0);
const physicalFresh = Number.isFinite(physicalObservedAt) &&
    physicalObservedAt <= now + FUTURE_TOLERANCE_MS &&
    now - physicalObservedAt <= PHYSICAL_FRESH_MS;
const ready = flow.get("sun_ready") === true && flow.get("light_reconciled") === true &&
    physicalFresh;
if (lifecycle.active_by_arrival !== true || !ready) return null;

const vehicleEventCanStop = msg.payload?.event === "turn_off" ||
    msg.payload?.event === "location_update";
if (vehicleEventCanStop && vehicle.ready === true &&
    msg.payload?.vehicle_primary_ready === true &&
    msg.payload?.vehicle_primary_engine_on === false &&
    msg.payload?.vehicle_primary_unlocked === true) {
    msg.payload.off_reason = "vehicle_primary_desligado_e_destravado";
    msg.payload.deadline_type = "immediate";
    return [msg, null];
}

if (msg.payload?.confirmed_home_transition !== true) return null;
const source = String(msg.payload?.source ?? "");
if (!["resident_primary", "resident_secondary"].includes(source)) {
    node.warn("iluminacao_seguranca: transição home sem fonte canônica; refresh não agendado");
    return null;
}
const resident = people[source];
if (resident?.ready !== true || resident?.stale === true ||
    resident?.current_home !== true) {
    node.warn("iluminacao_seguranca: HOME do morador sem localização atual; refresh não agendado");
    return null;
}
if (Number.isFinite(lifecycle.vehicle_refresh_at)) return null;

lifecycle.vehicle_refresh_at = Math.min(
    Number(lifecycle.force_off_at),
    now + HOME_CONFIRMATION_MS
);
lifecycle.vehicle_refresh_reason = "home_confirmation_" + source;
lifecycle.vehicle_refresh_source = source;
lifecycle.updated_at = now;
if (TEST_MODE) flow.set(lifecycleKey, lifecycle);
else flow.set(lifecycleKey, lifecycle, "persistent");
msg.payload.deadline_type = "vehicle_refresh";
msg.payload.deadline_at = lifecycle.vehicle_refresh_at;
msg.payload.refresh_reason = lifecycle.vehicle_refresh_reason;
msg.delay = Math.max(0, lifecycle.vehicle_refresh_at - now);
return [null, msg];
