const now = Date.now();
const TEST_MODE =
    msg._location_test === true ||
    msg.payload?.test_mode === true;
const PERSISTENT = "persistent";

function contextKey(base) {
    return TEST_MODE ? `${base}__test` : base;
}

function ctxGet(base, store) {
    const key = contextKey(base);
    return TEST_MODE || !store
        ? flow.get(key)
        : flow.get(key, store);
}

function ctxSet(base, value, store) {
    const key = contextKey(base);
    return TEST_MODE || !store
        ? flow.set(key, value)
        : flow.set(key, value, store);
}

const lifecycle =
    ctxGet("security_light_lifecycle_v1", PERSISTENT) ??
    { version: 1 };
const physicalObservedAt = Number(
    flow.get("security_light_physical_observed_at") ?? 0
);
const physicalFresh =
    Number.isFinite(physicalObservedAt) &&
    physicalObservedAt <= now + 60 * 1000 &&
    now - physicalObservedAt <= 2 * 60 * 1000;
const people = ctxGet("people_context_v1") ?? {};
const engineGateAllowed =
    msg.payload?.vehicle_primary_gate === "fresh_engine_on";
const bypassAllowed =
    msg.payload?.vehicle_primary_gate ===
        "manual_bypass_for_unreliable_engine" &&
    msg.payload?.engine_bypass_allowed === true &&
    msg.payload?.engine_data_unreliable === true;
const ready =
    people.ready === true &&
    flow.get("sun_ready") === true &&
    flow.get("sun_below_horizon") === true &&
    flow.get("light_reconciled") === true &&
    physicalFresh &&
    (engineGateAllowed || bypassAllowed);

if (
    !ready ||
    flow.get("security_light_physical_state") !== "off" ||
    lifecycle.active_by_arrival === true
) {
    return null;
}

const arrivalKey = msg.payload?.arrival_key;
const lastArrivalAt = Number(lifecycle.last_arrival_at ?? 0);
if (
    arrivalKey &&
    lifecycle.last_arrival_key === arrivalKey &&
    lastArrivalAt <= now + 60 * 1000 &&
    now - lastArrivalAt < 10 * 60 * 1000
) {
    return null;
}

lifecycle.version = 1;
lifecycle.active_by_arrival = true;
lifecycle.on_since = now;
lifecycle.force_off_at = now + 15 * 60 * 1000;
lifecycle.pending_off_at = null;
lifecycle.pending_off_reason = null;
lifecycle.pending_off_source = null;
lifecycle.last_arrival_key = arrivalKey ?? null;
lifecycle.last_arrival_at = now;
lifecycle.updated_at = now;
ctxSet("security_light_lifecycle_v1", lifecycle, PERSISTENT);
ctxSet("security_light_pending_arrival_v1", null, PERSISTENT);
ctxSet(
    "security_light_turn_on_notification_latch_v1",
    {
        version: 1,
        latched: true,
        reason: "turn_on_dispatched",
        latched_at: now,
        arrival_key: arrivalKey ?? null
    },
    PERSISTENT
);

msg.delay = 15 * 60 * 1000;
msg.payload.deadline_type = "backstop";
msg.payload.deadline_at = lifecycle.force_off_at;
msg.payload.reason = bypassAllowed
    ? (TEST_MODE
        ? "test_arrival_after_dark_with_engine_bypass"
        : "arrival_after_dark_with_engine_bypass")
    : (TEST_MODE
        ? "test_arrival_with_vehicle_primary_engine_on_after_dark"
        : "arrival_with_vehicle_primary_engine_on_after_dark");

if (TEST_MODE) {
    msg.payload.simulated = true;
    msg.payload.dispatched = false;
    node.status({
        fill: bypassAllowed ? "yellow" : "green",
        shape: "dot",
        text: bypassAllowed
            ? "TESTE: lifecycle criado com bypass — despacho simulado"
            : "TESTE: lifecycle criado — despacho simulado"
    });
    return [null, msg];
}

return [msg, null];
