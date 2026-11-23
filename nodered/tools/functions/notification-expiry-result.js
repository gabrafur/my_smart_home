const expiry = msg._notification_expiry ?? {};
const status = msg.notification_delivery?.status ?? "unknown";
const accepted = status === "accepted" || status === "simulated";
node.status({
    fill: accepted ? "green" : "red",
    shape: accepted ? "dot" : "ring",
    text: `${expiry.test_mode ? "TESTE: " : ""}${expiry.notification_id ?? "?"} → ${status}`
});
if (!accepted) node.warn({ expired_notification: expiry.notification_id ?? null, delivery_status: status });
return null;
