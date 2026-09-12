const data = msg._people;
const facts = data?.facts ?? {};
const source = data?.people?.[data.source];
data.blocked = {
    _location_test: data.test_mode,
    _location_test_case: data.test_mode ? (msg._location_test_case ?? null) : undefined,
    payload: {
        contract: "security.arrival-direction.v1",
        kind: "arrival_blocked",
        source: data.source,
        trigger_state: data.trigger_state,
        trigger_prev_state: data.trigger_prev_state,
        direction_reason: facts.departure ? "departure_from_home"
            : !facts.external_cycle_confirmed ? "external_cycle_not_confirmed"
            : facts.stale_catchup ? "stale_home_catchup"
            : "transition_not_arrival_eligible",
        simulated: data.test_mode,
        dispatched: false,
        event_at: source?.updated_at ?? Date.now()
    }
};
return msg;
