const testMode = msg._zigbee_test === true;
const stateKey = testMode ? "zigbee_route_incidents_v1__test" : "zigbee_route_incidents_v1";
const incidents = (testMode ? flow.get(stateKey) : flow.get(stateKey, "persistent")) || {};
const current = JSON.parse(JSON.stringify(incidents[msg.zigbee_route_key] || {
    incident_open: false, phase: "idle", attempts: 0, next_retry_at: null
}));
const nextRetry = Date.parse(current.next_retry_at || "") || Number.POSITIVE_INFINITY;
msg.zigbee_route_state_key = stateKey;
msg.zigbee_route_incidents = incidents;
msg.zigbee_route_current = current;
msg.zigbee_route_revision = Number(current.revision || 0);
msg.zigbee_route_deadline = Number.isFinite(nextRetry) ? nextRetry : null;
const stage = current.native_stage || ({scanning: "networkmap", configuring: "configure", verifying: "configure"})[current.phase] || null;
const terminal = current.native_completion_state === "terminal" &&
    typeof current.last_terminal_transaction === "string" &&
    ["networkmap", "configure"].includes(current.last_terminal_stage) &&
    ["ok", "error"].includes(current.last_terminal_status);
const unresolved = current.pending_transaction != null ||
    ["pending", "unknown"].includes(current.native_completion_state) ||
    (current.native_completion_state != null && current.native_completion_state !== "terminal");
msg.zigbee_route_native = { stage, terminal, unresolved,
    expired: msg.zigbee_route_deadline != null && msg.zigbee_route_now >= msg.zigbee_route_deadline,
    unproven: unresolved || (current.incident_open && current.attempts > 0 && !terminal) };
return msg;
