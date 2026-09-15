const data = msg._observer_evaluation;
const getState = () => data.store ? flow.get(data.state_key, data.store) : flow.get(data.state_key);
const state = getState();
if (state?.version !== 2) return null;
state.status_incidents ??= {};
const previous = state.status_incidents[data.key];
delete state.status_incidents[data.key];
if (data.store) flow.set(data.state_key, state, data.store);
else flow.set(data.state_key, state);
if (!Number.isFinite(previous?.notified_at)) return null;

msg.payload = {
    test_mode: data.test_mode,
    observer_kind: "node_recovery",
    persistent_incident_kind: "node_unavailable",
    persistent_notification_operation: "dismiss",
    mobile_notification: false,
    incident_key: data.key,
    resolution: data.active ? "corroboration_lost" : "recovered"
};
msg.alert = {
    title: data.test_mode
        ? "TESTE — Incidente do Node-RED encerrado"
        : "Incidente do Node-RED encerrado",
    message: "A condição de indisponibilidade não está mais ativa."
};
return msg;
