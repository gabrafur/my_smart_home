const testMode = msg._location_test === true || msg.payload?.test_mode === true;
const source = String(msg.payload?.source ?? "");
const previousState = String(msg.payload?.trigger_prev_state ?? "");
const currentState = String(msg.payload?.trigger_state ?? "");
const resident = msg.payload?.context?.[source] ?? {};
const eventCandidate = Number(msg.context_incoming_at ?? resident.updated_at);
const eventAt = Number.isFinite(eventCandidate) && eventCandidate > 0
    ? eventCandidate : Number(msg.context_now ?? Date.now());
const pendingKey = testMode ? "resident_home_refresh_v1__test" : "resident_home_refresh_v1";
const lastKey = testMode ? "resident_home_refresh_last_v1__test" : "resident_home_refresh_last_v1";
const previous = testMode ? flow.get(lastKey) : flow.get(lastKey, "persistent");
const signature = [source, previousState, currentState, eventAt].join(":");
const vehicle = flow.get(testMode ? "vehicle_primary_context_v1__test" : "vehicle_primary_context_v1") ?? {};
msg._location_test = testMode;
msg.home_refresh = {
    pending_key: pendingKey,
    last_key: lastKey,
    source,
    previous_state: previousState,
    current_state: currentState,
    event_at: eventAt,
    signature,
    domain_valid: msg.context_domain === "people",
    snapshot_accepted: msg.context_snapshot_accepted === true,
    source_valid: ["resident_primary", "resident_secondary"].includes(source),
    transition_valid: currentState === "home" && previousState.length > 0 && previousState !== "home",
    resident_current: resident.ready === true && resident.stale !== true && resident.current_home === true,
    duplicate: previous?.signature === signature,
    engine_on_at_arrival: vehicle.engine_state_valid === true && vehicle.engine_on === true
};
return msg;
