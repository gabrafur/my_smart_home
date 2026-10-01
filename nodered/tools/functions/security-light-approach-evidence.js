// Pure distance gate. Direction and freshness remain the canonical producer's responsibility.
function withinLightingApproach(resident, policy) {
    if (resident?.current_home === true && resident?.state === "home") return true;
    const radius = Number(policy.approach_radius_m);
    const distance = resident?.gate_distance_m;
    return Number.isFinite(radius) && radius > 0 && Number.isFinite(distance) &&
        distance >= 0 && distance <= radius;
}
