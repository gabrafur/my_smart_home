if (!String(msg.topic || "").startsWith("zigbee2mqtt/") || !String(msg.topic).endsWith("/availability")) {
    msg.zigbee_component_valid = false;
    return msg;
}
let value = msg.payload;
if (Buffer.isBuffer(value)) value = value.toString("utf8");
if (typeof value === "string") {
    try { const parsed = JSON.parse(value); value = parsed?.state ?? parsed; } catch { /* texto simples */ }
}
if (value && typeof value === "object") value = value.state;
const availability = String(value || "").toLowerCase();
const component = String(msg.topic).slice("zigbee2mqtt/".length, -"/availability".length);
msg.zigbee_component_valid = Boolean(component) && (availability === "online" || availability === "offline");
if (!msg.zigbee_component_valid) return msg;
let hash = 0x811c9dc5;
for (const byte of Buffer.from(component, "utf8")) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
}
const slug = component.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
msg.zigbee_component = component;
msg.zigbee_component_key = `${slug || "component"}_${hash.toString(16).padStart(8, "0")}`;
msg.zigbee_component_availability = availability;
msg.zigbee_now = Number(msg.monitor_now ?? Date.now());
msg.zigbee_now_iso = new Date(msg.zigbee_now).toISOString();
return msg;
