const data = msg._people;
if (!data) return null;
const validZone = (value) => typeof value === "string" &&
    !["", "unknown", "unavailable"].includes(value);
const external = (state) => validZone(state) && !["home", "near_home"].includes(state);
const near = (item) => item?.ready === true && (
    (item.gate_distance_m !== null && item.gate_distance_m <= Number(data.policy.near_home_radius_m)) ||
    (item.distance_m !== null && item.distance_m <= Number(data.policy.near_home_radius_m)) ||
    (item.distance_m === null && item.gate_distance_m === null && item.state === "home")
);
for (const [role, item] of Object.entries(data.people)) {
    if (item?.ready === true && external(item.state)) data.armed[role] = true;
}
const source = data.people[data.source];
const approach = data.trigger_state === "near_home" &&
    data.trigger_prev_state === "not_home" && source?.current_home !== true;
if (data.is_location_event && source?.ready === true &&
    data.trigger_state === "near_home" && source.current_home !== true &&
    external(data.trigger_prev_state)) data.armed[data.source] = true;
const departure = data.trigger_prev_state === "home" && data.trigger_state !== "home";
const graceMs = Number(data.policy.primary_home_grace_minutes) * 60000;
data.facts = {
    source_ready: source?.ready === true,
    trigger_prev_valid: validZone(data.trigger_prev_state),
    trigger_prev_unavailable: ["unknown", "unavailable"].includes(data.trigger_prev_state),
    approach_entry: approach,
    departure,
    stale_catchup: !approach && source?.primary_home === true &&
        typeof source.primary_home_for_ms === "number" && source.primary_home_for_ms > graceMs,
    near_home: near(source),
    external_cycle_confirmed: data.armed[data.source] === true,
    directional_candidate: source?.ready === true &&
        data.trigger_state !== data.trigger_prev_state &&
        ["home", "near_home"].includes(data.trigger_state)
};
if (departure) data.armed[data.source] = false;
if (!data.is_location_event) {
    for (const [role, item] of Object.entries(data.people)) {
        if (item?.ready === true && (item.distance_m !== null
            ? item.distance_m <= Number(data.policy.home_radius_m)
            : item.state === "home")) data.armed[role] = false;
    }
}
return msg;
