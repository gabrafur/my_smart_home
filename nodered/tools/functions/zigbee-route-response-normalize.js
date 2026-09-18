let payload = msg.payload;
if (typeof payload === "string") {
    try { payload = JSON.parse(payload); } catch { payload = null; }
}
const transaction = String(payload?.transaction || "");
const testMode = transaction.startsWith("nodered-zigbee-route-test-");
const prefixValid = testMode || transaction.startsWith("nodered-zigbee-route-");
const stateKey = testMode ? "zigbee_route_incidents_v1__test" : "zigbee_route_incidents_v1";
const incidents = (testMode ? flow.get(stateKey) : flow.get(stateKey, "persistent")) || {};
const entry = Object.entries(incidents).find(([, value]) => value.pending_transaction === transaction);
msg.zigbee_route_response_valid = Boolean(prefixValid && entry && ["ok", "error"].includes(payload?.status));
if (!msg.zigbee_route_response_valid) return msg;
const [key, current] = entry;
msg._zigbee_test = testMode;
msg.zigbee_route_state_key = stateKey;
msg.zigbee_route_incidents = incidents;
msg.zigbee_route_key = key;
msg.zigbee_route_current = current;
msg.zigbee_route_device = current.device;
msg.zigbee_route_ieee = current.ieee;
msg.zigbee_route_response_status = payload.status;
msg.zigbee_route_response_error = String(payload.error || "");
msg.zigbee_route_now = Number.isFinite(Number(msg.monitor_now)) ? Number(msg.monitor_now) : Date.now();
msg.zigbee_route_now_iso = new Date(msg.zigbee_route_now).toISOString();
return msg;
