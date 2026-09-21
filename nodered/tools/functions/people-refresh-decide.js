const input = msg.payload ?? {};
const explicit = input.kind === "arrival_location_refresh";
if (!explicit && input.kind !== "refresh_command") return null;
if (input.reason === "resident_departure" && input.resident_departure_force === true) return null;
const test = msg._location_test === true || input.test_mode === true;
const policy = global.get("location_policy_v1", "persistent") ?? {};
const required = ["near_home_refresh_minutes", "people_refresh_minutes", "people_refresh_retry_seconds",
    "people_refresh_attempts", "people_refresh_backoff_minutes", "people_refresh_backoff_max_minutes",
    "location_fresh_minutes", "future_tolerance_seconds"];
if (required.some(k => !Number.isFinite(Number(policy[k])))) return null;
const people = flow.get(test ? "people_context_v1__test" : "people_context_v1") ?? {};
const key = "security_people_location_refresh_v2" + (test ? "__test" : "");
const get = () => test ? flow.get(key) : flow.get(key, "persistent");
const set = value => test ? flow.set(key, value) : flow.set(key, value, "persistent");
const raw = get();
const state = raw?.version === 2 && raw.residents ? raw : { version: 2, residents: {} };
const now = Date.now(), retryMs = Number(policy.people_refresh_retry_seconds) * 1000;
const limit = Number(policy.people_refresh_attempts);
const validPast = value => Number.isFinite(value) && value > 0 &&
    value <= now + Number(policy.future_tolerance_seconds) * 1000;
const output = [null, null, null], alerts = [];
for (const [index, role] of ["resident_primary", "resident_secondary"].entries()) {
    if (explicit && input.source !== role) continue;
    const resident = people[role];
    if (!resident) continue; // Missing startup snapshot is not proof of a failed phone.
    const observed = Number(resident.updated_at);
    const current = resident.ready === true && resident.stale !== true && validPast(observed) &&
        now - observed <= Number(policy.location_fresh_minutes) * 60000;
    const entry = state.residents[role] ?? {};
    const priorObservation = Number(entry.observed_at_before_request ?? entry.last_success_at ?? 0);
    if (current && observed > priorObservation) {
        if (entry.failure_notified === true) alerts.push({ _location_test: test,
            payload: { test_mode: test, observer_kind: "node_recovery",
                persistent_incident_kind: "domain_alert", persistent_notification_operation: "dismiss",
                mobile_notification: false, incident_key: "people_location_refresh_" + role,
                resolution: "fresh_location_received" },
            alert: { title: "Localização recuperada", message: role + ": posição nova confirmada." } });
        entry.awaiting_evidence = false;
        entry.attempts = 0;
        entry.failure_notified = false;
        entry.last_success_at = observed;
        entry.observed_at_before_request = observed;
    }
    const attempts = Math.max(0, Math.min(20, Number(entry.attempts) || 0));
    const lastRequest = validPast(Number(entry.last_request_at)) ? Number(entry.last_request_at) : 0;
    const pending = entry.awaiting_evidence === true;
    const failed = pending && attempts >= limit && now - lastRequest >= retryMs;
    if (failed && entry.failure_notified !== true) {
        entry.failure_notified = true;
        alerts.push({ _location_test: test, payload: { test_mode: test,
            observer_kind: "domain_alert", incident_key: "people_location_refresh_" + role,
            reason: "location_refresh_without_new_evidence", severity: "warning", source: role,
            attempts, location_observed_at: validPast(observed) ? observed : null },
            alert: { title: "Localização sem atualização",
                message: role + ": os pedidos ao aplicativo e ao iCloud não trouxeram uma posição nova. " +
                    "Verifique a conexão e as permissões de localização do celular. Dados vencidos não autorizam a chegada." } });
    }
    const interval = attempts >= limit
        ? Math.min(Number(policy.people_refresh_backoff_max_minutes),
            Number(policy.people_refresh_backoff_minutes) * 2 ** Math.min(10, attempts - limit)) * 60000
        : retryMs;
    const ageLimit = Number(resident.state === "near_home"
        ? policy.near_home_refresh_minutes : policy.people_refresh_minutes) * 60000;
    const due = explicit || !current || now - observed >= ageLimit;
    entry.next_allowed_at = lastRequest ? lastRequest + interval : now;
    if (due && now >= entry.next_allowed_at - 500) {
        entry.attempts = attempts + 1;
        entry.awaiting_evidence = true;
        entry.last_request_at = now;
        entry.observed_at_before_request = validPast(observed) ? observed : null;
        output[index] = { ...msg, _location_test: test, payload: { ...input,
            test_mode: test, origin: input.origin ?? "localizacao_pessoas",
            people_refresh_recovery: !current, refresh_source: role,
            refresh_attempt: entry.attempts, refresh_requested_at: now,
            refresh_cooldown_minutes: interval / 60000, refresh_routes: ["companion", "icloud"] } };
    }
    state.residents[role] = entry;
}
state.updated_at = now;
set(state);
output[2] = alerts.length ? alerts : null;
node.status({ fill: alerts.length ? "yellow" : "grey", shape: "ring",
    text: alerts.length ? "sem evidência nova; aviso e backoff" : "GPS preventivo 5/10 min; retry limitado" });
return output.some(Boolean) ? output : null;
