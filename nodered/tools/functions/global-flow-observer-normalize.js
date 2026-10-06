const testMode = msg._global_observer_test === true||msg.payload?.test_mode === true;
const stateKey = testMode ? "global_flow_observer_v1__test" : "global_flow_observer_v1";
const store = testMode?undefined:"persistent";
const getState = () => store?flow.get(stateKey,store):flow.get(stateKey);
const policy = flow.get("global_observer_policy_v1","persistent");
if (policy?.version !== 1 || policy?.complete !== true) {
    node.status({ fill: "yellow", shape: "ring", text: "aguardando política visual" });
    return null;
}
const previousState = getState();
const state = previousState?.version === 2 ? previousState : { version: 2,
    errors: previousState?.errors ?? {}, status_sources: {}, status_incidents: {}, connection_events: {} };
state.errors ??= {};
state.status_sources ??= {};
state.status_incidents ??= {};
state.connection_events ??= {};
const now=Number(msg.observer_now??Date.now());
const bootKey = "global_observer_boot_at" + (testMode ? "__test" : "");
let bootAt = flow.get(bootKey, "memoryOnly");
if (!Number.isFinite(bootAt)) { bootAt = now; flow.set(bootKey, bootAt, "memoryOnly"); }
const readiness = typeof global !== "undefined" && typeof global.get === "function"
    ? global.get("startup_readiness_v1", "memoryOnly") : null;
const startupGrace = readiness?.ready === false ||
    now - bootAt < Number(policy.connection_recovery_grace_seconds) * 1000;
const observer=msg._global_observer??{};
const flowId=String(observer.flow_id??"unknown").slice(0,100);
const flowLabel = String(observer.flow_label ?? "fluxo desconhecido").replace(/[\r\n]+/g, " ").slice(0, 100);
const source = msg.error?.source ?? msg.status?.source ?? {};
const sourceId = String(source.id??"unknown").slice(0,100);
const sourceType = String(source.type??"unknown").slice(0,80);
const sourceName = String(source.name || sourceType || "nó desconhecido").replace(/[\r\n]+/g, " ").slice(0,100);
const haTypes = new Set(["api-call-service", "api-current-state", "api-get-history", "api-render-template",
    "events-all", "ha-api", "poll-state", "server-events", "server-state-changed", "trigger-state"]);
const haSource = haTypes.has(sourceType) || sourceType.startsWith("ha-");
const duloSource = sourceType === "DuloNodeDevice" || sourceType === "DuloNodeHub";
const internetState = String(readiness?.internet_state ?? "unknown").toLowerCase();
// Generated notification link callers depend on HA but do not report its status.
const haNotificationCaller = sourceType === "link call" && sourceId.endsWith("__hub_call") &&
    typeof msg.notification?.source === "string" && msg._notification_hub_context !== undefined;
const mqttSource = ["mqtt in", "mqtt out"].includes(sourceType);
const sharedIncidentKey = haSource || haNotificationCaller ? "connection:home_assistant" : mqttSource ? "connection:mqtt" : null;
const hash = (value) => {
    let result = 0x811c9dc5;
    for (const character of String(value)) {
        result ^= character.charCodeAt(0);
        result = Math.imul(result, 0x01000193) >>> 0;
    }
    return result.toString(16).padStart(8, "0");
};
const classify = (value) => {
    const text = String(value ?? "").toLowerCase();
    if (/(?:401|unauthori[sz]ed|authentic|credencial)/.test(text)) return "autenticação";
    if (/(?:timeout|timed out|tempo limite)/.test(text)) return "timeout";
    if (/(?:disconnect|offline|unavailable|indispon|sem conexão)/.test(text)) return "indisponibilidade";
    return "erro de execução";
};
const data = { test_mode: testMode, state_key: stateKey, store, policy, state, now,
    flow_id: flowId, flow_label: flowLabel, source_id: sourceId,
    source_type: sourceType, source_name: sourceName, shared_incident_key: sharedIncidentKey };
if (msg.error) {
    const errorText = String(msg.error.message ?? "erro desconhecido");
    const classification = classify(errorText);
    const connectionEvent = sharedIncidentKey ? state.connection_events[sharedIncidentKey] ?? {} : {};
    const lastTransitionAt = Math.max(Number(connectionEvent.last_failure_at ?? -Infinity), Number(connectionEvent.last_recovered_at ?? -Infinity));
    const sharedActive = sharedIncidentKey !== null && Object.values(state.status_sources).some((entry) => entry.incident_key === sharedIncidentKey);
    const graceMs = Number(policy.connection_recovery_grace_seconds) * 1000;
    const signature = hash(`${flowId}:${sourceId}:${classification}:${errorText}`);
    const key = `${flowId}:${sourceId}:${signature}`;
    const previous = state.errors[key] ?? {};
    // Consume the location coordinator's decision; do not duplicate its limits.
    const transportRetryPending = flowId === "ea0a6aa0d24ff863" &&
        ["people_visual_primary_icloud_update", "people_visual_secondary_icloud_update"].includes(sourceId) &&
        sourceType === "api-call-service" &&
        /^(?:HomeAssistantError: )?ICLOUD_TRANSPORT_INTERRUPTED$/.test(errorText) &&
        msg.payload?.refresh_transport_retry_pending === true;
    Object.assign(data, { kind: "error", error_text: errorText, classification, signature, key, previous,
        transport_retry_pending: transportRetryPending,
        accepted_wake_pending: flowId === "c22d8b12055e87f7" && sourceId === "8907830bb7f6c40c" &&
            /Bluelink wake accepted but fresh data is pending/i.test(errorText),
        connection_suppressed: Boolean(sharedIncidentKey && classification !== "autenticação" && (startupGrace || sharedActive || (Number.isFinite(lastTransitionAt) && now >= lastTransitionAt && now - lastTransitionAt <= graceMs))) });
    data.expected_pending = data.accepted_wake_pending || transportRetryPending;
    // A call can fail before the websocket status event reaches this observer.
    // Parse the transport envelope; domain/service errors cannot prove HA down.
    let disconnected = /^(?:Error: )?(?:NoConnectionError|Connection lost)$/i.test(errorText);
    const envelope = errorText.match(/^(?:Error: )?Unrecognized error: (\{.*\})$/);
    if (envelope) {
        try {
            const result = JSON.parse(envelope[1]);
            disconnected = result.type === "result" && result.success === false &&
                result.error?.code === 3 && result.error?.message === "Connection lost";
        } catch { /* Unknown errors stay on the ordinary error path. */ }
    }
    if (haSource && disconnected) {
        Object.assign(data, { kind: "status", monitored: true, failing: true,
            incident_key: "connection:home_assistant", incident_kind: "home_assistant",
            status_text: "connection lost", key: `${flowId}:${sourceId}` });
    }
} else if (msg.status) {
    const text = String(msg.status.text ?? "").toLowerCase();
    const shared = haSource || mqttSource;
    // HA entity values carry timestamps and may themselves be offline/unavailable.
    // Only the connection status contract can open a shared incident.
    const connectionFailure = haSource
        ? /^(?:home-assistant\.status\.(?:disconnected|error)|disconnected|not connected|connection (?:lost|error|failed|timed out)|sem conexão|desconectado)(?:$|: )/.test(text)
        : /^(?:disconnected|not connected|connection (?:lost|error|failed|timed out)|offline|unavailable|indisponível|sem conexão|desconectado)(?:$|: )/.test(text);
    const nodeFailure = connectionFailure || msg.status.fill === "red" ||
        /(?:error|failed|failure|timed out|timeout|falhou)/.test(text);
    Object.assign(data, { kind: "status", monitored: shared || (duloSource && internetState === "online"),
        failing: shared ? connectionFailure : nodeFailure,
        incident_key: haSource ? "connection:home_assistant" : mqttSource ? "connection:mqtt" : `node:${flowId}:${sourceId}`,
        incident_kind: haSource ? "home_assistant" : mqttSource ? "mqtt" : "node_status",
        key: `${flowId}:${sourceId}` });
} else data.kind = "unknown";
msg._observer_event = data;
return msg;
