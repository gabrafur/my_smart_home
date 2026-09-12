const data = msg._observer_event;
const previous = data.state.status_sources[data.key];
if (data.shared_incident_key && previous?.incident_key === data.incident_key) {
    const event = data.state.connection_events[data.incident_key] ?? {};
    data.state.connection_events[data.incident_key] = { ...event, last_recovered_at: data.now };
}
delete data.state.status_sources[data.key];
if (data.store) flow.set(data.state_key, data.state, data.store);
else flow.set(data.state_key, data.state);
return null;
