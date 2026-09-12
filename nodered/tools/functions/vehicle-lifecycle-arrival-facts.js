const data = msg._vehicle;
const validZone = (value) => typeof value === "string" &&
    !["", "unknown", "unavailable"].includes(value);
const external = (state) => validZone(state) && !["home", "near_home"].includes(state);
const isNear = data.location.ready && (
    (data.location.gate_distance_m !== null &&
        data.location.gate_distance_m <= Number(data.policy.near_home_radius_m)) ||
    (data.location.distance_m !== null &&
        data.location.distance_m <= Number(data.policy.near_home_radius_m)) ||
    (data.location.distance_m === null && data.location.gate_distance_m === null &&
        data.location.state === "home")
);
const isHome = data.location.ready && (data.location.distance_m !== null
    ? data.location.distance_m <= Number(data.policy.home_radius_m)
    : data.location.state === "home");
const isAway = data.location.ready && (data.location.distance_m !== null
    ? data.location.distance_m > Number(data.policy.home_radius_m)
    : data.location.state === "not_home");
if (data.location.ready && external(data.location.state)) data.armed = true;
if (data.is_location_event && data.location.ready && data.trigger_state === "near_home" &&
    data.location.primary_home !== true && external(data.trigger_prev_state)) data.armed = true;
const approach = data.trigger_state === "near_home" &&
    data.trigger_prev_state !== "near_home" && data.trigger_prev_state !== "home";
const departure = data.trigger_prev_state === "home" && data.trigger_state !== "home";
if (departure) data.armed = false;
const graceMs = Number(data.policy.primary_home_grace_minutes) * 60000;
const staleCatchup = !approach && data.location.primary_home === true &&
    typeof data.location.primary_home_for_ms === "number" &&
    data.location.primary_home_for_ms > graceMs;
data.facts = {
    trigger_prev_valid: validZone(data.trigger_prev_state),
    approach_entry: approach,
    departure,
    stale_catchup: staleCatchup,
    near_home: isNear,
    home: isHome,
    away: isAway,
    arrival_eligible: data.is_location_event && data.location.ready &&
        validZone(data.trigger_prev_state) && !departure && !staleCatchup &&
        (approach || isNear) && data.armed === true,
    blocked_candidate: data.is_location_event && data.location.ready &&
        validZone(data.trigger_prev_state) && data.trigger_state !== data.trigger_prev_state &&
        ["home", "near_home"].includes(data.trigger_state)
};
if (!data.is_location_event && isHome) data.armed = false;
return msg;
