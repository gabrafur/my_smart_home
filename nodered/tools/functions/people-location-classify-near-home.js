if (msg._location_test === true || msg.payload?.test_mode === true) return msg;

const policy = msg._location_policy ?? global.get("location_policy_v1", "persistent");
const homeRadius = Number(policy?.home_radius_m);
const nearRadius = Number(policy?.near_home_radius_m);
if (policy?.version !== 1 || policy?.complete !== true ||
    !Number.isFinite(homeRadius) || !Number.isFinite(nearRadius)) {
    node.error("Raios canônicos de localização ausentes", msg);
    return null;
}
const homeLat = Number(env.get("HOME_LAT"));
const homeLon = Number(env.get("HOME_LON"));
const gateLat = Number(env.get("GATE_LAT"));
const gateLon = Number(env.get("GATE_LON"));
const known = (lat, lon) => Number.isFinite(lat) && Number.isFinite(lon);
const RING = "location_update_ring";
const KEY = "canonical_near_home_people_v1";
const previous = flow.get(KEY, "persistent") ?? {};
const next = { ...previous };
const rawFallback = (value) => {
    const state = String(value ?? "");
    if (["unknown", "unavailable", "home", "near_home", RING].includes(state)) return state;
    return "not_home";
};
const distance = (a, b, c, d) => {
    const rad = (value) => value * Math.PI / 180;
    const lat = rad(c - a);
    const lon = rad(d - b);
    const h = Math.sin(lat / 2) ** 2 + Math.cos(rad(a)) *
        Math.cos(rad(c)) * Math.sin(lon / 2) ** 2;
    return Math.round(6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h)));
};
function classify(candidate) {
    if (!candidate) return null;
    const rawState = String(candidate.state ?? "unknown");
    const coordinates = candidate.reliable_coordinates === true &&
        Number.isFinite(candidate.latitude) && Number.isFinite(candidate.longitude);
    const homeDistance = coordinates && known(homeLat, homeLon)
        ? distance(homeLat, homeLon, candidate.latitude, candidate.longitude) : null;
    const gateDistance = coordinates && known(gateLat, gateLon)
        ? distance(gateLat, gateLon, candidate.latitude, candidate.longitude) : null;
    const nearest = [homeDistance, gateDistance].filter(Number.isFinite);
    let state = rawFallback(rawState);
    if (homeDistance !== null && homeDistance <= homeRadius) state = "home";
    else if (nearest.length && Math.min(...nearest) <= nearRadius) state = "near_home";
    else if (["home", "near_home", RING].includes(rawState)) state = "not_home";
    return {
        ...candidate,
        raw_state: rawState,
        state,
        distance_home_m: homeDistance,
        distance_gate_m: gateDistance,
        entity: {
            ...candidate.entity,
            state,
            attributes: {
                ...(candidate.entity?.attributes ?? {}),
                raw_location_state: rawState,
                canonical_distance_home_m: homeDistance,
                canonical_distance_gate_m: gateDistance,
                home_radius_m: homeRadius,
                near_home_radius_m: nearRadius,
                decision_owner: "node_red"
            }
        }
    };
}

const changedRoles = [];
for (const role of ["resident_primary", "resident_secondary"]) {
    const decision = msg._canonical_locations?.[role];
    if (!decision) continue;
    const selected = classify(decision.selected);
    const prior = previous[role] ?? {};
    const previousState = prior.state ?? rawFallback(decision.previous_state);
    const previousRawState = prior.raw_state ?? String(decision.previous_state ?? "");
    const stateChanged = Boolean(prior.state && selected?.state !== prior.state);
    const rawStateChanged = Boolean(prior.raw_state && selected?.raw_state !== prior.raw_state);
    if (stateChanged) changedRoles.push(role);
    Object.assign(decision, {
        selected,
        previous_state: previousState,
        canonical_state_changed: stateChanged,
        raw_state_changed: rawStateChanged
    });
    msg.payload[role + "_selected"] = selected?.entity ?? null;
    next[role] = {
        state: selected?.state ?? null,
        raw_state: selected?.raw_state ?? null,
        observed_at: selected?.observed_at ?? null,
        updated_at: Date.now()
    };
    if (msg.payload?.source === role && selected) {
        Object.assign(msg.payload, {
            trigger_prev_state: previousState,
            trigger_state: selected.state,
            trigger_raw_prev_state: previousRawState,
            trigger_raw_state: selected.raw_state,
            trigger_entity: "device_tracker." + role + "_location"
        });
        if (selected.state === previousState && !rawStateChanged) {
            msg.payload.event = "context_update";
        }
    }
}
if (msg.payload?.event === "context_snapshot" && changedRoles.length === 1) {
    const role = changedRoles[0];
    const selected = msg._canonical_locations?.[role]?.selected;
    Object.assign(msg.payload, {
        event: "location_update",
        source: role,
        trigger_prev_state: previous[role].state,
        trigger_state: selected.state,
        trigger_raw_prev_state: previous[role].raw_state,
        trigger_raw_state: selected.raw_state,
        trigger_entity: "device_tracker." + role + "_location"
    });
}
flow.set(KEY, next, "persistent");
const selected = msg._canonical_locations?.[msg.payload?.source]?.selected;
node.status({
    fill: selected?.state === "near_home" ? "blue" : "green",
    shape: selected ? "dot" : "ring",
    text: selected ? msg.payload.source + ": " + selected.state +
        " (home " + homeRadius + " / near_home " + nearRadius + " m)" :
        "snapshot canônico atualizado"
});
return msg;
