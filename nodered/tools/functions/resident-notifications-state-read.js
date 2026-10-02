const testMode = msg._location_test === true;
const key = "resident_notification_delivery_v4" + (testMode ? "__test" : "");
const store = testMode ? undefined : "persistent";
let state = flow.get(key, store);
if (!state || state.version !== 4 || typeof state.deliveries !== "object")
    state = { version: 4, deliveries: {} };
const deliveryId = msg.resident_source + ":" + msg.resident_recipient;
const recipient = state.deliveries[deliveryId] ?? {};
const now = Date.now();
const recent = Number.isFinite(recipient.accepted_at) &&
    now - recipient.accepted_at < msg.policy.dedupe_ttl_ms;
const differentCycle = msg.notification_canonical_cycle === true &&
    recipient.accepted_key?.startsWith("cycle:") && recipient.accepted_key !== msg.notification_key;
const homeFollowup = msg.arrival_stage === "home" && recent && !differentCycle &&
    ["approach", "local_return", "home"].includes(recipient.accepted_stage);
const pendingRecent = Number.isFinite(recipient.pending_at) &&
    now - recipient.pending_at < msg.policy.service_retry_seconds * 1000;
const duplicate = msg.event_at < recipient.accepted_event_at ||
    pendingRecent && msg.event_at < recipient.pending_event_at || recipient.accepted_key === msg.notification_key &&
    (recent || msg.notification_canonical_cycle === true) || homeFollowup ||
    recipient.pending_key === msg.notification_key && pendingRecent;
msg.notification_state_key = key;
msg.notification_delivery_state = state;
msg.notification_delivery_id = deliveryId;
msg.notification_recipient_state = recipient;
msg.notification_duplicate = duplicate;
// Reading and reserving must be one synchronous operation: separate nodes let
// concurrent HOME confirmations both pass before either reservation exists.
if (!duplicate) {
    state.sequence = Number(state.sequence ?? 0) + 1;
    msg.notification_reservation = now + ":" + state.sequence;
    Object.assign(recipient, { pending_key: msg.notification_key, pending_at: now,
        pending_token: msg.notification_reservation, pending_event_at: msg.event_at, pending_dispatched: false });
    state.deliveries[deliveryId] = recipient;
    state.updated_at = now;
    flow.set(key, state, store);
}
return msg;
