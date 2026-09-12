const data = msg._observer_event;
const reminderMs = Number(data.policy.reminder_hours) * 3600000;
const retentionMs = Number(data.policy.error_retention_days) * 86400000;
const notificationDue = !Number.isFinite(data.previous.notified_at) ||
    data.now - data.previous.notified_at >= reminderMs;
data.state.errors[data.key] = {
    flow_id: data.flow_id, flow_label: data.flow_label, source_id: data.source_id,
    source_type: data.source_type, source_name: data.source_name,
    failure_class: data.classification,
    first_seen_at: data.previous.first_seen_at ?? data.now,
    last_seen_at: data.now,
    notified_at: notificationDue ? data.now : data.previous.notified_at
};
for (const [key, entry] of Object.entries(data.state.errors)) {
    if (data.now - Number(entry.last_seen_at ?? data.now) > retentionMs) delete data.state.errors[key];
}
data.notification_due = notificationDue;
if (data.store) flow.set(data.state_key, data.state, data.store);
else flow.set(data.state_key, data.state);
return msg;
