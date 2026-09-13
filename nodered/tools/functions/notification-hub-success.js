const notification = msg.notification ?? {};
msg.notification_delivery = {
    version: 1,
    status: "accepted",
    channel: msg._notification_hub_channel,
    recipient: msg._notification_hub_recipient ?? null,
    recipients: Array.isArray(notification.recipients) ? [...notification.recipients] : [],
    target: msg._notification_hub_target ?? null,
    operation: notification.operation ?? null,
    source: notification.source ?? "unknown",
    accepted_at: Date.now()
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
return msg;
