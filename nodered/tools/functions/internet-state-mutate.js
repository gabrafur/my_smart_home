const state = msg.internet_state;
const action = msg.internet_state_action;
if (action === "healthy_baseline") {
    state.last_valid_ping = msg.internet_now_iso;
    state.consecutive_failures = 0;
    state.failure_started_at = null;
    state.consecutive_successes = 1;
    state.phase = "online";
} else if (action === "success_incident") {
    state.last_valid_ping = msg.internet_now_iso;
    state.consecutive_failures = 0;
    state.failure_started_at = null;
    state.consecutive_successes = Number(state.consecutive_successes || 0) + 1;
    state.phase = "recovering";
} else if (action === "failure_candidate") {
    state.consecutive_successes = 0;
    state.consecutive_failures = Number(state.consecutive_failures || 0) + 1;
    state.failure_started_at ??= msg.internet_now_iso;
    state.phase = "checking";
} else if (action === "failure_open") {
    state.consecutive_successes = 0;
    state.consecutive_failures = Number(state.consecutive_failures || 0) + 1;
    state.failure_started_at ??= msg.internet_now_iso;
    state.phase = "offline";
} else if (action === "open_failure") {
    state.phase = "offline";
    state.incident_open = true;
    state.outage_started_at = state.failure_started_at;
    state.last_outage_at = state.failure_started_at;
} else if (action === "recover_online") {
    const start = Date.parse(state.outage_started_at || state.last_outage_at || msg.internet_now_iso);
    state.phase = "online";
    state.incident_open = false;
    state.consecutive_successes = 0;
    state.last_recovery_at = msg.internet_now_iso;
    state.last_outage_duration_s = Number.isFinite(start)
        ? Math.max(0, Math.round((msg.internet_now - start) / 1000))
        : null;
}
msg.internet_incident_open = state.incident_open === true;
return msg;
