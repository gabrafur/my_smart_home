const data = msg._people;
if (!data) return null;
const key = "people_notification_cycles_v1" + (data.test_mode ? "__test" : "");
const store = data.test_mode ? undefined : "persistent";
const saved = flow.get(key, store);
const state = saved?.version === 1 ? saved : { version: 1, residents: {} };
const radius = Number(data.policy.notification_approach_radius_m);
data.notification_candidates = [];
for (const [role, resident] of Object.entries(data.people)) {
const observedAt = resident?.updated_at;
const distance = resident?.distance_m;
let cycle = state.residents[role];
// Paired snapshots also carry new GPS positions without a zone transition.
// Only a newer canonical observation advances the saved position.
const current = resident?.ready === true &&
    resident.stale !== true && Number.isFinite(distance) &&
    Number.isFinite(observedAt) && observedAt > 0 &&
    observedAt <= Date.now() + data.policy.future_tolerance_seconds * 1000 &&
    Date.now() - observedAt <= data.policy.location_fresh_minutes * 60000;
if (current && Number.isFinite(radius) && (!cycle || observedAt > cycle.observed_at)) {
    if (!cycle || cycle.radius_m !== radius || cycle.completed && !resident.current_home) {
        cycle = { id: role + ":" + observedAt, radius_m: radius,
            outside: false, issued: false, completed: false };
    }
    const eligible = !cycle.issued && !cycle.completed && cycle.outside &&
        distance <= radius && distance < cycle.distance_m && !resident.current_home &&
        data.armed[role] === true;
    if (eligible) data.notification_candidates.push({ role, resident, cycle });
    if (distance > radius) cycle.outside = true;
    if (resident.current_home) cycle.completed = true;
    cycle.observed_at = observedAt;
    cycle.distance_m = distance;
    state.residents[role] = cycle;
}
}
// A 350 m lighting arrival cannot bypass the independent notification radius.
// Keep HOME confirmation for local trips and missed wider crossings.
// Once the early event exists, later events share its identity for delivery
// dedupe; lighting retains its original contract and independent radius.
data.notification = data.arrival ? { ...data.arrival, payload: { ...data.arrival.payload } } : null;
const cycle = state.residents[data.source];
if (data.notification?.payload.arrival_stage === "approach" && cycle?.outside !== true)
    data.notification = null;
if (cycle && data.notification?.payload) {
    data.notification.payload.notification_cycle_id = cycle.id;
}
data.notification_eligible = data.notification_candidates.length > 0;
data.notification_state = state;
data.notification_state_key = key;
flow.set(key, state, store);
return msg;
