const recipients = msg.notification?.recipients;
const primaryOfExplicitPair =
    Array.isArray(recipients) &&
    recipients.length === 2 &&
    msg._notification_hub_recipient === "resident_primary";

if (!primaryOfExplicitPair) return [null, msg];

msg._notification_hub_prior_failure = String(
    msg.error?.message ?? "primary_mobile_service_failed"
).replace(/[\r\n]+/g, " ").slice(0, 180);
delete msg.error;
msg._notification_hub_recipient = "resident_secondary";
return [msg, null];
