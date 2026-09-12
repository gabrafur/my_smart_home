const data = msg._refresh;
const state = data.state;
state.cache_probe_in_flight = false;
state.cache_probe_in_flight_until = null;
state.cache_probe_for_request_at = null;
state.cache_probe_completed_for_request_at = null;
state.cache_probe_settle_until = null;
state.baseline_observed_at = {
    telemetry: Number(data.vehicle_context.telemetry_updated_at ?? 0)
};
if (state.awaiting_evidence !== true || !(Number(state.evidence_wait_started_at) > 0)) {
    state.evidence_wait_started_at = data.now;
}
state.attempts = Math.min(5, state.attempts + 1);
state.last_attempt_at = data.now;
state.last_request_at = data.now;
state.next_allowed_at = data.now + data.selected_interval_ms;
state.awaiting_evidence = true;
state.request_in_flight = true;
state.in_flight_until = data.now + Number(data.config.in_flight_lease_ms);
state.last_attempt_cycle = msg.payload.refresh_cycle_id ?? null;
state.require_lighting_ready = data.require_lighting_ready;
state.recovery_reason = data.requested_reason;
state.manual_force = data.requested_reason === "manual_force";
state.resident_departure_force = data.departure_bypass;
Object.assign(state, {
    state: "refreshing",
    reason: data.requested_reason,
    enabled: true,
    updated_at: data.now,
    next_retry_at: state.next_allowed_at,
    cooldown_until: null
});
msg.payload.retry_attempt = state.attempts;
msg.payload.refresh_requested_at = data.now;
msg.payload.vehicle_primary_refresh_recovery = data.recovery_needed;
msg.payload.require_lighting_ready = data.require_lighting_ready;
msg.payload.origin = msg.payload.origin ?? "contexto_chegadas";
msg.payload.test_mode = data.test_mode;
data.output = 0;
data.mirror_context = !data.test_mode;
return msg;
