// TESTE: the hub answered from its own dry-run; nothing was removed from Home Assistant.
const expiry = msg._notification_expiry ?? {};
msg.notification_expiry_dry_run = {
    simulated: true,
    dispatched: false,
    notification_id: expiry.notification_id ?? null,
    hub_status: msg.notification_delivery?.status ?? "unknown"
};
node.status({ fill: "blue", shape: "dot", text: `TESTE: ${expiry.notification_id ?? "?"} → ${msg.notification_delivery?.status ?? "?"}` });
return null;
