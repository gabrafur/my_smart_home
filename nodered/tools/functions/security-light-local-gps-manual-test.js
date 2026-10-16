// Synthetic local positions only; production state and devices are untouched.
const key = "security_light_gps_manual_v1__test";
if (msg.topic === "reset") {
    for (const name of [key, "people_context_v1__test", "vehicle_primary_context_v1__test",
        "security_light_local_excursion_v1__test", "security_light_lifecycle_v1__test",
        "security_light_pending_arrival_v1__test", "security_light_pending_arrivals_v1__test",
        "security_light_last_dry_run_v1__test"]) flow.set(name, null);
    return null;
}
let fixture = flow.get(key);
if (msg.topic === "start") fixture = { started_at: Date.now() - 180000, step: 0 };
if (!fixture) return null;
const steps = { start: [0, 140], outward: [30000, 320], return: [120000, 240], jitter: [120000, 310] };
const sample = steps[msg.topic];
if (!sample) return null;
const at = fixture.started_at + sample[0];
const vehicle = { ready: true, in_use: true, engine_on: true, engine_state_valid: true,
    engine_stale: false, telemetry_updated_at: fixture.started_at, updated_at: at };
flow.set("vehicle_primary_context_v1__test", vehicle);
flow.set(key, fixture);
msg._location_test = true;
msg._location_test_case = "local_gps_round_trip";
msg.payload = { test_mode: true, kind: "people_context", source: "resident_secondary", updated_at: at,
    context: { ready: true, updated_at: at,
        local_excursions: { resident_secondary: { started_at: fixture.started_at,
            expires_at: fixture.started_at + 90 * 60000 } },
        resident_secondary: { ready: true, stale: false, location_reliable: true,
            state: "near_home", current_home: false, distance_m: sample[1],
            gate_distance_m: sample[1], gps_accuracy: 5, updated_at: at } } };
return msg;
