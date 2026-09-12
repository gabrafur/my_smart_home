const data = msg._vehicle;
if (!data) return null;
const key = data.test_mode
    ? "vehicle_primary_location_observation_v1__test"
    : "vehicle_primary_location_observation_v1";
const previous = data.test_mode ? flow.get(key) : flow.get(key, "persistent");
const validZone = (value) => typeof value === "string" &&
    !["", "unknown", "unavailable"].includes(value);
const zoneChanged = validZone(data.trigger_prev_state) &&
    data.trigger_state !== data.trigger_prev_state &&
    ["home", "not_home", "near_home"].includes(data.trigger_state);
const distance = (a, b) => {
    const rad = (value) => value * Math.PI / 180;
    const dLat = rad(b.latitude - a.latitude);
    const dLon = rad(b.longitude - a.longitude);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.latitude)) *
        Math.cos(rad(b.latitude)) * Math.sin(dLon / 2) ** 2;
    return 6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
};
const comparable = previous && Number.isFinite(previous.latitude) &&
    Number.isFinite(previous.longitude) && Number.isFinite(data.location.latitude) &&
    Number.isFinite(data.location.longitude);
const movementM = comparable ? distance(previous, data.location) : null;
const requiredM = Math.max(Number(data.policy.movement_threshold_m),
    Number(previous?.gps_accuracy || 0) + Number(data.location.gps_accuracy || 0));
const significant = Number.isFinite(movementM) && movementM >= requiredM &&
    Number(data.location.updated_at || 0) > Number(previous?.updated_at || 0);
data.fresh_movement = data.is_location_event && data.location.ready &&
    (zoneChanged || significant);
data.zone_changed = zoneChanged;
data.movement_distance_m = movementM;
if (data.is_location_event && data.location.location_reliable &&
    (!previous || zoneChanged || significant)) {
    const value = { version: 1, latitude: data.location.latitude,
        longitude: data.location.longitude, gps_accuracy: data.location.gps_accuracy,
        state: data.location.state, updated_at: data.location.updated_at };
    if (data.test_mode) flow.set(key, value); else flow.set(key, value, "persistent");
}
data.location_observation = data.test_mode ? flow.get(key) : flow.get(key, "persistent");
if (!data.test_mode && data.fresh_movement) {
    node.log?.("VEHICLE_PRIMARY_LOCATION_CHANGED kind=" + (zoneChanged ? "zone" : "distance"));
}
return msg;
