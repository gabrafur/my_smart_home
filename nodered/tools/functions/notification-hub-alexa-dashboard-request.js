const eventEnvelope = msg.payload;
const event = eventEnvelope?.event !== null &&
    typeof eventEnvelope?.event === "object" &&
    !Array.isArray(eventEnvelope.event)
    ? eventEnvelope.event
    : eventEnvelope?.data !== null &&
        typeof eventEnvelope?.data === "object" &&
        !Array.isArray(eventEnvelope.data)
        ? eventEnvelope.data
        : eventEnvelope;
const message = typeof event?.message === "string" ? event.message.trim() : "";
const testMode = msg._notification_hub_dashboard_test === true;

msg._notification_hub_context = {
    payload: eventEnvelope,
    notification: msg.notification,
    had_notification: Object.hasOwn(msg, "notification")
};
msg.payload = message;
msg.notification = {
    source: "chat_dashboard",
    targets: ["voice_assistant_primary"],
    mode: "announce"
};
if (testMode) msg.notification.test_mode = true;
delete msg._notification_hub_dashboard_test;
return msg;
