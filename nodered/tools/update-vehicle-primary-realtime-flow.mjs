import assert from "node:assert/strict";
import fs from "node:fs";

const flowPath = process.argv[2] ?? new URL("../flows.json", import.meta.url);
const flows = JSON.parse(fs.readFileSync(flowPath, "utf8"));
const byId = new Map(flows.map((node) => [node.id, node]));

function replaceOnce(source, before, after, label) {
  assert(source.includes(before), `trecho ausente: ${label}`);
  return source.replace(before, after);
}

const locationEvent = byId.get("46c2142f93cfc3e1");
assert(locationEvent, "evento de localização do vehicle_primary ausente");
locationEvent.name = "Localização ou telemetria do vehicle_primary mudou";
locationEvent.entities = {
  entity: [
    "device_tracker.vehicle_primary",
    "sensor.vehicle_primary_last_updated_at",
  ],
  substring: [],
  regex: [],
};
locationEvent.outputOnlyOnStateChange = false;

const normalizer = byId.get("092625f2eb5cc156");
assert(normalizer?.type === "function", "normalizador do vehicle_primary ausente");
normalizer.func = replaceOnce(
  normalizer.func,
  'const MAX_GPS_ACCURACY_M = 100;\nconst APPROACH_ZONE = "chegando";',
  'const MAX_GPS_ACCURACY_M = 100;\nconst MOVEMENT_THRESHOLD_M = 250;\nconst APPROACH_ZONE = "chegando";',
  "limiar de movimento",
);
normalizer.func = replaceOnce(
  normalizer.func,
  'const IN_USE_KEY = "vehicle_primary_in_use";',
  'const IN_USE_KEY = "vehicle_primary_in_use";\nconst LOCATION_OBSERVATION_KEY = "vehicle_primary_location_observation_v1";',
  "chave da observação de localização",
);
normalizer.func = replaceOnce(
  normalizer.func,
  '        "security_vehicle_primary_ready_logged__test",\n        "security_vehicle_primary_test_clock"',
  '        "security_vehicle_primary_ready_logged__test",\n        "vehicle_primary_location_observation_v1__test",\n        "security_vehicle_primary_test_clock"',
  "limpeza do estado de teste",
);

const oldMovement = `const freshVehicleMovement =
    isLocationEvent &&
    vehicle_primary.ready === true &&
    triggerPrevValid &&
    triggerState !== triggerPrevState &&
    ["home", "not_home", APPROACH_ZONE].includes(triggerState);`;

const newMovement = `const previousLocation =
    ctxGet(LOCATION_OBSERVATION_KEY, PERSISTENT);
const zoneChanged =
    triggerPrevValid &&
    triggerState !== triggerPrevState &&
    ["home", "not_home", APPROACH_ZONE].includes(triggerState);
const movementDistanceM =
    previousLocation &&
    Number.isFinite(previousLocation.latitude) &&
    Number.isFinite(previousLocation.longitude) &&
    Number.isFinite(vehicle_primary.latitude) &&
    Number.isFinite(vehicle_primary.longitude)
        ? distanceMeters(
            previousLocation.latitude,
            previousLocation.longitude,
            vehicle_primary.latitude,
            vehicle_primary.longitude
        )
        : null;
const movementAccuracyM = Math.max(
    MOVEMENT_THRESHOLD_M,
    Number(previousLocation?.gps_accuracy || 0) +
        Number(vehicle_primary.gps_accuracy || 0)
);
const significantCoordinateMovement =
    Number.isFinite(movementDistanceM) &&
    movementDistanceM >= movementAccuracyM &&
    Number(vehicle_primary.updated_at || 0) >
        Number(previousLocation?.updated_at || 0);
const freshVehicleMovement =
    isLocationEvent &&
    vehicle_primary.ready === true &&
    (zoneChanged || significantCoordinateMovement);

if (
    isLocationEvent &&
    vehicle_primary.location_reliable === true &&
    (
        !previousLocation ||
        zoneChanged ||
        significantCoordinateMovement
    )
) {
    ctxSet(
        LOCATION_OBSERVATION_KEY,
        {
            version: 1,
            latitude: vehicle_primary.latitude,
            longitude: vehicle_primary.longitude,
            gps_accuracy: vehicle_primary.gps_accuracy,
            state: vehicle_primary.state,
            updated_at: vehicle_primary.updated_at
        },
        PERSISTENT
    );
}

if (!TEST_MODE && freshVehicleMovement) {
    const movementKind = zoneChanged ? "zone" : "distance";
    const distanceBucketM = Number.isFinite(movementDistanceM)
        ? Math.ceil(movementDistanceM / 100) * 100
        : null;
    node.log?.(
        "VEHICLE_PRIMARY_LOCATION_CHANGED kind=" + movementKind +
        (distanceBucketM === null
            ? ""
            : " displacement_bucket_m=" + distanceBucketM)
    );
    node.log?.(
        "VEHICLE_PRIMARY_MOVEMENT_DETECTED source=device_tracker " +
        "engine_stale=" + String(engineFresh !== true)
    );
}`;

normalizer.func = replaceOnce(
  normalizer.func,
  oldMovement,
  newMovement,
  "detecção de movimento do veículo",
);
normalizer.func = replaceOnce(
  normalizer.func,
  `            node.status({
                fill: "green",
                shape: "dot",
                text:
                    refreshState.last_success_reason ===`,
  `            node.log?.(
                "VEHICLE_PRIMARY_NEW_DATA_RECEIVED domains=" +
                changedDomains.join(",") +
                " readiness=" + refreshState.last_success_reason
            );

            node.status({
                fill: "green",
                shape: "dot",
                text:
                    refreshState.last_success_reason ===`,
  "log de confirmação do refresh",
);
normalizer.func = replaceOnce(
  normalizer.func,
  `if (
    !TEST_MODE &&
    freshVehicleMovement &&
    engineFresh !== true
) {`,
  `if (
    !TEST_MODE &&
    freshVehicleMovement
) {`,
  "refresh por qualquer movimento significativo",
);
normalizer.func = replaceOnce(
  normalizer.func,
  `            reason:
                "vehicle_primary_location_changed_engine_stale",
            force_recovery: true,
            require_lighting_ready: true,`,
  `            reason: engineFresh === true
                ? "vehicle_primary_location_changed"
                : "vehicle_primary_location_changed_engine_stale",
            force_recovery: true,
            require_lighting_ready: engineFresh !== true,`,
  "motivo do refresh por movimento",
);
normalizer.func = normalizer.func.replace(
  "movimento do vehicle_primary; recovery do motor solicitado",
  "movimento do vehicle_primary; refresh solicitado",
);

const refreshDecision = byId.get("b33e117e55bdb5ed");
assert(refreshDecision?.type === "function", "decisão de refresh do vehicle_primary ausente");
refreshDecision.func = replaceOnce(
  refreshDecision.func,
  `flow.set(key, state, "persistent");

msg.payload.retry_attempt = state.attempts;`,
  `flow.set(key, state, "persistent");

node.log?.(
    (state.attempts > 1
        ? "VEHICLE_PRIMARY_REFRESH_RETRY"
        : "VEHICLE_PRIMARY_REFRESH_REQUESTED") +
    " attempt=" + state.attempts +
    " recovery=" + String(recoveryNeeded) +
    " require_lighting_ready=" + String(requireLightingReady)
);

msg.payload.retry_attempt = state.attempts;`,
  "telemetria de solicitação e retry",
);

const group = byId.get("43a2bc9c218353ae");
assert(group?.type === "group", "grupo de refresh do vehicle_primary ausente");
group.y = 525;
group.h = 456;
const catchId = "vehicle_primary_api_error_catch_v1";
const loggerId = "vehicle_primary_api_error_log_v1";
assert(!byId.has(catchId) && !byId.has(loggerId), "nodes de erro já existem");
flows.push(
  {
    id: catchId,
    type: "catch",
    z: "c22d8b12055e87f7",
    g: group.id,
    name: "Erros das chamadas do vehicle_primary",
    scope: ["8907830bb7f6c40c", "77cf2dfe4ff36964", "16396e34ff530ac7"],
    uncaught: false,
    x: 920,
    y: 880,
    wires: [[loggerId]],
  },
  {
    id: loggerId,
    type: "function",
    z: "c22d8b12055e87f7",
    g: group.id,
    name: "Registrar erro da API do vehicle_primary",
    func: `const source = String(msg.error?.source?.name ?? "unknown").replace(/[^a-zA-Z0-9 _-]/g, "");
const message = String(msg.error?.message ?? "unknown").replace(/[\\r\\n]+/g, " ").slice(0, 240);
node.error("VEHICLE_PRIMARY_API_ERROR source=" + source + " message=" + message);
return null;`,
    outputs: 0,
    timeout: "",
    noerr: 0,
    initialize: "",
    finalize: "",
    libs: [],
    x: 1190,
    y: 880,
    wires: [],
  },
);
group.nodes.push(catchId, loggerId);

fs.writeFileSync(flowPath, `${JSON.stringify(flows, null, 4)}\n`);
console.log("Fluxo contexto_vehicle_primary atualizado para refresh por movimento significativo.");
