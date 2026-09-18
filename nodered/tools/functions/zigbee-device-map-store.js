let devices = msg.payload;
if (typeof devices === "string") {
    try { devices = JSON.parse(devices); } catch { devices = []; }
}
const names = {};
for (const device of Array.isArray(devices) ? devices : []) {
    const ieee = String(device.ieee_address || "").toLowerCase();
    const name = String(device.friendly_name || "").trim();
    if (/^0x[0-9a-f]{16}$/.test(ieee) && name) names[ieee] = name;
}
flow.set("zigbee_device_name_by_ieee_v1", names);
node.status({ fill: "green", shape: "dot", text: `${Object.keys(names).length} dispositivos mapeados` });
return null;
