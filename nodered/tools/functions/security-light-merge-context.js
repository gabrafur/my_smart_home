const kind = msg.payload?.kind;
const TEST_MODE =
    msg._location_test === true ||
    msg.payload?.test_mode === true;
const TEST_CASE =
    msg._location_test_case ??
    msg.payload?.test_case ??
    null;
const incomingAt = Number(
    msg.payload?.updated_at ??
    msg.payload?.context?.updated_at ??
    0
);
const FUTURE_TOLERANCE_MS = 60 * 1000;
const SHORT_RECOVERY_TTL_MS = 2 * 60 * 1000;
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

function updateCache(baseKey) {
    const old = ctxGet(baseKey);
    const oldAt = Number(old?.updated_at ?? 0);

    if (
        incomingAt > Date.now() + FUTURE_TOLERANCE_MS ||
        (old && incomingAt && oldAt && incomingAt < oldAt)
    ) {
        node.warn(
            "iluminacao_seguranca: snapshot" +
            (TEST_MODE ? " [TESTE]" : "") +
            " fora de ordem ou no futuro; descartado"
        );
        return false;
    }

    if (!old || (incomingAt && (!oldAt || incomingAt > oldAt))) {
        ctxSet(baseKey, msg.payload.context);
        return true;
    }

    if (!incomingAt) {
        node.warn(
            "iluminacao_seguranca: snapshot sem timestamp; cache atual preservado"
        );
        return false;
    }

    if (
        incomingAt === oldAt &&
        JSON.stringify(old) !== JSON.stringify(msg.payload.context)
    ) {
        ctxSet(baseKey, msg.payload.context);
        node.status({
            fill: "yellow",
            shape: "dot",
            text: "contexto atualizado no mesmo timestamp"
        });
        return true;
    }

    return false;
}

let contextAccepted = true;
if (kind === "people_context") {
    contextAccepted = updateCache("people_context_v1");
}
if (kind === "vehicle_primary_context") {
    contextAccepted = updateCache("vehicle_primary_context_v1");
}
if (kind === "sun_context") {
    flow.set(
        "sun_below_horizon",
        msg.payload.sun_below_horizon === true
    );
}
if (
    kind === "engine_bypass_context" &&
    typeof msg.payload?.communication_failed === "boolean"
) {
    ctxSet(
        "security_light_engine_communication_failed",
        msg.payload.communication_failed,
        PERSISTENT
    );
}

if (TEST_MODE && msg._location_test_reset === true) {
    for (const base of [
        "security_light_pending_arrival_v1",
        "security_light_lifecycle_v1",
        "security_light_last_dry_run_v1",
        "security_light_turn_on_notification_latch_v1",
        "security_light_engine_bypass_enabled",
        "security_light_engine_bypass_automatic",
        "security_light_engine_communication_failed"
    ]) {
        ctxSet(base, null);
    }
}

const reconcile = TEST_MODE
    ? null
    : {
        payload: {
            kind: "reconcile_signal",
            reason: "context_update"
        }
    };

const people = ctxGet("people_context_v1") ?? {};
const vehicle = ctxGet("vehicle_primary_context_v1") ?? {};
const lifecycle = ctxGet(
    "security_light_lifecycle_v1",
    PERSISTENT
) ?? {};
const bypassEnabled = ctxGet(
    "security_light_engine_bypass_enabled",
    PERSISTENT
) === true;
const bypassAutomatic = ctxGet(
    "security_light_engine_bypass_automatic",
    PERSISTENT
) === true;
const engineStateKnown = vehicle.engine_state_valid === true;
const engineKnownOff =
    engineStateKnown &&
    vehicle.engine_on === false;
const engineCommunicationFailed =
    vehicle.engine_communication_failed === true ||
    ctxGet(
        "security_light_engine_communication_failed",
        PERSISTENT
    ) === true ||
    bypassAutomatic;
const engineUnreliable =
    engineCommunicationFailed;
const bypassAllowed =
    bypassEnabled &&
    engineUnreliable &&
    !engineKnownOff;
const engineGateAllowed =
    vehicle.in_use === true &&
    vehicle.engine_on === true &&
    engineStateKnown &&
    !engineUnreliable;
const sunReady = flow.get("sun_ready") === true;
const dark = flow.get("sun_below_horizon") === true;

const pendingKey = "security_light_pending_arrival_v1";
let pending = ctxGet(pendingKey, PERSISTENT);
let replay = null;

if (pending && lifecycle.active_by_arrival === true) {
    ctxSet(pendingKey, null, PERSISTENT);
    pending = null;
}

if (pending) {
    const queuedAt = Number(pending.queued_at ?? 0);
    const isApproach =
        pending.version === 2 &&
        pending.retention === "while_approaching" &&
        ["resident_primary", "resident_secondary"].includes(
            pending.source
        );
    let validPending =
        Boolean(pending.message) &&
        Number.isFinite(queuedAt) &&
        queuedAt > 0 &&
        queuedAt <= Date.now() + FUTURE_TOLERANCE_MS;
    let invalidReason = null;

    if (validPending && isApproach) {
        const resident = people[pending.source];
        validPending =
            resident?.ready === true &&
            resident?.stale !== true &&
            resident?.state === "chegando";
        if (!validPending) {
            invalidReason = resident?.state === "home"
                ? "resident_home"
                : resident?.stale === true || resident?.ready !== true
                    ? "resident_location_stale"
                    : "resident_left_approach_zone";
        }
    } else if (validPending) {
        const expiresAt = Number(pending.expires_at ?? 0);
        validPending =
            Number.isFinite(expiresAt) &&
            Date.now() <= expiresAt &&
            expiresAt - queuedAt <= SHORT_RECOVERY_TTL_MS + 1000;
        if (!validPending) invalidReason = "short_recovery_expired";
    }

    if (!validPending) {
        ctxSet(pendingKey, null, PERSISTENT);
        node.warn(
            "iluminacao_seguranca: chegada pendente cancelada (" +
            (invalidReason ?? "invalid_pending") + ")"
        );
        pending = null;
    }
}

const replayReady =
    pending &&
    sunReady &&
    dark &&
    (engineGateAllowed || bypassAllowed);

if (replayReady) {
    replay = {
        ...pending.message,
        payload: {
            ...(pending.message.payload ?? {}),
            arrival_replayed_after_context_recovery: true,
            arrival_originally_queued_at: pending.queued_at,
            arrival_replayed_at: Date.now(),
            engine_bypass_enabled: bypassEnabled,
            engine_bypass_allowed: bypassAllowed
        }
    };
    replay._arrival_replay = true;

    if (TEST_MODE) {
        replay._location_test = true;
        replay._location_test_case =
            TEST_CASE ??
            pending.message._location_test_case ??
            null;
        replay.payload.test_mode = true;
        replay.payload.test_case = replay._location_test_case;
    }

    node.status({
        fill: bypassAllowed ? "yellow" : "green",
        shape: "dot",
        text: bypassAllowed
            ? "chegada pendente reprocessada com bypass seguro"
            : "chegada pendente reprocessada após recovery/anoitecer"
    });
}

const original = msg.payload;
let lifecycleMsg = msg;
if (
    ["people_context", "vehicle_primary_context"].includes(kind) &&
    !contextAccepted
) {
    lifecycleMsg = null;
}

if (lifecycleMsg) {
    lifecycleMsg.payload = {
        event: original?.event ?? "context_update",
        reason: original?.reason,
        source: original?.source,
        trigger_state: original?.trigger_state,
        trigger_prev_state: original?.trigger_prev_state,
        confirmed_home_transition:
            original?.confirmed_home_transition === true,
        vehicle_primary_ready: vehicle.ready === true,
        vehicle_primary_lighting_ready:
            vehicle.lighting_ready === true,
        vehicle_primary_engine_on: vehicle.engine_on,
        vehicle_primary_engine_state_valid:
            vehicle.engine_state_valid === true,
        engine_communication_failed: engineCommunicationFailed,
        vehicle_primary_unlocked: vehicle.unlocked,
        vehicle_primary_in_use: vehicle.in_use,
        engine_bypass_enabled: bypassEnabled,
        engine_bypass_allowed: bypassAllowed,
        active: lifecycle.active_by_arrival === true
    };

    if (TEST_MODE) {
        lifecycleMsg._location_test = true;
        lifecycleMsg._location_test_case = TEST_CASE;
        lifecycleMsg.payload.test_mode = true;
        lifecycleMsg.payload.test_case = TEST_CASE;
    }
}

return [lifecycleMsg, reconcile, replay];
