const state = msg.zigbee_state;
const action = msg.zigbee_state_action;
const interval = msg.policy.reminder_interval_h * 3600000;
if (action === "baseline_online") {
    state.phase = "online";
} else if (action === "mark_recovering") {
    state.phase = "recovering";
} else if (action === "recover_online") {
    const started = Date.parse(state.outage_started_at || state.last_outage_at || msg.zigbee_now_iso);
    state.phase = "online";
    state.incident_open = false;
    state.last_recovery_at = msg.zigbee_now_iso;
    state.last_outage_duration_s = Number.isFinite(started) ? Math.max(0, Math.round((msg.zigbee_now - started) / 1000)) : null;
    state.next_reminder_at = null;
} else if (action === "mark_checking") {
    state.phase = "checking";
} else if (action === "open_failure") {
    const observation = msg._zigbee_test === true ? flow.get("zigbee_bridge_observation__test") : flow.get("zigbee_bridge_observation", "memoryOnly");
    state.phase = "offline";
    state.incident_open = true;
    state.outage_started_at = new Date(Number(observation?.changed_at || msg.zigbee_now)).toISOString();
    state.last_outage_at = state.outage_started_at;
    state.last_notification_at = msg.zigbee_now_iso;
    state.next_reminder_at = new Date(msg.zigbee_now + interval).toISOString();
} else if (action === "keep_offline") {
    state.phase = "offline";
} else if (action === "network_reminder") {
    state.phase = "offline";
    state.last_notification_at = msg.zigbee_now_iso;
    state.next_reminder_at = new Date(msg.zigbee_now + interval).toISOString();
}
state.raw_state = msg.zigbee_raw_state;
state.last_checked_at = msg.zigbee_now_iso;
state.stable_for_s = Math.floor(msg.zigbee_stable_for_ms / 1000);
return msg;
