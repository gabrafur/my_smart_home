const testMode = msg._location_test === true || msg.payload?.test_mode === true;
const key = testMode ? "refresh_pending__test" : "refresh_pending";
const pending = flow.get(key);
const now = Number(msg.monitor_now ?? Date.now());
msg._location_test = testMode;
msg._location_test_case = msg._location_test_case ?? msg.payload?.test_case ?? null;
msg.context_pending_key = key;
msg.context_pending = pending;
msg.context_now = now;
msg.context_cycle_inflight = Boolean(pending && pending.emitted !== true &&
    Number.isFinite(Number(pending.started_at)) && now - Number(pending.started_at) < msg.policy.inflight_timeout_s * 1000);
msg.context_force_recovery = msg.payload?.force_recovery === true;
msg.context_require_lighting = msg.payload?.require_lighting_ready === true;
msg.context_request_reason = msg.payload?.reason || "startup_or_periodic_reconciliation";
msg.context_resident_arrival_force = msg.payload?.resident_arrival_force === true;
msg.context_arrival_source = msg.payload?.arrival_source ?? null;
msg.context_arrival_stage = msg.payload?.arrival_stage ?? null;
return msg;
