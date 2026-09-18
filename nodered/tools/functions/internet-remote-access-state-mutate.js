const testMode = msg._internet_test === true;
const key = testMode ? "internet_remote_access_state_v1__test" : "internet_remote_access_state_v1";
const store = testMode ? undefined : "persistent";
const previous = msg.remote_access?.state ?? {
    version: 1, phase: "unknown", incident_open: false,
    consecutive_failures: 0, last_request_at: 0
};
const state = { ...previous, version: 1, last_checked_at: msg.remote_access?.now ?? Date.now() };
const action = String(msg.remote_access_state_action ?? "none");
msg.remote_access_event = "none";
if (action === "failure") {
    state.phase = state.incident_open ? "unavailable" : "checking";
    state.consecutive_failures = Number(state.consecutive_failures ?? 0) + 1;
    state.reason = msg.remote_access.reason;
} else if (action === "open") {
    state.phase = "unavailable";
    state.incident_open = true;
    state.incident_started_at = state.incident_started_at ?? state.last_checked_at;
    state.reason = msg.remote_access.reason;
    msg.remote_access_event = "down";
} else if (action === "healthy") {
    const recovered = state.incident_open === true;
    state.phase = "ready";
    state.incident_open = false;
    state.consecutive_failures = 0;
    state.reason = "ready";
    state.last_ready_at = state.last_checked_at;
    if (recovered) {
        state.last_recovery_at = state.last_checked_at;
        msg.remote_access_event = "recovery";
    }
} else if (action === "suppress") {
    if (!state.incident_open) {
        state.phase = "suppressed";
        state.consecutive_failures = 0;
    }
} else if (action === "request") {
    state.last_request_at = msg.remote_access.now;
}
if (store) flow.set(key, state, store);
else flow.set(key, state);
msg.remote_access_state = state;
msg.remote_access.state = state;
return msg;
