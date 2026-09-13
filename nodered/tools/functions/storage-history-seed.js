const now = Date.now();
const policy = flow.get("storage_health_config_v1", "persistent");
const configuredRetention = Number(policy?.historyRetentionMs);
const configuredInterval = Number(policy?.sampleIntervalMs);
const retention = Number.isFinite(configuredRetention) && configuredRetention >= 172800000 && configuredRetention <= 2592000000
    ? configuredRetention : 691200000;
const sampleInterval = Number.isFinite(configuredInterval) && configuredInterval > 0 ? configuredInterval : 900000;
const cutoff = now - retention;
const rows = Array.isArray(msg.payload) ? msg.payload.flat(2) : [];
let history = flow.get("storage_health_history_v1", "persistent");
if (!Array.isArray(history)) history = [];
const valid = (point) => point?.source === "production" && Number.isFinite(point.ts) &&
    Number.isFinite(point.used) && point.used >= 0 && point.used <= 100 &&
    point.ts >= cutoff && point.ts <= now + sampleInterval;
const imported = rows.map((row) => ({
    ts: Date.parse(row?.last_updated ?? row?.last_changed ?? ""),
    used: row?.state === "" || row?.state == null ? NaN : Number(row.state),
    source: "production", origin: "recorder"
})).filter(valid);
const buckets = new Map();
for (const point of [...history.filter(valid), ...imported].sort((a, b) => a.ts - b.ts)) {
    buckets.set(Math.floor(point.ts / sampleInterval), point);
}
history = [...buckets.values()].sort((a, b) => a.ts - b.ts);
const limit = Math.ceil(retention / sampleInterval) + 2;
if (history.length > limit) history = history.slice(-limit);
flow.set("storage_health_history_v1", history, "persistent");
msg.storage_history_seeded = {
    imported: imported.length, points: history.length,
    oldest_at: history.length ? new Date(history[0].ts).toISOString() : null
};
node.status(history.length
    ? { fill: "green", shape: "dot", text: `${history.length} amostras reais` }
    : { fill: "yellow", shape: "ring", text: "Recorder sem histórico" });
return msg;
