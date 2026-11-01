const test = msg._zigbee_test === true;
const read = key => (test ? flow.get(key + "__test") : flow.get(key, "persistent")) || {};
const key = "zigbee_component_incidents_v1" + (test ? "__test" : "");
const all = read("zigbee_component_incidents_v1");
const prior = all[msg.zigbee_component] || { offline: false };
const last = Date.parse(prior.last_notification_at || prior.outage_started_at || "");
const next = Date.parse(prior.next_reminder_at || "");
msg.zigbee_component_state_key = key;
msg.zigbee_component_incidents = all;
msg.zigbee_component_current = prior;
msg.zigbee_component_next_reminder_ms = Number.isFinite(next) ? next :
  (Number.isFinite(last) ? last : msg.zigbee_now) + msg.policy.reminder_interval_h * 3600000;
const routes = read("zigbee_route_incidents_v1");
const rows = typeof routes === "object" && !Array.isArray(routes) ? Object.values(routes) : [];
const valid = rows.length <= 256;
const names = flow.get("zigbee_device_name_by_ieee_v1" + (test ? "__test" : "")) || {};
const ids = Object.entries(names).filter(([ieee, name]) =>
  /^0x[0-9a-f]{16}$/i.test(ieee) && name === msg.zigbee_component).map(([ieee]) => ieee.toLowerCase());
const found = valid ? rows.filter(r =>
  r && typeof r === "object" && (r.device === msg.zigbee_component ||
      typeof r.ieee === "string" && ids.includes(r.ieee.toLowerCase()))) : [];
const open = found.some(r => r.incident_open === true);
msg.zigbee_component_route_context = {
  source: "canonical_NodeRED_Zigbee_route_lifecycle",
  observed_at: Number.isFinite(msg.zigbee_now) ? new Date(msg.zigbee_now).toISOString() : null,
  state: !valid || !found.length ? "unknown" : open ? "pending" : "no_open_incident",
  collection_error: valid ? null : "route_context_capacity",
  incident_open: found.length && valid ? open : null,
  related_records: found.length,
  command_functional_health: "unknown",
  coverage: ["independent_route_incident_snapshot", "not_command_execution_or_RF_proof"]
};
return msg;
