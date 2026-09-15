#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";

/*
 * A migração de movimento do veículo já foi incorporada ao canvas. Este
 * comando agora é deliberadamente um verificador: thresholds pertencem aos
 * blocos de `localizacao_pessoas`, e não podem voltar a ser gravados aqui.
 */
const flowPath = process.argv[2] ?? new URL("../flows.json", import.meta.url);
const flows = JSON.parse(fs.readFileSync(flowPath, "utf8"));
const byId = new Map(flows.map((node) => [node.id, node]));

const locationEvent = byId.get("46c2142f93cfc3e1");
assert(locationEvent, "evento de localização do vehicle_primary ausente");
assert.equal(locationEvent.outputOnlyOnStateChange, false);
assert.deepEqual(locationEvent.entities?.entity, [
  "device_tracker.vehicle_primary",
  "sensor.vehicle_primary_last_updated_at",
  "sensor.vehicle_primary_last_scanned_at",
]);

const normalizer = byId.get("vehicle_visual_normalize");
assert(normalizer?.type === "function", "normalizador do vehicle_primary ausente");
assert.match(normalizer.func, /global\.get\("location_policy_v1", "persistent"\)/);
assert.match(normalizer.func, /vehicle_primary_last_scanned/);
assert.match(normalizer.func, /cache_scanned_at/);

assert(byId.has("vehicle_primary_api_error_catch_v1"), "catch da API ausente");
assert(byId.has("vehicle_primary_api_error_log_v1"), "logger da API ausente");

console.log(
  "Movimento do veículo usa a política canônica visual; nenhuma cópia alterada.",
);
