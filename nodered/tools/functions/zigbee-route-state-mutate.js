const current = msg.zigbee_route_current || {};
const retryAt = new Date(msg.zigbee_route_now + msg.policy.route_recovery_cooldown_min * 60000).toISOString();
let updated = current;
if (["open", "retry"].includes(msg.zigbee_route_action)) {
    const attempts = msg.zigbee_route_action === "open" ? 1 : Number(current.attempts || 0) + 1;
    const testPrefix = msg._zigbee_test === true ? "test-" : "";
    const transaction = `nodered-zigbee-route-${testPrefix}${msg.zigbee_route_key}-${msg.zigbee_route_now}`;
    updated = { ...current, incident_open: true, phase: "recovering", attempts,
        device: msg.zigbee_route_device, ieee: msg.zigbee_route_ieee || current.ieee || null,
        first_failure_at: current.first_failure_at || msg.zigbee_route_now_iso,
        last_failure_at: msg.zigbee_route_now_iso, last_error: "NWK_NO_ROUTE",
        pending_transaction: transaction, next_retry_at: retryAt };
    msg.zigbee_route_transaction = transaction;
} else if (msg.zigbee_route_action === "touch") updated = {
    ...current, last_failure_at: msg.zigbee_route_now_iso, last_error: "NWK_NO_ROUTE"
};
else if (msg.zigbee_route_action === "recovery_failed") updated = {
    ...current, phase: "failed", pending_transaction: null,
    recovery_error: msg.zigbee_route_response_error || "unknown",
    next_retry_at: retryAt
};
else if (msg.zigbee_route_action === "recovered") updated = {
    ...current, incident_open: false, phase: "recovered", pending_transaction: null,
    recovered_at: msg.zigbee_route_now_iso, next_retry_at: null, recovery_error: null
};
msg.zigbee_route_incidents[msg.zigbee_route_key] = updated;
if (msg._zigbee_test === true) flow.set(msg.zigbee_route_state_key, msg.zigbee_route_incidents);
else flow.set(msg.zigbee_route_state_key, msg.zigbee_route_incidents, "persistent");
msg.zigbee_route_current = updated;
node.status({ fill: updated.incident_open ? "yellow" : "green", shape: "dot", text: `${updated.device}: ${updated.phase}` });
return msg;
