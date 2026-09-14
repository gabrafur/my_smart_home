const data = msg._light_context;
if (!data) return null;

data.engine_on_arrival = null;
const engineJustTurnedOn =
    data.kind === "vehicle_primary_context" &&
    data.accepted === true &&
    data.original_payload?.event === "turn_on" &&
    data.engine_allowed === true;
const bypassJustBecameAvailable =
    data.kind === "engine_bypass_context" &&
    data.original_payload?.enabled === true &&
    data.bypass_allowed === true;
if (!engineJustTurnedOn && !bypassJustBecameAvailable) return msg;

const armed = data.people?.arrival_armed ?? {};
const candidates = ["resident_primary", "resident_secondary"]
    .map((source) => ({ source, resident: data.people?.[source] }))
    .filter(({ source, resident }) =>
        armed[source] === true &&
        resident?.ready === true &&
        resident?.stale !== true &&
        resident?.state === "near_home" &&
        resident?.current_home !== true)
    .sort((left, right) => {
        const leftDistance = Number(left.resident?.distance_m);
        const rightDistance = Number(right.resident?.distance_m);
        return (Number.isFinite(leftDistance) ? leftDistance : Infinity) -
            (Number.isFinite(rightDistance) ? rightDistance : Infinity);
    });
const candidate = candidates[0];
if (!candidate) return msg;

const eventAt = Number(data.original_payload?.updated_at ?? data.now);
data.engine_on_arrival = {
    payload: {
        contract: "security.arrival.v1",
        kind: "arrival",
        source: candidate.source,
        arriving: [candidate.source],
        arrival_source_type: "person",
        arrival_stage: "approach",
        arrival_previous_state: "not_home",
        arrival_direction: "returning",
        external_cycle_confirmed: true,
        event_at: Number.isFinite(eventAt) ? eventAt : data.now,
        refresh_cycle_id: data.original_payload?.refresh_cycle_id,
        arrival_replayed_after_engine_authorization: true,
        arrival_replayed_after_engine_on: engineJustTurnedOn,
        arrival_replayed_after_engine_bypass: bypassJustBecameAvailable
    },
    _arrival_replay: true
};
if (data.test_mode) {
    data.engine_on_arrival._location_test = true;
    data.engine_on_arrival._location_test_case = data.test_case;
    data.engine_on_arrival.payload.test_mode = true;
    data.engine_on_arrival.payload.test_case = data.test_case;
}
return msg;
