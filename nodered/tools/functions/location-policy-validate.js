const DEFAULTS = {
    near_home_radius_m: 700,
    home_radius_m: 100,
    people_fast_refresh_radius_m: 2000,
    location_fresh_minutes: 15,
    source_report_fresh_minutes: 75,
    recency_tie_seconds: 60,
    max_gps_accuracy_m: 100,
    vehicle_location_fresh_minutes: 30,
    movement_threshold_m: 250,
    arrival_recovery_minutes: 10,
    arrival_dedupe_minutes: 10,
    primary_home_grace_minutes: 10,
    external_cycle_confirm_seconds: 60,
    future_tolerance_seconds: 60,
    vehicle_signal_fresh_minutes: 5,
    vehicle_recovery_hours: 24
};
const LIMITS = {
    near_home_radius_m: [50, 1500],
    home_radius_m: [20, 500],
    people_fast_refresh_radius_m: [100, 10000],
    location_fresh_minutes: [1, 120],
    source_report_fresh_minutes: [5, 1440],
    recency_tie_seconds: [0, 300],
    max_gps_accuracy_m: [5, 1000],
    vehicle_location_fresh_minutes: [5, 180],
    movement_threshold_m: [10, 2000],
    arrival_recovery_minutes: [3, 30],
    arrival_dedupe_minutes: [1, 60],
    primary_home_grace_minutes: [1, 60],
    external_cycle_confirm_seconds: [15, 600],
    future_tolerance_seconds: [0, 300],
    vehicle_signal_fresh_minutes: [1, 30],
    vehicle_recovery_hours: [1, 168]
};
const topic = String(msg.topic ?? "");
const value = Number(msg.payload);
const bounds = LIMITS[topic];
if (!bounds || !Number.isFinite(value) || value < bounds[0] || value > bounds[1]) {
    msg.location_policy_rejection = {
        parameter: topic || null,
        rejected_value: msg.payload,
        limits: bounds ?? null,
        preserved: true
    };
    return [null, msg];
}
const previous = global.get("location_policy_v1", "persistent");
const base = previous?.version === 1 && previous?.complete === true
    ? previous
    : DEFAULTS;
msg.location_policy_candidate = {
    ...DEFAULTS,
    ...base,
    [topic]: value,
    version: 1,
    owner: "node_red",
    complete: true,
    updated_at: Date.now()
};
return [msg, null];
