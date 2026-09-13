const TEST_MODE =
    msg._location_test === true ||
    msg.payload?.test_mode === true;

if (TEST_MODE) {
    node.status({
        fill: "blue",
        shape: "dot",
        text: "TESTE: refresh físico dos iPhones suprimido"
    });
    return null;
}

if (msg.payload?.kind !== "refresh_command") return null;

const LOCATION_POLICY = global.get("location_policy_v1", "persistent");
const FAST_REFRESH_RADIUS_M = Number(
    LOCATION_POLICY?.people_fast_refresh_radius_m
);
if (
    LOCATION_POLICY?.version !== 1 ||
    LOCATION_POLICY?.complete !== true ||
    !Number.isFinite(FAST_REFRESH_RADIUS_M)
) {
    node.error("Raio de refresh rápido ausente", msg);
    return null;
}

/* A saída confirmada de um morador é um gatilho exclusivo do veículo.
 * O próprio evento acabou de trazer a posição do telefone; não duplique
 * essa atualização no Companion App. */
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

const peopleContext = flow.get("people_context_v1") ?? {};
const residents = [
    peopleContext.resident_primary,
    peopleContext.resident_secondary
];
const contextReady = peopleContext.ready === true;
const stationaryHome =
    residents.length === 2 &&
    residents.every((resident) => resident?.stationary_home === true);
const recoveryNeeded =
    msg.payload?.people_ready === false ||
    contextReady !== true;
const anyoneAway = peopleContext.anyone_away === true;

/* GPS sem movimento não é falha quando ambas as fontes continuam
 * reportando casa e nenhuma delas traz evidência de afastamento. */
if (!anyoneAway && (contextReady || stationaryHome)) {
    node.status({
        fill: "grey",
        shape: "ring",
        text: stationaryHome
            ? "iPhones ativos e parados em casa"
            : "iPhones ready e todos em casa"
    });
    return null;
}

if (!recoveryNeeded) {
    node.status({
        fill: "grey",
        shape: "ring",
        text: anyoneAway
            ? "posição atual; aguardar eventos nativos"
            : "iPhones ready e todos em casa"
    });
    return null;
}

/* request_location_update é uma notificação silenciosa de melhor esforço.
 * Use-a somente como recovery: geofences e mudanças significativas do iOS
 * continuam sendo a fonte responsiva para saída e aproximação. */
const interval = 30 * 60 * 1000;

const key = "security_people_last_refresh_at";
let last = Number(flow.get(key, "persistent") ?? 0);
const now = Date.now();
if (!Number.isFinite(last) || last > now + 60 * 1000) last = 0;

/* O inject periódico roda a cada 30 s. Uma diferença de poucos
 * milissegundos entre ticks não deve adiar um ciclo nominal por mais 30 s. */
const SCHEDULER_JITTER_TOLERANCE_MS = 500;
if (now - last < interval - SCHEDULER_JITTER_TOLERANCE_MS) {
    node.status({
        fill: "grey",
        shape: "ring",
        text: "refresh iPhones em cooldown"
    });
    return null;
}

flow.set(key, now, "persistent");
msg.payload.origin = msg.payload.origin ?? "contexto_chegadas";
msg.payload.people_refresh_recovery = recoveryNeeded;

node.status({
    fill: "green",
    shape: "dot",
    text: recoveryNeeded
        ? "refresh iPhones: recuperar readiness (máx. 2/h)"
        : "refresh iPhones: pessoas fora"
});

return msg;
