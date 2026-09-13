const s = msg.storage;
const fields = [];
let title;
let message;
const freeText = `${s.free.toFixed(1)} GiB livres`;
const trendText = s.growth24h === null ? "" : `; ${s.growth24h >= 0 ? "+" : ""}${s.growth24h.toFixed(1)} pp/24h`;
const cause = s.growth_cause_bytes === null ? "" : `; causa provavel: ${s.growth_cause} +${(s.growth_cause_bytes / 1073741824).toFixed(1)} GiB/24h`;
if (s.alert_kind === "recovery") {
    title = "Raspberry Pi - storage recuperado";
    message = `✅ Raspberry Pi storage back to normal: ${s.used.toFixed(1)}% used (${freeText})${trendText}.`;
    fields.push("lastNotificationAt");
} else if (s.alert_kind === "capacity") {
    const icon = s.severity === "critical" ? "🚨" : "⚠️";
    title = `Raspberry Pi - storage ${s.severity}`;
    message = `${icon} Raspberry Pi storage ${s.severity}: ${s.used.toFixed(1)}% used (${freeText})${trendText}${cause}.`;
    fields.push("lastNotificationAt");
    if (s.accelerated) fields.push("lastTrendNotificationAt");
} else if (s.alert_kind === "trend") {
    const parts = [];
    if (s.growth24h !== null) parts.push(`${s.growth24h >= 0 ? "+" : ""}${s.growth24h.toFixed(1)} pp/24h`);
    if (s.growth7d !== null) parts.push(`${s.growth7d >= 0 ? "+" : ""}${s.growth7d.toFixed(1)} pp/7d`);
    title = "Raspberry Pi - crescimento de storage";
    message = `⚠️ Storage crescendo rapidamente: ${parts.join(", ")}. Uso atual: ${s.used.toFixed(1)}% (${freeText})${cause}. A limpeza segura foi solicitada automaticamente.`;
    fields.push("lastTrendNotificationAt");
} else return msg;
msg.storage_alert = { payload: { title, message }, notificationAck: { id: `${s.now}:${fields.join(",")}`, at: s.now, targets: fields.map((field) => ({ key: s.stateKey, field })) } };
return msg;
