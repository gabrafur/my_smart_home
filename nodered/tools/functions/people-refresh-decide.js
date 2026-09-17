if (msg.payload?.kind !== "refresh_command") return null;

const TEST_MODE =
    msg._location_test === true ||
    msg.payload?.test_mode === true;

/* A saída confirmada de um morador é um gatilho exclusivo do veículo.
 * O próprio evento acabou de trazer a posição do telefone; não duplique
 * essa atualização nas fontes de localização. */
if (
    msg.payload?.reason === "resident_departure" &&
    msg.payload?.resident_departure_force === true
) {
    node.status({
        fill: "grey",
        shape: "ring",
        text: "saída recebida; wake reservado ao vehicle_primary"
    });
    return null;
}

const peopleContext = flow.get(
    TEST_MODE ? "people_context_v1__test" : "people_context_v1"
) ?? {};
const roles = ["resident_primary", "resident_secondary"];
const now = Date.now();
const interval = 30 * 60 * 1000;
const futureTolerance = 60 * 1000;
const jitterTolerance = 500;
const stateKey = TEST_MODE
    ? "security_people_location_refresh_v2__test"
    : "security_people_location_refresh_v2";
const store = TEST_MODE ? undefined : "persistent";
const rawState = store ? flow.get(stateKey, store) : flow.get(stateKey);
const state = rawState?.version === 2 && rawState.residents &&
    typeof rawState.residents === "object"
    ? rawState
    : { version: 2, residents: {} };
const legacyLast = TEST_MODE
    ? 0
    : Number(flow.get("security_people_last_refresh_at", "persistent") ?? 0);

function validPast(value) {
    return Number.isFinite(value) && value >= 0 && value <= now + futureTolerance;
}

const outputs = [null, null];
const requested = [];
let stateChanged = rawState !== state;

for (const [index, role] of roles.entries()) {
    const resident = peopleContext[role] ?? {};
    const observedAt = Number(resident.updated_at);
    const previous = state.residents[role] &&
        typeof state.residents[role] === "object"
        ? state.residents[role]
        : {};
    const entry = { ...previous };
    let lastRequestAt = Number(entry.last_request_at);
    if (!validPast(lastRequestAt)) {
        lastRequestAt = validPast(legacyLast) ? legacyLast : 0;
        if (entry.last_request_at !== lastRequestAt) stateChanged = true;
        entry.last_request_at = lastRequestAt;
    }

    const requestedObservedAt = Number(entry.observed_at_before_request);
    if (
        entry.awaiting_evidence === true &&
        validPast(observedAt) &&
        (!validPast(requestedObservedAt) || observedAt > requestedObservedAt)
    ) {
        entry.awaiting_evidence = false;
        entry.last_success_at = observedAt;
        entry.attempts = 0;
        stateChanged = true;
    }

    const stale = resident.ready !== true || resident.stale === true;
    const stationaryHome = resident.stationary_home === true;
    const recoveryNeeded =
        stale &&
        !stationaryHome &&
        (msg.payload?.people_ready === false || peopleContext.ready !== true);
    const cooldownActive = now - lastRequestAt < interval - jitterTolerance;

    if (recoveryNeeded && !cooldownActive) {
        const attempt = Math.min(10, Number(entry.attempts ?? 0) + 1);
        entry.last_request_at = now;
        entry.observed_at_before_request = validPast(observedAt)
            ? observedAt
            : null;
        entry.awaiting_evidence = true;
        entry.attempts = attempt;
        stateChanged = true;

        const request = {
            ...msg,
            payload: {
                ...msg.payload,
                origin: msg.payload.origin ?? "contexto_chegadas",
                people_refresh_recovery: true,
                refresh_source: role,
                refresh_attempt: attempt,
                refresh_requested_at: now,
                refresh_routes: ["companion", "icloud"]
            }
        };
        outputs[index] = request;
        requested.push(role);
    }

    state.residents[role] = entry;
}

if (stateChanged) {
    state.updated_at = now;
    if (store) flow.set(stateKey, state, store);
    else flow.set(stateKey, state);
}

if (requested.length > 0) {
    node.status({
        fill: TEST_MODE ? "blue" : "green",
        shape: "dot",
        text: (TEST_MODE ? "TESTE: " : "") +
            "refresh seletivo " + requested.join(" + ") + " (máx. 2/h cada)"
    });
    return outputs;
}

const allStationaryHome = roles.every(
    (role) => peopleContext[role]?.stationary_home === true
);
node.status({
    fill: "grey",
    shape: "ring",
    text: allStationaryHome
        ? "fontes ativas e paradas em casa"
        : "sem localização vencida fora do cooldown"
});
return null;
