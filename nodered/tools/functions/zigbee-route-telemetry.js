// Only a fresh device publication is evidence; retained snapshots are never proof.
const topic = String(msg.topic || "");
if (msg.retain === true || !topic.startsWith("zigbee2mqtt/")) return null;
const device = topic.slice("zigbee2mqtt/".length);
let payload = msg.payload;
if (typeof payload === "string") { try { payload = JSON.parse(payload); } catch { return null; } }
if (!payload || typeof payload !== "object" || Array.isArray(payload) || !Object.keys(payload).length) return null;
const test = msg._zigbee_test === true;
const suffix = test ? "__test" : "";
const incidents = flow.get("zigbee_route_incidents_v1" + suffix, test ? undefined : "persistent") || {};
const incident = Object.values(incidents).find(v => v.incident_open && v.device === device);
if (!incident) return null;
const key = "zigbee_route_live" + suffix;
const store = test ? undefined : "memoryOnly";
const live = flow.get(key, store) || {};
const now = Number(msg.monitor_now ?? Date.now());
const previous = live[device];
live[device] = { last_seen: now, failure_at: incident.last_failure_at,
    first_seen: previous?.failure_at === incident.last_failure_at ? previous.first_seen : now };
flow.set(key, live, store);
return msg;
