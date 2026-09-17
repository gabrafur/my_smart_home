const data = msg._people;
if (!data?.facts?.wake_ring_entry || !data.facts.external_cycle_confirmed) {
    return [null, null];
}
const firstDelay = Number(data.policy.wake_ring_refresh_delay_seconds ?? 45) * 1000;
const repeatDelay = Number(data.policy.wake_ring_refresh_repeat_seconds ?? 60) * 1000;
const base = {
    contract: "security.location-refresh.v1",
    kind: "arrival_location_refresh",
    reason: "wake_ring_approach_probe",
    source: data.source,
    test_mode: data.test_mode,
    simulated: data.test_mode,
    dispatched: false,
    trigger_observed_at: data.people?.[data.source]?.updated_at ?? null
};
const request = (probe, delayMs) => ({
    ...msg,
    delay: data.test_mode ? 1 : delayMs,
    payload: { ...base, refresh_probe: probe }
});
return [request(1, firstDelay), request(2, firstDelay + repeatDelay)];
