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
        status_incidents: {}
    };
state.errors = state.errors ?? {};
state.status_sources = state.status_sources ?? {};
state.status_incidents = state.status_incidents ?? {};

const observer = msg._global_observer ?? {};
const flowId = String(observer.flow_id ?? "unknown").slice(0, 100);
const flowLabel = String(observer.flow_label ?? "fluxo desconhecido")
    .replace(/[\r\n]+/g, " ")
    .slice(0, 100);
const source = msg.error?.source ?? msg.status?.source ?? {};
const sourceId = String(source.id ?? "unknown").slice(0, 100);
const sourceType = String(source.type ?? "unknown").slice(0, 80);
const sourceName = String(source.name || sourceType || "nó desconhecido")
    .replace(/[\r\n]+/g, " ")
    .slice(0, 100);

function hash(value) {
    let result = 0x811c9dc5;
    for (const character of String(value)) {
        result ^= character.charCodeAt(0);
        result = Math.imul(result, 0x01000193) >>> 0;
    }
    return result.toString(16).padStart(8, "0");
}

function failureClass(value) {
    const text = String(value ?? "").toLowerCase();
    if (/(?:401|unauthori[sz]ed|authentic|credencial)/.test(text)) {
        return "autenticação";
    }
    if (/(?:timeout|timed out|tempo limite)/.test(text)) return "timeout";
    if (/(?:disconnect|offline|unavailable|indispon|sem conexão)/.test(text)) {
        return "indisponibilidade";
    }
    return "erro de execução";
}

if (msg.error) {
    const errorText = String(msg.error.message ?? "erro desconhecido");
    const classification = failureClass(errorText);
    const signature = hash(`${flowId}:${sourceId}:${classification}:${errorText}`);
    const key = `${flowId}:${sourceId}:${signature}`;
    const previous = state.errors[key] ?? {};
    const notificationDue =
        !Number.isFinite(previous.notified_at) ||
        now - previous.notified_at >= 6 * 60 * 60 * 1000;
    state.errors[key] = {
        flow_id: flowId,
        flow_label: flowLabel,
        source_id: sourceId,
        source_type: sourceType,
        source_name: sourceName,
        failure_class: classification,
        first_seen_at: previous.first_seen_at ?? now,
        last_seen_at: now,
        notified_at: notificationDue ? now : previous.notified_at
    };
    for (const [entryKey, entry] of Object.entries(state.errors)) {
        if (now - Number(entry.last_seen_at ?? now) > 7 * 24 * 60 * 60 * 1000) {
            delete state.errors[entryKey];
        }
    }
    setState(state);
    if (!notificationDue) return null;
    msg.payload = {
        test_mode: TEST_MODE,
        observer_kind: "node_error",
        flow_id: flowId,
        source_id: sourceId
    };
    msg.alert = {
        title: TEST_MODE
            ? "TESTE — Falha em fluxo Node-RED"
            : "Falha em fluxo Node-RED",
        message:
            `O fluxo “${flowLabel}” registrou ${classification} no nó ` +
            `“${sourceName}”. O mesmo erro será silenciado por 6 horas ` +
            "para evitar notificações repetidas."
    };
    return msg;
}

if (msg.status) {
    const text = String(msg.status.text ?? "").toLowerCase();
    const haTypes = new Set([
        "api-call-service",
        "api-current-state",
        "api-get-history",
        "api-render-template",
        "events-all",
        "ha-api",
        "poll-state",
        "server-events",
        "server-state-changed",
        "trigger-state"
    ]);
    const monitoredConnectionType =
        haTypes.has(sourceType) ||
        sourceType.startsWith("ha-") ||
        sourceType === "mqtt in" ||
        sourceType === "mqtt out" ||
        sourceType === "DuloNodeDevice" ||
        sourceType === "DuloNodeHub";
    if (!monitoredConnectionType) {
        delete state.status_sources[`${flowId}:${sourceId}`];
        setState(state);
        return null;
    }
    const sharedConnectionType =
        haTypes.has(sourceType) ||
        sourceType.startsWith("ha-") ||
        sourceType === "mqtt in" ||
        sourceType === "mqtt out";
    const connectionFailure =
        /(?:disconnect|not connected|connection (?:lost|error|failed|timed out)|offline|unavailable|indispon|sem conexão|desconect|connecting|conectando)/.test(text);
    const nodeFailure =
        connectionFailure ||
        msg.status.fill === "red" ||
        /(?:error|failed|failure|timed out|timeout|falhou)/.test(text);
    // HA nodes also use red status for domain conditions and rejected service
    // calls. Those failures are handled by catch and must not masquerade as a
    // shared Home Assistant outage.
    const failing = sharedConnectionType ? connectionFailure : nodeFailure;
    let incidentKey = `node:${flowId}:${sourceId}`;
    let incidentKind = "node_status";
    if (haTypes.has(sourceType) || sourceType.startsWith("ha-")) {
        incidentKey = "connection:home_assistant";
        incidentKind = "home_assistant";
    } else if (sourceType === "mqtt in" || sourceType === "mqtt out") {
        incidentKey = "connection:mqtt";
        incidentKind = "mqtt";
    }
    const key = `${flowId}:${sourceId}`;
    if (failing) {
        const previous = state.status_sources[key];
        state.status_sources[key] = {
            flow_id: flowId,
            flow_label: flowLabel,
            source_id: sourceId,
            source_type: sourceType,
            source_name: sourceName,
            incident_key: incidentKey,
            incident_kind: incidentKind,
            first_seen_at:
                previous?.incident_key === incidentKey
                    ? previous.first_seen_at
                    : now,
            last_seen_at: now
        };
    } else {
        delete state.status_sources[key];
    }
    setState(state);
}

return null;
