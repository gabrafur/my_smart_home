const state = msg.tuya_device_state;
const action = msg.tuya_device_action;
const wait = msg.policy.reminder_interval_h * 3600000;
if (action === "baseline") state.phase = "online";
else if (action === "checking") state.phase = "checking";
else if (action === "recovering") state.phase = "recovering";
else if (action === "keep_offline") state.phase = "offline";
else if (action === "open") {
    const key = msg._tuya_test === true ? "tuya_device_observations_v1__test" : "tuya_device_observations_v1";
    const observations = msg._tuya_test === true ? flow.get(key) : flow.get(key, "memoryOnly");
    state.phase = "offline";
    state.incident_open = true;
    state.outage_started_at = new Date(Number(observations?.[msg.tuya_device.key]?.changed_at || msg.tuya_now)).toISOString();
    state.last_outage_at = state.outage_started_at;
    state.last_notification_at = msg.tuya_now_iso;
    state.next_reminder_at = new Date(msg.tuya_now + wait).toISOString();
} else if (action === "reminder") {
    state.phase = "offline";
    state.last_notification_at = msg.tuya_now_iso;
    state.next_reminder_at = new Date(msg.tuya_now + wait).toISOString();
} else if (action === "recover") {
    const start = Date.parse(state.outage_started_at || state.last_outage_at || msg.tuya_now_iso);
    state.phase = "online";
    state.incident_open = false;
    state.last_recovery_at = msg.tuya_now_iso;
    state.last_outage_duration_s = Number.isFinite(start) ? Math.max(0, Math.round((msg.tuya_now - start) / 1000)) : null;
    state.next_reminder_at = null;
}
Object.assign(state, { name: msg.tuya_device.name, platforms: msg.tuya_device.platforms,
raw_state: msg.tuya_device.raw_state, stable_for_s: Math.floor(msg.tuya_stable_for_ms / 1000), last_checked_at: msg.tuya_now_iso });
msg.tuya_incidents[msg.tuya_device.key] = state;
if (msg._tuya_test === true) flow.set(msg.tuya_incidents_key, msg.tuya_incidents);
else flow.set(msg.tuya_incidents_key, msg.tuya_incidents, "persistent");
return msg;
