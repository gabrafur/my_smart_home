const state = msg.internet_state;
state.last_checked_at = msg.internet_checked_at;
state.targets_ok = msg.internet_targets_ok;
state.targets_total = msg.internet_targets_total;
state.required_responses = msg.policy.required_responses;
const history = {
    last_outage_at: state.last_outage_at,
    last_recovery_at: state.last_recovery_at,
    last_outage_duration_s: state.last_outage_duration_s
};
if (msg._internet_test === true) {
    flow.set(msg.internet_state_key, state);
    flow.set(msg.internet_history_key, history);
} else {
    flow.set(msg.internet_state_key, state, "persistent");
    flow.set(msg.internet_history_key, history, "persistent");
}
const attributes = {
    state: state.phase,
    checked_at: state.last_checked_at,
    targets_ok: state.targets_ok,
    targets_total: state.targets_total,
    required_responses: state.required_responses,
    consecutive_failures: state.consecutive_failures,
    consecutive_successes: state.consecutive_successes,
    last_valid_ping: state.last_valid_ping,
    last_outage: state.last_outage_at || "Nenhuma queda confirmada",
    last_recovery: state.last_recovery_at || "Nenhuma recuperação registrada",
    last_outage_duration_s: state.last_outage_duration_s,
    targets: msg.internet_results
};
msg.internet_publications = [
    { topic: "nodered/infrastructure/internet/connection", payload: state.phase === "online" ? "ON" : "OFF" },
    { topic: "nodered/infrastructure/internet/attributes", payload: JSON.stringify(attributes) },
    { topic: "nodered/infrastructure/internet/state", payload: state.phase }
];
return msg;
