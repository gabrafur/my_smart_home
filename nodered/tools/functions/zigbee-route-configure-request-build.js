// Atomically claim this stage before the MQTT boundary (including dry-run).
const store = msg._zigbee_test === true ? undefined : "persistent";
const incidents = flow.get(msg.zigbee_route_state_key, store) || {};
const current = incidents[msg.zigbee_route_key];
if (!current || current.phase !== "scanning" || current.pending_transaction !== msg.payload?.transaction) return null;
incidents[msg.zigbee_route_key] = { ...current, phase: "configuring", revision: Number(current.revision || 0) + 1 };
flow.set(msg.zigbee_route_state_key, incidents, store);
msg.topic = "zigbee2mqtt/bridge/request/device/configure";
msg.payload = {
    id: msg.zigbee_route_device,
    transaction: msg.zigbee_route_transaction || msg.payload?.transaction
};
msg.retain = false;
msg.qos = "1";
msg.zigbee_route_effect = "configure";
return msg;
