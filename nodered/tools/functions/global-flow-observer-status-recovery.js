const data = msg._observer_event;
if (data.shared_incident_key) {
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
