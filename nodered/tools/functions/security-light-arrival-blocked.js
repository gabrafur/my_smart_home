const data = msg._light_arrival;
const resident = data.people?.[data.source];
msg._security_light_decision_state = resident?.current_home === true || resident?.state === "home"
    ? "blocked_home"
    : resident?.ready !== true || resident?.stale === true
        ? "blocked_location_stale"
        : "blocked_direction";
msg.payload = {
    ...(msg.payload ?? {}),
    kind: "arrival_blocked",
    direction_reason: data.direction_valid !== true
        ? "external_cycle_not_confirmed"
        : "resident_fresh_away_to_near_home_required",
    simulated: true,
    dispatched: false,
    blocked_at: Date.now()
};
data.outcome = "blocked";
return msg;
