const testMode = msg._zigbee_test === true;
const key = testMode ? "zigbee_component_incidents_v1__test" : "zigbee_component_incidents_v1";
const incidents = testMode ? (flow.get(key) || {}) : (flow.get(key, "persistent") || {});
const current = incidents[msg.zigbee_component] || { offline: false };
const last = Date.parse(current.last_notification_at || current.outage_started_at || "");
const next = Date.parse(current.next_reminder_at || "");
msg.zigbee_component_state_key = key;
msg.zigbee_component_incidents = incidents;
msg.zigbee_component_current = current;
msg.zigbee_component_next_reminder_ms = Number.isFinite(next) ? next :
    (Number.isFinite(last) ? last + msg.policy.reminder_interval_h * 3600000 : msg.zigbee_now + msg.policy.reminder_interval_h * 3600000);
return msg;
