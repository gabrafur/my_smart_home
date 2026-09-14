const data = msg._light_arrival;
const suffix = data.test_mode ? "__test" : "";
const key = "security_light_pending_arrival_v1";
const existing = data.test_mode ? flow.get(key + suffix) : flow.get(key, "persistent");
const existingAt = Number(existing?.event_at ?? 0);
const residentApproach = data.resident_arrival && data.stage === "approach";
if (!existing || !Number.isFinite(existingAt) || data.event_at >= existingAt) {
    /* Persist only the replay contract. The live Node-RED message contains
     * transient runtime objects (including _light_arrival itself); retaining
     * that object graph makes the file context circular after we attach the
     * diagnostic below. */
    const replayMessage = {
        payload: { ...(msg.payload ?? {}) }
    };
    if (msg.topic !== undefined) replayMessage.topic = msg.topic;
    if (msg._location_test === true) replayMessage._location_test = true;
    if (msg._location_test_case !== undefined) {
        replayMessage._location_test_case = msg._location_test_case;
    }
    const pending = {
        version: 2,
        queued_at: data.queued_at,
        expires_at: data.queued_at + data.arrival_recovery_ms,
        event_at: data.event_at,
        retention: residentApproach ? "while_approaching" : "recovery_window",
        source: data.source,
        arrival_stage: data.stage,
        message: replayMessage
    };
    if (data.test_mode) flow.set(key + suffix, pending);
    else flow.set(key, pending, "persistent");
}
data.diagnostic = {
    ...msg,
    payload: {
        ...(msg.payload ?? {}),
        diagnostic: "arrival_trigger_received",
        gps_trigger_functional: true,
        decision_context_ready: data.logic_ready,
        people_context_ready: data.people.ready === true,
        vehicle_primary_context_ready: data.vehicle.ready === true,
        vehicle_primary_lighting_ready: data.vehicle_lighting_ready,
        vehicle_primary_location_required: false,
        vehicle_primary_engine_state_valid: data.vehicle.engine_state_valid === true,
        vehicle_primary_engine_stale: data.vehicle.engine_stale === true,
        engine_communication_failed: data.engine_communication_failed,
        engine_bypass_enabled: data.bypass_enabled,
        engine_bypass_allowed: data.bypass_allowed,
        engine_data_unreliable: data.engine_unreliable,
        sun_ready: data.sun_ready,
        sun_below_horizon: data.dark,
        vehicle_primary_in_use: data.vehicle.in_use,
        vehicle_primary_engine_on: data.vehicle.engine_on,
        reflector_state: data.physical,
        reflector_physical_fresh: data.physical_fresh,
        reflector_reconciled: data.light_reconciled,
        would_evaluate_turn_on: data.logic_ready,
        arrival_replay: msg._arrival_replay === true,
        pending_arrival_queued: true,
        pending_arrival_retention: residentApproach ? "while_approaching" : "recovery_window",
        pending_arrival_ttl_ms: data.arrival_recovery_ms
    }
};
if (data.test_mode) {
    data.diagnostic._location_test = true;
    data.diagnostic._location_test_case = data.test_case;
    data.diagnostic.payload.test_mode = true;
    data.diagnostic.payload.test_case = data.test_case;
}
return msg;
