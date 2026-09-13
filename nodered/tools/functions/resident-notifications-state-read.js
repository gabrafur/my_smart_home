const testMode = msg._location_test === true;
const key = testMode
    ? "resident_notification_delivery_v3__test"
    : "resident_notification_delivery_v3";
let state = testMode ? flow.get(key) : flow.get(key, "persistent");
if (!state || state.version !== 3 || typeof state.residents !== "object") {
    const legacy = testMode ? null : flow.get("resident_notification_delivery_v2", "persistent");
    const residents = {};
    if (legacy?.version === 2 && legacy.residents) {
        for (const [role, item] of Object.entries(legacy.residents)) {
            residents[role] = {
                accepted_key: item?.delivered_key ?? null,
                accepted_at: Number(item?.delivered_at || 0),
                pending_key: null,
                pending_at: 0
            };
        }
    }
    state = { version: 3, residents };
}
const resident = state.residents[msg.resident_source] || {
    accepted_key: null,
    accepted_at: 0,
    pending_key: null,
    pending_at: 0
};
const now = Date.now();

msg.notification_state_key = key;
msg.notification_delivery_state = state;
msg.notification_resident_state = resident;
msg.notification_duplicate = resident.accepted_key === msg.notification_key &&
    Number.isFinite(resident.accepted_at) &&
    now - resident.accepted_at < msg.policy.dedupe_ttl_ms ||
    resident.pending_key === msg.notification_key &&
    Number.isFinite(resident.pending_at) &&
    now - resident.pending_at < msg.policy.service_retry_seconds * 1000;
return msg;
