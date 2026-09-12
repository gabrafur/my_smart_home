const data = msg._light_arrival;
const key = "security_light_last_recovery_request_at" + (data.test_mode ? "__test" : "");
flow.set(key, data.now);
const reason = data.vehicle.ready === true
    ? "arrival_engine_recovery_needed" : "arrival_vehicle_primary_context_recovery_needed";
data.recovery_request = {
    _location_test: data.test_mode,
    _location_test_case: data.test_case,
    payload: {
        kind: "refresh_tick",
        origin: "iluminacao_seguranca",
        reason,
        force_recovery: true,
        require_lighting_ready: true,
        requested_at: data.now,
        arrival_source: data.source,
        arrival_stage: data.stage,
        test_mode: data.test_mode,
        test_case: data.test_case
    }
};
data.diagnostic.payload.context_recovery_requested = true;
data.diagnostic.payload.context_recovery_reason = reason;
data.outcome = "pending";
return msg;
