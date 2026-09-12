const kind = msg.payload?.kind;
const isReset = msg._location_test_reset === true || kind === "test_reset" || kind === "alarm_test_reset";
if (!isReset) return null;
const now = Number(msg.arrival_now ?? Date.now());
const shared = global.get("security_location_test_state_v1") ?? {};
const resetAt = Math.max(now, Number(shared.reset_at ?? 0) || 0, Number(msg.payload?.reset_at ?? 0) || 0);
flow.set("alarm_arrival_test_pending_confirmation", null);
flow.set("alarm_arrival_last_dry_run_v1", null);
global.set("alarm_arrival_test_reset_at", resetAt);
Object.assign(msg, {
    _location_test: true, _location_test_case: "reset", _location_test_reset: true,
    alarm_arrival_test: true, alarm_arrival_test_reset: true,
    payload: { kind: "alarm_test_reset_done", test_mode: true, test_case: "reset", reset_at: resetAt,
        source: kind === "alarm_test_reset" ? "alarme_desarme_chegada" : "location_test_reset" }
});
return msg;
