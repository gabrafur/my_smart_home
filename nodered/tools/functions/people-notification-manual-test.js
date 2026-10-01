const key = "people_notification_manual_v1__test";
const policy = global.get("location_policy_v1", "persistent");
const distance = Number(msg.payload);
const reset = msg.topic === "reset";
if (reset) {
    for (const name of ["people_notification_cycles_v1", "security_people_recovery_v1",
        "people_arrival_armed", "people_context_v1", "people_notification_manual_v1"])
        flow.set(name + "__test", undefined);
}
const previous = flow.get(key) ?? "home";
const state = distance <= policy.home_radius_m ? "home" :
    distance <= policy.near_home_radius_m ? "near_home" : "not_home";
flow.set(key, state);
const stamp = new Date().toISOString();
const tracker = (role, meters, zone) => ({
    entity_id: "device_tracker." + role + "_location", state: zone,
    last_changed: stamp, last_updated: stamp,
    attributes: { latitude: 0, longitude: 0, gps_accuracy: 10,
        canonical_distance_home_m: meters, canonical_distance_gate_m: meters,
        location_observed_at: stamp, source_reported_at: stamp }
});
msg._location_test = true;
msg._location_test_case = "notification_700_" + (reset ? "reset" : distance);
msg.payload = {
    event: "location_update", test_mode: true, source: "resident_primary",
    trigger_state: state, trigger_prev_state: previous,
    resident_primary_selected: tracker("resident_primary", distance, state),
    resident_secondary_selected: tracker("resident_secondary", 20, "home")
};
return msg;
