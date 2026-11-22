// One persistent notice per condition, replaced by each new occurrence and
// dismissed when the condition resolves (resolved alerts leave nothing in HA).
const ack = msg.notificationAck;
const at = Number(ack?.at ?? Date.now());
const kind = msg.storage_notification_kind ??
    (/:collection_recovery$/.test(String(ack?.id)) ? "collection_recovery" : /:collection_error$/.test(String(ack?.id)) ? "collection_error" : "capacity");
const collection = kind === "collection_error" || kind === "collection_recovery";
const resolved = kind === "recovery" || kind === "collection_recovery";
msg.payload = { ...msg.payload,
    notification_id: collection ? "raspberry_storage_collection" : "raspberry_storage_alert",
    persistent_notification_operation: resolved ? "dismiss" : "create",
    message: msg.payload.message + "\n\nOcorrência: " + new Date(at).toISOString() };
return msg;
