const testMode = msg._zigbee_test === true;
const stateKey = testMode ? "zigbee_network_monitor_state_v1__test" : "zigbee_network_monitor_state_v1";
const historyKey = testMode ? "zigbee_network_monitor_history_v1__test" : "zigbee_network_monitor_history_v1";
const observationKey = testMode ? "zigbee_bridge_observation__test" : "zigbee_bridge_observation";
const get = (key, store) => testMode ? flow.get(key) : flow.get(key, store);
let state = get(stateKey, "persistent");
if (!state || typeof state !== "object") state = {
    version: 1, phase: "checking", incident_open: false,
    outage_started_at: null, last_outage_at: null, last_recovery_at: null,
    last_outage_duration_s: null, last_notification_at: null, next_reminder_at: null
};
const history = get(historyKey, "persistent") || {};
state.last_outage_at ??= history.last_outage_at ?? null;
state.last_recovery_at ??= history.last_recovery_at ?? null;
state.last_outage_duration_s ??= history.last_outage_duration_s ?? null;
const now = Number(msg.monitor_now ?? msg.zigbee_now ?? Date.now());
const bootKey = "zigbee_boot_at" + (testMode ? "__test" : "");
let boot = get(bootKey, "memoryOnly");
if (!Number.isFinite(boot)) {
    boot = now;
    if (testMode) flow.set(bootKey, boot); else flow.set(bootKey, boot, "memoryOnly");
}
msg.zigbee_boot_age_ms = Math.max(0, now - boot);
let observation = get(observationKey, "memoryOnly");
if (!observation) {
    observation = { state: "unknown", changed_at: now };
    if (testMode) flow.set(observationKey, observation);
    else flow.set(observationKey, observation, "memoryOnly");
}
const changedAt = Number(observation.changed_at ?? now);
msg.zigbee_state_key = stateKey;
msg.zigbee_history_key = historyKey;
msg.zigbee_state = state;
msg.zigbee_raw_state = observation.state;
msg.zigbee_now = now;
msg.zigbee_now_iso = new Date(now).toISOString();
msg.zigbee_stable_for_ms = Math.max(0, now - changedAt);
const lastNotice = Date.parse(state.last_notification_at || state.outage_started_at || "");
const next = Date.parse(state.next_reminder_at || "");
msg.zigbee_next_reminder_ms = Number.isFinite(next) ? next :
    (Number.isFinite(lastNotice) ? lastNotice + msg.policy.reminder_interval_h * 3600000 : now + msg.policy.reminder_interval_h * 3600000);
return msg;
