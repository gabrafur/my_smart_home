const delivery = msg.notification_delivery_state;
const resident = msg.notification_resident_state;
if (delivery?.version === 2 && resident && resident.pending_key === msg.notification_key) {
    resident.pending_key = null;
    resident.pending_at = 0;
    delivery.residents[msg.resident_source] = resident;
    delivery.updated_at = Date.now();
    flow.set(msg.notification_state_key, delivery, "persistent");
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
