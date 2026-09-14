const TEST_MODE =
    msg._global_observer_test === true ||
    msg._global_observer_integration_test === true ||
    msg.payload?.test_mode === true;
const STORE = TEST_MODE ? undefined : "persistent";
const STATE_KEY = TEST_MODE
    ? "global_flow_observer_integrations_v1__test"
    : "global_flow_observer_integrations_v1";
const getState = () => STORE
    ? flow.get(STATE_KEY, STORE)
    : flow.get(STATE_KEY);
const setState = (value) => STORE
    ? flow.set(STATE_KEY, value, STORE)
    : flow.set(STATE_KEY, value);

if (msg._global_observer_integration_reset === true) {
    if (!TEST_MODE) {
        node.error("INTEGRATION_MONITOR_RESET_REFUSED production_state", msg);
        return null;
    }
    setState({ version: 1, incidents: {}, last_scan_at: null });
    node.status({ fill: "blue", shape: "dot", text: "TESTE integrações resetado" });
    return null;
}

const policy = flow.get("global_observer_policy_v1", "persistent");
if (policy?.version !== 1 || policy?.complete !== true) {
    node.status({ fill: "yellow", shape: "ring", text: "aguardando política visual" });
    return null;
}

const snapshot = msg._integration_monitor_snapshot;
if (snapshot?.version !== 1 || !Array.isArray(snapshot.entries)) {
    node.error("INTEGRATION_MONITOR_INVALID_NORMALIZED_SNAPSHOT", msg);
    return null;
}

const suppliedNow = Number(msg.observer_now);
const now = Number.isFinite(suppliedNow) && suppliedNow > 0
    ? suppliedNow
    : Date.now();
const confirmMs = Number(policy.status_confirm_seconds) * 1000;
const reminderMs = Number(policy.reminder_hours) * 60 * 60 * 1000;
if (
    !Number.isFinite(confirmMs) || confirmMs < 10000 ||
    !Number.isFinite(reminderMs) || reminderMs < 60 * 60 * 1000
) {
    node.error("INTEGRATION_MONITOR_INVALID_POLICY", msg);
    return null;
}

const failureStates = new Set([
    "setup_error",
    "setup_retry",
    "migration_error",
    "failed_unload"
]);
const current = new Map(
    snapshot.entries.map((entry) => [entry.entry_id, entry])
);
const previous = getState();
const state = previous?.version === 1
    ? previous
    : { version: 1, incidents: {}, last_scan_at: null };
if (!state.incidents || typeof state.incidents !== "object") {
    state.incidents = {};
}

const formatInteger = new Intl.NumberFormat("pt-BR", {
    maximumFractionDigits: 0
});
const safeIncident = (entryId) =>
    `config_entry_${entryId}`.replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 120);
const knownDomainLabels = {
    hacs: "HACS",
    homekit: "HomeKit",
    icloud: "iCloud",
    mqtt: "MQTT",
    tuya: "Tuya"
};
const domainLabel = (domain) => knownDomainLabels[domain] ?? domain
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
const output = [];

const recoveryMessage = (incident, resolution, mobileNotification) => ({
    _global_observer_test: TEST_MODE,
    _global_observer_integration_test: TEST_MODE,
    payload: {
        test_mode: TEST_MODE,
        observer_kind: "integration_recovery",
        incident_key: safeIncident(incident.entry_id),
        integration_domain: incident.domain,
        persistent_incident_kind: "integration_failure",
        persistent_notification_operation: "dismiss",
        mobile_notification: mobileNotification,
        resolution
    },
    alert: {
        title: TEST_MODE
            ? `TESTE — Integração ${domainLabel(incident.domain)} recuperada`
            : `Integração ${domainLabel(incident.domain)} recuperada`,
        message:
            `A integração ${domainLabel(incident.domain)} voltou ao estado loaded. ` +
            "O incidente anterior foi encerrado."
    }
});

for (const entry of snapshot.entries) {
    const incident = state.incidents[entry.entry_id];

    if (entry.disabled) {
        if (incident?.notified_at) {
            output.push(recoveryMessage(incident, "disabled", false));
        }
        delete state.incidents[entry.entry_id];
        continue;
    }

    if (failureStates.has(entry.state)) {
        const active = incident ?? {
            entry_id: entry.entry_id,
            domain: entry.domain,
            first_seen_at: now,
            notified_at: null
        };
        active.domain = entry.domain;
        active.state = entry.state;
        active.last_seen_at = now;
        state.incidents[entry.entry_id] = active;

        const confirmed = now - Number(active.first_seen_at) >= confirmMs;
        const reminderDue =
            active.notified_at === null ||
            now - Number(active.notified_at) >= reminderMs;
        if (!confirmed || !reminderDue) continue;

        const durationMinutes = Math.max(
            1,
            Math.round((now - Number(active.first_seen_at)) / 60000)
        );
        const reminder = active.notified_at !== null;
        active.notified_at = now;
        const failureTitle = reminder
            ? `Falha persiste na integração ${domainLabel(entry.domain)}`
            : `Falha na integração ${domainLabel(entry.domain)}`;
        output.push({
            _global_observer_test: TEST_MODE,
            _global_observer_integration_test: TEST_MODE,
            payload: {
                test_mode: TEST_MODE,
                observer_kind: "integration_failure",
                incident_key: safeIncident(entry.entry_id),
                integration_domain: entry.domain,
                integration_state: entry.state,
                persistent_notification_operation: "create",
                mobile_notification: true
            },
            alert: {
                title: TEST_MODE
                    ? `TESTE — ${failureTitle}`
                    : failureTitle,
                message:
                    `A integração ${domainLabel(entry.domain)} permanece em ` +
                    `${entry.state} há ${formatInteger.format(durationMinutes)} min. ` +
                    "Abra Configurações → Dispositivos e serviços no Home Assistant " +
                    "para consultar ou reautenticar a entrada."
            }
        });
        node.warn(
            "HOME_ASSISTANT_INTEGRATION_FAILURE " +
            `domain=${entry.domain} state=${entry.state} reminder=${reminder}`
        );
        continue;
    }

    if (entry.state === "loaded") {
        if (incident?.notified_at) {
            output.push(recoveryMessage(incident, "loaded", true));
            node.log(
                "HOME_ASSISTANT_INTEGRATION_RECOVERED " +
                `domain=${incident.domain}`
            );
        }
        delete state.incidents[entry.entry_id];
    } else if (incident) {
        incident.last_seen_at = now;
        incident.transition_state = entry.state;
    }
}

for (const [entryId, incident] of Object.entries(state.incidents)) {
    if (current.has(entryId)) continue;
    if (incident.notified_at) {
        output.push(recoveryMessage(incident, "removed", false));
    }
    delete state.incidents[entryId];
}

const activeEntries = snapshot.entries.filter((entry) => !entry.disabled).length;
const failingEntries = snapshot.entries.filter(
    (entry) => !entry.disabled && failureStates.has(entry.state)
).length;
state.last_scan_at = now;
state.active_entries = activeEntries;
state.failing_entries = failingEntries;
setState(state);

node.status(failingEntries > 0
    ? {
        fill: "red",
        shape: "ring",
        text: `${formatInteger.format(failingEntries)} integração(ões) em falha`
    }
    : {
        fill: "green",
        shape: "dot",
        text: `${formatInteger.format(activeEntries)} entradas; nenhuma falha`
    });

return output.length ? [output] : null;
