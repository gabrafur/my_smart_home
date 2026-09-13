const channel = String(msg._notification_hub_channel ?? "unknown");
const source = String(msg.notification?.source ?? "unknown").slice(0, 100);
const reason = String(msg._notification_hub_failure_reason ?? "invalid_contract");
msg.notification_delivery = {
    version: 1,
    status: "rejected",
    channel,
    recipient: null,
    target: null,
    operation: msg.notification?.operation ?? null,
    source,
    reason,
    rejected_at: Date.now()
};
node.status({ fill: "red", shape: "ring", text: `${channel}: contrato rejeitado` });
node.warn(`NOTIFICATION_HUB_REJECTED channel=${channel} source=${source} reason=${reason}`);

const original = msg._notification_hub_context;
if (original && Object.hasOwn(original, "payload")) msg.payload = original.payload;
if (original?.had_notification === true) msg.notification = original.notification;
else delete msg.notification;
delete msg._notification_hub_context;
delete msg._notification_hub_channel;
delete msg._notification_hub_recipient;
delete msg._notification_hub_target;
delete msg._notification_hub_failure_reason;
return msg;
