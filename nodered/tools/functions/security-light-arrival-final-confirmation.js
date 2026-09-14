const input = msg.payload ?? {};
const testMode = msg._location_test === true || input.test_mode === true;
const lifecycleKey = "security_light_lifecycle_v1";
const lifecycle = testMode
    ? flow.get(lifecycleKey + "__test") ?? {}
    : flow.get(lifecycleKey, "persistent") ?? {};
if (lifecycle.active_by_arrival !== true) return null;
const key = "security_light_last_recovery_request_at" +
    (testMode ? "__test" : "");
const now = Date.now();
const refreshAt = Number(lifecycle.vehicle_refresh_at ?? 0);
if (!Number.isFinite(refreshAt) || refreshAt <= 0 || now < refreshAt) return null;
const source = String(lifecycle.vehicle_refresh_source ?? input.source ?? "");
const people = flow.get(testMode ? "people_context_v1__test" : "people_context_v1") ?? {};
const resident = people[source];
const stillHome = ["resident_primary", "resident_secondary"].includes(source) &&
    resident?.ready === true && resident?.stale !== true &&
    resident?.current_home === true;
lifecycle.vehicle_refresh_at = null;
lifecycle.vehicle_refresh_reason = null;
lifecycle.vehicle_refresh_source = null;
lifecycle.updated_at = now;
if (testMode) flow.set(lifecycleKey + "__test", lifecycle);
else flow.set(lifecycleKey, lifecycle, "persistent");
if (!stillHome) {
    node.warn("iluminacao_seguranca: atualização do carro cancelada porque a chegada não permanece em home");
    return null;
}
flow.set(key, now);
msg.payload = {
    kind: "refresh_tick",
    origin: "iluminacao_seguranca",
    reason: "resident_arrival_confirmation",
    force_recovery: true,
    require_lighting_ready: true,
    resident_arrival_force: true,
    requested_at: now,
    arrival_source: source,
    arrival_stage: "home",
    test_mode: testMode,
    test_case: msg._location_test_case ?? input.test_case
};
return msg;
