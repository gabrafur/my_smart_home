const now = Date.now();
const action = String(msg.payload ?? "");
msg._location_test = true;
msg._location_test_case = "home_confirmation_90s";
if (action === "vehicle_on") {
    msg.payload = {
        kind: "vehicle_primary_context", test_mode: true, test_case: msg._location_test_case,
        updated_at: now, ready: true,
        context: { updated_at: now, ready: true, engine_state_valid: true, engine_on: true,
            refresh: { last_request_at: null } }
    };
} else if (action === "resident_home") {
    msg.payload = {
        kind: "people_context", test_mode: true, test_case: msg._location_test_case,
        source: "resident_secondary", trigger_prev_state: "unavailable", trigger_state: "home",
        updated_at: now, ready: true,
        context: { updated_at: now, ready: true,
            resident_secondary: { state: "home", ready: true, stale: false, current_home: true, updated_at: now } }
    };
    return [msg, null];
} else if (action === "due") {
    const pendingState = flow.get("resident_home_refresh_v2__test");
    const pending = Object.values(pendingState?.residents ?? {})
        .sort((left, right) => Number(left.due_at) - Number(right.due_at))[0];
    if (!pending) return null;
    msg.payload = { kind: "home_confirmation_tick", test_mode: true,
        test_case: msg._location_test_case, test_now: Number(pending.due_at) + 1 };
    return [null, msg];
} else return null;
return [msg, null];
