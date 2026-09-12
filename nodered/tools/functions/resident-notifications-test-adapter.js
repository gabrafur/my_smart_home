const now = Date.now();
const transition = (global.get("security_location_test_state_v1") ?? {}).transitions?.people;
const cases = {
    direct_home: ["resident_secondary", "home", "returning", true, now],
    invalid_direction: ["resident_primary", "approach", "leaving", true, now],
    unavailable: ["resident_secondary", "approach", "returning", false, now],
    stale: ["resident_secondary", "approach", "returning", true, now - 960000],
    future: ["resident_secondary", "approach", "returning", true, now + 120000]
};
const selected = cases[msg.test_case] ?? [];
const source = msg.test_source ?? selected[0] ?? transition?.source;
if (!["resident_primary", "resident_secondary"].includes(source)) return null;
let eventAt = selected[4] ?? transition?.at ?? now;
if (msg.test_case === "duplicate") {
    eventAt = flow.get("resident_notifications_last_test_event_at_v2") ?? now;
} else if (!msg.test_case || msg.test_case === "direct_home") {
    flow.set("resident_notifications_last_test_event_at_v2", eventAt);
}
msg._location_test = true;
msg.payload = {
    contract: "security.arrival.v1",
    kind: "arrival",
    test_mode: true,
    source,
    arrival_source_type: "person",
    arrival_stage: selected[1] ?? (transition?.state === "home" ? "home" : "approach"),
    arrival_direction: selected[2] ?? "returning",
    external_cycle_confirmed: selected[3] ?? true,
    event_at: eventAt
};
return msg;
