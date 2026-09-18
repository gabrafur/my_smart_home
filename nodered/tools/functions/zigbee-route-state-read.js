const testMode = msg._zigbee_test === true;
const stateKey = testMode ? "zigbee_route_incidents_v1__test" : "zigbee_route_incidents_v1";
const incidents = (testMode ? flow.get(stateKey) : flow.get(stateKey, "persistent")) || {};
const current = incidents[msg.zigbee_route_key] || {
    incident_open: false, phase: "idle", attempts: 0, next_retry_at: null
};
const nextRetry = Date.parse(current.next_retry_at || "") || Number.POSITIVE_INFINITY;
const canRetry = current.incident_open && ["failed", "recovering"].includes(current.phase) &&
    current.attempts < msg.policy.route_recovery_max_attempts && msg.zigbee_route_now >= nextRetry;
msg.zigbee_route_state_key = stateKey;
msg.zigbee_route_incidents = incidents;
msg.zigbee_route_current = current;
msg.zigbee_route_decision = !current.incident_open ? "open" : canRetry ? "retry" : "duplicate";
return msg;
