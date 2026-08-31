import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const toolsDir = path.dirname(fileURLToPath(import.meta.url));
const flowPath = path.resolve(toolsDir, "../flows.json");
const functionDir = path.join(toolsDir, "functions");
const flows = JSON.parse(fs.readFileSync(flowPath, "utf8"));
const byId = new Map(flows.map((node) => [node.id, node]));

function required(id) {
  const node = byId.get(id);
  if (!node) throw new Error(`Nó obrigatório ausente: ${id}`);
  return node;
}

function source(name) {
  return fs.readFileSync(path.join(functionDir, name), "utf8").trimEnd();
}

function upsert(node) {
  const current = byId.get(node.id);
  if (current) Object.assign(current, node);
  else {
    flows.push(node);
    byId.set(node.id, node);
  }
}

function addToGroup(groupId, ...ids) {
  const group = required(groupId);
  group.nodes = [...new Set([...(group.nodes ?? []), ...ids])];
}

function removeNode(id) {
  const index = flows.findIndex((node) => node.id === id);
  if (index >= 0) flows.splice(index, 1);
  byId.delete(id);
  for (const node of flows) {
    if (Array.isArray(node.nodes)) node.nodes = node.nodes.filter((item) => item !== id);
    if (Array.isArray(node.scope)) node.scope = node.scope.filter((item) => item !== id);
    if (Array.isArray(node.wires)) {
      node.wires = node.wires.map((output) =>
        Array.isArray(output) ? output.filter((item) => item !== id) : output,
      );
    }
  }
}

const refreshDecision = required("b33e117e55bdb5ed");
refreshDecision.name = "Coordenar refresh do vehicle_primary";
refreshDecision.func = source("vehicle-primary-refresh-coordinator.js");
refreshDecision.outputs = 4;
refreshDecision.wires = [
  ["vehicle_primary_refresh_dispatch_guard_v1"],
  ["eb4b8a519ab0bc28"],
  ["vehicle_primary_manual_refresh_blocked_notification_v1"],
  ["vehicle_primary_refresh_notification_requested_out_v1"],
];
Object.assign(required("25ca02f8c1de32d0"), { x: 215, y: 680 });
Object.assign(required("eb4b8a519ab0bc28"), { x: 630, y: 780 });

upsert({
  id: "vehicle_primary_refresh_dispatch_guard_v1",
  type: "function",
  z: "c22d8b12055e87f7",
  g: "43a2bc9c218353ae",
  name: "Separar refresh real e dry-run",
  func: source("vehicle-primary-refresh-dispatch-guard.js"),
  outputs: 2,
  timeout: 0,
  noerr: 0,
  initialize: "",
  finalize: "",
  libs: [],
  x: 715,
  y: 700,
  wires: [["8907830bb7f6c40c"], ["vehicle_primary_refresh_dry_run_out_v1"]],
});

const forceRefresh = required("8907830bb7f6c40c");
Object.assign(forceRefresh, {
  action: "public_bindings.call",
  entityId: [],
  data: '{"role":"vehicle_primary","action":"force_refresh"}',
  dataType: "json",
  domain: "public_bindings",
  service: "call",
  x: 990,
  y: 700,
  wires: [["vehicle_primary_refresh_accepted_v1"]],
});

upsert({
  id: "vehicle_primary_refresh_accepted_v1",
  type: "function",
  z: "c22d8b12055e87f7",
  g: "43a2bc9c218353ae",
  name: "Registrar serviço aceito",
  func: source("vehicle-primary-refresh-accepted.js"),
  outputs: 1,
  timeout: 0,
  noerr: 0,
  initialize: "",
  finalize: "",
  libs: [],
  x: 1260,
  y: 700,
  wires: [["7a99920b093547ea"]],
});

const waitForEvidence = required("7a99920b093547ea");
Object.assign(waitForEvidence, { x: 1510, y: 700 });
const recheck = required("ba55143f392aa361");
Object.assign(recheck, { x: 1370, y: 780 });
const recheckOut = required("f3bc2e5083769579");
Object.assign(recheckOut, { x: 1655, y: 780 });

const tripRefresh = required("16396e34ff530ac7");
Object.assign(tripRefresh, {
  action: "public_bindings.call",
  entityId: [],
  data: '{"role":"vehicle_primary","action":"refresh_trip_info"}',
  dataType: "json",
  domain: "public_bindings",
  service: "call",
  x: 1110,
  y: 860,
});

const arrivalActions = required("727be3d871cf85f0");
Object.assign(arrivalActions, {
  func: source("vehicle-primary-arrival-actions.js"),
  outputs: 2,
  x: 500,
  y: 840,
  wires: [["vehicle_primary_arrival_refresh_out_v1"], ["vehicle_primary_trip_dispatch_guard_v1"]],
});

upsert({
  id: "vehicle_primary_arrival_refresh_out_v1",
  type: "link out",
  z: "c22d8b12055e87f7",
  g: "43a2bc9c218353ae",
  name: "Chegada → coordenador único de refresh",
  mode: "link",
  links: ["vehicle_primary_arrival_refresh_in_v1"],
  x: 705,
  y: 820,
  wires: [],
});

upsert({
  id: "vehicle_primary_arrival_refresh_in_v1",
  type: "link in",
  z: "c22d8b12055e87f7",
  g: "43a2bc9c218353ae",
  name: "Receber refresh de chegada",
  links: ["vehicle_primary_arrival_refresh_out_v1"],
  x: 215,
  y: 760,
  wires: [["b33e117e55bdb5ed"]],
});

upsert({
  id: "vehicle_primary_trip_dispatch_guard_v1",
  type: "function",
  z: "c22d8b12055e87f7",
  g: "43a2bc9c218353ae",
  name: "Separar viagens reais e dry-run",
  func: source("vehicle-primary-trip-dispatch-guard.js"),
  outputs: 2,
  timeout: 0,
  noerr: 0,
  initialize: "",
  finalize: "",
  libs: [],
  x: 795,
  y: 860,
  wires: [["16396e34ff530ac7"], ["vehicle_primary_trip_dry_run_out_v1"]],
});

upsert({
  id: "vehicle_primary_refresh_dry_run_out_v1",
  type: "link out",
  z: "c22d8b12055e87f7",
  g: "43a2bc9c218353ae",
  name: "Refresh TESTE → terminal dry-run",
  mode: "link",
  links: ["vehicle_primary_dry_run_in_v1"],
  x: 875,
  y: 740,
  wires: [],
});

upsert({
  id: "vehicle_primary_trip_dry_run_out_v1",
  type: "link out",
  z: "c22d8b12055e87f7",
  g: "43a2bc9c218353ae",
  name: "Tripinfo TESTE → terminal dry-run",
  mode: "link",
  links: ["vehicle_primary_dry_run_in_v1"],
  x: 990,
  y: 900,
  wires: [],
});

upsert({
  id: "vehicle_primary_dry_run_in_v1",
  type: "link in",
  z: "c22d8b12055e87f7",
  g: "43a2bc9c218353ae",
  name: "Receber efeitos simulados",
  links: [
    "vehicle_primary_refresh_dry_run_out_v1",
    "vehicle_primary_trip_dry_run_out_v1",
    "vehicle_primary_refresh_notification_dry_run_out_v1",
  ],
  x: 1320,
  y: 860,
  wires: [["vehicle_primary_refresh_dry_run_terminal_v1"]],
});

upsert({
  id: "vehicle_primary_refresh_dry_run_terminal_v1",
  type: "function",
  z: "c22d8b12055e87f7",
  g: "43a2bc9c218353ae",
  name: "Terminal dry-run do vehicle_primary",
  func: source("vehicle-primary-dry-run-terminal.js"),
  outputs: 0,
  timeout: 0,
  noerr: 0,
  initialize: "",
  finalize: "",
  libs: [],
  x: 1530,
  y: 860,
  wires: [],
});

removeNode("77cf2dfe4ff36964");
removeNode("684feca0f1585885");

const normalizer = required("092625f2eb5cc156");
const semanticEvidenceInputIds = [
  "46c2142f93cfc3e1",
  "94164ea9e4f5c8d1",
  "vehicle_primary_engine_on_event_v1",
  "9bbff0058231747f",
  "2ff44a30d0a2cf18",
  "f673b02282a47d31",
];
for (const id of semanticEvidenceInputIds) {
  const node = required(id);
  const payload = node.outputProperties?.find(
    (property) => property.property === "payload",
  );
  if (!payload || typeof payload.value !== "string") {
    throw new Error(`Payload JSONata ausente no nó ${id}`);
  }
  if (!payload.value.includes('"vehicle_primary_last_updated"')) {
    payload.value = payload.value.replace(
      /("vehicle_primary_lock"\s*:\s*\$entities\("lock\.vehicle_primary_door_lock"\))/,
      '$1,"vehicle_primary_last_updated":$entities("sensor.vehicle_primary_last_updated_at")',
    );
  }
  if (!payload.value.includes('"vehicle_primary_last_updated"')) {
    throw new Error(`Timestamp semântico não inserido no nó ${id}`);
  }
}
normalizer.func = normalizer.func.replaceAll(
  '\n        "security_vehicle_primary_refresh_v1__test",',
  "",
);
if (!normalizer.func.includes("vehicle_primary_last_updated: testEntity(")) {
  normalizer.func = normalizer.func.replace(
    `        vehicle_primary_lock: testEntity(
            "lock.vehicle_primary_door_lock",
            shared.vehicle_primary_lock
        )`,
    `        vehicle_primary_lock: testEntity(
            "lock.vehicle_primary_door_lock",
            shared.vehicle_primary_lock
        ),
        vehicle_primary_last_updated: testEntity(
            "sensor.vehicle_primary_last_updated_at",
            now
        )`,
  );
}
if (!normalizer.func.includes("function semanticTimestamp(entity)")) {
  normalizer.func = normalizer.func.replace(
    "const vehicle_primary = position(msg.payload?.vehicle_primary);",
    `function semanticTimestamp(entity) {
    const value = Date.parse(entity?.state ?? "");
    return Number.isFinite(value) ? value : null;
}

const vehicle_primary = position(msg.payload?.vehicle_primary);
const telemetryUpdatedAt = semanticTimestamp(
    msg.payload?.vehicle_primary_last_updated
);`,
  );
}
if (!normalizer.func.includes("telemetry_updated_at: telemetryUpdatedAt")) {
  normalizer.func = normalizer.func.replace(
    "const vehicleContext = {\n    location: vehicle_primary,",
    "const vehicleContext = {\n    location: vehicle_primary,\n    telemetry_updated_at: telemetryUpdatedAt,",
  );
}
if (normalizer.func.includes("semantic_telemetry_evidence_v1")) {
  normalizer.func = normalizer.func.replace(
    "semantic_telemetry_evidence_v1",
    "semantic_telemetry_evidence_v2",
  );
  normalizer.func = normalizer.func.replace(
    `        const changedDomains = semanticAdvanced
            ? ["telemetry"]
            : [];`,
    `        const requestAt = Number(
            refreshState.last_request_at ??
            refreshState.last_attempt_at ??
            0
        );
        const semanticCurrentForAttempt =
            semanticAdvanced &&
            Number.isFinite(requestAt) &&
            requestAt > 0 &&
            currentTelemetryAt >=
                requestAt - FUTURE_TOLERANCE_MS;
        const changedDomains = semanticCurrentForAttempt
            ? ["telemetry"]
            : [];`,
  );
  normalizer.func = normalizer.func.replace(
    `        const evidenceObserved =
            attemptCurrent &&
            semanticAdvanced;`,
    `        const evidenceObserved =
            attemptCurrent &&
            semanticCurrentForAttempt;`,
  );
}
if (!normalizer.func.includes("semantic_telemetry_evidence_v2")) {
  const evidenceStart = normalizer.func.indexOf(
    "        const baseline =\n            refreshState.baseline_observed_at ?? {};",
  );
  const evidenceEnd = normalizer.func.indexOf(
    "        const targetReady =",
    evidenceStart,
  );
  if (evidenceStart < 0 || evidenceEnd < 0) {
    throw new Error("Bloco legado de evidência do refresh não encontrado");
  }
  const semanticEvidence = `        /* semantic_telemetry_evidence_v2:
         * republicar entidades, reler cache ou receber telemetria anterior
         * ao wake avaliado não prova dado novo. */
        const baseline = Number(
            refreshState.baseline_observed_at?.telemetry ?? 0
        );
        const currentTelemetryAt = Number(
            vehicleContext.telemetry_updated_at ?? 0
        );
        const semanticAdvanced =
            Number.isFinite(currentTelemetryAt) &&
            currentTelemetryAt > 0 &&
            (
                !Number.isFinite(baseline) ||
                baseline <= 0 ||
                currentTelemetryAt > baseline
            );
        const requestAt = Number(
            refreshState.last_request_at ??
            refreshState.last_attempt_at ??
            0
        );
        const semanticCurrentForAttempt =
            semanticAdvanced &&
            Number.isFinite(requestAt) &&
            requestAt > 0 &&
            currentTelemetryAt >=
                requestAt - FUTURE_TOLERANCE_MS;
        const changedDomains = semanticCurrentForAttempt
            ? ["telemetry"]
            : [];

        const lastAttemptAt =
            Number(refreshState.last_attempt_at ?? 0);

        const attemptCurrent =
            lastAttemptAt > 0 &&
            lastAttemptAt <= Date.now() + FUTURE_TOLERANCE_MS &&
            Date.now() - lastAttemptAt <= 5 * 60 * 1000;

        const evidenceObserved =
            attemptCurrent &&
            semanticCurrentForAttempt;

`;
  normalizer.func =
    normalizer.func.slice(0, evidenceStart) +
    semanticEvidence +
    normalizer.func.slice(evidenceEnd);
}
for (const marker of [
  "vehicle_primary_last_updated: testEntity(",
  "function semanticTimestamp(entity)",
  "telemetry_updated_at: telemetryUpdatedAt",
  "semantic_telemetry_evidence_v2",
]) {
  if (!normalizer.func.includes(marker)) {
    throw new Error(`Contrato de evidência semântica ausente: ${marker}`);
  }
}
normalizer.func = normalizer.func.replace(
  '        "security_vehicle_primary_test_clock"',
  '        "security_vehicle_primary_test_clock",\n        "security_vehicle_primary_refresh_v1__test"',
);
normalizer.func = normalizer.func.replace(
  'if (!TEST_MODE) {\n    const refreshKey = "security_vehicle_primary_refresh_v1";\n    let refreshState =\n        flow.get(refreshKey, "persistent");',
  ' {\n    const refreshKey = TEST_MODE\n        ? "security_vehicle_primary_refresh_v1__test"\n        : "security_vehicle_primary_refresh_v1";\n    let refreshState = TEST_MODE\n        ? flow.get(refreshKey)\n        : flow.get(refreshKey, "persistent");\n    const setRefreshState = (value) => TEST_MODE\n        ? flow.set(refreshKey, value)\n        : flow.set(refreshKey, value, "persistent");',
);
normalizer.func = normalizer.func.replaceAll(
  '            flow.set(\n                refreshKey,\n                refreshState,\n                "persistent"\n            );',
  '            setRefreshState(refreshState);',
);
normalizer.func = normalizer.func.replace(
  '                next_allowed_at:\n                    Date.now() + 15 * 60 * 1000,',
  '                next_allowed_at: Math.max(\n                    Date.now(),\n                    Number(refreshState.last_request_at ?? Date.now()) +\n                        15 * 60 * 1000\n                ),',
);
normalizer.func = normalizer.func.replace(
  '                awaiting_evidence: false,\n                state: "cooldown",',
  '                awaiting_evidence: false,\n                request_in_flight: false,\n                in_flight_until: null,\n                state: "cooldown",',
);
normalizer.func = normalizer.func.replace(
  '                request_in_flight: false,\n                in_flight_until: null,\n                state: "cooldown",',
  '                request_in_flight: false,\n                in_flight_until: null,\n                failure_notified_at: null,\n                last_failure_class: null,\n                state: "cooldown",',
);
normalizer.func = normalizer.func.replace(
  '                cooldown_until: Date.now() + 15 * 60 * 1000,',
  '                cooldown_until: Math.max(\n                    Date.now(),\n                    Number(refreshState.last_request_at ?? Date.now()) +\n                        15 * 60 * 1000\n                ),',
);
const dispatchAnchoredDeadline =
  'Math.max(\n                    Date.now(),\n                    Number(refreshState.last_request_at ?? Date.now()) +\n                        15 * 60 * 1000\n                )';
const acceptedAnchoredDeadline =
  'Math.max(\n                    Date.now(),\n                    Number(refreshState.next_allowed_at ?? 0),\n                    Number(refreshState.last_request_at ?? Date.now()) +\n                        15 * 60 * 1000\n                )';
normalizer.func = normalizer.func.replaceAll(
  dispatchAnchoredDeadline,
  acceptedAnchoredDeadline,
);
if (!normalizer.func.includes("Number(refreshState.next_allowed_at ?? 0)")) {
  throw new Error("Não foi possível preservar o deadline após aceite do refresh");
}
normalizer.func = normalizer.func.replace(
  'const sharedRefreshState =\n    flow.get("security_vehicle_primary_refresh_v1", "persistent") ?? {};',
  'const sharedRefreshState = TEST_MODE\n    ? flow.get("security_vehicle_primary_refresh_v1__test") ?? {}\n    : flow.get("security_vehicle_primary_refresh_v1", "persistent") ?? {};',
);
normalizer.func = normalizer.func.replace(
  '    awaiting_evidence: sharedRefreshState.awaiting_evidence === true,\n    manual_force: sharedRefreshState.manual_force === true\n};',
  '    awaiting_evidence: sharedRefreshState.awaiting_evidence === true,\n    request_in_flight: sharedRefreshState.request_in_flight === true,\n    in_flight_until: Number(sharedRefreshState.in_flight_until ?? 0) || null,\n    last_failure_class: sharedRefreshState.last_failure_class ?? null,\n    manual_force: sharedRefreshState.manual_force === true\n};',
);
if (!normalizer.func.includes("refresh_state_contract_v1")) {
  normalizer.func = normalizer.func.replace(
    "                awaiting_evidence: false,\n                last_evidence_at: Date.now(),",
    "                awaiting_evidence: false,\n                state: \"cooldown\",\n                reason: refreshState.recovery_reason ?? \"refresh_success\",\n                cooldown_until: Date.now() + 15 * 60 * 1000,\n                next_retry_at: null,\n                last_evidence_at: Date.now(),",
  );
  normalizer.func = normalizer.func.replace(
    "            refreshState.last_partial_evidence_at =\n                Date.now();",
    "            refreshState.state = \"backoff\";\n            refreshState.reason =\n                refreshState.recovery_reason ?? \"partial_evidence\";\n            refreshState.next_retry_at =\n                refreshState.next_allowed_at ?? null;\n            refreshState.cooldown_until = null;\n            refreshState.last_partial_evidence_at =\n                Date.now();",
  );
  normalizer.func = normalizer.func.replace(
    'ctxSet("vehicle_primary_context_v1", vehicleContext);',
    `/* refresh_state_contract_v1: o contexto apenas espelha o estado\n * persistente do único coordenador; não calcula deadlines próprios. */\nconst sharedRefreshState =\n    flow.get("security_vehicle_primary_refresh_v1", "persistent") ?? {};\nvehicleContext.refresh = {\n    state: sharedRefreshState.state ?? "idle",\n    reason: sharedRefreshState.reason ??\n        sharedRefreshState.recovery_reason ?? null,\n    attempt: Number(sharedRefreshState.attempts ?? 0),\n    last_request_at: Number(sharedRefreshState.last_request_at ??\n        sharedRefreshState.last_attempt_at ?? 0) || null,\n    last_success_at: Number(sharedRefreshState.last_success_at ?? 0) || null,\n    next_retry_at: Number(sharedRefreshState.next_retry_at ?? 0) || null,\n    cooldown_until: Number(sharedRefreshState.cooldown_until ?? 0) || null,\n    awaiting_evidence: sharedRefreshState.awaiting_evidence === true,\n    manual_force: sharedRefreshState.manual_force === true\n};\nctxSet("vehicle_primary_context_v1", vehicleContext);`,
  );
  if (!normalizer.func.includes("refresh_state_contract_v1")) {
    throw new Error("Não foi possível inserir refresh no contexto_vehicle_primary");
  }
}

const errorLogger = required("vehicle_primary_api_error_log_v1");
errorLogger.func = source("vehicle-primary-refresh-error.js");
Object.assign(errorLogger, {
  outputs: 1,
  wires: [["vehicle_primary_refresh_error_notification_out_v1"]],
  x: 1520,
  y: 960,
});
const errorCatch = required("vehicle_primary_api_error_catch_v1");
Object.assign(errorCatch, {
  name: "Erros do force_refresh do vehicle_primary",
  scope: ["8907830bb7f6c40c"],
  x: 1240,
  y: 920,
});

upsert({
  id: "vehicle_primary_manual_refresh_button_v1",
  type: "server-state-changed",
  z: "62bb822e033d1623",
  g: "790bea5f55d43bd0",
  name: "Forçar atualização pelo dashboard",
  server: "4126427d5e161a03",
  version: 6,
  outputs: 1,
  exposeAsEntityConfig: "",
  entities: { entity: ["input_button.vehicle_primary_force_refresh_now"], substring: [], regex: [] },
  outputInitially: false,
  stateType: "str",
  ifState: "",
  ifStateType: "str",
  ifStateOperator: "is",
  outputOnlyOnStateChange: true,
  for: "0",
  forType: "num",
  forUnits: "minutes",
  ignorePrevStateNull: true,
  ignorePrevStateUnknown: true,
  ignorePrevStateUnavailable: true,
  ignoreCurrentStateUnknown: true,
  ignoreCurrentStateUnavailable: true,
  outputProperties: [
    { property: "payload", propertyType: "msg", value: '{"event_type":"manual_refresh"}', valueType: "json" },
  ],
  x: 315,
  y: 120,
  wires: [["vehicle_primary_manual_refresh_request_v1"]],
});

upsert({
  id: "vehicle_primary_manual_refresh_request_v1",
  type: "function",
  z: "62bb822e033d1623",
  g: "790bea5f55d43bd0",
  name: "Solicitar manual_force ao coordenador",
  func: source("vehicle-primary-manual-refresh.js"),
  outputs: 1,
  timeout: 0,
  noerr: 0,
  initialize: "",
  finalize: "",
  libs: [],
  x: 650,
  y: 120,
  wires: [["5b3d363c0035297b"]],
});

upsert({
  id: "vehicle_primary_refresh_telemetry_tick_v1",
  type: "inject",
  z: "c22d8b12055e87f7",
  g: "43a2bc9c218353ae",
  name: "Publicar refresh a cada 5 s",
  props: [{ p: "payload" }],
  repeat: "5",
  crontab: "",
  once: true,
  onceDelay: "3",
  topic: "",
  payload: "",
  payloadType: "date",
  x: 350,
  y: 1000,
  wires: [["vehicle_primary_refresh_telemetry_v1"]],
});

upsert({
  id: "vehicle_primary_refresh_telemetry_v1",
  type: "function",
  z: "c22d8b12055e87f7",
  g: "43a2bc9c218353ae",
  name: "Espelhar estado real do refresh",
  func: source("vehicle-primary-refresh-telemetry.js"),
  outputs: 1,
  timeout: 0,
  noerr: 0,
  initialize: "",
  finalize: "",
  libs: [],
  x: 650,
  y: 1000,
  wires: [["vehicle_primary_refresh_mqtt_v1"]],
});

upsert({
  id: "vehicle_primary_refresh_mqtt_v1",
  type: "mqtt out",
  z: "c22d8b12055e87f7",
  g: "43a2bc9c218353ae",
  name: "Publicar diagnóstico do refresh",
  topic: "",
  qos: "1",
  retain: "true",
  respTopic: "",
  contentType: "application/json",
  userProps: "",
  correl: "",
  expiry: "",
  broker: "721c47f31046b8bc",
  x: 960,
  y: 1000,
  wires: [],
});

upsert({
  id: "vehicle_primary_manual_refresh_blocked_notification_v1",
  type: "api-call-service",
  z: "c22d8b12055e87f7",
  g: "43a2bc9c218353ae",
  name: "Avisar refresh manual bloqueado",
  server: "4126427d5e161a03",
  version: 7,
  debugenabled: false,
  action: "persistent_notification.create",
  floorId: [],
  areaId: [],
  deviceId: [],
  entityId: [],
  labelId: [],
  data: '{"title":notification.title,"message":notification.message,"notification_id":notification.id}',
  dataType: "jsonata",
  mergeContext: "",
  mustacheAltTags: false,
  outputProperties: [],
  queue: "none",
  blockInputOverrides: true,
  domain: "persistent_notification",
  service: "create",
  x: 930,
  y: 940,
  wires: [[]],
});

upsert({
  id: "vehicle_primary_refresh_notification_requested_out_v1",
  type: "link out",
  z: "c22d8b12055e87f7",
  g: "43a2bc9c218353ae",
  name: "Falha de refresh → alerta",
  mode: "link",
  links: ["vehicle_primary_refresh_notification_in_v1"],
  x: 635,
  y: 640,
  wires: [],
});

upsert({
  id: "vehicle_primary_refresh_error_notification_out_v1",
  type: "link out",
  z: "c22d8b12055e87f7",
  g: "43a2bc9c218353ae",
  name: "Erro do serviço → alerta",
  mode: "link",
  links: ["vehicle_primary_refresh_notification_in_v1"],
  x: 1745,
  y: 960,
  wires: [],
});

upsert({
  id: "vehicle_primary_refresh_notification_in_v1",
  type: "link in",
  z: "c22d8b12055e87f7",
  g: "43a2bc9c218353ae",
  name: "Receber falha para alerta",
  links: [
    "vehicle_primary_refresh_notification_requested_out_v1",
    "vehicle_primary_refresh_error_notification_out_v1",
  ],
  x: 795,
  y: 1060,
  wires: [["vehicle_primary_refresh_notification_guard_v1"]],
});

upsert({
  id: "vehicle_primary_refresh_notification_guard_v1",
  type: "function",
  z: "c22d8b12055e87f7",
  g: "43a2bc9c218353ae",
  name: "Separar alerta real e dry-run",
  func: source("vehicle-primary-notification-dispatch-guard.js"),
  outputs: 2,
  timeout: 0,
  noerr: 0,
  initialize: "",
  finalize: "",
  libs: [],
  x: 1010,
  y: 1060,
  wires: [
    ["vehicle_primary_refresh_notify_primary_v1"],
    ["vehicle_primary_refresh_notification_dry_run_out_v1"],
  ],
});

upsert({
  id: "vehicle_primary_refresh_notify_primary_v1",
  type: "api-call-service",
  z: "c22d8b12055e87f7",
  g: "43a2bc9c218353ae",
  name: "Avisar resident_primary",
  server: "4126427d5e161a03",
  version: 7,
  debugenabled: false,
  action: "public_bindings.call",
  floorId: [],
  areaId: [],
  deviceId: [],
  entityId: [],
  labelId: [],
  data: '{"role":"mobile_primary","action":"notify_3","data":{"title":alert.title,"message":alert.message}}',
  dataType: "jsonata",
  mergeContext: "",
  mustacheAltTags: false,
  outputProperties: [],
  queue: "all",
  blockInputOverrides: true,
  domain: "public_bindings",
  service: "call",
  x: 1310,
  y: 1040,
  wires: [[]],
});

upsert({
  id: "vehicle_primary_refresh_notification_dry_run_out_v1",
  type: "link out",
  z: "c22d8b12055e87f7",
  g: "43a2bc9c218353ae",
  name: "Alerta TESTE → terminal dry-run",
  mode: "link",
  links: ["vehicle_primary_dry_run_in_v1"],
  x: 1325,
  y: 1100,
  wires: [],
});

addToGroup(
  "790bea5f55d43bd0",
  "vehicle_primary_manual_refresh_button_v1",
  "vehicle_primary_manual_refresh_request_v1",
);
addToGroup(
  "43a2bc9c218353ae",
  "vehicle_primary_refresh_dispatch_guard_v1",
  "vehicle_primary_refresh_accepted_v1",
  "vehicle_primary_arrival_refresh_out_v1",
  "vehicle_primary_arrival_refresh_in_v1",
  "vehicle_primary_trip_dispatch_guard_v1",
  "vehicle_primary_refresh_dry_run_out_v1",
  "vehicle_primary_trip_dry_run_out_v1",
  "vehicle_primary_dry_run_in_v1",
  "vehicle_primary_refresh_dry_run_terminal_v1",
  "vehicle_primary_refresh_telemetry_tick_v1",
  "vehicle_primary_refresh_telemetry_v1",
  "vehicle_primary_refresh_mqtt_v1",
  "vehicle_primary_manual_refresh_blocked_notification_v1",
  "vehicle_primary_refresh_notification_requested_out_v1",
  "vehicle_primary_refresh_error_notification_out_v1",
  "vehicle_primary_refresh_notification_in_v1",
  "vehicle_primary_refresh_notification_guard_v1",
  "vehicle_primary_refresh_notify_primary_v1",
  "vehicle_primary_refresh_notification_dry_run_out_v1",
);

const refreshGroup = required("43a2bc9c218353ae");
Object.assign(refreshGroup, { x: 174, y: 579, w: 1662, h: 582 });

const manualTestGroup = required("5df25064f701ecd2");
const manualTestShift = Math.max(0, 1199 - manualTestGroup.y);
if (manualTestShift > 0) {
  manualTestGroup.y += manualTestShift;
  for (const id of manualTestGroup.nodes ?? []) {
    const node = required(id);
    node.y += manualTestShift;
  }
}

const immediateRecovery = required("6473697c19342f07");
Object.assign(immediateRecovery, { x: 570, y: 240 });

fs.writeFileSync(flowPath, `${JSON.stringify(flows, null, 4)}\n`);
console.log("Controles e telemetria do vehicle_primary instalados sem duplicar o coordenador.");
