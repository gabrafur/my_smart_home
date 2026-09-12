if (msg._location_test !== true || msg.alarm_arrival_test !== true) return null;
const result = {
    version: 1, simulated: true, dispatched: false,
    result: msg.alarm_arrival_test_result ?? "ignorado",
    actions: ["notify_actionable:resident_primary", "notify_actionable:resident_secondary", "mobile_app_confirmation", "alarm_disarm"],
    source: msg.arrival_source ?? "manual", stage: msg.arrival_stage ?? "manual", completed_at: Date.now()
};
flow.set("alarm_arrival_last_dry_run_v1", result);
node.warn(`ALARM_ARRIVAL_DRY_RUN_COMPLETE source=${result.source} stage=${result.stage} result=${result.result} actions=4 dispatched=false`);
return null;
