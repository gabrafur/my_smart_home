const input = msg.payload && typeof msg.payload === "object" ? msg.payload : {};
const result = {
    version: 1,
    simulated: true,
    dispatched: false,
    source: input.source,
    recipient: input.recipient,
    message: input.message,
    completed_at: Date.now()
};
const stored = flow.get(msg.notification_state_key);
const delivery = stored?.version === 4 ? stored : msg.notification_delivery_state;
const recipient = delivery.deliveries[msg.notification_delivery_id] || msg.notification_recipient_state;
recipient.accepted_key = msg.notification_key;
recipient.accepted_at = Date.now();
recipient.pending_key = null;
recipient.pending_at = 0;
delivery.deliveries[msg.notification_delivery_id] = recipient;
delivery.updated_at = Date.now();
flow.set(msg.notification_state_key, delivery);
const results = flow.get("resident_notifications_last_dry_run_v2__test") || {};
results[msg.notification_delivery_id] = result;
flow.set("resident_notifications_last_dry_run_v2__test", results);
node.status({ fill: "blue", shape: "dot", text: "TESTE: aviso simulado; nenhum push" });
node.warn("RESIDENT_NOTIFICATION_DRY_RUN_COMPLETE source=" + String(result.source) +
    " recipient=" + String(result.recipient) + " dispatched=false");
return null;
