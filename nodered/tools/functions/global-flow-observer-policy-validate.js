const DEFAULTS = {
    connection_recovery_grace_seconds: 90,
    status_confirm_seconds: 60,
    reminder_hours: 6,
    error_retention_days: 7,
    ha_corroboration_sources: 2
};
const LIMITS = {
    connection_recovery_grace_seconds: [10, 600],
    status_confirm_seconds: [10, 600],
    reminder_hours: [1, 48],
    error_retention_days: [1, 30],
    ha_corroboration_sources: [2, 10]
};
const topic = String(msg.topic ?? "");
const value = Number(msg.payload);
const bounds = LIMITS[topic];
if (!bounds || !Number.isFinite(value) || value < bounds[0] || value > bounds[1] ||
    !Number.isInteger(value)) {
    msg.observer_policy_rejection = { parameter: topic || null,
        rejected_value: msg.payload, limits: bounds ?? null, preserved: true };
    return [null, msg];
}
const previous = flow.get("global_observer_policy_v1", "persistent");
msg.observer_policy_candidate = {
    ...DEFAULTS,
    ...(previous?.version === 1 && previous?.complete === true ? previous : {}),
    [topic]: value,
    version: 1,
    owner: "node_red",
    complete: true,
    updated_at: Date.now()
};
return [msg, null];
