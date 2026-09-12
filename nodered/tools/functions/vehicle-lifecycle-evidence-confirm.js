const data = msg._vehicle;
const state = data.refresh_state;
const interval = Number(state.interval_ms) > 0 ? Number(state.interval_ms) : 0;
const requestAt = Number(state.last_request_at ?? state.last_attempt_at ?? 0);
const cacheCurrent = Number(state.cache_probe_completed_for_request_at ?? 0) === requestAt &&
    Number(state.cache_probe_accepted_at ?? 0) > 0;
const next = Math.max(Date.now(), Number(state.next_allowed_at ?? 0),
    Number(state.last_request_at ?? Date.now()) + interval,
    cacheCurrent ? Date.now() + interval : 0);
const failureWasNotified = Number(state.failure_notified_at ?? 0) > 0;
data.refresh_state = {
    ...state,
    attempts: 0,
    last_success_at: Date.now(),
    next_allowed_at: next,
    awaiting_evidence: false,
    evidence_wait_started_at: null,
    request_in_flight: false,
    in_flight_until: null,
    cache_probe_in_flight: false,
    cache_probe_in_flight_until: null,
    cache_probe_for_request_at: null,
    cache_probe_completed_for_request_at: null,
    cache_probe_settle_until: null,
    failure_notified_at: null,
    failure_notification_key: null,
    recovery_notification_pending: failureWasNotified,
    last_failure_class: null,
    failure_at: null,
    failure_source: null,
    failure_endpoint: null,
    failure_stage: null,
    state: "cooldown",
    reason: state.recovery_reason ?? "refresh_success",
    cooldown_until: next,
    next_retry_at: null,
    last_evidence_at: Date.now(),
    last_evidence_domains: ["telemetry"],
    engine_communication_failed: false,
    engine_bypass_recovery_pending: state.engine_bypass_recovery_pending === true ||
        data.engine_communication_failed,
    lighting_ready_after_wake: data.context.ready && data.context.engine_state_valid,
    last_success_reason: data.context.ready && data.context.engine_state_valid
        ? "fresh_telemetry_engine_state_known" : "fresh_telemetry_context_ready",
    baseline_observed_at: null,
    require_lighting_ready: false,
    recovery_reason: null
};
if (data.test_mode) flow.set(data.refresh_key, data.refresh_state);
else flow.set(data.refresh_key, data.refresh_state, "persistent");
data.context.engine_communication_failed = false;
data.context.lighting_ready = data.refresh_state.lighting_ready_after_wake;
node.log?.("VEHICLE_PRIMARY_NEW_DATA_RECEIVED domains=telemetry");
return msg;
