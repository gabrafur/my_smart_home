let retained = msg.payload;
if (Buffer.isBuffer(retained)) retained = retained.toString("utf8");
if (typeof retained === "string") {
    try { retained = JSON.parse(retained); } catch { return null; }
}
if (!retained || typeof retained !== "object") return null;
const current = flow.get("zigbee_network_monitor_history_v1", "persistent") || {};
const timestamp = (value) => typeof value === "string" && Number.isFinite(Date.parse(value));
if (timestamp(retained.last_outage)) current.last_outage_at = retained.last_outage;
if (timestamp(retained.last_recovery)) current.last_recovery_at = retained.last_recovery;
const duration = Number(retained.last_outage_duration_s);
if (retained.last_outage_duration_s != null && retained.last_outage_duration_s !== "" && Number.isFinite(duration) && duration >= 0) {
    current.last_outage_duration_s = duration;
}
flow.set("zigbee_network_monitor_history_v1", current, "persistent");
return null;
