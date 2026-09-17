const now = Date.now();
msg.home_confirmation_state = "home";
msg.home_confirmation_entity = {
    state: "home",
    last_changed: new Date(now - msg.home_confirmation_required_ms).toISOString(),
    attributes: {
        location_fresh: true,
        location_observed_at: new Date(now).toISOString()
    }
};
return msg;
