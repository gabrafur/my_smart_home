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
refreshDecision.outputs = 3;
refreshDecision.wires = [
  ["vehicle_primary_refresh_dispatch_guard_v1"],
  ["eb4b8a519ab0bc28"],
  ["vehicle_primary_manual_refresh_blocked_notification_v1"],
];

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
  '                cooldown_until: Date.now() + 15 * 60 * 1000,',
  '                cooldown_until: Math.max(\n                    Date.now(),\n                    Number(refreshState.last_request_at ?? Date.now()) +\n                        15 * 60 * 1000\n                ),',
);
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
Object.assign(errorLogger, { x: 1580, y: 940 });
const errorCatch = required("vehicle_primary_api_error_catch_v1");
Object.assign(errorCatch, {
  name: "Erros do force_refresh do vehicle_primary",
  scope: ["8907830bb7f6c40c"],
  x: 1220,
  y: 940,
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
);

const refreshGroup = required("43a2bc9c218353ae");
Object.assign(refreshGroup, { x: 174, y: 579, w: 1662, h: 462 });

const immediateRecovery = required("6473697c19342f07");
Object.assign(immediateRecovery, { x: 570, y: 240 });

fs.writeFileSync(flowPath, `${JSON.stringify(flows, null, 4)}\n`);
console.log("Controles e telemetria do vehicle_primary instalados sem duplicar o coordenador.");
