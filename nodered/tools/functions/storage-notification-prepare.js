const ack = msg.notificationAck;
const at = Number(ack?.at ?? Date.now());
const id = String(ack?.id ?? at).replace(/[^a-zA-Z0-9_-]/g, "_");
msg.payload = { ...msg.payload, notification_id: "raspberry_storage_" + id,
    message: msg.payload.message + "\n\nOcorrência: " + new Date(at).toISOString() };
return msg;
