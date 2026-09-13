const s = msg.storage;
const state = s.state;
msg.storage_selected_alert = msg.storage_alert ?? state.pendingAlert ?? null;
if (msg.storage_alert) state.pendingAlert = msg.storage_alert;
Object.assign(state, {
    severity: s.severity, updatedAt: s.now, usedPercent: s.used, freeGiB: s.free,
    growth24h: s.growth24h, growth7d: s.growth7d, growthCause: s.growth_cause,
    growthCauseBytes: s.growth_cause_bytes, historySamples: s.history_samples,
    historyCoverageHours: s.history_coverage_hours, historyOldestAt: s.history_oldest_at
});
msg.storage_remediation = null;
if (s.remediation_due) {
    state.lastAutoRemediationAt = s.now;
    msg.storage_remediation = {
        ...msg, storageAutoRemediation: true, test_mode: msg.test_mode === true,
        payload: { reason: s.accelerated ? "accelerated-growth" : "capacity-threshold", used: s.used,
            growth24h: s.growth24h, growth7d: s.growth7d, growthCause: s.growth_cause,
            growthCauseBytes: s.growth_cause_bytes }
    };
}
if (s.testMode) flow.set(s.stateKey, state); else flow.set(s.stateKey, state, "persistent");
return msg;
