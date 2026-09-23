const value = msg.observer_policy_candidate;
if (value?.version !== 1 || value?.complete !== true) return null;
flow.set("global_observer_policy_v1", value, "persistent");
// Remove only legacy HA entity-value evidence; retain actual connection failures.
const state = flow.get("global_flow_observer_v1", "persistent");
if (state?.version === 2 && state.status_sources) {
    for (const [key, source] of Object.entries(state.status_sources)) {
        if (source.incident_key === "connection:home_assistant" &&
            /^(?:offline|unavailable)\s*:/i.test(String(source.status_text))) {
            delete state.status_sources[key];
        }
    }
    flow.set("global_flow_observer_v1", state, "persistent");
}
msg.payload = { kind: "global_observer_policy", ...value };
return msg;
