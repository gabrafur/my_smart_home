const incidents = msg.zigbee_component_incidents;
const current = msg.zigbee_component_current;
const interval = msg.policy.reminder_interval_h * 3600000;
let updated = current;
if (msg.zigbee_component_action === "open") updated = {
    offline: true, outage_started_at: msg.zigbee_now_iso, last_seen_at: msg.zigbee_now_iso,
    last_notification_at: msg.zigbee_now_iso,
    next_reminder_at: new Date(msg.zigbee_now + interval).toISOString()
};
else if (msg.zigbee_component_action === "touch") updated = {
    ...current, offline: true, last_seen_at: msg.zigbee_now_iso,
    next_reminder_at: current.next_reminder_at || new Date(msg.zigbee_component_next_reminder_ms).toISOString()
};
else if (msg.zigbee_component_action === "baseline") updated = {
    ...current, offline: false, last_seen_at: msg.zigbee_now_iso, next_reminder_at: null
};
else if (msg.zigbee_component_action === "recover") updated = {
    ...current, offline: false, recovered_at: msg.zigbee_now_iso,
    last_seen_at: msg.zigbee_now_iso, next_reminder_at: null
};
else if (msg.zigbee_component_action === "reminder") updated = {
    ...current, offline: true, last_notification_at: msg.zigbee_now_iso,
    next_reminder_at: new Date(msg.zigbee_now + interval).toISOString()
};
incidents[msg.zigbee_component] = updated;
if (msg._zigbee_test === true) flow.set(msg.zigbee_component_state_key, incidents);
else flow.set(msg.zigbee_component_state_key, incidents, "persistent");
msg.zigbee_component_current = updated;
return msg;
