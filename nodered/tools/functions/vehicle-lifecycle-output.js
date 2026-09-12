const data = msg._vehicle;
const refresh = data.refresh_state ?? {};
data.context.refresh = {
    state: refresh.state ?? "idle",
    reason: refresh.reason ?? refresh.recovery_reason ?? null,
    attempt: Number(refresh.attempts ?? 0),
    last_request_at: Number(refresh.last_request_at ?? refresh.last_attempt_at ?? 0) || null,
    last_success_at: Number(refresh.last_success_at ?? 0) || null,
    next_retry_at: Number(refresh.next_retry_at ?? 0) || null,
    cooldown_until: Number(refresh.cooldown_until ?? 0) || null,
    awaiting_evidence: refresh.awaiting_evidence === true,
    request_in_flight: refresh.request_in_flight === true,
    in_flight_until: Number(refresh.in_flight_until ?? 0) || null,
    last_failure_class: refresh.last_failure_class ?? null,
    manual_force: refresh.manual_force === true
};
const contextKey = data.test_mode ? "vehicle_primary_context_v1__test" : "vehicle_primary_context_v1";
flow.set(contextKey, data.context);
const readyKey = data.test_mode
    ? "security_vehicle_primary_ready_logged__test" : "security_vehicle_primary_ready_logged";
if (flow.get(readyKey) !== data.context.ready) {
    node.log?.("contexto_vehicle_primary: contexto " +
        (data.context.ready ? "ready (" + data.context.in_use_reason + ")" : "pending/stale"));
    flow.set(readyKey, data.context.ready);
}
msg.payload = {
    contract: "security.vehicle_primary-context.v1",
    kind: "vehicle_primary_context",
    context: data.context,
    event: data.event,
    reason: data.reason ?? (data.context.ready ? data.context.in_use_reason : "vehicle_context_pending"),
    source: "vehicle_primary",
    trigger_entity: data.trigger_entity,
    trigger_state: data.trigger_state,
    trigger_prev_state: data.trigger_prev_state,
    confirmed_home_transition: data.is_location_event && data.location.ready &&
        data.facts.trigger_prev_valid && data.trigger_state === "home" &&
        data.trigger_prev_state !== "home",
    refresh_cycle_id: data.refresh_cycle_id,
    updated_at: data.context.updated_at,
    valid: data.context.state_valid,
    ready: data.context.ready,
    lighting_ready: data.context.lighting_ready,
    stale: data.context.stale,
    readiness_reason: data.context.ready ? data.context.in_use_reason : "vehicle_context_pending"
};
if (data.test_mode) {
    msg._location_test = true;
    msg._location_test_case = msg._location_test_case ?? null;
    msg.payload.test_mode = true;
    msg.payload.test_case = msg._location_test_case;
    if (data.arrival?.payload) {
        data.arrival._location_test = true;
        data.arrival._location_test_case = msg._location_test_case;
        data.arrival.payload.test_mode = true;
        data.arrival.payload.test_case = msg._location_test_case;
    }
}
const recoveryRequest = !data.test_mode && data.fresh_movement ? {
    payload: {
        kind: "refresh_tick",
        origin: "contexto_vehicle_primary",
        reason: data.engine_fresh ? "vehicle_primary_location_changed"
            : "vehicle_primary_location_changed_engine_stale",
        force_recovery: true,
        require_lighting_ready: !data.engine_fresh,
        requested_at: Date.now()
    }
} : null;
const arrival = data.arrival ?? null;
const blocked = data.blocked ?? null;
delete msg._vehicle;
return [msg, arrival, recoveryRequest, blocked];
