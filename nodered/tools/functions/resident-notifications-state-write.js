const delivery = msg.notification_delivery_state;
const resident = msg.notification_resident_state;
resident.pending_key = msg.notification_key;
resident.pending_at = Date.now();
delivery.residents[msg.resident_source] = resident;
delivery.updated_at = Date.now();
if (msg._location_test === true) flow.set(msg.notification_state_key, delivery);
else flow.set(msg.notification_state_key, delivery, "persistent");
return msg;
