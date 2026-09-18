if (msg._location_test === true || msg.payload?.test_mode === true) {
    return null;
}
const policy = msg._location_policy ?? {};
const outputs = [];
for (const role of ["resident_primary", "resident_secondary"]) {
    const decision = msg._canonical_locations?.[role];
    const selected = decision?.selected;
    if (!selected) continue;
    const current = selected.fresh === true && selected.state_valid === true;
    const publishedState = current ? selected.state : "unavailable";
    const locationSources = (decision.candidates ?? []).map((candidate) => ({
        name: candidate.label,
        last_updated: candidate.reported_at === null
            ? null
            : new Date(candidate.reported_at).toISOString(),
        location_observed_at: candidate.observed_at === null
            ? null
            : new Date(candidate.observed_at).toISOString(),
        position_fresh: candidate.fresh === true,
        reporting_fresh: candidate.reporting_fresh === true,
        reliable_coordinates: candidate.reliable_coordinates === true,
        gps_accuracy: candidate.accuracy
    }));
    const payload = {
        state: publishedState,
        raw_location_state: selected.raw_state ?? selected.state,
        selected_location_source: selected.label,
        location_sources: locationSources,
        binding_role: role,
        decision_owner: "node_red",
        selection_policy_version: 1,
        selection_reason: decision.reason,
        location_observed_at: selected.observed_at === null
            ? null
            : new Date(selected.observed_at).toISOString(),
        source_reported_at: selected.reported_at === null
            ? null
            : new Date(selected.reported_at).toISOString(),
        home_radius_m: Number(policy.home_radius_m),
        near_home_radius_m: Number(policy.near_home_radius_m),
        location_fresh_minutes: Number(policy.location_fresh_minutes),
        source_report_fresh_minutes:
            Number(policy.source_report_fresh_minutes),
        location_fresh: current
    };
    if (
        current &&
        selected.reliable_coordinates === true &&
        Number.isFinite(selected.latitude) &&
        Number.isFinite(selected.longitude)
    ) {
        payload.latitude = selected.latitude;
        payload.longitude = selected.longitude;
        if (Number.isFinite(selected.accuracy)) {
            payload.gps_accuracy = selected.accuracy;
        }
        payload.source_type = "gps";
    }
    const baseTopic = "smart_home/location/" + role;
    outputs.push({
        topic: baseTopic + "/state",
        payload: publishedState,
        qos: "1",
        retain: true
    });
    outputs.push({
        topic: baseTopic + "/attributes",
        payload: JSON.stringify(payload),
        qos: "1",
        retain: true
    });
}
return [outputs];
