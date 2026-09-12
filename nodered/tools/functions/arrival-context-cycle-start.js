const testMode = msg._location_test === true;
const clockKey = testMode ? "refresh_cycle_clock__test" : "refresh_cycle_clock";
const previous = Number(flow.get(clockKey) || 0);
const cycle = Math.max(msg.context_now, Number.isFinite(previous) ? previous + 1 : 0);
flow.set(clockKey, cycle);
const pending = {
    cycle, people_received: false, vehicle_primary_received: false,
    people_ready: false, vehicle_primary_ready: false, emitted: false,
    started_at: msg.context_now, force_recovery: msg.context_force_recovery,
    require_lighting_ready: msg.context_require_lighting,
    request_reason: msg.context_request_reason
};
flow.set(msg.context_pending_key, pending);
msg.payload = {
    contract: "security.snapshot-request.v1", kind: "snapshot_request",
    refresh_cycle_id: cycle, origin: "contexto_chegadas",
    reason: testMode ? (msg._location_test_reset ? "manual_location_test_reset" : "manual_location_test") : msg.context_request_reason,
    force_recovery: msg.context_force_recovery,
    require_lighting_ready: msg.context_require_lighting, requested_at: cycle,
    ...(testMode ? { test_mode: true, test_case: msg._location_test_case } : {})
};
return msg;
