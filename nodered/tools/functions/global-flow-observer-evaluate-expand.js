const testMode = msg._global_observer_test === true || msg.payload?.test_mode === true;
const stateKey = testMode ? "global_flow_observer_v1__test" : "global_flow_observer_v1";
const store = testMode ? undefined : "persistent";
const getState = () => store ? flow.get(stateKey, store) : flow.get(stateKey);
const setState = (value) => store ? flow.set(stateKey, value, store) : flow.set(stateKey, value);
const policy = flow.get("global_observer_policy_v1", "persistent");
if (policy?.version !== 1 || policy?.complete !== true) {
    node.status({ fill: "yellow", shape: "ring", text: "aguardando política visual" });
    return null;
}
const now = Number(msg.observer_now ?? Date.now());
const previousState = getState();
const state = previousState?.version === 2 ? previousState : {
    version: 2, errors: previousState?.errors ?? {}, status_sources: {},
    status_incidents: {}, connection_events: {}
};
state.errors ??= {};
state.status_sources ??= {};
state.status_incidents ??= {};
state.connection_events ??= {};

const grouped = new Map();
for (const source of Object.values(state.status_sources)) {
    const key = source.incident_key;
    const current = grouped.get(key) ?? {
        kind: source.incident_kind,
        first_seen_at: Number(source.first_seen_at ?? now),
        sources: []
    };
    current.first_seen_at = Math.min(current.first_seen_at, Number(source.first_seen_at ?? now));
    current.sources.push(source);
    grouped.set(key, current);
}
for (const key of Object.keys(state.status_incidents)) {
    if (!grouped.has(key)) grouped.set(key, { kind: "stale", first_seen_at: now, sources: [] });
}
setState(state);

const evaluation = [];
for (const [key, incident] of grouped) {
    const active = incident.sources.length > 0;
    const corroborated = active && (incident.kind !== "home_assistant" ||
        incident.sources.length >= Number(policy.ha_corroboration_sources));
    const durationMet = active && now - incident.first_seen_at >=
        Number(policy.status_confirm_seconds) * 1000;
    evaluation.push({
        _global_observer_test: testMode,
        observer_now: now,
        _observer_evaluation: {
            test_mode: testMode, state_key: stateKey, store, policy, key,
            kind: incident.kind, first_seen_at: incident.first_seen_at,
            sources: incident.sources, active, corroborated, duration_met: durationMet
        }
    });
}
return [evaluation.length ? evaluation : null];
