const data = msg._vehicle;
const key = data.test_mode
    ? "security_vehicle_primary_refresh_v1__test" : "security_vehicle_primary_refresh_v1";
const state = data.test_mode ? flow.get(key) : flow.get(key, "persistent");
data.refresh_key = key;
data.refresh_state = state && typeof state === "object" ? state : {};
const requestAt = Number(data.refresh_state.last_request_at ??
    data.refresh_state.last_attempt_at ?? 0);
const baseline = Number(data.refresh_state.baseline_observed_at?.telemetry ?? 0);
const current = Number(data.context.telemetry_updated_at ?? 0);
const futureMs = Number(data.policy.future_tolerance_seconds) * 1000;
const evidenceWindowMs = Number(data.refresh_state.semantic_evidence_window_ms);
const attemptCurrent = Number(data.refresh_state.last_attempt_at ?? 0) > 0 &&
    Number.isFinite(evidenceWindowMs) && evidenceWindowMs > 0 &&
    Number(data.refresh_state.last_attempt_at) <= Date.now() + futureMs &&
    Date.now() - Number(data.refresh_state.last_attempt_at) <= evidenceWindowMs + futureMs;
data.evidence = {
    awaiting: data.refresh_state.awaiting_evidence === true,
    confirmed: attemptCurrent && current > 0 &&
        current <= Date.now() + futureMs &&
        (baseline <= 0 || current > baseline) && requestAt > 0 &&
        current >= requestAt - futureMs
};
return msg;
