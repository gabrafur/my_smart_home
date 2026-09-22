const data = msg._observer_event;
if (data.shared_incident_key) {
    // A value/status update is not proof that the shared connection recovered.
    const text = String(msg.status?.text || "").toLowerCase();
    const haConnectionRestored = data.incident_kind === "home_assistant" &&
        /^home-assistant\.status\.(?:connected|running)$/.test(text);
    if (!haConnectionRestored && !/^(?:connected|online|conectado)(?:$|\s+to\b)/.test(text)) {
        if (data.store) flow.set(data.state_key, data.state, data.store);
        else flow.set(data.state_key, data.state);
        return null;
    }
    const sharedRecovered = Object.values(data.state.status_sources)
        .some((entry) => entry.incident_key === data.incident_key);
    if (sharedRecovered) {
        const event = data.state.connection_events[data.incident_key] ?? {};
        data.state.connection_events[data.incident_key] = {
            ...event,
            last_recovered_at: data.now
        };
    }
    for (const [key, entry] of Object.entries(data.state.status_sources)) {
        if (entry.incident_key === data.incident_key) {
            delete data.state.status_sources[key];
        }
    }
} else {
    delete data.state.status_sources[data.key];
}
if (data.store) flow.set(data.state_key, data.state, data.store);
else flow.set(data.state_key, data.state);
return null;
