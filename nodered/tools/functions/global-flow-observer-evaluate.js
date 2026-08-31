const TEST_MODE =
    msg._global_observer_test === true ||
    msg.payload?.test_mode === true;
const STATE_KEY = TEST_MODE
    ? "global_flow_observer_v1__test"
    : "global_flow_observer_v1";
const STORE = TEST_MODE ? undefined : "persistent";
const now = Number(msg.observer_now ?? Date.now());
const getState = () => STORE
    ? flow.get(STATE_KEY, STORE)
    : flow.get(STATE_KEY);
const setState = (value) => STORE
    ? flow.set(STATE_KEY, value, STORE)
    : flow.set(STATE_KEY, value);
const previousState = getState();
const state = previousState?.version === 2
    ? previousState
    : {
        version: 2,
        errors: previousState?.errors ?? {},
        status_sources: {},
        status_incidents: {},
        connection_events: {}
    };
state.status_sources = state.status_sources ?? {};
state.status_incidents = state.status_incidents ?? {};
state.connection_events = state.connection_events ?? {};

const grouped = new Map();
for (const source of Object.values(state.status_sources)) {
    const key = source.incident_key;
    const current = grouped.get(key) ?? {
        kind: source.incident_kind,
        first_seen_at: Number(source.first_seen_at ?? now),
        sources: []
    };
    current.first_seen_at = Math.min(
        current.first_seen_at,
        Number(source.first_seen_at ?? now)
    );
    current.sources.push(source);
    grouped.set(key, current);
}

const alerts = [];
const confirmedIncidentKeys = new Set();
for (const [key, incident] of grouped) {
    // A single HA node can retain a connection-like status when only its
    // entity/domain is unavailable. A real shared HA outage is observed by
    // many nodes, so require independent corroboration before alerting.
    if (incident.kind === "home_assistant" && incident.sources.length < 2) {
        continue;
    }
    if (now - incident.first_seen_at < 60 * 1000) continue;
    confirmedIncidentKeys.add(key);
    const previous = state.status_incidents[key] ?? {};
    const notificationDue =
        !Number.isFinite(previous.notified_at) ||
        now - previous.notified_at >= 6 * 60 * 60 * 1000;
    state.status_incidents[key] = {
        kind: incident.kind,
        first_seen_at: previous.first_seen_at ?? incident.first_seen_at,
        last_seen_at: now,
        notified_at: notificationDue ? now : previous.notified_at
    };
    if (!notificationDue) continue;

    const first = incident.sources[0];
    let title = "Nó Node-RED indisponível";
    let message =
        `O nó “${first.source_name}” do fluxo “${first.flow_label}” ` +
        "permanece em estado de falha há pelo menos 1 minuto.";
    if (incident.kind === "home_assistant") {
        title = "Node-RED sem Home Assistant";
        message =
            "Os fluxos perderam a conexão com o Home Assistant por pelo " +
            "menos 1 minuto. As chamadas configuradas com fila serão " +
            "retomadas e este push será entregue quando a conexão voltar.";
    } else if (incident.kind === "mqtt") {
        title = "Node-RED sem MQTT";
        message =
            "Os fluxos perderam a conexão com o broker MQTT por pelo menos " +
            "1 minuto. Verifique o Mosquitto e a rede local.";
    }
    alerts.push({
        _global_observer_test: TEST_MODE,
        payload: {
            test_mode: TEST_MODE,
            observer_kind: "node_unavailable",
            incident_key: key
        },
        alert: {
            title: TEST_MODE ? `TESTE — ${title}` : title,
            message
        }
    });
}

for (const key of Object.keys(state.status_incidents)) {
    if (!confirmedIncidentKeys.has(key)) delete state.status_incidents[key];
}
setState(state);
return [alerts.length ? alerts : null];
