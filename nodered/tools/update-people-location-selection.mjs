#!/usr/bin/env node

import fs from "node:fs";

const flowPath = new URL("../flows.json", import.meta.url);
const flows = JSON.parse(fs.readFileSync(flowPath, "utf8"));
const node = flows.find(
  (item) => item.name === "Normalizar pessoas e detectar transições",
);

if (!node?.func) {
  throw new Error("Normalizador do tab localizacao_pessoas não encontrado");
}

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

fs.writeFileSync(flowPath, `${JSON.stringify(flows, null, 4)}\n`);
console.log("Seleção de localização de pessoas atualizada.");
