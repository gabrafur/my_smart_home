const data = msg._vehicle;
data.blocked = {
    _location_test: data.test_mode,
    _location_test_case: data.test_mode ? (msg._location_test_case ?? null) : undefined,
    payload: {
        contract: "security.arrival-direction.v1",
        kind: "arrival_blocked",
        source: "vehicle_primary",
        trigger_state: data.trigger_state,
        trigger_prev_state: data.trigger_prev_state,
        direction_reason: data.facts.departure ? "departure_from_home"
            : data.armed !== true ? "external_cycle_not_confirmed"
            : data.facts.stale_catchup ? "stale_home_catchup"
            : "transition_not_arrival_eligible",
        simulated: data.test_mode,
        dispatched: false,
        event_at: data.location.updated_at ?? Date.now()
    }
};
if (!data.facts.approach_entry && data.facts.near_home) data.armed = false;
return msg;
