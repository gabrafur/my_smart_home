const alert = msg._sd_card_alert ?? {};
const status = msg.notification_delivery?.status ?? "unknown";
const accepted = status === "accepted";
node.status({
    fill: accepted ? "green" : "red",
    shape: accepted ? "dot" : "ring",
    text: (alert.operation === "dismiss" ? "aviso removido" : "aviso criado") + " → " + status
});
if (!accepted) node.warn({ sd_card_alert: alert.operation ?? null, delivery_status: status });
return null;
