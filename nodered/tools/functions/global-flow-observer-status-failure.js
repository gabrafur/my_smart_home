const data = msg._observer_event;
const previous = data.state.status_sources[data.key];
if (data.shared_incident_key) {
    const event = data.state.connection_events[data.incident_key] ?? {};
    data.state.connection_events[data.incident_key] = { ...event, last_failure_at: data.now };
}
data.state.status_sources[data.key] = {
    flow_id: data.flow_id, flow_label: data.flow_label, source_id: data.source_id,
    source_type: data.source_type, source_name: data.source_name,
    incident_key: data.incident_key, incident_kind: data.incident_kind,
    status_text: String(msg.status?.text ?? ""),
    first_seen_at: previous?.incident_key === data.incident_key ? previous.first_seen_at : data.now,
    last_seen_at: data.now
};
if (data.store) flow.set(data.state_key, data.state, data.store);
else flow.set(data.state_key, data.state);
return null;
