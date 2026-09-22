const test = msg._zigbee_test === true;
const suffix = test ? "__test" : "";
const store = test ? undefined : "memoryOnly";
const now = Number(msg.monitor_now ?? Date.now());
const bootKey = "zigbee_boot_at" + suffix;
let boot = flow.get(bootKey, store);
if (!Number.isFinite(boot)) { boot = now; flow.set(bootKey, boot, store); }
const bridge = flow.get("zigbee_bridge_observation" + suffix, store);
msg.zigbee_boot_age_ms = Math.max(0, now - boot);
msg.zigbee_bridge_online = bridge?.state === "online";
msg.zigbee_bridge_stable_ms = bridge ? Math.max(0, now - bridge.changed_at) : 0;
return msg;
