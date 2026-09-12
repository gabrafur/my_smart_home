const testMode = msg._internet_test === true;
const stateKey = testMode ? "internet_monitor_state_v1__test" : "internet_monitor_state_v1";
const historyKey = testMode ? "internet_monitor_history_v1__test" : "internet_monitor_history_v1";
let state = testMode ? flow.get(stateKey) : flow.get(stateKey, "persistent");
if (!state || state.version !== 1) {
    state = {
        version: 1, phase: "checking", incident_open: false,
        consecutive_failures: 0, consecutive_successes: 0,
        failure_started_at: null, outage_started_at: null,
        last_outage_at: null, last_recovery_at: null,
        last_outage_duration_s: null, last_valid_ping: null
    };
}
const history = testMode ? flow.get(historyKey) : flow.get(historyKey, "persistent");
if (history && typeof history === "object") {
    state.last_outage_at ??= history.last_outage_at ?? null;
    state.last_recovery_at ??= history.last_recovery_at ?? null;
    state.last_outage_duration_s ??= history.last_outage_duration_s ?? null;
}
msg.internet_state_key = stateKey;
msg.internet_history_key = historyKey;
msg.internet_state = state;
msg.internet_incident_open = state.incident_open === true;
msg.internet_now = Number(msg.monitor_now ?? Date.now());
msg.internet_now_iso = new Date(msg.internet_now).toISOString();
return msg;
