// Keep the latest raw error until the bridge is ready; no attempt is lost at startup.
if (msg.zigbee_route_tick === true) return msg;
const test = msg._zigbee_test === true;
const key = "zigbee_route_pending" + (test ? "__test" : "");
const store = test ? undefined : "memoryOnly";
const pending = flow.get(key, store) || {};
pending[msg.zigbee_route_key] = {
    zigbee_route_key: msg.zigbee_route_key, zigbee_route_device: msg.zigbee_route_device,
    zigbee_route_ieee: msg.zigbee_route_ieee, failure_at: msg.zigbee_route_now
};
flow.set(key, pending, store);
return msg;
