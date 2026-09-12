const shared = global.get("security_location_test_state_v1") ?? {};
const transition = shared.transitions?.people;
const direct = msg.test_source;
const scenario = msg.test_case;
const now = Date.now();
const scenarios = {
    departure: { source: "resident_primary", previous: "home", current: "near_home", at: now },
    unavailable: { source: "resident_secondary", previous: "unavailable", current: "near_home", at: now },
    stale: { source: "resident_secondary", previous: "not_home", current: "near_home", at: now - 16 * 60 * 1000 },
    future: { source: "resident_secondary", previous: "not_home", current: "near_home", at: now + 2 * 60 * 1000 }
};
const selected = scenario ? scenarios[scenario] : null;
const source = direct ?? selected?.source ?? transition?.source;
if (!["resident_primary", "resident_secondary"].includes(source)) return null;

msg._location_test = true;
msg.payload = {
    event: "location_update",
    test_mode: true,
    source,
    trigger_state: direct ? "near_home" : selected?.current ?? transition?.state,
    trigger_prev_state: direct ? "not_home" : selected?.previous ?? transition?.prev,
    observed_at: new Date(direct ? now : selected?.at ?? transition?.at ?? shared.observed_at ?? now).toISOString()
};
return msg;
