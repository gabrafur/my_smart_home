const policy = global.get("location_policy_v1", "persistent");
if (policy?.version !== 1 || policy?.complete !== true) {
    node.error("Política canônica de localização ausente", msg);
    return null;
}
const TEST_MODE = msg._location_test === true || msg.payload?.test_mode === true;
const futureMs = Number(policy.future_tolerance_seconds) * 1000;
const locationFreshMs = Number(policy.location_fresh_minutes) * 60000;
const reportFreshMs = Number(policy.source_report_fresh_minutes) * 60000;
const validState = (value) => typeof value === "string" &&
    !["", "unknown", "unavailable"].includes(value);
const timestamp = (entity, attribute, fallback) => {
    const value = Date.parse(entity?.attributes?.[attribute] ?? entity?.[fallback] ?? "");
    return Number.isFinite(value) ? value : null;
};
const fresh = (value, ttl) => value !== null &&
    value <= Date.now() + futureMs && Date.now() - value <= ttl;
function position(selected, primary, fallback) {
    const attrs = selected?.attributes ?? {};
    const observedAt = timestamp(selected, "location_observed_at", "last_changed");
    const reportedAt = timestamp(selected, "source_reported_at", "last_updated");
    const latitude = Number(attrs.latitude);
    const longitude = Number(attrs.longitude);
    const accuracy = Number(attrs.gps_accuracy);
    const distanceHome = Number(attrs.canonical_distance_home_m);
    const distanceGate = Number(attrs.canonical_distance_gate_m);
    const state = selected?.state;
    const ready = validState(state) && fresh(observedAt, locationFreshMs);
    const home = Number.isFinite(distanceHome)
        ? distanceHome <= Number(policy.home_radius_m)
        : state === "home";
    const away = Number.isFinite(distanceHome)
        ? distanceHome > Number(policy.home_radius_m)
        : ["not_home", "near_home"].includes(state);
    const sourceReporting = [primary, fallback].some((entity) =>
        fresh(timestamp(entity, "source_reported_at", "last_updated"), reportFreshMs));
    const changedAt = Date.parse(selected?.last_changed ?? "");
    return {
        entity_id: selected?.entity_id,
        state,
        raw_state: String(attrs.raw_location_state ?? state ?? ""),
        latitude: Number.isFinite(latitude) ? latitude : null,
        longitude: Number.isFinite(longitude) ? longitude : null,
        gps_accuracy: Number.isFinite(accuracy) ? accuracy : null,
        location_reliable: Number.isFinite(latitude) && Number.isFinite(longitude),
        state_valid: ready,
        updated_at: observedAt,
        source_updated_at: reportedAt,
        source_stale: !fresh(reportedAt, reportFreshMs),
        any_source_reporting: sourceReporting,
        stale: !fresh(observedAt, locationFreshMs),
        ready,
        distance_m: Number.isFinite(distanceHome) ? distanceHome : null,
        gate_distance_m: Number.isFinite(distanceGate) ? distanceGate : null,
        current_home: ready ? home : null,
        primary_home: home,
        best_location_away: away,
        any_tracker_home: home,
        any_tracker_away: away,
        stationary_home: state === "home" && home && !away && sourceReporting,
        primary_home_for_ms: Number.isFinite(changedAt) ? Date.now() - changedAt : null
    };
}
const people = {
    resident_primary: position(msg.payload?.resident_primary_selected,
        msg.payload?.resident_primary, msg.payload?.resident_primary_icloud),
    resident_secondary: position(msg.payload?.resident_secondary_selected,
        msg.payload?.resident_secondary, msg.payload?.resident_secondary_icloud)
};
msg._people = {
    test_mode: TEST_MODE,
    policy,
    people,
    source: msg.payload?.source,
    trigger_state: msg.payload?.trigger_state,
    trigger_prev_state: msg.payload?.trigger_prev_state,
    trigger_raw_state: msg.payload?.trigger_raw_state,
    trigger_raw_prev_state: msg.payload?.trigger_raw_prev_state,
    refresh_cycle_id: msg.payload?.refresh_cycle_id,
    trigger_entity: msg.payload?.trigger_entity,
    is_location_event: msg.payload?.event === "location_update"
};
return msg;
