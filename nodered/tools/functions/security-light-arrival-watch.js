const data = msg._light_context;
if (!data) return null;

const suffix = data.test_mode ? "__test" : "";
const key = "security_light_arrival_watch_v1";
const get = () => data.test_mode ? flow.get(key + suffix) : flow.get(key, "persistent");
const set = (value) => data.test_mode ? flow.set(key + suffix, value) : flow.set(key, value, "persistent");
const watches = get();
if (watches?.version !== 1 || !watches.residents) return msg;

const freshnessMs = Number(data.location_policy.location_fresh_minutes) * 60000;
const refreshMs = Number(data.location_policy.near_home_refresh_minutes) * 60000;
const retryMs = 60 * 1000;
const armed = data.people?.arrival_armed ?? {};
const requests = [];

for (const source of ["resident_primary", "resident_secondary"]) {
    const watch = watches.residents[source];
    if (!watch) continue;
    const resident = data.people?.[source];
    const observedAt = Number(resident?.updated_at);
    const timestampCurrent = Number.isFinite(observedAt) && observedAt > 0 &&
        observedAt <= data.now + data.future_ms && data.now - observedAt <= freshnessMs;
    const current = resident?.ready === true && resident?.stale !== true && timestampCurrent;
    const home = current && (resident?.current_home === true || resident?.state === "home");
    const outsideApproach = current && resident?.state !== "near_home";
    if (home || outsideApproach || armed[source] !== true || data.lifecycle.active_by_arrival === true) {
        delete watches.residents[source];
        continue;
    }

    const nearHome = resident?.state === "near_home" && resident?.current_home !== true;
    const ageMs = Number.isFinite(observedAt) ? data.now - observedAt : Infinity;
    const previousObservation = Number(watch.position_observed_at ?? watch.event_at ?? 0);
    const newObservation = current && Number.isFinite(previousObservation) &&
        observedAt > previousObservation;
    if (newObservation) {
        watch.position_observed_at = observedAt;
        watch.attempts = 0;
        watch.last_refresh_at = null;
        watch.failure_reported = false;
    }
    const attempts = Number(watch.attempts ?? 0);
    const lastRefreshAt = Number(watch.last_refresh_at ?? 0);
    const retryReady = !Number.isFinite(lastRefreshAt) || lastRefreshAt <= 0 ||
        data.now - lastRefreshAt >= retryMs;

    /* A callback do iPhone pode manter o mesmo estado near_home. O ciclo
     * originalmente validado continua sendo a prova de direção, mas somente
     * uma posição novamente atual pode autorizar o replay. */
    if (newObservation && nearHome && watch.waiting_for_callback === true &&
        (data.engine_allowed || data.bypass_allowed) && data.sun_ready && data.dark) {
        data.engine_on_arrival = {
            payload: {
                contract: "security.arrival.v1",
                kind: "arrival",
                source,
                arriving: [source],
                arrival_source_type: "person",
                arrival_stage: "approach",
                arrival_previous_state: "not_home",
                arrival_direction: "returning",
                external_cycle_confirmed: true,
                event_at: Number(watch.event_at),
                arrival_replayed_after_location_refresh: true
            },
            _arrival_replay: true
        };
        if (data.test_mode) {
            data.engine_on_arrival._location_test = true;
            data.engine_on_arrival._location_test_case = data.test_case;
            data.engine_on_arrival.payload.test_mode = true;
            data.engine_on_arrival.payload.test_case = data.test_case;
        }
        watch.waiting_for_callback = false;
        continue;
    }

    if (newObservation) watch.waiting_for_callback = false;
    const proactiveDue = nearHome && ageMs >= refreshMs && attempts === 0;
    const retryDue = nearHome && watch.waiting_for_callback === true &&
        ageMs >= refreshMs && attempts > 0;
    const authorizationNeedsCurrent = data.location_authorization_just_became_valid === true &&
        nearHome && !current && attempts < 2;
    if (nearHome && !current && attempts >= 2 && watch.failure_reported !== true) {
        watch.failure_reported = true;
        node.warn("iluminacao_seguranca: localização de chegada sem evidência nova após duas sondas");
        requests.push({
            payload: { kind: "arrival_location_refresh_failed", source,
                reason: "location_refresh_without_new_evidence", attempt: attempts,
                observed_at: observedAt, requested_at: watch.last_refresh_at },
            _location_test: data.test_mode,
            _security_light_decision_state: "location_refresh_failed"
        });
    }
    if (attempts >= 2 || !retryReady ||
        (!proactiveDue && !retryDue && !authorizationNeedsCurrent)) continue;

    watch.attempts = attempts + 1;
    watch.last_refresh_at = data.now;
    watch.waiting_for_callback = true;
    requests.push({
        payload: {
            kind: "arrival_location_refresh",
            source,
            arrival_event_at: Number(watch.event_at),
            reason: authorizationNeedsCurrent
                ? "engine_authorized_location_stale"
                : "near_home_refresh_before_stale",
            attempt: watch.attempts,
            requested_at: data.now,
            test_mode: data.test_mode,
            test_case: data.test_case
        },
        _location_test: data.test_mode,
        _location_test_case: data.test_case,
        _security_light_decision_state: "waiting_location_refresh"
    });
}

set(watches);
data.phone_refresh_request = requests.length === 1 ? requests[0] :
    requests.length > 1 ? requests : null;
return msg;
