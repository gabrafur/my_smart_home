const testMode = msg._zigbee_test === true;
const stateKey = testMode ? "zigbee_route_incidents_v1__test" : "zigbee_route_incidents_v1";
const incidents = (testMode ? flow.get(stateKey) : flow.get(stateKey, "persistent")) || {};
const current = structuredClone(incidents[msg.zigbee_route_key] || {
    incident_open: false, phase: "idle", attempts: 0, next_retry_at: null
});
const nextRetry = Date.parse(current.next_retry_at || "") || Number.POSITIVE_INFINITY;
msg.zigbee_route_state_key = stateKey;
msg.zigbee_route_incidents = incidents;
msg.zigbee_route_current = current;
msg.zigbee_route_revision = Number(current.revision || 0);
msg.zigbee_route_deadline = Number.isFinite(nextRetry) ? nextRetry : null;
return msg;
