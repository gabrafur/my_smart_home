const event = msg.payload;
const message = typeof event?.message === "string" ? event.message.trim() : "";
const testMode = msg._notification_hub_dashboard_test === true;

msg._notification_hub_context = {
    payload: event,
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
