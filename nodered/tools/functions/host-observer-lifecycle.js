const test = msg._host_observer_test === true;
const store = test ? undefined : "persistent";
const key = test ? "host_observer_incidents_v1__test" : "host_observer_incidents_v1";
const state = flow.get(key, store) ?? {version: 1, incidents: {}};
const fact = msg._host_fact;
const name = `${fact.kind}_${fact.source ?? "host"}_${fact.name}`;
if (!/^[a-z0-9_-]{1,90}$/.test(name) || !["failed", "healthy", "unknown"].includes(msg._host_signal)) return null;
const now = msg._host_now;
let incident = state.incidents[name];
if (incident && now < incident.last_seen_at) {
    incident.clock_conflict = true;
    flow.set(key, state, store);
    return null;
}
if (msg._host_signal === "unknown") {
    if (incident) { incident.current_evidence = "unknown"; incident.last_seen_at = now; }
    flow.set(key, state, store);
    return null;
}
const label = fact.kind === "resource" ? `recurso ${fact.name}` :
    fact.kind === "observation" ? `observação ${fact.name}` : `serviço ${fact.name}`;
const alert = (recovery) => ({
    _global_observer_test: test,
    payload: {test_mode: test, observer_kind: recovery ? "host_recovery" : "host_failure",
        persistent_incident_kind: "host_failure", incident_key: name,
        persistent_notification_operation: recovery ? "dismiss" : "create",
        mobile_notification: !recovery, host_source: fact.source ?? "host", host_role: fact.name,
        source_observed_at: fact.occurred_at ?? fact.observed_at ?? null,
        policy_decided_at: new Date(now).toISOString(),
        resolution: recovery ? "approved_observation_returned" : undefined},
    alert: {title: `${test ? "TESTE — " : ""}${recovery ? "Observação recuperada" : "Servidor exige atenção"}`,
        message: recovery ? `A observação de ${label} voltou ao estado esperado. O incidente anterior foi encerrado.` :
            `Foi confirmada uma condição de atenção em ${label}. A Eva pode consultar o MCP para verificar a causa e os próximos passos. ` +
            "Este aviso não comprova uma ação do assistente ou a saúde de todos os serviços."}
});
if (msg._host_signal === "healthy") {
    delete state.incidents[name];
    flow.set(key, state, store);
    return incident?.notified_at ? alert(true) : null;
}
incident ??= {first_seen_at: now, last_seen_at: now, notified_at: null, kind: fact.kind};
if (incident.current_evidence === "unknown") {
    incident.first_seen_at = now; incident.sample_count = 0; incident.last_sample_at = null;
}
incident.last_seen_at = now; incident.current_evidence = "failed";
if (fact.kind === "resource" && fact.observed_at !== incident.last_sample_at) {
    const observed = Date.parse(fact.observed_at);
    if (!Number.isFinite(observed) || incident.last_sample_at && observed < Date.parse(incident.last_sample_at)) {
        incident.clock_conflict = true;
    } else {
        incident.sample_count = (incident.sample_count ?? 0) + 1;
        incident.last_sample_at = fact.observed_at;
    }
}
const confirmation = fact.kind === "resource" ? msg._host_policy.resource_confirm_ms :
    fact.kind === "observation" ? msg._host_policy.observation_confirm_ms : msg._host_policy.event_confirm_ms;
state.incidents[name] = incident;
if (!Number.isFinite(confirmation) || confirmation < 1000 || incident.clock_conflict ||
    now - incident.first_seen_at < confirmation || fact.kind === "resource" && incident.sample_count < 2 ||
    incident.notified_at !== null) {
    flow.set(key, state, store);
    return null;
}
incident.notified_at = now;
flow.set(key, state, store);
node.log(`HOST_OBSERVATION_INCIDENT role=${fact.name} kind=${fact.kind} simulated=${test}`);
return alert(false);
