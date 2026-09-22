const test = msg._zigbee_test === true;
const suffix = test ? "__test" : "";
const incidents = flow.get("zigbee_route_incidents_v1" + suffix, test ? undefined : "persistent") || {};
const pending = flow.get("zigbee_route_pending" + suffix, test ? undefined : "memoryOnly") || {};
const now = Number(msg.monitor_now ?? Date.now());
const entries = new Map(Object.entries(incidents).filter(([, v]) => v.incident_open).map(([key, v]) => [key, {
    zigbee_route_key: key, zigbee_route_device: v.device, zigbee_route_ieee: v.ieee
}]));
for (const [key, value] of Object.entries(pending)) entries.set(key, value);
return [[...entries.values()].map(value => ({ ...value, _zigbee_test: test,
    zigbee_route_tick: !Object.hasOwn(pending, value.zigbee_route_key),
    monitor_now: now, zigbee_route_now: now, zigbee_route_now_iso: new Date(now).toISOString()
}))];
