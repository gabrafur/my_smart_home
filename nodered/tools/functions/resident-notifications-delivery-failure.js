const testMode = msg._location_test === true;
const stored = testMode
    ? flow.get(msg.notification_state_key)
    : flow.get(msg.notification_state_key, "persistent");
const delivery = stored?.version === 4 ? stored : msg.notification_delivery_state;
const recipient = delivery?.deliveries?.[msg.notification_delivery_id] || msg.notification_recipient_state;
if (delivery?.version === 4 && recipient?.pending_key === msg.notification_key) {
    recipient.pending_key = null;
    recipient.pending_at = 0;
    delivery.deliveries[msg.notification_delivery_id] = recipient;
    delivery.updated_at = Date.now();
    if (testMode) flow.set(msg.notification_state_key, delivery);
    else flow.set(msg.notification_state_key, delivery, "persistent");
}

msg.notification_retry_count = Number(msg.notification_retry_count ?? 0) + 1;
msg.delay = msg.policy.service_retry_seconds * 1000;
msg.notification_retry_allowed = msg.notification_retry_count <= 2;
node.status({
    fill: msg.notification_retry_allowed ? "yellow" : "red",
    shape: "ring",
    text: msg.notification_retry_allowed
        ? `falha; retry ${msg.notification_retry_count}/2`
        : "falha após 3 tentativas"
});
return msg;
