const testMode = msg._location_test === true;
const key = testMode
    ? "resident_approach_notification_recovery_v1__test"
    : "resident_approach_notification_recovery_v1";
let recovery = testMode ? flow.get(key) : flow.get(key, "persistent");
if (!recovery || recovery.version !== 1 || typeof recovery.residents !== "object") {
    recovery = { version: 1, residents: {} };
}
const state = recovery.residents[msg.resident_source] ?? {
    notified: false,
    away_cycle: false,
    last_notification_key: null,
    last_notification_at: 0
};
const notificationKey = [msg.resident_source, msg.resident_current, msg.event_at].join(":");

msg.notification_state_key = key;
msg.notification_recovery = recovery;
msg.notification_resident_state = state;
msg.notification_key = notificationKey;
msg.notification_previously_sent = state.notified === true;
msg.notification_duplicate =
    state.last_notification_key === notificationKey &&
    Number.isFinite(state.last_notification_at) &&
    Date.now() - state.last_notification_at < msg.policy.dedupe_ttl_ms;
return msg;
