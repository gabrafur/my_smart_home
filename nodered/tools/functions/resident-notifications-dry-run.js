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
const delivery = msg.notification_delivery_state;
const resident = msg.notification_resident_state;
resident.delivered_key = msg.notification_key;
resident.delivered_at = Date.now();
resident.pending_key = null;
resident.pending_at = 0;
delivery.residents[msg.resident_source] = resident;
delivery.updated_at = Date.now();
flow.set(msg.notification_state_key, delivery);
flow.set("resident_notifications_last_dry_run_v1__test", result);
node.status({ fill: "blue", shape: "dot", text: "TESTE: aviso simulado; nenhum push" });
node.warn("RESIDENT_NOTIFICATION_DRY_RUN_COMPLETE source=" + String(result.source) +
    " recipient=" + String(result.recipient) + " dispatched=false");
return null;
