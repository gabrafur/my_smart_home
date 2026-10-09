// A missing service proves this attempt did not dispatch a push. Other
// failures are ambiguous and must not be retried here.
const text = String(msg.error?.message ?? "");
const missing = /^HomeAssistantError: Service public_bindings\.call not found\.?$/.test(text);
msg.notification_service_missing = missing;
msg.notification_service_attempt = Number(msg.notification_service_attempt ?? 0);
return msg;
