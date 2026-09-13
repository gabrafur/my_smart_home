const notification = msg.notification;
const recipients = notification?.recipients;
const allowedRecipients = new Set(["resident_primary", "resident_secondary"]);
const allowedProfiles = new Set(["simple", "actionable", "background_command"]);
const validData = notification?.data === undefined || (
    notification.data !== null &&
    typeof notification.data === "object" &&
    !Array.isArray(notification.data)
);
const validRecipients = Array.isArray(recipients) &&
    recipients.length >= 1 &&
    recipients.length <= 2 &&
    new Set(recipients).size === recipients.length &&
    recipients.every((recipient) => allowedRecipients.has(recipient));
const valid =
    typeof msg.payload === "string" &&
    msg.payload.length > 0 &&
    notification !== null &&
    typeof notification === "object" &&
    !Array.isArray(notification) &&
    typeof notification.source === "string" &&
    notification.source.length > 0 &&
    allowedProfiles.has(notification.profile) &&
    validData &&
    validRecipients &&
    (notification.title === undefined || typeof notification.title === "string") &&
    (
        notification.profile !== "background_command" ||
        ["request_location_update", "clear_notification"].includes(msg.payload)
    );

if (!valid) {
    msg._notification_hub_failure_reason = "invalid_mobile_contract";
    return [null, msg];
}

msg._notification_hub_recipient_count = recipients.length;
return [msg, null];
