const data = msg._refresh;
Object.assign(data.state, {
    state: data.state.awaiting_evidence === true ? "awaiting_evidence" : "cooldown",
    reason: "resident_departure_already_covered",
    enabled: true,
    updated_at: data.now
});
data.output = null;
return msg;
