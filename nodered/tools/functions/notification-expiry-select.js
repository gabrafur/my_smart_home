// Owner policy (23/11/2026): a Home Assistant persistent notification whose flow
// has no resolution signal is removed 24 h after it was created. Notifications
// with a real resolution (dismiss on recovery) are never touched here.
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const EXACT = new Set([
    "portao_garagem_rele_preso",
    "vehicle_primary_remote_command_failed",
    "vehicle_primary_refresh_blocked",
    "codex_alert_cache_low",
    "codex_alert_credits_low",
    "codex_alert_daily",
    "codex_alert_test"
]);
const PREFIXES = [
    "nodered_observabilidade_global_node_error_",
    "nodered_observabilidade_global_monitor_internal_error_"
];
const eligible = (id) => EXACT.has(id) || PREFIXES.some((prefix) => id.startsWith(prefix));

const testMode = msg.test_mode === true;
const list = Array.isArray(msg.ha_notifications) ? msg.ha_notifications : null;
if (list === null) {
    node.status({ fill: "red", shape: "ring", text: "lista do HA indisponível" });
    return null;
}
const now = Number.isFinite(msg.expiry_now) ? msg.expiry_now : Date.now();
const expired = [];
for (const entry of list) {
    const id = entry?.notification_id;
    if (typeof id !== "string" || !eligible(id)) continue;
    const createdAt = Date.parse(entry.created_at);
    if (!Number.isFinite(createdAt) || now - createdAt < MAX_AGE_MS) continue;
    expired.push({
        topic: id,
        payload: "",
        test_mode: testMode,
        _notification_expiry: { notification_id: id, created_at: entry.created_at, test_mode: testMode },
        notification: {
            source: "expiracao_notificacoes",
            operation: "dismiss",
            delivery: "queued",
            notification_id: id,
            test_mode: testMode
        }
    });
}
const clock = new Date(now).toISOString().slice(11, 16);
node.status({
    fill: expired.length ? "yellow" : "green",
    shape: "dot",
    text: `${testMode ? "TESTE: " : ""}${expired.length} vencida(s) de ${list.length} · ${clock} UTC`
});
return [expired];
