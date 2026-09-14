const data = msg._light_arrival;
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
