const data = msg._people;
const candidate = data?.arrival ?? data?.lighting_only;
if (!candidate) return msg;
const eventAt = Number(candidate.payload?.event_at ?? Date.now());
const eventKey = data.arrival
    ? [data.source, candidate.payload.arrival_stage, data.trigger_state ?? "?", eventAt].join(":")
    : ["lighting_tracker_recovery_approach", data.source, eventAt].join(":");
if (data.recovery.recent_arrivals[eventKey]) {
    data.arrival = null;
    data.lighting_only = null;
    data.deduplicated = true;
} else {
    data.recovery.recent_arrivals[eventKey] = Date.now();
}
return msg;
