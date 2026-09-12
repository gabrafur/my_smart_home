const c = msg.policy_candidate;
const policy = { version: 2, ...c };
flow.set("storage_health_policy_v2", policy, "persistent");
flow.set("storage_health_config_v1", {
    version: 1, thresholds: { warning: c.warning_pct, high: c.high_pct, critical: c.critical_pct },
    hysteresisPercentagePoints: c.hysteresis_pp, notificationCooldownMs: c.notification_cooldown_h * 3600000,
    commandErrorCooldownMs: c.command_error_cooldown_h * 3600000, trendAlert24hPercentagePoints: c.trend_24h_pp,
    trendAlert7dPercentagePoints: c.trend_7d_pp, autoRemediationCooldownMs: c.auto_remediation_cooldown_h * 3600000,
    sampleIntervalMs: c.sample_interval_min * 60000, historyRetentionMs: c.history_retention_days * 86400000
}, "persistent");
node.status({ fill: "green", shape: "dot", text: "política visual válida" });
return msg;
