const notification = msg.notification;
const operation = notification?.operation;
const validBase =
    notification !== null &&
    typeof notification === "object" &&
    !Array.isArray(notification) &&
    typeof notification.source === "string" &&
    notification.source.length > 0 &&
    typeof notification.notification_id === "string" &&
    notification.notification_id.length > 0 &&
    ["queued", "immediate"].includes(notification.delivery) &&
    ["create", "dismiss"].includes(operation);
const validCreate = operation !== "create" || (
    typeof msg.payload === "string" &&
    msg.payload.length > 0 &&
    typeof notification.title === "string" &&
    notification.title.length > 0
);

if (!validBase || !validCreate) {
    msg._notification_hub_failure_reason = "invalid_persistent_contract";
    return [null, msg];
}

return [msg, null];
