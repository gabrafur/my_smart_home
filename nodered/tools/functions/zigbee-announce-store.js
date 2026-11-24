// A mains module announces itself when it boots; one that only lost radio
// contact returns without announcing. This separates power from signal.
if (msg.retain === true || msg.topic !== "zigbee2mqtt/bridge/event") return null;
let event = msg.payload;
if (typeof event === "string") { try { event = JSON.parse(event); } catch { return null; } }
const name = event?.data?.friendly_name;
if (event?.type !== "device_announce" || typeof name !== "string" || !name) return null;
const test = msg._zigbee_test === true;
const key = "zigbee_announce_v1" + (test ? "__test" : "");
const store = test ? undefined : "persistent";
const announces = flow.get(key, store) || {};
announces[name] = Number(msg.monitor_now ?? Date.now());
flow.set(key, announces, store);
return null;
