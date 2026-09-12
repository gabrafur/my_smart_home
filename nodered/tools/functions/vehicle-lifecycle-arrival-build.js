const data = msg._vehicle;
data.arrival = {
    _location_test: data.test_mode,
    _location_test_case: data.test_mode ? (msg._location_test_case ?? null) : undefined,
    payload: {
        contract: "security.arrival.v1",
        kind: "arrival",
        source: "vehicle_primary",
        arriving: ["vehicle_primary"],
        arrival_source_type: "vehicle_primary",
        arrival_stage: data.facts.approach_entry ? "approach" : "home",
        arrival_direction: "returning",
        external_cycle_confirmed: true,
        request_vehicle_primary_wake: data.facts.approach_entry,
        event_at: data.location.updated_at ?? Date.now(),
        refresh_cycle_id: data.refresh_cycle_id
    }
};
if (!data.facts.approach_entry && data.facts.near_home) data.armed = false;
return msg;
