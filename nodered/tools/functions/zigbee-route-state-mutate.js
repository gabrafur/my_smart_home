const current = msg.zigbee_route_current || {};
// Compare-and-set: messages can interleave between the visual read and mutation.
const store = msg._zigbee_test === true ? undefined : "persistent";
const incidents = flow.get(msg.zigbee_route_state_key, store) || {};
if (Number(incidents[msg.zigbee_route_key]?.revision || 0) !== Number(msg.zigbee_route_revision || 0)) return null;
const retryAt = new Date(msg.zigbee_route_now + msg.policy.route_recovery_cooldown_min * 60000).toISOString();
let updated = current;
if (["open", "retry"].includes(msg.zigbee_route_action)) {
    const attempts = msg.zigbee_route_action === "open" ? 1 : Number(current.attempts || 0) + 1;
    const testPrefix = msg._zigbee_test === true ? "test-" : "";
    const transaction = `nodered-zigbee-route-${testPrefix}${msg.zigbee_route_key}-${msg.zigbee_route_now}`;
    updated = { ...current, incident_open: true, phase: "scanning", attempts,
        device: msg.zigbee_route_device, ieee: msg.zigbee_route_ieee || current.ieee || null,
        first_failure_at: msg.zigbee_route_action === "open" ? msg.zigbee_route_now_iso : current.first_failure_at,
        last_failure_at: msg.zigbee_route_now_iso, last_error: "NWK_NO_ROUTE",
        pending_transaction: transaction, next_retry_at: retryAt, verification_started_at: null,
        exhaustion_notified: false };
    msg.zigbee_route_transaction = transaction;
} else if (msg.zigbee_route_action === "touch") {
    if (msg.zigbee_route_tick === true) return null;
    updated = { ...current, last_failure_at: msg.zigbee_route_now_iso, last_error: "NWK_NO_ROUTE",
        verification_started_at: null, phase: current.phase === "verifying" ? "failed" : current.phase };
}
else if (msg.zigbee_route_action === "verify") updated = {
    ...current, phase: "verifying", verification_started_at: msg.zigbee_route_now_iso
};
else if (msg.zigbee_route_action === "recovery_failed") updated = {
    ...current, phase: "failed", pending_transaction: null,
    recovery_error: msg.zigbee_route_response_error || "unknown",
    next_retry_at: retryAt,
    exhaustion_notified: current.attempts >= msg.policy.route_recovery_max_attempts
};
else if (msg.zigbee_route_action === "recovered") updated = {
    ...current, incident_open: false, phase: "recovered", pending_transaction: null,
    recovered_at: msg.zigbee_route_now_iso, next_retry_at: null, recovery_error: null
};
updated.revision = Number(current.revision || 0) + 1;
incidents[msg.zigbee_route_key] = updated;
flow.set(msg.zigbee_route_state_key, incidents, store);
const pendingKey = "zigbee_route_pending" + (msg._zigbee_test === true ? "__test" : "");
const pendingStore = msg._zigbee_test === true ? undefined : "memoryOnly";
const pending = flow.get(pendingKey, pendingStore) || {};
delete pending[msg.zigbee_route_key];
flow.set(pendingKey, pending, pendingStore);
msg.zigbee_route_incidents = incidents;
msg.zigbee_route_current = updated;
node.status({ fill: updated.incident_open ? "yellow" : "green", shape: "dot", text: `${updated.device}: ${updated.phase}` });
return msg;
