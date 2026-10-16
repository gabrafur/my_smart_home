// Bounded radial evidence for a local trip; no raw GPS or device effects.
function localGpsReturn(cycle, resident, data) {
    const policy = data.location_policy;
    const progress = Number(data.policy.local_return_progress_m);
    const at = resident?.updated_at;
    const distance = resident?.distance_m;
    const accuracy = resident?.gps_accuracy;
    if (!Number.isFinite(progress) || progress <= 0 || resident?.ready !== true ||
        resident.stale === true || resident.location_reliable !== true ||
        !["home", "near_home"].includes(resident.state) ||
        !Number.isFinite(at) || at < cycle.started_at || at > data.now + data.future_ms ||
        data.now - at > Number(policy.location_fresh_minutes) * 60000 ||
        !Number.isFinite(distance) || distance < 0 || !Number.isFinite(accuracy) ||
        accuracy < 0 || accuracy > Number(policy.max_gps_accuracy_m)) return false;
    let track = cycle.gps_return_evidence;
    if (track && (!["first_distance", "first_accuracy", "first_at", "peak_distance",
        "peak_accuracy", "peak_at", "last_at", "last_distance", "last_accuracy"]
        .every((key) => Number.isFinite(track[key])) || track.first_at < cycle.started_at ||
        track.peak_at < track.first_at || track.last_at < track.peak_at ||
        track.last_at > data.now + data.future_ms)) {
        delete cycle.gps_return_evidence;
        track = null;
    }
    if (!track) {
        // A home snapshot cannot create the outbound leg.
        if (resident.state !== "near_home" || resident.current_home === true) return false;
        track = cycle.gps_return_evidence = {
            first_distance: distance, first_accuracy: accuracy, first_at: at,
            peak_distance: distance, peak_accuracy: accuracy, peak_at: at,
            last_at: at, last_distance: distance, last_accuracy: accuracy, returning: false
        };
    }
    if (at < track.last_at) return false;
    if (at > track.last_at) {
        track.returning = track.peak_at > track.first_at &&
            track.peak_distance >= Number(policy.movement_threshold_m) &&
            track.peak_distance - track.first_distance >=
                Math.max(progress, track.peak_accuracy + track.first_accuracy) &&
            track.peak_distance - distance >= Math.max(progress, track.peak_accuracy + accuracy) &&
            at - cycle.started_at >= Number(policy.external_cycle_confirm_seconds) * 1000;
        if (distance > track.peak_distance) {
            track.peak_distance = distance;
            track.peak_accuracy = accuracy;
            track.peak_at = at;
        }
        track.last_at = at;
        track.last_distance = distance;
        track.last_accuracy = accuracy;
    }
    return track.returning === true && at === track.last_at &&
        distance === track.last_distance && accuracy === track.last_accuracy &&
        Number.isFinite(cycle.departure_engine_on_seen_at) &&
        cycle.departure_engine_on_seen_at <= track.peak_at;
}
