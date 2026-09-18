let payload = msg.payload;
if (typeof payload === "string") {
    try { payload = JSON.parse(payload); } catch { payload = { message: payload }; }
}
const message = String(payload?.message || "");
const level = String(payload?.level || "").toLowerCase();
msg.zigbee_route_valid = false;
if (!message.includes("NWK_NO_ROUTE") || !["warning", "error"].includes(level)) return msg;
const quoted = message.match(/(?:to|ping|of|configure)\s+'([^']+)'/i);
const ieeeMatch = message.match(/0x[0-9a-f]{16}/i);
const ieee = ieeeMatch ? ieeeMatch[0].toLowerCase() : null;
const names = flow.get("zigbee_device_name_by_ieee_v1") || {};
const device = quoted?.[1] || names[ieee] || ieee;
if (!device) return msg;
let hash = 0x811c9dc5;
for (const byte of Buffer.from(device, "utf8")) { hash ^= byte; hash = Math.imul(hash, 0x01000193) >>> 0; }
const slug = device.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
msg.zigbee_route_valid = true;
msg.zigbee_route_device = device;
msg.zigbee_route_ieee = ieee;
msg.zigbee_route_key = `${slug || "device"}_${hash.toString(16).padStart(8, "0")}`;
msg.zigbee_route_error = "NWK_NO_ROUTE";
msg.zigbee_route_now = Number.isFinite(Number(msg.monitor_now)) ? Number(msg.monitor_now) : Date.now();
msg.zigbee_route_now_iso = new Date(msg.zigbee_route_now).toISOString();
return msg;
