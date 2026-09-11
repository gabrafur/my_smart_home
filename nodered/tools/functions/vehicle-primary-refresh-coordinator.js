const TEST_MODE =
    msg._location_test === true ||
    msg.payload?.test_mode === true;

if (msg.payload?.kind !== "refresh_command") return null;

const policyConfig = msg.payload?.refresh_policy_config ?? {};
const AWAY_INTERVAL_MS = Number(policyConfig.away_interval_ms);
const APPROACHING_INTERVAL_MS = Number(policyConfig.approaching_interval_ms);
const HOME_INTERVAL_MS = Number(policyConfig.home_interval_ms);
const presenceIntervalMs = Number(msg.payload?.refresh_interval_ms);
const policyReady =
    msg.payload?.refresh_policy_version === 1 &&
    Number.isFinite(AWAY_INTERVAL_MS) &&
    Number.isFinite(APPROACHING_INTERVAL_MS) &&
    Number.isFinite(HOME_INTERVAL_MS) &&
    Number.isFinite(presenceIntervalMs) &&
    AWAY_INTERVAL_MS > 0 &&
    APPROACHING_INTERVAL_MS > 0 &&
    HOME_INTERVAL_MS > 0 &&
    presenceIntervalMs > 0;

if (!policyReady) {
    node.error(
        "Política visual de refresh ausente; comando não será despachado",
        msg
    );
    return null;
}

const IN_FLIGHT_LEASE_MS = 2 * 60 * 1000;
const CACHE_PROBE_SETTLE_MS = 15 * 1000;
const FUTURE_TOLERANCE_MS = 60 * 1000;
const MAX_PROVIDER_BACKOFF_MS = 6 * 60 * 60 * 1000;
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
const residentStatesKnown =
    msg.payload?.refresh_resident_states_known === true;
const bothResidentsHome =
    msg.payload?.refresh_both_residents_home === true;
const anyoneApproaching =
    msg.payload?.refresh_anyone_approaching === true;
const anyoneAwayOrApproaching =
    msg.payload?.refresh_anyone_away === true ||
    anyoneApproaching;

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

const previousStateVersion = Number(state.version ?? 0);
state.version = 14;
state.attempts = Number.isFinite(state.attempts)
    ? Math.max(0, Math.min(5, state.attempts))
    : 0;
state.last_success_at = Number.isFinite(state.last_success_at) &&
    state.last_success_at <= now + FUTURE_TOLERANCE_MS
        ? state.last_success_at
        : 0;
state.next_allowed_at = Number.isFinite(state.next_allowed_at) &&
    state.next_allowed_at <= now + MAX_PROVIDER_BACKOFF_MS + FUTURE_TOLERANCE_MS
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
state.service_accepted_at = Number.isFinite(state.service_accepted_at) &&
    state.service_accepted_at <= now + FUTURE_TOLERANCE_MS
        ? state.service_accepted_at
        : 0;
/* A versão 13 promovia o aceite do serviço a sucesso semântico. Reverta esse
 * falso sucesso para que o runtime instalado volte a tentar imediatamente e
 * só se recupere quando o timestamp real do veículo avançar. */
if (
    previousStateVersion < 14 &&
    state.last_success_reason === "api_accepted_200_or_202" &&
    state.service_accepted_at > 0 &&
    state.service_accepted_at >= state.last_request_at
) {
    const lastSemanticEvidenceAt = Number(state.last_evidence_at ?? 0);
    state.attempts = Math.max(1, state.attempts);
    state.awaiting_evidence = true;
    state.evidence_wait_started_at =
        state.last_request_at || state.service_accepted_at;
    state.last_success_at = Number.isFinite(lastSemanticEvidenceAt) &&
        lastSemanticEvidenceAt > 0 &&
        lastSemanticEvidenceAt < state.service_accepted_at
            ? lastSemanticEvidenceAt
            : 0;
    state.last_success_reason = state.last_success_at > 0
        ? "previous_semantic_evidence"
        : null;
    state.last_evidence_domains = state.last_success_at > 0
        ? ["telemetry"]
        : [];
    state.next_allowed_at = Math.min(state.next_allowed_at, now);
    state.state = "backoff";
    state.reason = "api_accepted_awaiting_fresh_data";
    state.cooldown_until = null;
}
const contextReady =
    msg.payload?.vehicle_primary_ready === true ||
    vehicleContext.ready === true;
const derivedContextRecoveryNeeded =
    msg.payload?.recovery_needed === true ||
    msg.payload?.vehicle_primary_ready === false ||
    contextReady !== true;
const lastSemanticSuccessAt = Number(state.last_success_at ?? 0);
const semanticWakeHealthy =
    state.awaiting_evidence !== true &&
    state.last_failure_class == null &&
    Array.isArray(state.last_evidence_domains) &&
    state.last_evidence_domains.includes("telemetry") &&
    lastSemanticSuccessAt > 0 &&
    lastSemanticSuccessAt <= now + FUTURE_TOLERANCE_MS &&
    now - lastSemanticSuccessAt <=
        HOME_INTERVAL_MS + FUTURE_TOLERANCE_MS;
/*
 * Readiness derivado continua protegendo iluminação e demais automações,
 * mas não deve reduzir sozinho o ciclo de wake depois que o próprio
 * Bluelink aceitou a chamada. Uma recuperação explícita, uma falha real ou
 * uma chamada ainda sem conclusão continuam usando 15 minutos.
 */
const recoveryNeeded =
    msg.payload?.force_recovery === true ||
    msg.payload?.require_lighting_ready === true ||
    state.awaiting_evidence === true ||
    (derivedContextRecoveryNeeded && !semanticWakeHealthy);
const requireLightingReady =
    msg.payload?.require_lighting_ready === true ||
    (
        state.awaiting_evidence === true &&
        state.require_lighting_ready === true
    );
const requestedReason = msg.payload?.reason ??
    msg.payload?.recovery_reason ??
    (recoveryNeeded ? "readiness_recovery_needed" : "scheduled_refresh");
const manualBypass = requestedReason === "manual_force";
const residentDepartureBypass =
    requestedReason === "resident_departure" &&
    msg.payload?.resident_departure_force === true;
const deadlineBypass = manualBypass || residentDepartureBypass;
/* Chegada tem precedência inclusive quando o contexto do veículo está
 * pendente: durante a aproximação, a política solicitada é sempre aplicada.
 * Fora desse estado, recuperação usa o intervalo configurado para fora. */
const selectedIntervalMs = anyoneApproaching
    ? APPROACHING_INTERVAL_MS
    : recoveryNeeded && !deadlineBypass
        ? AWAY_INTERVAL_MS
        : presenceIntervalMs;
const previousIntervalMs = [
    AWAY_INTERVAL_MS,
    APPROACHING_INTERVAL_MS,
    HOME_INTERVAL_MS
]
    .includes(Number(state.interval_ms))
        ? Number(state.interval_ms)
        : AWAY_INTERVAL_MS;
const intervalChanged = previousIntervalMs !== selectedIntervalMs;
state.interval_ms = selectedIntervalMs;
state.interval_policy = anyoneApproaching
    ? "approaching"
    : recoveryNeeded && !deadlineBypass
        ? "recovery"
        : msg.payload.refresh_interval_policy;
const intervalAnchorAt = Math.max(
    state.last_request_at,
    state.service_accepted_at,
    state.last_success_at
);
const requestFloorAt = intervalAnchorAt > 0
    ? intervalAnchorAt + selectedIntervalMs
    : 0;
state.next_allowed_at = intervalChanged
    ? requestFloorAt
    : Math.max(state.next_allowed_at, requestFloorAt);
state.in_flight_until = Number.isFinite(state.in_flight_until) &&
    state.in_flight_until <= now + IN_FLIGHT_LEASE_MS
        ? state.in_flight_until
        : 0;
state.cache_probe_for_request_at = Number.isFinite(
    state.cache_probe_for_request_at
) && state.cache_probe_for_request_at <= now + FUTURE_TOLERANCE_MS
    ? state.cache_probe_for_request_at
    : 0;
state.cache_probe_completed_for_request_at = Number.isFinite(
    state.cache_probe_completed_for_request_at
) && state.cache_probe_completed_for_request_at <= now + FUTURE_TOLERANCE_MS
    ? state.cache_probe_completed_for_request_at
    : 0;
state.cache_probe_in_flight_until = Number.isFinite(
    state.cache_probe_in_flight_until
) && state.cache_probe_in_flight_until <= now + IN_FLIGHT_LEASE_MS
    ? state.cache_probe_in_flight_until
    : 0;
state.cache_probe_settle_until = Number.isFinite(
    state.cache_probe_settle_until
) && state.cache_probe_settle_until <= now + CACHE_PROBE_SETTLE_MS
    ? state.cache_probe_settle_until
    : 0;
state.failure_notified_at = Number.isFinite(state.failure_notified_at) &&
    state.failure_notified_at <= now + FUTURE_TOLERANCE_MS
        ? state.failure_notified_at
        : 0;
state.evidence_wait_started_at =
    Number.isFinite(state.evidence_wait_started_at) &&
    state.evidence_wait_started_at > 0 &&
    state.evidence_wait_started_at <= now + FUTURE_TOLERANCE_MS
        ? state.evidence_wait_started_at
        : (
            state.awaiting_evidence === true
                ? state.last_request_at || state.last_attempt_at || 0
                : 0
        );
/* Versões anteriores inferiam integration_unavailable apenas por readiness
 * incompleto. Um incidente real, classificado pelo catch da chamada, sempre
 * registra failure_endpoint; reavalie imediatamente somente o estado legado
 * sem essa evidência. */
if (
    state.last_failure_class === "integration_unavailable" &&
    !state.failure_endpoint
) {
    state.last_failure_class = null;
    state.failure_source = null;
    state.failure_stage = null;
    state.next_allowed_at = Math.min(state.next_allowed_at, now);
}
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
    return [null, null, msg, null, null];
}

function withFailure(result) {
    return result;
}

if (
    state.cache_probe_in_flight === true &&
    now < state.cache_probe_in_flight_until
) {
    const waitS = Math.max(
        1,
        Math.ceil((state.cache_probe_in_flight_until - now) / 1000)
    );
    save("probing_cache", "cache_probe_in_flight", { enabled: true });
    node.status({
        fill: "yellow",
        shape: "ring",
        text: `releitura do cache em andamento ${waitS}s`
    });
    return withFailure(blockedNotification("in_flight", waitS));
}

if (state.cache_probe_in_flight === true) {
    state.cache_probe_in_flight = false;
    state.cache_probe_in_flight_until = null;
    state.cache_probe_for_request_at = null;
    state.last_failure_class = "cache_probe_lease_expired";
    state.next_allowed_at = Math.max(
        state.next_allowed_at,
        now + selectedIntervalMs
    );
}

if (now < state.cache_probe_settle_until) {
    const waitS = Math.max(
        1,
        Math.ceil((state.cache_probe_settle_until - now) / 1000)
    );
    save("probing_cache", "cache_probe_settling", { enabled: true });
    node.status({
        fill: "yellow",
        shape: "ring",
        text: `aguardando cache ${waitS}s`
    });
    return withFailure(blockedNotification("cache_probe_settling", waitS));
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
    return withFailure(blockedNotification("in_flight", waitS));
}

if (state.request_in_flight === true) {
    state.request_in_flight = false;
    state.in_flight_until = null;
    state.last_failure_class = "in_flight_lease_expired";
}

/* A pausa noturna já foi aplicada pelo bloco visual anterior. Aqui resta
 * apenas a compatibilidade diurna para localização ainda desconhecida. */
const hour = new Date(now).getHours();
const legacyDaytime = hour >= 7 && hour < 22;

const departureEventAt = Number(msg.payload?.departure_event_at ?? 0);
if (
    residentDepartureBypass &&
    departureEventAt > 0 &&
    state.last_request_at >= departureEventAt
) {
    save(
        state.awaiting_evidence === true ? "awaiting_evidence" : "cooldown",
        "resident_departure_already_covered",
        { enabled: true }
    );
    node.status({
        fill: "grey",
        shape: "ring",
        text: "saída do morador já coberta por refresh"
    });
    return withFailure(null);
}

const enabled =
    recoveryNeeded ||
    anyoneAwayOrApproaching ||
    bothResidentsHome ||
    (!residentStatesKnown && legacyDaytime);

if (!enabled) {
    save("waiting", "waiting_for_resident_location", {
        enabled: false,
        next_retry_at: null,
        cooldown_until: null
    });
    node.status({
        fill: "grey",
        shape: "ring",
        text: "refresh vehicle_primary: aguardando localização"
    });
    return withFailure(null);
}

const pendingRequestAt = Number(state.last_request_at ?? 0);

if (!deadlineBypass && now < state.next_allowed_at) {
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
        return withFailure(blockedNotification("backoff", waitS));
    }
    return withFailure(blockedNotification("minimum_interval", waitS));
}

/*
 * Antes de repetir um wake automático, peça ao Home Assistant uma leitura
 * somente do cache. Isso alinha os dois ciclos de 15 minutos: se a telemetria
 * do wake anterior já chegou ao provedor, o snapshot seguinte a confirmará e
 * o novo wake será evitado. O clique manual continua explícito e não passa por
 * esta etapa.
 */
const cacheProbeCompletedForPendingRequest =
    pendingRequestAt > 0 &&
    state.cache_probe_completed_for_request_at === pendingRequestAt;
if (
    !deadlineBypass &&
    state.awaiting_evidence === true &&
    pendingRequestAt > 0 &&
    !cacheProbeCompletedForPendingRequest
) {
    state.cache_probe_in_flight = true;
    state.cache_probe_in_flight_until = now + IN_FLIGHT_LEASE_MS;
    state.cache_probe_for_request_at = pendingRequestAt;
    state.cache_probe_settle_until = null;
    save("probing_cache", "pre_wake_cache_probe", { enabled: true });
    msg.payload.cache_probe_for_request_at = pendingRequestAt;
    msg.payload.origin = msg.payload.origin ?? "contexto_chegadas";
    msg.payload.test_mode = TEST_MODE;
    msg.payload.side_effect = "vehicle_primary.cache_probe";
    node.log?.(
        "VEHICLE_PRIMARY_CACHE_PROBE_REQUESTED" +
        " previous_request_at=" + pendingRequestAt +
        " test_mode=" + String(TEST_MODE)
    );
    node.status({
        fill: TEST_MODE ? "blue" : "yellow",
        shape: "dot",
        text: TEST_MODE
            ? "TESTE: releitura de cache em dry-run"
            : "relendo cache antes de novo wake"
    });
    return withFailure([null, null, null, null, msg]);
}

state.cache_probe_in_flight = false;
state.cache_probe_in_flight_until = null;
state.cache_probe_for_request_at = null;
state.cache_probe_completed_for_request_at = null;
state.cache_probe_settle_until = null;

state.baseline_observed_at = {
    telemetry: Number(vehicleContext.telemetry_updated_at ?? 0)
};
if (
    state.awaiting_evidence !== true ||
    !(Number(state.evidence_wait_started_at) > 0)
) {
    state.evidence_wait_started_at = now;
}
state.attempts = Math.min(5, state.attempts + 1);
state.last_attempt_at = now;
state.last_request_at = now;
state.next_allowed_at = now + selectedIntervalMs;
state.awaiting_evidence = true;
state.request_in_flight = true;
state.in_flight_until = now + IN_FLIGHT_LEASE_MS;
state.last_attempt_cycle = msg.payload.refresh_cycle_id ?? null;
state.require_lighting_ready = requireLightingReady;
state.recovery_reason = requestedReason;
state.manual_force = requestedReason === "manual_force";
state.resident_departure_force = residentDepartureBypass;
save("refreshing", requestedReason, { enabled: true });

node.log?.(
    (state.attempts > 1
        ? "VEHICLE_PRIMARY_REFRESH_RETRY"
        : "VEHICLE_PRIMARY_REFRESH_REQUESTED") +
    " attempt=" + state.attempts +
    " reason=" + requestedReason +
    " recovery=" + String(recoveryNeeded) +
    " semantic_health=" + String(semanticWakeHealthy) +
    " interval_minutes=" + String(selectedIntervalMs / 60_000) +
    " both_home=" + String(bothResidentsHome) +
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

return [
    msg,
    TEST_MODE ? null : msg,
    null,
    null,
    null
];
