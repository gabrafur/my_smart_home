// Protocol adapter: called only on the successful output of each service call.
// A mobile pair produces one record per accepted leg, even on partial failure.
const notification = msg.notification ?? {};
const channel = msg._notification_hub_channel;
if (!["mobile", "alexa", "persistent"].includes(channel)) {
    node.error("NOTIFICATION_HISTORY_INVALID_CHANNEL", { _msgid: msg._msgid });
    return null;
}
const simulated = notification.test_mode === true && notification.delivery_under_test !== true;
const acceptedAt = new Date().toISOString();
const record = {
    version: 1,
    accepted_at: acceptedAt,
    status: simulated ? "simulated" : "accepted",
    channel,
    source: notification.source,
    recipient: msg._notification_hub_recipient ?? null,
    target: msg._notification_hub_target ?? null,
    operation: notification.operation ?? "notify",
    profile: notification.profile ?? null,
    notification_id: notification.notification_id ?? null,
    title: notification.title ?? null,
    message: channel === "alexa" && Object.hasOwn(notification.data ?? {}, "message")
        ? notification.data.message : msg.payload,
    data: notification.data ?? null,
    correlation_id: msg._msgid ?? null,
    delivery_under_test: notification.delivery_under_test === true
};
// Do not carry the caller context, credentials or unrelated residential state.
const entry = { payload: JSON.stringify(record) };
if (simulated) {
    entry.notification_delivery = { simulated: true, dispatched: false, channel };
    return [null, entry];
}
entry.filename = `/data/notification-history/${channel}/${acceptedAt.slice(0, 13)}.jsonl`;
return [entry, null];
