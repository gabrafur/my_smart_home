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
if (node.func.includes(marker)) {
  console.log("Seleção de localização de pessoas já está atualizada.");
  process.exit(0);
}

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
fs.writeFileSync(flowPath, `${JSON.stringify(flows, null, 4)}\n`);
console.log("Seleção de localização de pessoas atualizada.");
