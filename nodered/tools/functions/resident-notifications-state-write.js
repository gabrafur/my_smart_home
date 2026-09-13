const testMode = msg._location_test === true;
const stored = testMode
    ? flow.get(msg.notification_state_key)
    : flow.get(msg.notification_state_key, "persistent");
const delivery = stored?.version === 4 ? stored : msg.notification_delivery_state;
const recipient = delivery.deliveries[msg.notification_delivery_id] || msg.notification_recipient_state;
recipient.pending_key = msg.notification_key;
recipient.pending_at = Date.now();
delivery.deliveries[msg.notification_delivery_id] = recipient;
delivery.updated_at = Date.now();
msg.notification_delivery_state = delivery;
msg.notification_recipient_state = recipient;
if (testMode) flow.set(msg.notification_state_key, delivery);
else flow.set(msg.notification_state_key, delivery, "persistent");
return msg;
