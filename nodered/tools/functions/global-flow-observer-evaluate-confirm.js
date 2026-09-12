const data = msg._observer_evaluation;
const getState = () => data.store ? flow.get(data.state_key, data.store) : flow.get(data.state_key);
const state = getState();
if (state?.version !== 2) return null;
state.status_incidents ??= {};
const previous = state.status_incidents[data.key] ?? {};
const now = Number(msg.observer_now ?? Date.now());
const reminderMs = Number(data.policy.reminder_hours) * 3600000;
const notificationDue = !Number.isFinite(previous.notified_at) ||
    now - previous.notified_at >= reminderMs;
state.status_incidents[data.key] = {
    kind: data.kind,
    first_seen_at: previous.first_seen_at ?? data.first_seen_at,
    last_seen_at: now,
    notified_at: notificationDue ? now : previous.notified_at
};
if (data.store) flow.set(data.state_key, state, data.store);
else flow.set(data.state_key, state);
data.notification_due = notificationDue;
return msg;
