const data = msg._refresh;
Object.assign(data.state, {
    state: "waiting",
    reason: "waiting_for_resident_location",
    enabled: false,
    next_retry_at: null,
    cooldown_until: null,
    updated_at: data.now
});
data.output = null;
return msg;
