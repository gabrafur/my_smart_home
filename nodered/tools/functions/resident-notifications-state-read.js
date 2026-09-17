const testMode = msg._location_test === true;
const key = testMode
    ? "resident_notification_delivery_v4__test"
    : "resident_notification_delivery_v4";
let state = testMode ? flow.get(key) : flow.get(key, "persistent");
if (!state || state.version !== 4 || typeof state.deliveries !== "object") {
    state = { version: 4, deliveries: {} };
}
const deliveryId = msg.resident_source + ":" + msg.resident_recipient;
const recipient = state.deliveries[deliveryId] ?? {
    accepted_key: null,
    accepted_at: 0,
    accepted_stage: null,
    pending_key: null,
    pending_at: 0
};
const now = Date.now();
const acceptedRecently = Number.isFinite(recipient.accepted_at) &&
    now - recipient.accepted_at < msg.policy.dedupe_ttl_ms;
const laterHomeForSameArrival = msg.arrival_stage === "home" &&
    ["approach", "local_return"].includes(recipient.accepted_stage) &&
    acceptedRecently;

msg.notification_state_key = key;
msg.notification_delivery_state = state;
msg.notification_delivery_id = deliveryId;
msg.notification_recipient_state = recipient;
msg.notification_duplicate = recipient.accepted_key === msg.notification_key &&
    acceptedRecently || laterHomeForSameArrival ||
    recipient.pending_key === msg.notification_key &&
    Number.isFinite(recipient.pending_at) &&
    now - recipient.pending_at < msg.policy.service_retry_seconds * 1000;
return msg;
