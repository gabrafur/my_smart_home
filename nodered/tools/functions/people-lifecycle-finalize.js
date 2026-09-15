const data = msg._people;
if (!data) return [null, null, null, null];
const key = (name) => data.test_mode ? name + "__test" : name;
const set = (name, value, store) => data.test_mode || !store
    ? flow.set(key(name), value) : flow.set(key(name), value, store);
data.recovery.arrival_armed = { ...data.armed };
data.recovery.external_since = { ...data.external_since };
data.recovery.local_excursions = { ...data.local_excursions };
data.recovery.updated_at = Date.now();
set("people_arrival_armed", data.armed);
set("security_people_recovery_v1", data.recovery, "persistent");
const primary = data.people.resident_primary;
const secondary = data.people.resident_secondary;
const distances = Object.values(data.people).map((item) => item.distance_m)
    .filter((value) => value !== null);
const contextValue = {
    resident_primary: primary,
    resident_secondary: secondary,
    home_radius_m: Number(data.policy.home_radius_m),
    near_home_radius_m: Number(data.policy.near_home_radius_m),
    best_location_away: primary.best_location_away === true || secondary.best_location_away === true,
    any_tracker_away: primary.any_tracker_away === true || secondary.any_tracker_away === true,
    anyone_away: primary.ready && secondary.ready
        ? Object.values(data.people).some((item) => item.ready === true &&
            (item.distance_m !== null
                ? item.distance_m > Number(data.policy.home_radius_m)
                : item.state === "not_home"))
        : null,
    nearest_distance_m: distances.length ? Math.min(...distances) : null,
    state_valid: primary.state_valid && secondary.state_valid,
    ready: primary.ready && secondary.ready,
    stale: primary.stale || secondary.stale,
    updated_at: Math.max(...[primary.updated_at, secondary.updated_at].filter(Number.isFinite), 0),
    arrival_armed: { ...data.armed },
    local_excursions: { ...data.local_excursions }
};
set("people_context_v1", contextValue);
const previousReady = flow.get(key("security_people_ready_logged"));
if (previousReady !== contextValue.ready) {
    node.log?.("localizacao_pessoas: contexto " +
        (contextValue.ready ? "ready" : "pending/stale"));
    flow.set(key("security_people_ready_logged"), contextValue.ready);
}
msg.payload = {
    contract: "security.people-context.v1",
    kind: "people_context",
    context: contextValue,
    trigger_entity: data.trigger_entity,
    trigger_state: data.trigger_state,
    trigger_prev_state: data.trigger_prev_state,
    confirmed_home_transition: data.is_location_event && data.facts.source_ready &&
        data.facts.trigger_prev_valid && data.trigger_state === "home" &&
        data.trigger_prev_state !== "home",
    refresh_cycle_id: data.refresh_cycle_id,
    updated_at: contextValue.updated_at,
    valid: contextValue.state_valid,
    ready: contextValue.ready,
    stale: contextValue.stale,
    source: data.source ?? "people",
    reason: contextValue.ready ? "current_entities" : "entity_stale_or_unavailable"
};
if (data.test_mode) {
    msg.payload.test_mode = true;
    msg.payload.test_case = msg._location_test_case ?? null;
    if (data.arrival?.payload) {
        data.arrival.payload.test_mode = true;
        data.arrival.payload.test_case = msg._location_test_case ?? null;
    }
}
delete msg._people;
return [msg, data.arrival ?? null, data.lighting_only ?? null, data.blocked ?? null];
