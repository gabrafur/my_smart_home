const data = msg._people;
const facts = data?.facts ?? {};
const source = data?.people?.[data.source];
data.arrival = {
    _location_test: data.test_mode,
    _location_test_case: data.test_mode ? (msg._location_test_case ?? null) : undefined,
    payload: {
        contract: "security.arrival.v1",
        kind: "arrival",
        source: data.source,
        arriving: [data.source],
        arrival_source_type: "person",
        arrival_stage: facts.approach_entry ? "approach" : "home",
        arrival_previous_state: data.trigger_prev_state,
        arrival_direction: "returning",
        external_cycle_confirmed: true,
        event_at: source?.updated_at ?? Date.now(),
        arrival_resident_snapshot: {
            state: source?.state ?? null,
            current_home: source?.current_home === true,
            ready: source?.ready === true,
            stale: source?.stale === true,
            updated_at: source?.updated_at ?? null
        },
        refresh_cycle_id: data.refresh_cycle_id
    }
};
if (!facts.approach_entry && facts.near_home) data.armed[data.source] = false;
return msg;
