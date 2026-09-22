const data = msg._light_context;
if (!data) return null;

const suffix = data.test_mode ? "__test" : "";
const key = "security_light_local_excursion_v1";
const get = () => data.test_mode
    ? flow.get(key + suffix)
    : flow.get(key, "persistent");
const set = (value) => data.test_mode
    ? flow.set(key + suffix, value)
    : flow.set(key, value, "persistent");
const state = get()?.version === 1
    ? get()
    : { version: 1, residents: {} };
state.residents = { ...(state.residents ?? {}) };
const timestampDefined = (value) =>
    value !== null && value !== undefined && Number.isFinite(Number(value));

const signalFreshMs = Number(data.location_policy.vehicle_signal_fresh_minutes ?? 5) * 60000;
const maxMs = Number(data.location_policy.local_excursion_minutes) * 60000;
const validCycle = (item) => Number.isFinite(item?.started_at) && item.started_at > 0 &&
    item.started_at <= data.now + data.future_ms && Number.isFinite(item.expires_at) &&
    item.expires_at > item.started_at && data.now <= item.expires_at &&
    item.expires_at - item.started_at <= maxMs + 1000;
const configured = data.people?.local_excursions;
const known = configured && typeof configured === "object" && !Array.isArray(configured);
for (const source of ["resident_primary", "resident_secondary"]) {
    if (!validCycle(state.residents[source])) delete state.residents[source];
    const persisted = state.residents[source];
    if (persisted) {
        const firstOn = Number(persisted.departure_engine_on_seen_at);
        const off = Number(persisted.engine_off_seen_at);
        if (!timestampDefined(persisted.departure_engine_on_seen_at) ||
            firstOn < persisted.started_at - signalFreshMs || firstOn > data.now + data.future_ms) {
            persisted.departure_engine_on_seen_at = null;
            persisted.engine_off_seen_at = null;
        } else if (!timestampDefined(persisted.engine_off_seen_at) || off <= firstOn ||
            off < persisted.started_at || off > data.now + data.future_ms) {
            persisted.engine_off_seen_at = null;
        }
    }
    // Partial startup is not evidence that the canonical cycle has ended.
    if (!known) continue;
    const incoming = configured[source];
    if (!validCycle(incoming)) {
        delete state.residents[source];
        continue;
    }
    const old = state.residents[source];
    if (!old || old.started_at !== incoming.started_at) {
        state.residents[source] = {
            started_at: incoming.started_at,
            expires_at: incoming.expires_at,
            departure_engine_on_seen_at: null,
            engine_off_seen_at: null,
            consumed_at: null
        };
    } else old.expires_at = incoming.expires_at;
}

const engineObservedAt = Number(data.vehicle?.engine_updated_at);
const currentEngineOn = data.engine_allowed === true &&
    Number.isFinite(engineObservedAt) && engineObservedAt > 0 &&
    engineObservedAt <= data.now + data.future_ms &&
    data.now - engineObservedAt <= signalFreshMs;
if (currentEngineOn) {
    for (const item of Object.values(state.residents)) {
        const departureOnSeen = timestampDefined(item.departure_engine_on_seen_at);
        const observationFitsDeparture = engineObservedAt >=
            Number(item.started_at) - signalFreshMs;
        if (!departureOnSeen && observationFitsDeparture) {
            /* O primeiro ON pertence à saída. Somente um OFF posterior e outro
             * ON podem transformar o passeio em retorno. */
            item.departure_engine_on_seen_at = engineObservedAt;
        }
    }
}
const acceptedEngineOff = data.kind === "vehicle_primary_context" &&
    data.accepted === true &&
    data.vehicle?.engine_state_valid === true &&
    data.vehicle?.engine_on === false &&
    data.communication_failed !== true &&
    Number.isFinite(engineObservedAt) && engineObservedAt > 0 &&
    engineObservedAt <= data.now + data.future_ms &&
    data.now - engineObservedAt <= signalFreshMs;
if (acceptedEngineOff) {
    for (const item of Object.values(state.residents)) {
        const departureOnAt = Number(item.departure_engine_on_seen_at);
        if (timestampDefined(item.departure_engine_on_seen_at) &&
            engineObservedAt > departureOnAt &&
            engineObservedAt >= Number(item.started_at) &&
            (!timestampDefined(item.engine_off_seen_at) ||
                engineObservedAt > Number(item.engine_off_seen_at))) {
            item.engine_off_seen_at = engineObservedAt;
        }
    }
}

const current = (resident) => {
    const observedAt = Number(resident?.updated_at);
    return resident?.ready === true && resident?.stale !== true &&
        Number.isFinite(observedAt) && observedAt > 0 &&
        observedAt <= data.now + data.future_ms &&
        data.now - observedAt <=
            Number(data.location_policy.location_fresh_minutes) * 60000;
};
const engineOnAfterStop = data.engine_allowed === true &&
    Number.isFinite(engineObservedAt) && engineObservedAt > 0 &&
    engineObservedAt <= data.now + data.future_ms &&
    data.now - engineObservedAt <= signalFreshMs;

if (!data.engine_on_arrival && engineOnAfterStop) {
    const candidates = ["resident_primary", "resident_secondary"]
        .map((source) => ({
            source,
            resident: data.people?.[source],
            excursion: state.residents[source]
        }))
        .filter(({ source, resident, excursion }) =>
            known && validCycle(configured[source]) &&
            excursion && !timestampDefined(excursion.consumed_at) &&
            timestampDefined(excursion.departure_engine_on_seen_at) &&
            timestampDefined(excursion.engine_off_seen_at) &&
            Number(excursion.engine_off_seen_at) > Number(excursion.departure_engine_on_seen_at) &&
            Number(excursion.engine_off_seen_at) >= Number(excursion.started_at) &&
            engineObservedAt > Number(excursion.engine_off_seen_at) &&
            current(resident) && ["home", "near_home"].includes(resident?.state))
        .sort((left, right) =>
            Number(left.excursion.started_at) - Number(right.excursion.started_at));
    const candidate = candidates[0];
    if (candidate) {
        data.engine_on_arrival = {
            payload: {
                contract: "security.arrival.v1",
                kind: "arrival",
                source: candidate.source,
                arriving: [candidate.source],
                arrival_source_type: "person",
                arrival_stage: "local_return",
                arrival_previous_state: "near_home",
                arrival_direction: "returning_local_excursion",
                external_cycle_confirmed: false,
                local_excursion_return: true,
                local_excursion_started_at: candidate.excursion.started_at,
                arrival_resident_snapshot: { ...candidate.resident },
                event_at: engineObservedAt,
                arrival_replayed_after_engine_on: true
            },
            _arrival_replay: true
        };
        if (data.test_mode) {
            data.engine_on_arrival._location_test = true;
            data.engine_on_arrival._location_test_case = data.test_case;
            data.engine_on_arrival.payload.test_mode = true;
            data.engine_on_arrival.payload.test_case = data.test_case;
        }
    }
}

state.updated_at = data.now;
set(state);
data.local_excursions = state;
return msg;
