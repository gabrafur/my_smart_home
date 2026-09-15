if (msg.payload?.kind !== "refresh_command") return null;
const config = msg.payload?.refresh_policy_config ?? {};
const required = ["away_interval_ms", "arrival_armed_interval_ms",
    "approaching_interval_ms", "home_interval_ms",
    "in_flight_lease_ms", "cache_probe_settle_ms", "provider_backoff_max_ms",
    "semantic_evidence_window_ms", "unknown_location_start_hour",
    "unknown_location_end_hour"];
if (msg.payload?.refresh_policy_version !== 1 ||
    required.some((key) => !Number.isFinite(Number(config[key]))) ||
    required.slice(0, 8).some((key) => Number(config[key]) <= 0)) {
    node.error("Política visual de refresh ausente; comando não será despachado", msg);
    return null;
}
const testMode = msg._location_test === true || msg.payload?.test_mode === true;
const stateKey = testMode
    ? "security_vehicle_primary_refresh_v1__test" : "security_vehicle_primary_refresh_v1";
const nowCandidate = Number(msg.payload?.test_now);
const now = testMode && Number.isFinite(nowCandidate) ? nowCandidate : Date.now();
const locationPolicy = global.get("location_policy_v1", "persistent") ?? {};
const futureMs = Number(locationPolicy.future_tolerance_seconds) * 1000;
const futureToleranceMs = Number.isFinite(futureMs) ? futureMs : 60000;
let state = testMode ? flow.get(stateKey) : flow.get(stateKey, "persistent");
if (!state || typeof state !== "object" || Array.isArray(state)) state = {};
const previousVersion = Number(state.version ?? 0);
state.version = 14;
state.attempts = Number.isFinite(state.attempts)
    ? Math.max(0, Math.min(5, state.attempts)) : 0;
const validPast = (value) => Number.isFinite(value) && value <= now + futureToleranceMs;
state.last_success_at = validPast(state.last_success_at) ? state.last_success_at : 0;
state.last_attempt_at = validPast(state.last_attempt_at) ? state.last_attempt_at : 0;
state.last_request_at = validPast(state.last_request_at)
    ? state.last_request_at : state.last_attempt_at;
state.service_accepted_at = validPast(state.service_accepted_at)
    ? state.service_accepted_at : 0;
state.next_allowed_at = Number.isFinite(state.next_allowed_at) &&
    state.next_allowed_at <= now + Number(config.provider_backoff_max_ms) + futureToleranceMs
        ? state.next_allowed_at : 0;
if (previousVersion < 14 && state.last_success_reason === "api_accepted_200_or_202" &&
    state.service_accepted_at > 0 && state.service_accepted_at >= state.last_request_at) {
    const evidenceAt = Number(state.last_evidence_at ?? 0);
    state.attempts = Math.max(1, state.attempts);
    state.awaiting_evidence = true;
    state.evidence_wait_started_at = state.last_request_at || state.service_accepted_at;
    state.last_success_at = Number.isFinite(evidenceAt) && evidenceAt > 0 &&
        evidenceAt < state.service_accepted_at ? evidenceAt : 0;
    state.last_success_reason = state.last_success_at > 0 ? "previous_semantic_evidence" : null;
    state.last_evidence_domains = state.last_success_at > 0 ? ["telemetry"] : [];
    state.next_allowed_at = Math.min(state.next_allowed_at, now);
    state.state = "backoff";
    state.reason = "api_accepted_awaiting_fresh_data";
    state.cooldown_until = null;
}
const boundedFuture = (value, max) => Number.isFinite(value) &&
    value <= now + max + futureToleranceMs ? value : 0;
state.in_flight_until = boundedFuture(state.in_flight_until, Number(config.in_flight_lease_ms));
state.cache_probe_for_request_at = validPast(state.cache_probe_for_request_at)
    ? state.cache_probe_for_request_at : 0;
state.cache_probe_completed_for_request_at = validPast(state.cache_probe_completed_for_request_at)
    ? state.cache_probe_completed_for_request_at : 0;
state.cache_probe_in_flight_until = boundedFuture(state.cache_probe_in_flight_until,
    Number(config.in_flight_lease_ms));
state.cache_probe_settle_until = boundedFuture(state.cache_probe_settle_until,
    Number(config.cache_probe_settle_ms));
state.failure_notified_at = validPast(state.failure_notified_at)
    ? state.failure_notified_at : 0;
state.semantic_evidence_window_ms = Number(config.semantic_evidence_window_ms);
state.evidence_wait_started_at = validPast(state.evidence_wait_started_at) &&
    state.evidence_wait_started_at > 0 ? state.evidence_wait_started_at
    : state.awaiting_evidence === true
        ? state.last_request_at || state.last_attempt_at || 0 : 0;
if (state.last_failure_class === "integration_unavailable" && !state.failure_endpoint) {
    state.last_failure_class = null;
    state.failure_source = null;
    state.failure_stage = null;
    state.next_allowed_at = Math.min(state.next_allowed_at, now);
}
msg._refresh = {
    test_mode: testMode,
    state_key: stateKey,
    now,
    future_tolerance_ms: futureToleranceMs,
    config,
    state,
    vehicle_context: testMode
        ? flow.get("vehicle_primary_context_v1__test") ?? {}
        : flow.get("vehicle_primary_context_v1") ?? {}
};
return msg;
