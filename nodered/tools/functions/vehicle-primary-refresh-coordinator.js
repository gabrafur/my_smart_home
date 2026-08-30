const TEST_MODE =
    msg._location_test === true ||
    msg.payload?.test_mode === true;

if (msg.payload?.kind !== "refresh_command") return null;

const INTERVAL_MS = 15 * 60 * 1000;
const IN_FLIGHT_LEASE_MS = 2 * 60 * 1000;
const FUTURE_TOLERANCE_MS = 60 * 1000;
const key = TEST_MODE
    ? "security_vehicle_primary_refresh_v1__test"
    : "security_vehicle_primary_refresh_v1";
const nowCandidate = Number(msg.payload?.test_now);
const now = TEST_MODE && Number.isFinite(nowCandidate)
    ? nowCandidate
    : Date.now();
const vehicleContext = TEST_MODE
    ? flow.get("vehicle_primary_context_v1__test") ?? {}
    : flow.get("vehicle_primary_context_v1") ?? {};

function stateGet() {
    return TEST_MODE ? flow.get(key) : flow.get(key, "persistent");
}

function stateSet(value) {
    return TEST_MODE
        ? flow.set(key, value)
        : flow.set(key, value, "persistent");
}

let state = stateGet();
if (!state || typeof state !== "object" || Array.isArray(state)) {
    state = {};
}

state.version = 4;
state.attempts = Number.isFinite(state.attempts)
    ? Math.max(0, Math.min(5, state.attempts))
    : 0;
state.last_success_at = Number.isFinite(state.last_success_at) &&
    state.last_success_at <= now + FUTURE_TOLERANCE_MS
        ? state.last_success_at
        : 0;
state.next_allowed_at = Number.isFinite(state.next_allowed_at) &&
    state.next_allowed_at <= now + INTERVAL_MS
        ? state.next_allowed_at
        : 0;
state.last_attempt_at = Number.isFinite(state.last_attempt_at) &&
    state.last_attempt_at <= now + FUTURE_TOLERANCE_MS
        ? state.last_attempt_at
        : 0;
state.last_request_at = Number.isFinite(state.last_request_at) &&
    state.last_request_at <= now + FUTURE_TOLERANCE_MS
        ? state.last_request_at
        : state.last_attempt_at;
const requestFloorAt = state.last_request_at > 0
    ? state.last_request_at + INTERVAL_MS
    : 0;
state.next_allowed_at = Math.max(
    state.next_allowed_at,
    requestFloorAt
);
state.in_flight_until = Number.isFinite(state.in_flight_until) &&
    state.in_flight_until <= now + IN_FLIGHT_LEASE_MS
        ? state.in_flight_until
        : 0;
state.failure_notified_at = Number.isFinite(state.failure_notified_at) &&
    state.failure_notified_at <= now + FUTURE_TOLERANCE_MS
        ? state.failure_notified_at
        : 0;

function save(displayState, reason, extra = {}) {
    state.state = displayState;
    state.reason = reason ?? null;
    state.updated_at = now;
    state.next_retry_at = state.awaiting_evidence === true
        ? state.next_allowed_at || null
        : null;
    state.cooldown_until = state.awaiting_evidence !== true &&
        state.last_success_at > 0 &&
        state.next_allowed_at > now
            ? state.next_allowed_at
            : null;
    Object.assign(state, extra);
    stateSet(state);
}

function blockedNotification(reason, waitS) {
    if (msg.payload?.reason !== "manual_force") return null;
    const retryAt = new Date(now + waitS * 1000).toLocaleTimeString(
        "pt-BR",
        { hour: "2-digit", minute: "2-digit", second: "2-digit" }
    );
    msg.notification = {
        title: "Atualização do vehicle_primary não enviada",
        message:
            "Já existe uma tentativa de atualização " +
            (reason === "in_flight"
                ? "em andamento"
                : reason === "minimum_interval"
                    ? "dentro do intervalo mínimo do Bluelink"
                    : "aguardando resposta") +
            ". O clique foi recebido, mas nenhuma nova consulta foi enviada. " +
            `Próxima avaliação em ${waitS} s, às ${retryAt}.`,
        id: "vehicle_primary_refresh_blocked"
    };
    node.log?.(
        "VEHICLE_PRIMARY_REFRESH_SUPPRESSED origin=dashboard " +
        `reason=${reason} remaining_seconds=${waitS}`
    );
    return [null, null, msg, null];
}

if (state.request_in_flight === true && now < state.in_flight_until) {
    const waitS = Math.max(1, Math.ceil((state.in_flight_until - now) / 1000));
    save("in_flight", state.recovery_reason ?? "request_in_flight", {
        enabled: true
    });
    node.status({
        fill: "yellow",
        shape: "ring",
        text: `Bluelink em andamento ${waitS}s`
    });
    return blockedNotification("in_flight", waitS);
}

if (state.request_in_flight === true) {
    state.request_in_flight = false;
    state.in_flight_until = null;
    state.last_failure_class = "in_flight_lease_expired";
}

const contextReady =
    msg.payload?.vehicle_primary_ready === true ||
    vehicleContext.ready === true;
const recoveryNeeded =
    msg.payload?.recovery_needed === true ||
    msg.payload?.force_recovery === true ||
    msg.payload?.vehicle_primary_ready === false ||
    contextReady !== true ||
    state.awaiting_evidence === true;
const requireLightingReady =
    msg.payload?.require_lighting_ready === true ||
    (
        state.awaiting_evidence === true &&
        state.require_lighting_ready === true
    );
const requestedReason = msg.payload?.reason ??
    msg.payload?.recovery_reason ??
    (recoveryNeeded ? "readiness_recovery_needed" : "scheduled_refresh");

/*
 * O backend brasileiro e o coordinator Python impõem 15 minutos entre
 * wakes reais. Stale de segurança, movimento, chegada e clique manual podem
 * pedir uma avaliação imediata, mas nunca tornam útil despachar outra chamada
 * antes desse piso: ela leria somente o mesmo cache e seria contada como uma
 * nova falha sem qualquer chance de acordar o veículo.
 */

const hour = new Date(now).getHours();
const daytime = hour >= 7 && hour < 22;
const enabled =
    recoveryNeeded ||
    msg.payload?.anyone_away === true ||
    daytime;

if (!enabled) {
    save("waiting", "waiting_for_day_or_away", {
        enabled: false,
        next_retry_at: null,
        cooldown_until: null
    });
    node.status({
        fill: "grey",
        shape: "ring",
        text: "refresh vehicle_primary: noite com todos em casa"
    });
    return null;
}

if (now < state.next_allowed_at) {
    const waitS = Math.max(1, Math.ceil((state.next_allowed_at - now) / 1000));
    const waitingEvidence = state.awaiting_evidence === true;
    save(waitingEvidence ? "backoff" : "cooldown", requestedReason, {
        enabled: true
    });
    node.status({
        fill: "grey",
        shape: "ring",
        text: waitingEvidence
            ? `retry Bluelink em ${waitS}s`
            : `refresh vehicle_primary cooldown ${waitS}s`
    });
    if (waitingEvidence) {
        return blockedNotification("backoff", waitS);
    }
    return blockedNotification("minimum_interval", waitS);
}

state.baseline_observed_at = {
    location: Number(vehicleContext.location?.updated_at ?? 0),
    engine: Number(vehicleContext.engine_updated_at ?? 0),
    lock: Number(vehicleContext.lock_updated_at ?? 0)
};
state.attempts = Math.min(5, state.attempts + 1);
state.last_attempt_at = now;
state.last_request_at = now;
state.next_allowed_at = now + INTERVAL_MS;
state.awaiting_evidence = true;
state.request_in_flight = true;
state.in_flight_until = now + IN_FLIGHT_LEASE_MS;
state.last_attempt_cycle = msg.payload.refresh_cycle_id ?? null;
state.require_lighting_ready = requireLightingReady;
state.recovery_reason = requestedReason;
state.manual_force = requestedReason === "manual_force";
let failureNotification = null;
if (state.attempts >= 2 && !state.failure_notified_at) {
    state.failure_notified_at = now;
    state.last_failure_class = state.last_failure_class ?? "no_fresh_data";
    failureNotification = {
        ...msg,
        payload: (msg.payload && typeof msg.payload === "object")
            ? { ...msg.payload }
            : msg.payload
    };
    failureNotification.payload = {
        ...failureNotification.payload,
        test_mode: TEST_MODE,
        side_effect: "notify:resident_primary"
    };
    failureNotification.alert = {
        title: TEST_MODE
            ? "TESTE — Falha ao atualizar veículo"
            : "Falha ao atualizar veículo",
        message:
            "O Bluelink não publicou dados novos após a atualização. " +
            "As retentativas automáticas continuam com backoff; " +
            "verifique a conectividade do veículo e o serviço da Hyundai."
    };
}
save("refreshing", requestedReason, { enabled: true });

node.log?.(
    (state.attempts > 1
        ? "VEHICLE_PRIMARY_REFRESH_RETRY"
        : "VEHICLE_PRIMARY_REFRESH_REQUESTED") +
    " attempt=" + state.attempts +
    " reason=" + requestedReason +
    " recovery=" + String(recoveryNeeded) +
    " require_lighting_ready=" + String(requireLightingReady) +
    " test_mode=" + String(TEST_MODE)
);

msg.payload.retry_attempt = state.attempts;
msg.payload.refresh_requested_at = now;
msg.payload.vehicle_primary_refresh_recovery = recoveryNeeded;
msg.payload.require_lighting_ready = requireLightingReady;
msg.payload.origin = msg.payload.origin ?? "contexto_chegadas";
msg.payload.test_mode = TEST_MODE;

node.status({
    fill: TEST_MODE ? "blue" : (recoveryNeeded ? "yellow" : "green"),
    shape: "dot",
    text: TEST_MODE
        ? `TESTE Bluelink #${state.attempts}: dry-run`
        : (recoveryNeeded
            ? `Bluelink #${state.attempts}: ${requestedReason}`
            : `Bluelink #${state.attempts}: refresh real`)
});

return [msg, TEST_MODE ? null : msg, null, failureNotification];
