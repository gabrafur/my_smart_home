const data = msg._light_arrival;
msg.payload = {
    ...(msg.payload ?? {}),
    kind: "arrival_blocked",
    direction_reason: "external_cycle_not_confirmed",
    simulated: true,
    dispatched: false,
    blocked_at: Date.now()
};
data.outcome = "blocked";
return msg;
