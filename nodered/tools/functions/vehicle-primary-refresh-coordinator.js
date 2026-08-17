const TEST_MODE =
    msg._location_test === true ||
    msg.payload?.test_mode === true;

if (TEST_MODE || msg.payload?.kind !== "refresh_command") return null;

const vehicleContext = flow.get("vehicle_primary_context_v1") ?? {};
const INTERVAL_MS = 15 * 60 * 1000;
const BASE_RETRY_MS = 60 * 1000;
const FUTURE_TOLERANCE_MS = 60 * 1000;
const key = "security_vehicle_primary_refresh_v1";
const now = Date.now();

let state = flow.get(key, "persistent");
if (!state || typeof state !== "object" || Array.isArray(state)) {
    state = {};
}

state.version = 2;
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
    flow.set(key, state, "persistent");
}

const contextReady = vehicleContext.ready === true;
const outstandingRecovery =
    state.awaiting_evidence === true &&
    (
        state.require_lighting_ready === true ||
        (
            typeof state.recovery_reason === "string" &&
            state.recovery_reason.includes("recovery")
        )
    );
const recoveryNeeded =
    msg.payload?.recovery_needed === true ||
    msg.payload?.force_recovery === true ||
    msg.payload?.vehicle_primary_ready === false ||
    contextReady !== true ||
    outstandingRecovery;
const requireLightingReady =
    msg.payload?.require_lighting_ready === true ||
    (
        state.awaiting_evidence === true &&
        state.require_lighting_ready === true
    );
const requestedReason = msg.payload?.reason ??
    msg.payload?.recovery_reason ??
    (recoveryNeeded ? "readiness_recovery_needed" : "scheduled_refresh");

/* Recovery explícito, inclusive manual_force, quebra apenas cooldown de
 * sucesso. Nunca quebra o backoff de uma tentativa aguardando evidência. */
const successCooldownActive =
    state.awaiting_evidence !== true &&
    state.last_success_at > 0 &&
    now < state.next_allowed_at;
if (recoveryNeeded && successCooldownActive) state.next_allowed_at = 0;

const hour = new Date(now).getHours();
const daytime = hour >= 7 && hour < 22;
const enabled =
    recoveryNeeded ||
    msg.payload?.anyone_away === true ||
    daytime;

if (!enabled) {
    save("waiting", "waiting_for_movement", {
        enabled: false,
        next_retry_at: null,
        cooldown_until: null
    });
    node.status({
        fill: "grey",
        shape: "ring",
        text: "refresh vehicle_primary: aguardando movimento"
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
    if (requestedReason === "manual_force" && waitingEvidence) {
        const retryAt = new Date(state.next_allowed_at).toLocaleTimeString(
            "pt-BR",
            { hour: "2-digit", minute: "2-digit", second: "2-digit" }
        );
        msg.notification = {
            title: "Atualização do Creta não enviada",
            message:
                "Já existe uma tentativa de atualização aguardando resposta " +
                `do Bluelink. O clique foi recebido, mas uma nova consulta não ` +
                `foi enviada para evitar excesso de chamadas. Próxima tentativa ` +
                `automática em ${waitS} s, às ${retryAt}.`,
            id: "vehicle_primary_refresh_blocked"
        };
        node.log?.(
            "VEHICLE_PRIMARY_REFRESH_SUPPRESSED origin=dashboard " +
            `reason=backoff remaining_seconds=${waitS}`
        );
        return [null, null, msg];
    }
    return null;
}

state.baseline_observed_at = {
    location: Number(vehicleContext.location?.updated_at ?? 0),
    engine: Number(vehicleContext.engine_updated_at ?? 0),
    lock: Number(vehicleContext.lock_updated_at ?? 0)
};
state.attempts = Math.min(5, state.attempts + 1);
state.last_attempt_at = now;
state.last_request_at = now;
state.next_allowed_at = now + Math.min(
    INTERVAL_MS,
    BASE_RETRY_MS * (2 ** (state.attempts - 1))
);
state.awaiting_evidence = true;
state.last_attempt_cycle = msg.payload.refresh_cycle_id ?? null;
state.require_lighting_ready = requireLightingReady;
state.recovery_reason = requestedReason;
state.manual_force = requestedReason === "manual_force";
save("refreshing", requestedReason, { enabled: true });

node.log?.(
    (state.attempts > 1
        ? "VEHICLE_PRIMARY_REFRESH_RETRY"
        : "VEHICLE_PRIMARY_REFRESH_REQUESTED") +
    " attempt=" + state.attempts +
    " reason=" + requestedReason +
    " recovery=" + String(recoveryNeeded) +
    " require_lighting_ready=" + String(requireLightingReady)
);

msg.payload.retry_attempt = state.attempts;
msg.payload.refresh_requested_at = now;
msg.payload.vehicle_primary_refresh_recovery = recoveryNeeded;
msg.payload.require_lighting_ready = requireLightingReady;
msg.payload.origin = msg.payload.origin ?? "contexto_chegadas";

node.status({
    fill: recoveryNeeded ? "yellow" : "green",
    shape: "dot",
    text: recoveryNeeded
        ? `Bluelink #${state.attempts}: ${requestedReason}`
        : `Bluelink #${state.attempts}: refresh real`
});

return [msg, msg, null];
