const data = msg._light_arrival;
msg.payload.arrival_key = [data.source, data.stage, data.event_at].join(":");
Object.assign(msg.payload, {
    sun_below_horizon: data.dark,
    vehicle_primary_in_use: data.vehicle.in_use,
    vehicle_primary_engine_on: data.vehicle.engine_on,
    vehicle_primary_engine_state_valid: data.vehicle.engine_state_valid === true,
    vehicle_primary_engine_stale: data.vehicle.engine_stale === true,
    engine_communication_failed: data.engine_communication_failed,
    vehicle_primary_lighting_ready: data.vehicle_lighting_ready,
    engine_data_unreliable: data.engine_unreliable,
    engine_bypass_enabled: data.bypass_enabled,
    engine_bypass_allowed: data.bypass_allowed,
    stale_engine_home_fallback: data.stale_engine_home_fallback === true,
    active: data.lifecycle.active_by_arrival === true || data.physical === "on",
    reflector_state: data.physical,
    reflector_physical_fresh: data.physical_fresh,
    reflector_reconciled: data.light_reconciled
});
if (data.test_mode) {
    msg._location_test = true;
    msg._location_test_case = data.test_case;
    msg.payload.test_mode = true;
    msg.payload.test_case = data.test_case;
}
data.outcome = "ready";
return msg;
