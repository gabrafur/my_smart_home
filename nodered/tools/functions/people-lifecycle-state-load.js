const data = msg._people;
if (!data) return null;
const key = (name) => data.test_mode ? name + "__test" : name;
const get = (name, store) => data.test_mode || !store
    ? flow.get(key(name)) : flow.get(key(name), store);
let recovery = get("security_people_recovery_v1", "persistent");
if (!recovery || typeof recovery !== "object" || Array.isArray(recovery) || recovery.version !== 1) {
    if (recovery !== undefined) node.warn("localizacao_pessoas: recovery inválido descartado");
    recovery = { version: 1, recent_arrivals: {} };
}
if (!recovery.recent_arrivals || typeof recovery.recent_arrivals !== "object" ||
    Array.isArray(recovery.recent_arrivals)) recovery.recent_arrivals = {};
const now = Date.now();
const futureMs = Number(data.policy.future_tolerance_seconds) * 1000;
const dedupeMs = Number(data.policy.arrival_dedupe_minutes) * 60000;
for (const [eventKey, at] of Object.entries(recovery.recent_arrivals)) {
    if (!Number.isFinite(at) || at > now + futureMs || now - at > dedupeMs) {
        delete recovery.recent_arrivals[eventKey];
    }
}
let armed = get("people_arrival_armed");
if (!armed || typeof armed !== "object" || Array.isArray(armed)) {
    armed = recovery.arrival_armed && typeof recovery.arrival_armed === "object"
        ? recovery.arrival_armed : {};
}
data.recovery = recovery;
data.armed = {
    resident_primary: armed.resident_primary === true,
    resident_secondary: armed.resident_secondary === true
};
const recoveredExternal = recovery.external_since &&
    typeof recovery.external_since === "object" &&
    !Array.isArray(recovery.external_since)
    ? recovery.external_since
    : {};
const validExternalAt = (value) => Number.isFinite(value) && value > 0 &&
    value <= now + futureMs;
data.external_since = {
    resident_primary: validExternalAt(Number(recoveredExternal.resident_primary))
        ? Number(recoveredExternal.resident_primary) : null,
    resident_secondary: validExternalAt(Number(recoveredExternal.resident_secondary))
        ? Number(recoveredExternal.resident_secondary) : null
};
const recoveredExcursions = recovery.local_excursions &&
    typeof recovery.local_excursions === "object" &&
    !Array.isArray(recovery.local_excursions)
    ? recovery.local_excursions : {};
const excursionMaxMs = Number(data.policy.local_excursion_minutes ?? 90) * 60000;
data.local_excursions = {};
for (const role of ["resident_primary", "resident_secondary"]) {
    const item = recoveredExcursions[role];
    const startedAt = Number(item?.started_at);
    const expiresAt = Number(item?.expires_at);
    if (Number.isFinite(startedAt) && startedAt > 0 &&
        startedAt <= now + futureMs && Number.isFinite(expiresAt) &&
        now <= expiresAt && expiresAt - startedAt <= excursionMaxMs + 1000) {
        data.local_excursions[role] = { started_at: startedAt, expires_at: expiresAt };
    }
}
data.home_arrival_candidates = {};
const recoveryMs = Number(data.policy.arrival_recovery_minutes) * 60000;
for (const role of ["resident_primary", "resident_secondary"]) {
    const item = recovery.home_arrival_candidates?.[role];
    if (Number.isFinite(item?.observed_at) && item.observed_at > 0 &&
        item.observed_at <= now + futureMs && Number.isFinite(item.expires_at) &&
        now <= item.expires_at && item.expires_at > item.observed_at &&
        item.expires_at - item.observed_at <= recoveryMs + 1000) {
        data.home_arrival_candidates[role] = { ...item };
    }
}
// Preserve the read version: sibling events can reach this node before either
// has committed its lifecycle at the finalizer.
data.state_baseline = JSON.parse(JSON.stringify({
    arrival_armed: data.armed,
    external_since: data.external_since,
    home_arrival_candidates: data.home_arrival_candidates,
    local_excursions: data.local_excursions
}));
return msg;
