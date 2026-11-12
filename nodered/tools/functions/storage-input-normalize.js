const input = msg.payload ?? {};
const now = Number(msg.testNow ?? Date.now());
const metric = (v) => (typeof v === "number" || (typeof v === "string" && v.trim() !== "")) ? Number(v) : NaN;
const used = metric(input.used_percent);
const free = metric(input.free_gb);
const collected = Date.parse(input.collected_at);
const fresh = Number.isFinite(collected) && now - collected >= -60000 && now - collected <= msg.policy.metric_max_age_s * 1000;
const testMode = msg.test_mode === true;
const suffix = testMode ? "__test" : "";
const stateKey = "storage_health_state_v1" + suffix;
const historyKey = "storage_health_history_v1" + suffix;
const categoryHistoryKey = "storage_health_category_history_v1" + suffix;
const state = (testMode ? flow.get(stateKey) : flow.get(stateKey, "persistent")) ?? {
    severity: "normal", lastNotificationAt: 0, lastTrendNotificationAt: 0, lastErrorNotificationAt: 0
};
const labels = { docker: "Docker", repository: "repositorio", vscode: "VS Code Server", recorder: "Recorder", backupArchives: "backups operacionais do Home Assistant", manualSnapshots: "snapshots manuais do Home Assistant", npmCache: "cache npm", knownLogs: "logs" };
const categories = {};
for (const [key, raw] of Object.entries(input.categories ?? {})) {
    const value = Number(raw);
    if (Number.isFinite(value) && value >= 0 && Object.hasOwn(labels, key)) categories[key] = value;
}
msg.storage = {
    input, now, used, free, state, labels, categories, testMode, stateKey, historyKey, categoryHistoryKey,
    valid: !msg.storageReadError && fresh && Number.isFinite(used) && used >= 0 && used <= 100 && Number.isFinite(free) && free >= 0,
    collection_reason: msg.storageReadError ? "read_failed" : !fresh ? "stale_or_missing_timestamp" : "invalid_metrics",
    previous: state.severity ?? "normal",
    error_due: now - Number(state.lastErrorNotificationAt || 0) >= msg.policy.command_error_cooldown_h * 3600000
};
return msg;
