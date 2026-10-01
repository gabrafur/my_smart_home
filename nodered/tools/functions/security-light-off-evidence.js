// Shared pure evidence check, embedded by the generator in both OFF gates.
function offEvidence(vehicle, lifecycle, policy, now) {
    const raw = vehicle.telemetry_updated_at ?? vehicle.engine_updated_at;
    const observedAt = Number(raw);
    const ageMs = now - observedAt;
    let reason = null;
    if (vehicle.engine_communication_failed === true) reason = "engine_communication_failed";
    else if (vehicle.ready !== true || vehicle.engine_state_valid !== true) reason = "vehicle_not_ready";
    else if (vehicle.engine_on !== false) reason = "engine_not_off";
    else if (raw == null || !Number.isFinite(observedAt) || observedAt <= 0 ||
        vehicle.telemetry_timestamp_future === true || observedAt > now + Number(policy.future_tolerance_seconds) * 1000)
        reason = "engine_timestamp_invalid";
    else if (ageMs > Number(policy.vehicle_signal_fresh_minutes) * 60000) reason = "engine_observation_stale";
    else if (!Number.isFinite(lifecycle.on_since) || observedAt <= lifecycle.on_since)
        reason = "engine_observation_before_activation";
    return { valid: reason === null, reason, observed_at: observedAt, age_ms: ageMs };
}
