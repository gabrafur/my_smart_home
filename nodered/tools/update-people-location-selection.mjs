#!/usr/bin/env node

import fs from "node:fs";

const flowPath = new URL("../flows.json", import.meta.url);
const flows = JSON.parse(fs.readFileSync(flowPath, "utf8"));
const node = flows.find(
  (item) => item.name === "Normalizar pessoas e detectar transições",
);
const refreshNode = flows.find(
  (item) => item.name === "Atualizar iPhones agora?",
);

if (!node?.func) {
  throw new Error("Normalizador do tab localizacao_pessoas não encontrado");
}
if (!refreshNode?.func) {
  throw new Error("Política de refresh do tab localizacao_pessoas não encontrada");
}

node.func = node.func.replace(
  "const LOCATION_FRESH_MS = 15 * 60 * 1000;",
  `const LOCATION_FRESH_MS = 15 * 60 * 1000;
const SOURCE_REPORT_FRESH_MS = 75 * 60 * 1000;`,
).replace(
  "const SOURCE_REPORT_FRESH_MS = 75 * 60 * 1000;\nconst SOURCE_REPORT_FRESH_MS = 75 * 60 * 1000;",
  "const SOURCE_REPORT_FRESH_MS = 75 * 60 * 1000;",
);

const marker = "const TRACKER_RECENCY_TIE_MS = 60 * 1000;";
if (!node.func.includes(marker)) {
  const mergePattern = /function mergeTrackers\(primary, fallback\) \{[\s\S]*?\n\}(?=\n\nfunction position)/;
  const matches = node.func.match(mergePattern);
  if (!matches) {
    throw new Error("Bloco mergeTrackers esperado não encontrado");
  }

  const replacement = `const TRACKER_RECENCY_TIE_MS = 60 * 1000;

function trackerAccuracy(entity) {
    const accuracy = Number(
        entity?.attributes?.gps_accuracy
    );

    return Number.isFinite(accuracy) &&
        accuracy >= 0
        ? accuracy
        : Infinity;
}

function mergeTrackers(primary, fallback) {
    const primaryFresh = freshTracker(primary);
    const fallbackFresh = freshTracker(fallback);

    if (primaryFresh !== fallbackFresh) {
        return primaryFresh
            ? primary
            : fallback;
    }

    const primaryCoords = reliableCoords(primary);
    const fallbackCoords = reliableCoords(fallback);

    if (Boolean(primaryCoords) !== Boolean(fallbackCoords)) {
        return primaryCoords
            ? primary
            : fallback;
    }

    const primaryObservedAt = observedAt(primary);
    const fallbackObservedAt = observedAt(fallback);

    if (
        primaryObservedAt !== null &&
        fallbackObservedAt !== null &&
        Math.abs(primaryObservedAt - fallbackObservedAt) >
            TRACKER_RECENCY_TIE_MS
    ) {
        return primaryObservedAt > fallbackObservedAt
            ? primary
            : fallback;
    }

    const primaryAccuracy = trackerAccuracy(primary);
    const fallbackAccuracy = trackerAccuracy(fallback);

    if (primaryAccuracy !== fallbackAccuracy) {
        return primaryAccuracy < fallbackAccuracy
            ? primary
            : fallback;
    }

    if (primaryObservedAt !== fallbackObservedAt) {
        if (primaryObservedAt === null) return fallback;
        if (fallbackObservedAt === null) return primary;

        return primaryObservedAt > fallbackObservedAt
            ? primary
            : fallback;
    }

    const primaryStateValid = validZoneState(
        primary?.state
    );
    const fallbackStateValid = validZoneState(
        fallback?.state
    );

    if (primaryStateValid !== fallbackStateValid) {
        return primaryStateValid
            ? primary
            : fallback;
    }

    return primary ?? fallback;
}`;

  node.func = node.func.replace(mergePattern, replacement);
}

const observedAt = `const LOCATION_OBSERVED_AT_ATTRIBUTE =
    "location_observed_at";
const SOURCE_REPORTED_AT_ATTRIBUTE =
    "source_reported_at";

function observedAt(entity) {
    const value = Date.parse(
        entity?.attributes?.[
            LOCATION_OBSERVED_AT_ATTRIBUTE
        ] ??
        entity?.last_changed ??
        ""
    );

    return Number.isFinite(value)
        ? value
        : null;
}

function reportedAt(entity) {
    const value = Date.parse(
        entity?.attributes?.[
            SOURCE_REPORTED_AT_ATTRIBUTE
        ] ??
        entity?.last_updated ??
        ""
    );

    return Number.isFinite(value)
        ? value
        : null;
}

function freshSource(entity) {
    const value = reportedAt(entity);

    return (
        value !== null &&
        value <= Date.now() + FUTURE_TOLERANCE_MS &&
        Date.now() - value <= SOURCE_REPORT_FRESH_MS
    );
}`;
const observedAtPattern = /(?:const LOCATION_OBSERVED_AT_ATTRIBUTE =[\s\S]*?\n\n)?function observedAt\(entity\) \{[\s\S]*?\n\}(?:\n\nfunction reportedAt\(entity\) \{[\s\S]*?\n\}\n\nfunction freshSource\(entity\) \{[\s\S]*?\n\})?(?=\n\nfunction freshTracker)/;
if (!observedAtPattern.test(node.func)) {
  throw new Error("Função observedAt esperada não encontrada");
}
node.func = node.func.replace(observedAtPattern, observedAt);

const position = `function position(primary, fallback) {
    const selected = mergeTrackers(
        primary,
        fallback
    );

    const attrs = selected?.attributes ?? {};
    const coords = reliableCoords(selected);

    const accuracy = Number(
        attrs.gps_accuracy
    );

    const state = selected?.state;

    const validState =
        typeof state === "string" &&
        ![
            "unknown",
            "unavailable",
            ""
        ].includes(state);

    const updatedAt = observedAt(selected);
    const sourceUpdatedAt = reportedAt(selected);

    const stale =
        updatedAt === null ||
        Date.now() - updatedAt > LOCATION_FRESH_MS ||
        updatedAt > Date.now() + FUTURE_TOLERANCE_MS;

    const sourceStale =
        sourceUpdatedAt === null ||
        Date.now() - sourceUpdatedAt > SOURCE_REPORT_FRESH_MS ||
        sourceUpdatedAt > Date.now() + FUTURE_TOLERANCE_MS;

    const anyTrackerHome =
        primaryHome(primary) ||
        primaryHome(fallback);
    const anyTrackerAway =
        awayEvidence(primary) ||
        awayEvidence(fallback);
    const anySourceReporting =
        freshSource(primary) ||
        freshSource(fallback);

    return {
        entity_id: selected?.entity_id,
        state,

        latitude: coords?.lat ?? null,
        longitude: coords?.lon ?? null,

        gps_accuracy:
            Number.isFinite(accuracy)
                ? accuracy
                : null,

        location_reliable: Boolean(coords),

        state_valid:
            validState &&
            !stale &&
            (
                Boolean(coords) ||
                ["home", "not_home", APPROACH_ZONE].includes(state)
            ),

        updated_at: updatedAt,
        source_updated_at: sourceUpdatedAt,
        source_stale: sourceStale,
        any_source_reporting: anySourceReporting,
        stale,
        ready: validState && !stale,

        distance_m:
            HOME_KNOWN && coords
                ? Math.round(
                    distanceMeters(
                        HOME_LAT,
                        HOME_LON,
                        coords.lat,
                        coords.lon
                    )
                )
                : null,

        gate_distance_m:
            GATE_KNOWN && coords
                ? Math.round(
                    distanceMeters(
                        GATE_LAT,
                        GATE_LON,
                        coords.lat,
                        coords.lon
                    )
                )
                : null,

        current_home:
            validState && !stale
                ? primaryHome(selected)
                : null,

        primary_home: primaryHome(primary),
        any_tracker_home: anyTrackerHome,
        any_tracker_away: anyTrackerAway,

        stationary_home:
            validState &&
            state === "home" &&
            anyTrackerHome &&
            !anyTrackerAway &&
            anySourceReporting,

        primary_home_for_ms: homeForMs(primary)
    };
}`;
const positionPattern = /function position\(primary, fallback\) \{[\s\S]*?\n\}(?=\n\nfunction isAway)/;
if (!positionPattern.test(node.func)) {
  throw new Error("Função position esperada não encontrada");
}
node.func = node.func.replace(positionPattern, position);

const awayEvidenceMarker = "function awayEvidence(entity) {";
const awayEvidence = `function awayEvidence(entity) {
    if (!validZoneState(entity?.state)) {
        return false;
    }

    const coords = reliableCoords(entity);
    if (HOME_KNOWN && coords) {
        return distanceMeters(
            HOME_LAT,
            HOME_LON,
            coords.lat,
            coords.lon
        ) > ARM_DISTANCE_M;
    }

    return ["not_home", APPROACH_ZONE].includes(entity?.state);
}`;

const legacyAwayEvidencePattern = /function freshAwayEvidence\(entity\) \{[\s\S]*?\n\}(?=\n\nfunction position)/;
if (legacyAwayEvidencePattern.test(node.func)) {
  node.func = node.func.replace(legacyAwayEvidencePattern, awayEvidence);
} else if (!node.func.includes(awayEvidenceMarker)) {
  const positionMarker = "function position(primary, fallback) {";
  if (!node.func.includes(positionMarker)) {
    throw new Error("Função position esperada não encontrada");
  }

  node.func = node.func.replace(
    positionMarker,
    `${awayEvidence}\n\n${positionMarker}`,
  );
}

node.func = node.func
  .replaceAll("freshAwayEvidence", "awayEvidence")
  .replaceAll("any_fresh_tracker_away", "any_tracker_away");

if (!node.func.includes("        any_tracker_away:")) {
  const homeEvidence = `        any_tracker_home:
            primaryHome(primary) ||
            primaryHome(fallback),`;
  if (!node.func.includes(homeEvidence)) {
    throw new Error("Evidência combinada de presença não encontrada");
  }
  node.func = node.func.replace(
    homeEvidence,
    `${homeEvidence}

        any_tracker_away:
            awayEvidence(primary) ||
            awayEvidence(fallback),`,
  );
}

if (!node.func.includes("    any_tracker_away:")) {
  const peopleContextMarker = `    resident_primary,
    resident_secondary,

    anyone_away:`;
  if (!node.func.includes(peopleContextMarker)) {
    throw new Error("Contexto consolidado de pessoas não encontrado");
  }
  node.func = node.func.replace(
    peopleContextMarker,
    `    resident_primary,
    resident_secondary,

    any_tracker_away:
        resident_primary.any_tracker_away === true ||
        resident_secondary.any_tracker_away === true,

    anyone_away:`,
  );
}

refreshNode.func = `const TEST_MODE =
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

if (!recoveryNeeded && !anyoneAway) return null;

const interval = recoveryNeeded
    ? 15 * 60 * 1000
    : (
        peopleContext.nearest_distance_m !== null &&
        peopleContext.nearest_distance_m !== undefined &&
        peopleContext.nearest_distance_m <= 2000
            ? 30 * 1000
            : 60 * 1000
    );

const key = "security_people_last_refresh_at";
let last = Number(flow.get(key, "persistent") ?? 0);
const now = Date.now();
if (!Number.isFinite(last) || last > now + 60 * 1000) last = 0;

if (now - last < interval) {
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
        ? "refresh iPhones: recuperar readiness"
        : "refresh iPhones: pessoas fora"
});

return msg;`;

fs.writeFileSync(flowPath, `${JSON.stringify(flows, null, 4)}\n`);
console.log("Seleção de localização de pessoas atualizada.");
