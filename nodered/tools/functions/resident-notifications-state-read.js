const testMode = msg._location_test === true;
const key = testMode
    ? "resident_notification_delivery_v2__test"
    : "resident_notification_delivery_v2";
let state = testMode ? flow.get(key) : flow.get(key, "persistent");
if (!state || state.version !== 2 || typeof state.residents !== "object") {
    state = { version: 2, residents: {} };
}
const resident = state.residents[msg.resident_source] ?? {
    delivered_key: null,
    delivered_at: 0,
    pending_key: null,
    pending_at: 0
};
const now = Date.now();

msg.notification_state_key = key;
msg.notification_delivery_state = state;
msg.notification_resident_state = resident;
msg.notification_duplicate = (
    resident.delivered_key === msg.notification_key &&
    Number.isFinite(resident.delivered_at) &&
    now - resident.delivered_at < msg.policy.dedupe_ttl_ms
) || (
    resident.pending_key === msg.notification_key &&
    Number.isFinite(resident.pending_at) &&
    now - resident.pending_at < msg.policy.service_retry_seconds * 1000
);
return msg;
