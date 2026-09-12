const data = msg._vehicle;
if (!data) return null;
const key = (name) => data.test_mode ? name + "__test" : name;
const get = (name, store) => data.test_mode || !store
    ? flow.get(key(name)) : flow.get(key(name), store);
let recovery = get("security_vehicle_primary_recovery_v1", "persistent");
const futureMs = Number(data.policy.future_tolerance_seconds) * 1000;
const recoveryMs = Number(data.policy.vehicle_recovery_hours) * 3600000;
const confirmedAt = Number(recovery?.last_confirmed_at ?? 0);
const valid = recovery && typeof recovery === "object" && !Array.isArray(recovery) &&
    recovery.version === 1 &&
    (recovery.in_use === undefined || typeof recovery.in_use === "boolean") &&
    (recovery.in_use === undefined || (Number.isFinite(confirmedAt) && confirmedAt > 0 &&
        confirmedAt <= Date.now() + futureMs && Date.now() - confirmedAt <= recoveryMs));
if (!valid) {
    if (recovery !== undefined) node.warn("contexto_vehicle_primary: recovery inválido ou expirado descartado");
    recovery = { version: 1 };
}
if (typeof recovery.trip_active !== "boolean") recovery.trip_active = false;
if (recovery.in_use !== true) {
    recovery.trip_active = false;
    recovery.trip_started_at = null;
}
if (typeof recovery.arrival_armed !== "boolean") recovery.arrival_armed = false;
if (recovery.trip_started_at != null && (!Number.isFinite(recovery.trip_started_at) ||
    recovery.trip_started_at > Date.now() + futureMs)) recovery.trip_started_at = null;
data.recovery = recovery;
const armed = get("vehicle_primary_arrival_armed");
data.armed = typeof armed === "boolean" ? armed : recovery.arrival_armed === true;
data.in_use = null;
data.in_use_reason = "insufficient_current_evidence";
return msg;
