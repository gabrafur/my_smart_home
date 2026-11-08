msg.policy = flow.get("storage_health_policy_v2", "persistent");
msg.policy_available = msg.policy?.version === 2;

// Migrate the previous reminder interval without resetting incident history.
if (msg.policy_available && msg.policy.notification_cooldown_h < 24) {
    msg.policy = { ...msg.policy, notification_cooldown_h: 24 };
    flow.set("storage_health_policy_v2", msg.policy, "persistent");
    const legacy = flow.get("storage_health_config_v1", "persistent");
    if (legacy) flow.set("storage_health_config_v1", { ...legacy, notificationCooldownMs: 86400000 }, "persistent");
}
return msg;
