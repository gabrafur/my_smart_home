const pending = msg.confirmation.test_pending;
flow.set("alarm_arrival_test_pending_confirmation", null);
Object.assign(msg, {
    _location_test: true, _location_test_case: pending.testCase ?? null,
    alarm_arrival_test: true, alarm_arrival_test_action: msg.confirmation.action,
    arrival_source: pending.source ?? "manual", arrival_stage: pending.stage ?? "manual",
    refresh_cycle_id: pending.refreshCycleId ?? null
});
return msg;
