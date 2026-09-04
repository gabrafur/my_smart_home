if (msg.payload?.kind !== "arrival") {
    return null;
}

const TEST_MODE =
    msg._location_test === true ||
    msg.payload?.test_mode === true;
const TEST_CASE =
    msg._location_test_case ??
    msg.payload?.test_case ??
    null;
const SHORT_RECOVERY_TTL_MS = 2 * 60 * 1000;
const RECOVERY_REQUEST_THROTTLE_MS = 30 * 1000;
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

const now = Date.now();
const vehicle = ctxGet("vehicle_primary_context_v1") ?? {};
const people = ctxGet("people_context_v1") ?? {};
const lifecycle = TEST_MODE
    ? ctxGet("security_light_lifecycle_v1") ?? {}
    : flow.get("security_light_lifecycle_v1", PERSISTENT) ?? {};
const physical = flow.get("security_light_physical_state") ?? "unknown";
const physicalObservedAt = Number(
    flow.get("security_light_physical_observed_at") ?? 0
);
const physicalFresh =
    Number.isFinite(physicalObservedAt) &&
    physicalObservedAt <= now + 60 * 1000 &&
    now - physicalObservedAt <= 2 * 60 * 1000;
const lightReconciled = flow.get("light_reconciled") === true;
const sunReady = flow.get("sun_ready") === true;
const source = msg.payload?.source;
const stage = msg.payload?.arrival_stage;
const residentArrival =
    ["resident_primary", "resident_secondary"].includes(source);
const bypassEnabled =
    ctxGet("security_light_engine_bypass_enabled", PERSISTENT) === true;
const bypassAutomatic =
    ctxGet("security_light_engine_bypass_automatic", PERSISTENT) === true;
const engineStateKnown = vehicle.engine_state_valid === true;
const engineKnownOff =
    engineStateKnown &&
    vehicle.engine_on === false;
const engineCommunicationFailed =
    vehicle.engine_communication_failed === true ||
    bypassAutomatic;
const engineUnreliable =
    engineCommunicationFailed;
const bypassAllowed =
    bypassEnabled &&
    engineUnreliable &&
    !engineKnownOff;
/* A posição do carro só participa da validação quando o próprio carro é a
 * origem da chegada. Para uma chegada de morador, ON/OFF conhecido e API
 * saudável bastam para decidir; localização antiga do veículo é diagnóstica. */
const trustedEngineDecision =
    engineStateKnown &&
    !engineCommunicationFailed;
const vehicleLightingReady =
    trustedEngineDecision &&
    (
        residentArrival ||
        (
            vehicle.ready === true &&
            vehicle.lighting_ready === true
        )
    );
const vehicleDecisionReady =
    engineKnownOff ||
    vehicleLightingReady ||
    bypassAllowed;
const logicReady =
    sunReady &&
    vehicleDecisionReady;

const pendingKey = "security_light_pending_arrival_v1";
const eventAt = Number(
    msg.payload?.event_at ??
    msg.payload?.updated_at ??
    now
);
const residentApproach =
    residentArrival &&
    stage === "approach";
const originalQueuedAt = Number(
    msg.payload?.arrival_originally_queued_at ?? now
);
const queuedAt =
    Number.isFinite(originalQueuedAt) &&
    originalQueuedAt > 0 &&
    originalQueuedAt <= now + 60 * 1000
        ? originalQueuedAt
        : now;
const existing = ctxGet(pendingKey, PERSISTENT);
const existingEventAt = Number(existing?.event_at ?? 0);

if (
    !existing ||
    !Number.isFinite(existingEventAt) ||
    eventAt >= existingEventAt
) {
    ctxSet(
        pendingKey,
        {
            version: 2,
            queued_at: queuedAt,
            expires_at: residentApproach
                ? null
                : queuedAt + SHORT_RECOVERY_TTL_MS,
            event_at: eventAt,
            retention: residentApproach
                ? "while_approaching"
                : "short_recovery",
            source,
            arrival_stage: stage,
            message: {
                ...msg,
                payload: { ...(msg.payload ?? {}) }
            }
        },
        PERSISTENT
    );
}

const diagnostic = {
    ...msg,
    payload: {
        ...(msg.payload ?? {}),
        diagnostic: "arrival_trigger_received",
        gps_trigger_functional: true,
        decision_context_ready: logicReady,
        people_context_ready: people.ready === true,
        vehicle_primary_context_ready: vehicle.ready === true,
        vehicle_primary_lighting_ready: vehicleLightingReady,
        vehicle_primary_location_required: !residentArrival,
        vehicle_primary_engine_state_valid:
            vehicle.engine_state_valid === true,
        vehicle_primary_engine_stale: vehicle.engine_stale === true,
        engine_communication_failed: engineCommunicationFailed,
        engine_bypass_enabled: bypassEnabled,
        engine_bypass_allowed: bypassAllowed,
        engine_data_unreliable: engineUnreliable,
        sun_ready: sunReady,
        sun_below_horizon:
            flow.get("sun_below_horizon") === true,
        vehicle_primary_in_use: vehicle.in_use,
        vehicle_primary_engine_on: vehicle.engine_on,
        reflector_state: physical,
        reflector_physical_fresh: physicalFresh,
        reflector_reconciled: lightReconciled,
        would_evaluate_turn_on: logicReady,
        arrival_replay: msg._arrival_replay === true,
        pending_arrival_queued: true,
        pending_arrival_retention: residentApproach
            ? "while_approaching"
            : "short_recovery"
    }
};

if (TEST_MODE) {
    diagnostic._location_test = true;
    diagnostic._location_test_case = TEST_CASE;
    diagnostic.payload.test_mode = true;
    diagnostic.payload.test_case = TEST_CASE;
}

node.status({
    fill: logicReady ? "green" : "yellow",
    shape: "dot",
    text:
        `${TEST_MODE ? "TESTE " : ""}` +
        `GPS ${source}/${stage} | ` +
        (bypassAllowed
            ? "bypass do motor"
            : vehicleLightingReady
                ? residentArrival
                    ? "motor conhecido/confiável"
                    : "motor/contextos OK"
                : "vehicle_primary/motor pendente") +
        ` | ${flow.get("sun_below_horizon") === true ? "escuro" : "claro"}`
});

let recoveryRequest = null;
if (!logicReady) {
    if (!vehicleLightingReady && !bypassAllowed) {
        const recoveryKey = "security_light_last_recovery_request_at";
        const lastRecoveryAt = Number(ctxGet(recoveryKey) ?? 0);
        const canRequest =
            !Number.isFinite(lastRecoveryAt) ||
            lastRecoveryAt <= 0 ||
            now - lastRecoveryAt >= RECOVERY_REQUEST_THROTTLE_MS;

        if (canRequest) {
            ctxSet(recoveryKey, now);
            const recoveryReason = vehicle.ready === true
                ? "arrival_engine_recovery_needed"
                : "arrival_vehicle_primary_context_recovery_needed";
            recoveryRequest = {
                _location_test: TEST_MODE,
                _location_test_case: TEST_CASE,
                payload: {
                    kind: "refresh_tick",
                    origin: "iluminacao_seguranca",
                    reason: recoveryReason,
                    force_recovery: true,
                    require_lighting_ready: true,
                    requested_at: now,
                    arrival_source: source,
                    arrival_stage: stage,
                    test_mode: TEST_MODE,
                    test_case: TEST_CASE
                }
            };
            diagnostic.payload.context_recovery_requested = true;
            diagnostic.payload.context_recovery_reason = recoveryReason;
        } else {
            diagnostic.payload.context_recovery_requested = false;
            diagnostic.payload.context_recovery_throttled = true;
        }
    }

    node.warn(
        "iluminacao_seguranca: trigger de chegada recebido; " +
        (!sunReady
            ? "luminosidade ainda não ready"
            : "vehicle_primary/motor ainda não ready") +
        " — intenção preservada para reavaliação"
    );
    return [null, diagnostic, recoveryRequest];
}

msg.payload.arrival_key = [source, stage, eventAt].join(":");
msg.payload.sun_below_horizon =
    flow.get("sun_below_horizon") === true;
msg.payload.vehicle_primary_in_use = vehicle.in_use;
msg.payload.vehicle_primary_engine_on = vehicle.engine_on;
msg.payload.vehicle_primary_engine_state_valid =
    vehicle.engine_state_valid === true;
msg.payload.vehicle_primary_engine_stale =
    vehicle.engine_stale === true;
msg.payload.engine_communication_failed = engineCommunicationFailed;
msg.payload.vehicle_primary_lighting_ready = vehicleLightingReady;
msg.payload.engine_data_unreliable = engineUnreliable;
msg.payload.engine_bypass_enabled = bypassEnabled;
msg.payload.engine_bypass_allowed = bypassAllowed;
msg.payload.active =
    lifecycle.active_by_arrival === true || physical === "on";
msg.payload.reflector_state = physical;
msg.payload.reflector_physical_fresh = physicalFresh;
msg.payload.reflector_reconciled = lightReconciled;

if (TEST_MODE) {
    msg._location_test = true;
    msg._location_test_case = TEST_CASE;
    msg.payload.test_mode = true;
    msg.payload.test_case = TEST_CASE;
}

return [msg, diagnostic, null];
