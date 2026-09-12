const s = msg.storage;
const event = { ...msg, payload: {
    event: "health_check", severity: s.severity, previous: s.previous, used: s.used, freeGiB: s.free,
    growth24h: s.growth24h, growth7d: s.growth7d, growthCause: s.growth_cause,
    growthCauseBytes: s.growth_cause_bytes, remediationRequested: msg.storage_remediation !== null,
    at: new Date(s.now).toISOString()
} };
return [
    msg.test_mode === true ? [] : msg.storage_mqtt,
    msg.test_mode === true ? null : msg.storage_selected_alert,
    event,
    msg.storage_remediation
];
