const data = msg._refresh;
if (!data) return null;
const state = data.state;
const now = data.now;
const config = data.config;
const contextReady = msg.payload?.vehicle_primary_ready === true ||
    data.vehicle_context.ready === true;
const derivedRecovery = msg.payload?.recovery_needed === true ||
    msg.payload?.vehicle_primary_ready === false || contextReady !== true;
const lastSuccessAt = Number(state.last_success_at ?? 0);
const semanticHealthy = state.awaiting_evidence !== true &&
    state.last_failure_class == null && Array.isArray(state.last_evidence_domains) &&
    state.last_evidence_domains.includes("telemetry") && lastSuccessAt > 0 &&
    lastSuccessAt <= now + data.future_tolerance_ms &&
    now - lastSuccessAt <= Number(config.home_interval_ms) + data.future_tolerance_ms;
const recoveryNeeded = msg.payload?.force_recovery === true ||
    msg.payload?.require_lighting_ready === true || state.awaiting_evidence === true ||
    (derivedRecovery && !semanticHealthy);
const requireLighting = msg.payload?.require_lighting_ready === true ||
    (state.awaiting_evidence === true && state.require_lighting_ready === true);
const requestedReason = msg.payload?.reason ?? msg.payload?.recovery_reason ??
    (recoveryNeeded ? "readiness_recovery_needed" : "scheduled_refresh");
const manualBypass = requestedReason === "manual_force";
const departureBypass = requestedReason === "resident_departure" &&
    msg.payload?.resident_departure_force === true;
const arrivalBypass = requestedReason === "resident_arrival_confirmation" &&
    msg.payload?.resident_arrival_force === true;
const deadlineBypass = manualBypass || departureBypass || arrivalBypass;
const approaching = msg.payload?.refresh_anyone_approaching === true;
const arrivalRestartPending = msg.payload?.refresh_arrival_restart_pending === true;
const selectedInterval = arrivalRestartPending
    ? Number(config.arrival_armed_interval_ms)
    : approaching ? Number(config.approaching_interval_ms)
    : recoveryNeeded && !deadlineBypass ? Number(config.away_interval_ms)
    : Number(msg.payload?.refresh_interval_ms);
if (!Number.isFinite(selectedInterval) || selectedInterval <= 0) {
    node.error("Intervalo visual de refresh inválido", msg);
    return null;
}
const allowedIntervals = [Number(config.away_interval_ms),
    Number(config.arrival_armed_interval_ms),
    Number(config.approaching_interval_ms), Number(config.home_interval_ms)];
const previousInterval = allowedIntervals.includes(Number(state.interval_ms))
    ? Number(state.interval_ms) : Number(config.away_interval_ms);
const anchor = Math.max(state.last_request_at, state.service_accepted_at, state.last_success_at);
const floor = anchor > 0 ? anchor + selectedInterval : 0;
state.next_allowed_at = previousInterval !== selectedInterval
    ? floor : Math.max(state.next_allowed_at, floor);
const providerRetryAt = Number(state.provider_retry_at ?? 0);
const providerBlocked = Number.isFinite(providerRetryAt) && providerRetryAt > now;
if (providerBlocked) state.next_allowed_at = Math.max(state.next_allowed_at, providerRetryAt);
state.interval_ms = selectedInterval;
state.interval_policy = arrivalRestartPending ? "arrival_armed_engine_pending"
    : approaching ? "approaching"
    : recoveryNeeded && !deadlineBypass ? "recovery" : msg.payload.refresh_interval_policy;
const cacheActive = state.cache_probe_in_flight === true &&
    now < state.cache_probe_in_flight_until;
if (state.cache_probe_in_flight === true && !cacheActive) {
    state.cache_probe_in_flight = false;
    state.cache_probe_in_flight_until = null;
    state.cache_probe_for_request_at = null;
    state.last_failure_class = "cache_probe_lease_expired";
    state.next_allowed_at = Math.max(state.next_allowed_at, now + selectedInterval);
}
const requestActive = state.request_in_flight === true && now < state.in_flight_until;
if (state.request_in_flight === true && !requestActive) {
    state.request_in_flight = false;
    state.in_flight_until = null;
    state.last_failure_class = "in_flight_lease_expired";
}
const start = Number(config.unknown_location_start_hour);
const end = Number(config.unknown_location_end_hour);
const hour = new Date(now).getHours();
const unknownWindow = start < end ? hour >= start && hour < end
    : hour >= start || hour < end;
const statesKnown = msg.payload?.refresh_resident_states_known === true;
const bothHome = msg.payload?.refresh_both_residents_home === true;
const awayOrApproaching = msg.payload?.refresh_anyone_away === true || approaching;
const enabled = recoveryNeeded || awayOrApproaching || bothHome ||
    (!statesKnown && unknownWindow);
const pendingRequestAt = Number(state.last_request_at ?? 0);
const cacheCompleted = pendingRequestAt > 0 &&
    state.cache_probe_completed_for_request_at === pendingRequestAt;
data.recovery_needed = recoveryNeeded;
data.require_lighting_ready = requireLighting;
data.requested_reason = requestedReason;
data.manual_bypass = manualBypass;
data.departure_bypass = departureBypass;
data.arrival_bypass = arrivalBypass;
data.deadline_bypass = deadlineBypass;
data.selected_interval_ms = selectedInterval;
data.semantic_healthy = semanticHealthy;
data.flags = {
    cache_active: cacheActive,
    cache_settling: now < state.cache_probe_settle_until,
    request_active: requestActive,
    departure_covered: departureBypass && Number(msg.payload?.departure_event_at ?? 0) > 0 &&
        state.last_request_at >= Number(msg.payload.departure_event_at),
    enabled,
    deadline_blocked: providerBlocked || (!deadlineBypass && now < state.next_allowed_at),
    waiting_evidence: state.awaiting_evidence === true,
    cache_probe_needed: !deadlineBypass && state.awaiting_evidence === true &&
        pendingRequestAt > 0 && !cacheCompleted
};
return msg;
