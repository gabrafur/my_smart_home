const data = msg._refresh;
const state = data.state;
const requestAt = Number(state.last_request_at ?? 0);
state.cache_probe_in_flight = true;
state.cache_probe_in_flight_until = data.now + Number(data.config.in_flight_lease_ms);
state.cache_probe_for_request_at = requestAt;
state.cache_probe_settle_until = null;
Object.assign(state, {
    state: "probing_cache",
    reason: "pre_wake_cache_probe",
    enabled: true,
    updated_at: data.now
});
msg.payload.cache_probe_for_request_at = requestAt;
msg.payload.origin = msg.payload.origin ?? "contexto_chegadas";
msg.payload.test_mode = data.test_mode;
msg.payload.side_effect = "vehicle_primary.cache_probe";
data.output = 4;
return msg;
