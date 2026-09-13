const notification = msg.notification ?? {};
const channel = String(msg._notification_hub_channel ?? "unknown");
const source = String(notification.source ?? "unknown").slice(0, 100);
const detail = String(
    msg._notification_hub_failure_reason ??
    msg._notification_hub_prior_failure ??
    msg.error?.message ??
    "channel_service_failed"
).replace(/[\r\n]+/g, " ").slice(0, 180);

msg.notification_delivery = {
    version: 1,
    status: "failed",
    channel,
    recipient: msg._notification_hub_recipient ?? null,
    target: msg._notification_hub_target ?? null,
    operation: notification.operation ?? null,
    source,
    reason: detail,
    failed_at: Date.now()
};
msg.error ??= {
    message: detail,
    source: { id: `notification_hub_${channel}`, type: "notification-hub" }
};
node.status({ fill: "red", shape: "ring", text: `${channel}: entrega falhou` });
node.warn(`NOTIFICATION_HUB_FAILED channel=${channel} source=${source}`);

const observer = source === "observabilidade_global" ? null : {
    payload: {
        observer_kind: "notification_hub_failure",
        incident_key: `${channel}:${source}`,
        notification_channel: channel,
        notification_source: source
    },
    alert: {
        title: `Falha no hub de notificações ${channel}`,
        message: `O hub ${channel} não conseguiu concluir uma entrega solicitada por ${source}. Verifique o Node-RED e a conexão com o Home Assistant.`
    },
    _notification_hub_no_observer: true
};

const original = msg._notification_hub_context;
if (original && Object.hasOwn(original, "payload")) msg.payload = original.payload;
if (original?.had_notification === true) msg.notification = original.notification;
else delete msg.notification;
delete msg._notification_hub_context;
delete msg._notification_hub_channel;
delete msg._notification_hub_recipient;
delete msg._notification_hub_target;
delete msg._notification_hub_failure_reason;
delete msg._notification_hub_prior_failure;
return [msg, observer];
