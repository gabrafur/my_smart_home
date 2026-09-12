const DEFAULTS = {
    physical_fresh_seconds: 120,
    recovery_request_throttle_seconds: 30,
    off_grace_seconds: 90,
    backstop_minutes: 15,
    post_off_cooldown_minutes: 5,
    lifecycle_retention_hours: 24,
    deadline_slack_minutes: 1,
    unavailable_dedupe_seconds: 10,
    cooldown_max_minutes: 30
};
const LIMITS = {
    physical_fresh_seconds: [30, 600],
    recovery_request_throttle_seconds: [5, 300],
    off_grace_seconds: [10, 300],
    backstop_minutes: [2, 60],
    post_off_cooldown_minutes: [1, 30],
    lifecycle_retention_hours: [1, 168],
    deadline_slack_minutes: [0, 10],
    unavailable_dedupe_seconds: [1, 120],
    cooldown_max_minutes: [5, 120]
};
const topic = String(msg.topic ?? "");
const value = Number(msg.payload);
const bounds = LIMITS[topic];
if (!bounds || !Number.isFinite(value) || value < bounds[0] || value > bounds[1]) {
    msg.security_light_policy_rejection = {
        parameter: topic || null,
        rejected_value: msg.payload,
        limits: bounds ?? null,
        preserved: true
    };
    return [null, msg];
}
const previous = global.get("security_light_policy_v1", "persistent");
msg.security_light_policy_candidate = {
    ...DEFAULTS,
    ...(previous?.version === 1 && previous?.complete === true ? previous : {}),
    [topic]: value,
    version: 1,
    owner: "node_red",
    complete: true,
    updated_at: Date.now()
};
return [msg, null];
