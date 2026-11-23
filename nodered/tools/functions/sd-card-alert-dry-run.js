const alert = msg._sd_card_alert ?? {};
msg.sd_card_alert_dry_run = {
    simulated: true,
    dispatched: false,
    operation: alert.operation ?? null,
    hub_status: msg.notification_delivery?.status ?? "unknown"
};
node.status({ fill: "blue", shape: "dot", text: "TESTE: " + (alert.operation ?? "?") + " simulado, nada enviado" });
return null;
