let value = msg.payload;
if (msg.status) {
    const normalized = String(msg.status.text || "").toLowerCase();
    value = msg.status.fill === "red" || /disconnected|offline|error/.test(normalized) ? "offline" : null;
}
if (Buffer.isBuffer(value)) value = value.toString("utf8");
if (typeof value === "string") {
    try {
        const parsed = JSON.parse(value);
        value = parsed?.state ?? parsed;
    } catch {
        // Zigbee2MQTT também publica online/offline como texto simples.
    }
}
if (value && typeof value === "object") value = value.state;
const state = String(value || "").toLowerCase();
msg.zigbee_observation_valid = state === "online" || state === "offline";
msg.zigbee_observed_state = msg.zigbee_observation_valid ? state : "unknown";
msg.zigbee_now = Number(msg.monitor_now ?? Date.now());
msg.zigbee_now_iso = new Date(msg.zigbee_now).toISOString();
return msg;
