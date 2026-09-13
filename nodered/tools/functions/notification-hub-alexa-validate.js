const notification = msg.notification;
const targets = notification?.targets;
const validData = notification?.data === undefined || (
    notification.data !== null &&
    typeof notification.data === "object" &&
    !Array.isArray(notification.data)
);
const valid =
    typeof msg.payload === "string" &&
    msg.payload.length > 0 &&
    notification !== null &&
    typeof notification === "object" &&
    !Array.isArray(notification) &&
    typeof notification.source === "string" &&
    notification.source.length > 0 &&
    notification.mode === "announce" &&
    Array.isArray(targets) &&
    targets.length === 1 &&
    targets[0] === "voice_assistant_primary" &&
    validData;

if (!valid) {
    msg._notification_hub_failure_reason = "invalid_alexa_contract";
    return [null, msg];
}

return [msg, null];
