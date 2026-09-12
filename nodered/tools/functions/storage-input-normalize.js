const input = msg.payload ?? {};
const now = Number(msg.testNow ?? Date.now());
const used = Number(input.used_percent);
const free = Number(input.free_gb);
const state = flow.get("storage_health_state_v1", "persistent") ?? {
    severity: "normal", lastNotificationAt: 0, lastTrendNotificationAt: 0, lastErrorNotificationAt: 0
};
const labels = { docker: "Docker", repository: "repositorio", vscode: "VS Code Server", recorder: "Recorder", backups: "backups do Home Assistant", npmCache: "cache npm", knownLogs: "logs" };
const categories = {};
for (const [key, raw] of Object.entries(input.categories ?? {})) {
    const value = Number(raw);
    if (Number.isFinite(value) && value >= 0 && Object.hasOwn(labels, key)) categories[key] = value;
}
msg.storage = {
    input, now, used, free, state, labels, categories,
    valid: Number.isFinite(used) && used >= 0 && used <= 100 && Number.isFinite(free) && free >= 0,
    previous: state.severity ?? "normal",
    error_due: now - Number(state.lastErrorNotificationAt || 0) >= msg.policy.command_error_cooldown_h * 3600000
};
return msg;
