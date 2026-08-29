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
  ["8907830bb7f6c40c"],
  ["eb4b8a519ab0bc28"],
  ["vehicle_primary_manual_refresh_blocked_notification_v1"],
];

const forceRefresh = required("8907830bb7f6c40c");
Object.assign(forceRefresh, {
  action: "public_bindings.call",
  entityId: [],
  data: '{"role":"vehicle_primary","action":"force_refresh"}',
  dataType: "json",
  domain: "public_bindings",
  service: "call",
});

const tripRefresh = required("16396e34ff530ac7");
Object.assign(tripRefresh, {
  action: "public_bindings.call",
  entityId: [],
  data: '{"role":"vehicle_primary","action":"refresh_trip_info"}',
  dataType: "json",
  domain: "public_bindings",
  service: "call",
});

removeNode("77cf2dfe4ff36964");
removeNode("684feca0f1585885");

const normalizer = required("092625f2eb5cc156");
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
errorLogger.func = `const source = String(msg.error?.source?.name ?? "unknown")\n    .replace(/[^a-zA-Z0-9 _-]/g, "");\nconst message = String(msg.error?.message ?? "unknown")\n    .replace(/[\\r\\n]+/g, " ")\n    .slice(0, 240);\nconst key = "security_vehicle_primary_refresh_v1";\nconst state = flow.get(key, "persistent") ?? {};\nconst now = Date.now();\nstate.state = "backoff";\nstate.reason = "api_error";\nstate.failure_at = now;\nstate.failure_source = source;\nstate.next_retry_at = Number(state.next_allowed_at ?? 0) || null;\nstate.cooldown_until = null;\nstate.updated_at = now;\nflow.set(key, state, "persistent");\nnode.error("VEHICLE_PRIMARY_API_ERROR source=" + source + " message=" + message);\nreturn null;`;

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
  x: 215,
  y: 300,
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
  x: 230,
  y: 300,
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
  y: 860,
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
  x: 635,
  y: 860,
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
  x: 925,
  y: 860,
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
  x: 1010,
  y: 900,
  wires: [[]],
});

addToGroup(
  "790bea5f55d43bd0",
  "vehicle_primary_manual_refresh_button_v1",
  "vehicle_primary_manual_refresh_request_v1",
);
addToGroup(
  "43a2bc9c218353ae",
  "vehicle_primary_refresh_telemetry_tick_v1",
  "vehicle_primary_refresh_telemetry_v1",
  "vehicle_primary_refresh_mqtt_v1",
  "vehicle_primary_manual_refresh_blocked_notification_v1",
);

fs.writeFileSync(flowPath, `${JSON.stringify(flows, null, 4)}\n`);
console.log("Controles e telemetria do vehicle_primary instalados sem duplicar o coordenador.");
