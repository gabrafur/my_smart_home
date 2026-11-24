const testMode = msg._zigbee_test === true;
const state = msg.zigbee_state;
const persistedHistory = {
    last_outage_at: state.last_outage_at,
    last_recovery_at: state.last_recovery_at,
    last_outage_duration_s: state.last_outage_duration_s
};
if (testMode) {
    flow.set(msg.zigbee_state_key, state);
    flow.set(msg.zigbee_history_key, persistedHistory);
} else {
    flow.set(msg.zigbee_state_key, state, "persistent");
    flow.set(msg.zigbee_history_key, persistedHistory, "persistent");
}
const outages = testMode ? flow.get("zigbee_component_outages_v1__test") : flow.get("zigbee_component_outages_v1", "persistent");
const unstable = Object.entries(outages || {}).map(([name, rows]) => [name, rows.filter((row) => Date.now() - Date.parse(row.start) < 86400000)])
    .filter(([, rows]) => rows.length)
    .map(([name, rows]) => `${name}:${rows.length}:${rows.filter((row) => row.rebooted === false).length}`);
msg.zigbee_publications = [
    { topic: "nodered/infrastructure/zigbee/connection", payload: state.phase === "online" ? "ON" : "OFF" },
    { topic: "nodered/infrastructure/zigbee/attributes", payload: JSON.stringify({
        state: state.phase, raw_state: state.raw_state, stable_for_s: state.stable_for_s,
        checked_at: state.last_checked_at,
        last_outage: state.last_outage_at || "Nenhuma queda confirmada",
        last_recovery: state.last_recovery_at || "Nenhuma recuperação registrada",
        last_outage_duration_s: state.last_outage_duration_s,
        failure_confirmation_s: msg.policy.failure_confirmation_s,
        recovery_confirmation_s: msg.policy.recovery_confirmation_s,
        reminder_interval_h: msg.policy.reminder_interval_h,
        unstable_components: unstable.join(" ").slice(0, 64) || "nenhum",
        next_reminder: state.incident_open ? state.next_reminder_at : null
    }) },
    { topic: "nodered/infrastructure/zigbee/state", payload: state.phase }
];
return msg;
