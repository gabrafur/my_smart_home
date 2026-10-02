const stored = flow.get(msg.notification_state_key, "persistent");
const delivery = stored?.version === 4 ? stored : msg.notification_delivery_state;
const recipient = delivery.deliveries[msg.notification_delivery_id] || msg.notification_recipient_state;
// Ignore a callback belonging to an older reservation.
if (recipient?.pending_token !== msg.notification_reservation) return null;
recipient.accepted_key = msg.notification_key;
recipient.accepted_at = Date.now();
recipient.accepted_event_at = msg.event_at;
recipient.accepted_stage = msg.arrival_stage;
recipient.pending_key = null;
recipient.pending_at = 0;
delivery.deliveries[msg.notification_delivery_id] = recipient;
delivery.updated_at = Date.now();
flow.set(msg.notification_state_key, delivery, "persistent");
node.status({ fill: "green", shape: "dot", text: "push aceito: " + msg.resident_recipient });
return null;
