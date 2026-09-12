const testMode = msg._zigbee_test === true;
const key = testMode ? "zigbee_component_incidents_v1__test" : "zigbee_component_incidents_v1";
const incidents = testMode ? (flow.get(key) || {}) : (flow.get(key, "persistent") || {});
const now = Number(msg.monitor_now ?? Date.now());
const outputs = [];
for (const [component, current] of Object.entries(incidents)) {
    const copy = { ...msg, zigbee_component: component, zigbee_component_current: current,
        zigbee_component_incidents: incidents, zigbee_component_state_key: key,
        zigbee_now: now, zigbee_now_iso: new Date(now).toISOString() };
    const last = Date.parse(current.last_notification_at || current.outage_started_at || "");
    const next = Date.parse(current.next_reminder_at || "");
    copy.zigbee_component_next_reminder_ms = Number.isFinite(next) ? next :
        (Number.isFinite(last) ? last + msg.policy.reminder_interval_h * 3600000 : now + msg.policy.reminder_interval_h * 3600000);
    outputs.push(copy);
}
return outputs.length ? [outputs] : null;
