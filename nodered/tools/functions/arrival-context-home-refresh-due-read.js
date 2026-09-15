const testMode = msg._location_test === true || msg.payload?.test_mode === true;
const pendingKey = testMode ? "resident_home_refresh_v1__test" : "resident_home_refresh_v1";
const pending = testMode ? flow.get(pendingKey) : flow.get(pendingKey, "persistent");
const testNow = Number(msg.payload?.test_now);
const monitorNow = Number(msg.monitor_now);
const effectiveNow = testMode && Number.isFinite(testNow) ? testNow
    : Number.isFinite(monitorNow) ? monitorNow : Date.now();
const people = flow.get(testMode ? "people_context_v1__test" : "people_context_v1") ?? {};
const vehicle = flow.get(testMode ? "vehicle_primary_context_v1__test" : "vehicle_primary_context_v1") ?? {};
const resident = pending ? people[pending.source] ?? {} : {};
const vehicleObservedAt = Number(vehicle.updated_at ?? 0);
const explicitAway = resident.ready === true && resident.stale !== true && resident.current_home === false;
const engineOffAfterArrival = vehicle.engine_state_valid === true && vehicle.engine_on === false &&
    vehicleObservedAt >= Number(pending?.arrival_observed_at ?? 0);
const engineOn = vehicle.engine_state_valid === true && vehicle.engine_on === true;
const requestObserved = Number(pending?.issued_at ?? 0) > 0 &&
    Number(vehicle.refresh?.last_request_at ?? 0) >= Number(pending.issued_at);
msg._location_test = testMode;
msg.home_refresh_due = {
    pending_key: pendingKey,
    pending,
    now: effectiveNow,
    exists: Boolean(pending && pending.version === 1),
    request_observed: requestObserved,
    expired: Boolean(pending && effectiveNow > Number(pending.expires_at)),
    explicit_away: explicitAway,
    explicit_engine_off: engineOffAfterArrival,
    due: Boolean(pending && effectiveNow >= Number(pending.due_at)),
    engine_allows: Boolean(pending && !engineOffAfterArrival &&
        (engineOn || pending.engine_on_at_arrival === true)),
    retry_due: Boolean(pending && effectiveNow >= Number(pending.next_emit_at ?? pending.due_at))
};
return msg;
