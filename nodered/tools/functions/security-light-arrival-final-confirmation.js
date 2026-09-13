const input = msg.payload ?? {};
const testMode = msg._location_test === true || input.test_mode === true;
const key = "security_light_last_recovery_request_at" +
    (testMode ? "__test" : "");
const now = Date.now();
flow.set(key, now);
msg.payload = {
    kind: "refresh_tick",
    origin: "iluminacao_seguranca",
    reason: "resident_arrival_confirmation",
    force_recovery: true,
    require_lighting_ready: false,
    resident_arrival_force: true,
    requested_at: now,
    arrival_source: input.source,
    arrival_stage: input.arrival_stage,
    test_mode: testMode,
    test_case: msg._location_test_case ?? input.test_case
};
return msg;
