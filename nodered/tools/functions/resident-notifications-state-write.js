const store = msg._location_test === true ? undefined : "persistent";
const delivery = flow.get(msg.notification_state_key, store);
const recipient = delivery?.deliveries?.[msg.notification_delivery_id];
// A queued message may have lost its reservation, or the same message may
// reach this boundary twice. Each reservation dispatches at most once.
if (!recipient || recipient.pending_token !== msg.notification_reservation ||
    recipient.pending_key !== msg.notification_key || recipient.pending_dispatched === true)
    return null;
recipient.pending_dispatched = true;
flow.set(msg.notification_state_key, delivery, store);
msg.notification_delivery_state = delivery;
msg.notification_recipient_state = recipient;
return msg;
