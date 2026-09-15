import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installNotificationHubs } from "./install-notification-hubs.mjs";

const toolsDir = path.dirname(fileURLToPath(import.meta.url));
const flowPath = path.resolve(toolsDir, "../flows.json");
const flowOutputPath = process.env.NODE_RED_FLOW_OUTPUT ?? flowPath;
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
// O pós-processador visual substitui a entrada deste nó pelo pipeline de
// fatos/gates. Este terminal pequeno mantém o contrato do gerador-base sem
// reintroduzir uma segunda implementação das políticas de refresh.
refreshDecision.func = source("vehicle-refresh-output.js");
refreshDecision.outputs = 5;
refreshDecision.wires = [
  ["vehicle_primary_refresh_dispatch_guard_v1"],
  ["eb4b8a519ab0bc28"],
  ["vehicle_primary_manual_blocked_route_out_v1"],
  ["vehicle_primary_refresh_notification_requested_out_v1"],
  ["vehicle_primary_cache_probe_dispatch_guard_v1"],
];

const contextCoordinator = flows.find((node) =>
  node.type === "function" &&
  node.name === "Coordenar snapshot e refresh" &&
  node.func?.includes('contract: "security.refresh-command.v1"'),
);
if (contextCoordinator) {
contextCoordinator.func = contextCoordinator.func.replaceAll(
  "people?.any_fresh_tracker_away",
  "people?.best_location_away",
);
contextCoordinator.func = contextCoordinator.func.replaceAll(
  "people?.any_tracker_away",
  "people?.best_location_away",
);
contextCoordinator.func = contextCoordinator.func.replaceAll(
  "msg.payload.context?.any_tracker_away",
  "msg.payload.context?.best_location_away",
);
if (!contextCoordinator.func.includes("resident_primary_state:")) {
  const presenceMarker = `                    anyone_away:
                        people?.anyone_away === true ||
                        vehicle_primary?.away === true,`;
  if (!contextCoordinator.func.includes(presenceMarker)) {
    throw new Error("Contrato de presença do coordenador não encontrado");
  }
  contextCoordinator.func = contextCoordinator.func.replace(
    presenceMarker,
    `${presenceMarker}
                    resident_primary_state:
                        people?.resident_primary?.state ?? null,
                    resident_secondary_state:
                        people?.resident_secondary?.state ?? null,`,
  );
}
if (!contextCoordinator.func.includes("any_resident_away:")) {
  const residentPresenceMarker = `                    resident_secondary_state:
                        people?.resident_secondary?.state ?? null,`;
  if (!contextCoordinator.func.includes(residentPresenceMarker)) {
    throw new Error("Estados dos moradores não encontrados no coordenador");
  }
  contextCoordinator.func = contextCoordinator.func.replace(
    residentPresenceMarker,
    `${residentPresenceMarker}
                    any_resident_away:
                        people?.best_location_away === true,`,
  );
}
if (!contextCoordinator.func.includes("resident_departure_force:")) {
  const refreshMarker = `    let refresh = null;
    const pending = ctxGet("refresh_pending");`;
  if (!contextCoordinator.func.includes(refreshMarker)) {
    throw new Error("Ponto de emissão do refresh coordenado não encontrado");
  }
  contextCoordinator.func = contextCoordinator.func.replace(
    refreshMarker,
    `    const departureSource = msg.payload?.source;
    const departureState = msg.payload?.trigger_state;
    const departurePreviousState = msg.payload?.trigger_prev_state;
    const departurePosition = msg.payload?.context?.[departureSource];
    const departureEventAt = Number(
        departurePosition?.updated_at ?? incomingAt ?? Date.now()
    );
    const departureKey = [
        departureSource,
        departurePreviousState,
        departureState,
        departureEventAt
    ].join(":");
    const previousDeparture = ctxGet(
        "resident_departure_refresh_v1",
        "persistent"
    );
    const isResidentDeparture =
        domain === "people" &&
        accepted &&
        ["resident_primary", "resident_secondary"].includes(departureSource) &&
        departurePreviousState === "home" &&
        ["near_home", "not_home"].includes(departureState) &&
        departurePosition?.ready === true &&
        departurePosition?.best_location_away === true &&
        previousDeparture?.key !== departureKey;

    let departureRefresh = null;
    if (isResidentDeparture) {
        ctxSet(
            "resident_departure_refresh_v1",
            { key: departureKey, at: Date.now() },
            "persistent"
        );
        departureRefresh = {
            payload: {
                contract: "security.refresh-command.v1",
                kind: "refresh_command",
                reason: "resident_departure",
                recovery_reason: "resident_departure",
                resident_departure_force: true,
                departure_source: departureSource,
                departure_state: departureState,
                departure_event_at: departureEventAt,
                resident_primary_state:
                    msg.payload.context?.resident_primary?.state ?? null,
                resident_secondary_state:
                    msg.payload.context?.resident_secondary?.state ?? null,
                any_resident_away:
                    msg.payload.context?.best_location_away === true,
                people_ready: msg.payload.ready === true,
                vehicle_primary_ready:
                    ctxGet("vehicle_primary_context_v1")?.ready === true,
                force_recovery: true,
                origin: "resident_departure_transition",
                issued_at: Date.now()
            }
        };
        markTest(departureRefresh);
        node.status({
            fill: TEST_MODE ? "blue" : "yellow",
            shape: "dot",
            text: TEST_MODE
                ? "TESTE: saída solicita wake do vehicle_primary"
                : "saída de morador solicita wake do vehicle_primary"
        });
    }

    let refresh = null;
    const pending = ctxGet("refresh_pending");`,
  );

  const returnMarker = "    return refresh ? [null, refresh] : null;";
  if (!contextCoordinator.func.includes(returnMarker)) {
    throw new Error("Retorno do refresh coordenado não encontrado");
  }
  contextCoordinator.func = contextCoordinator.func.replace(
    returnMarker,
    `    const selectedRefresh = departureRefresh ?? refresh;
    return selectedRefresh ? [null, selectedRefresh] : null;`,
  );
}
if (!contextCoordinator.func.includes(
  "departurePosition?.best_location_away === true",
)) {
  const departureReadinessMarker =
    "        departurePosition?.ready === true &&\n        previousDeparture?.key !== departureKey;";
  if (!contextCoordinator.func.includes(departureReadinessMarker)) {
    throw new Error("Gate da melhor localização na saída não encontrado");
  }
  contextCoordinator.func = contextCoordinator.func.replace(
    departureReadinessMarker,
    "        departurePosition?.ready === true &&\n" +
      "        departurePosition?.best_location_away === true &&\n" +
      "        previousDeparture?.key !== departureKey;",
  );
}
const independentPeopleRecoveryMarker =
  "vehicle_recovery_independent_of_people_freshness_v1";
if (!contextCoordinator.func.includes(independentPeopleRecoveryMarker)) {
  const sharedRecoveryBlock = `            const recoveryNeeded =
                !contextsReady ||
                pending.force_recovery === true;

            const recoveryReason =
                pending.request_reason ??
                (contextsReady
                    ? "paired_ready_snapshots"
                    : "readiness_recovery_needed");`;
  if (!contextCoordinator.func.includes(sharedRecoveryBlock)) {
    throw new Error("Recovery conjunto de pessoas e veículo não encontrado");
  }
  contextCoordinator.func = contextCoordinator.func.replace(
    sharedRecoveryBlock,
    `            /* ${independentPeopleRecoveryMarker}: localização stale
             * recupera os telefones, mas não reduz sozinha o ciclo do carro. */
            const peopleRecoveryNeeded =
                pending.people_ready !== true;
            const recoveryNeeded =
                pending.vehicle_primary_ready !== true ||
                pending.force_recovery === true;

            const recoveryReason =
                pending.request_reason ??
                (recoveryNeeded
                    ? "vehicle_readiness_recovery_needed"
                    : peopleRecoveryNeeded
                        ? "people_location_recovery_only"
                        : "paired_ready_snapshots");`,
  );
  contextCoordinator.func = contextCoordinator.func.replace(
    "                    people_ready: pending.people_ready === true,",
    `                    people_ready: pending.people_ready === true,
                    people_recovery_needed: peopleRecoveryNeeded,`,
  );
  contextCoordinator.func = contextCoordinator.func.replace(
    `                text: recoveryNeeded
                    ? "refresh de recuperação emitido"
                    : "snapshots ready; política de refresh emitida"`,
    `                text: recoveryNeeded
                    ? "refresh do veículo em recuperação"
                    : peopleRecoveryNeeded
                        ? "localização pendente; política normal do veículo"
                        : "snapshots ready; política de refresh emitida"`,
  );
}
}
upsert({
  id: "vehicle_primary_refresh_config_group_v1",
  type: "group",
  z: "c22d8b12055e87f7",
  name: "3. Configuração dos intervalos do veículo",
  style: {
    label: true,
    "label-position": "nw",
    stroke: "#b38f00",
    "stroke-opacity": "1",
    fill: "none",
    color: "#a4a4a4",
  },
  nodes: [],
  x: 1344,
  y: 259,
  w: 552,
  h: 342,
});

upsert({
  id: "vehicle_primary_refresh_policy_group_v1",
  type: "group",
  z: "c22d8b12055e87f7",
  name: "4. Política visual: 1 min armado, 5 min, 15 min, 30 min e pausa",
  style: {
    label: true,
    "label-position": "nw",
    stroke: "#4d7ea8",
    "stroke-opacity": "1",
    fill: "none",
    color: "#a4a4a4",
  },
  nodes: [],
  x: 1940,
  y: 259,
  w: 942,
  h: 342,
});

upsert({
  id: "vehicle_primary_refresh_config_help_v1",
  type: "comment",
  z: "c22d8b12055e87f7",
  g: "vehicle_primary_refresh_config_group_v1",
  name: "Duplo clique no número → altere o valor → Deploy",
  info: "Os seis blocos são a única configuração dos intervalos e da pausa noturna. Os valores são validados e persistidos no contexto do flow.",
  x: 1585,
  y: 300,
  wires: [],
  width: 430,
});

const refreshPolicyInjects = [
  ["vehicle_primary_refresh_arrival_armed_minutes_v1", "Chegada armada + motor não ON — 1 min", "arrival_armed_interval_minutes", "1", 340],
  ["vehicle_primary_refresh_approaching_minutes_v1", "near_home comum — 5 min", "approaching_interval_minutes", "5", 380],
  ["vehicle_primary_refresh_away_minutes_v1", "Fora — 15 min", "away_interval_minutes", "15", 420],
  ["vehicle_primary_refresh_home_minutes_v1", "Ambos em casa — 30 min", "home_interval_minutes", "30", 460],
  ["vehicle_primary_refresh_quiet_start_v1", "Pausa começa — 0h", "quiet_start_hour", "0", 500],
  ["vehicle_primary_refresh_quiet_end_v1", "Pausa termina — 6h", "quiet_end_hour", "6", 540],
];

for (const [id, name, topic, payload, y] of refreshPolicyInjects) {
  upsert({
    id,
    type: "inject",
    z: "c22d8b12055e87f7",
    g: "vehicle_primary_refresh_config_group_v1",
    name,
    props: [{ p: "payload" }, { p: "topic", vt: "str" }],
    repeat: "",
    crontab: "",
    once: true,
    onceDelay: "0.5",
    topic,
    payload,
    payloadType: "num",
    x: 1485,
    y,
    wires: [["vehicle_primary_refresh_policy_config_apply_v1"]],
  });
}

upsert({
  id: "vehicle_primary_refresh_policy_config_apply_v1",
  type: "function",
  z: "c22d8b12055e87f7",
  g: "vehicle_primary_refresh_config_group_v1",
  name: "Validar e salvar configuração",
  func: source("vehicle-primary-refresh-policy-config.js"),
  outputs: 1,
  timeout: 0,
  noerr: 0,
  initialize: "",
  finalize: "",
  libs: [],
  x: 1720,
  y: 440,
  wires: [[]],
});

Object.assign(required("25ca02f8c1de32d0"), {
  g: "vehicle_primary_refresh_policy_group_v1",
  x: 1980,
  y: 320,
  wires: [["vehicle_primary_refresh_policy_select_v1"]],
});

upsert({
  id: "vehicle_primary_refresh_policy_select_v1",
  type: "function",
  z: "c22d8b12055e87f7",
  g: "vehicle_primary_refresh_policy_group_v1",
  name: "Escolher presença, chegada armada e motor",
  func: source("vehicle-primary-refresh-policy.js"),
  outputs: 5,
  timeout: 0,
  noerr: 0,
  initialize: "",
  finalize: "",
  libs: [],
  x: 2200,
  y: 350,
  wires: [
    ["vehicle_primary_refresh_use_arrival_armed_interval_v1"],
    ["vehicle_primary_refresh_use_approaching_interval_v1"],
    ["vehicle_primary_refresh_use_away_interval_v1"],
    ["vehicle_primary_refresh_use_home_interval_v1"],
    ["vehicle_primary_refresh_use_unknown_interval_v1"],
  ],
});

function refreshIntervalNode(id, name, configProperty, policy, y) {
  upsert({
    id,
    type: "change",
    z: "c22d8b12055e87f7",
    g: "vehicle_primary_refresh_policy_group_v1",
    name,
    rules: [
      {
        t: "set",
        p: "payload.refresh_interval_ms",
        pt: "msg",
        to: `payload.refresh_policy_config.${configProperty}`,
        tot: "msg",
      },
      {
        t: "set",
        p: "payload.refresh_interval_policy",
        pt: "msg",
        to: policy,
        tot: "str",
      },
    ],
    x: 2425,
    y,
    wires: [["vehicle_primary_refresh_quiet_hours_v1"]],
  });
}

refreshIntervalNode(
  "vehicle_primary_refresh_use_arrival_armed_interval_v1",
  "Usar 1 min enquanto aguarda motor",
  "arrival_armed_interval_ms",
  "arrival_armed_engine_pending",
  290,
);
refreshIntervalNode(
  "vehicle_primary_refresh_use_approaching_interval_v1",
  "Usar intervalo near_home",
  "approaching_interval_ms",
  "approaching",
  330,
);
refreshIntervalNode(
  "vehicle_primary_refresh_use_away_interval_v1",
  "Usar intervalo fora",
  "away_interval_ms",
  "away",
  370,
);
refreshIntervalNode(
  "vehicle_primary_refresh_use_home_interval_v1",
  "Usar intervalo em casa",
  "home_interval_ms",
  "both_home",
  410,
);
refreshIntervalNode(
  "vehicle_primary_refresh_use_unknown_interval_v1",
  "Usar intervalo seguro sem localização",
  "away_interval_ms",
  "presence_unknown",
  450,
);

upsert({
  id: "vehicle_primary_refresh_quiet_hours_v1",
  type: "function",
  z: "c22d8b12055e87f7",
  g: "vehicle_primary_refresh_policy_group_v1",
  name: "Pausar madrugada se ambos em casa",
  func: source("vehicle-primary-refresh-quiet-hours.js"),
  outputs: 1,
  timeout: 0,
  noerr: 0,
  initialize: "",
  finalize: "",
  libs: [],
  x: 2660,
  y: 370,
  wires: [["vehicle_primary_refresh_policy_out_v1"]],
});

upsert({
  id: "vehicle_primary_refresh_policy_out_v1",
  type: "link out",
  z: "c22d8b12055e87f7",
  g: "vehicle_primary_refresh_policy_group_v1",
  name: "Política pronta → coordenador",
  mode: "link",
  links: ["vehicle_primary_refresh_policy_in_v1"],
  x: 2830,
  y: 370,
  wires: [],
});

upsert({
  id: "vehicle_primary_refresh_policy_in_v1",
  type: "link in",
  z: "c22d8b12055e87f7",
  g: "43a2bc9c218353ae",
  name: "Receber política pronta",
  links: ["vehicle_primary_refresh_policy_out_v1"],
  x: 215,
  y: 680,
  wires: [["b33e117e55bdb5ed"]],
});

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

upsert({
  id: "vehicle_primary_cache_probe_dispatch_guard_v1",
  type: "function",
  z: "c22d8b12055e87f7",
  g: "43a2bc9c218353ae",
  name: "Separar releitura de cache real e dry-run",
  func: source("vehicle-primary-cache-probe-dispatch-guard.js"),
  outputs: 2,
  timeout: 0,
  noerr: 0,
  initialize: "",
  finalize: "",
  libs: [],
  x: 720,
  y: 660,
  wires: [["vehicle_primary_cache_probe_call_v1"], ["vehicle_primary_refresh_dry_run_out_v1"]],
});

upsert({
  id: "vehicle_primary_cache_probe_call_v1",
  type: "api-call-service",
  z: "c22d8b12055e87f7",
  g: "43a2bc9c218353ae",
  name: "Reler cache do vehicle_primary",
  server: "4126427d5e161a03",
  version: 7,
  debugenabled: false,
  action: "kia_uvo.update",
  floorId: [],
  areaId: [],
  deviceId: [],
  entityId: [],
  labelId: [],
  data: "{}",
  dataType: "json",
  mergeContext: "",
  mustacheAltTags: false,
  outputProperties: [],
  queue: "all",
  blockInputOverrides: true,
  domain: "kia_uvo",
  service: "update",
  x: 1010,
  y: 660,
  wires: [["vehicle_primary_cache_probe_accepted_v1"]],
});

upsert({
  id: "vehicle_primary_cache_probe_accepted_v1",
  type: "function",
  z: "c22d8b12055e87f7",
  g: "43a2bc9c218353ae",
  name: "Registrar cache relido",
  func: source("vehicle-primary-cache-probe-accepted.js"),
  outputs: 1,
  timeout: 0,
  noerr: 0,
  initialize: "",
  finalize: "",
  libs: [],
  x: 1270,
  y: 660,
  wires: [["7a99920b093547ea"]],
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
Object.assign(waitForEvidence, {
  x: 1510,
  y: 700,
  wires: [["vehicle_primary_post_refresh_route_out_v1"]],
});
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
  g: "vehicle_primary_refresh_policy_group_v1",
  name: "Chegada solicita atualização",
  links: ["vehicle_primary_arrival_refresh_out_v1"],
  x: 1980,
  y: 380,
  wires: [["vehicle_primary_refresh_policy_select_v1"]],
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
    "vehicle_primary_remote_command_dry_run_out_v1",
    "vehicle_primary_remote_request_dry_run_out_v1",
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
if (normalizer.func.includes("function observedAt")) {
const legacyObservedAt = `function observedAt(entity) {
    const value = Date.parse(entity?.last_updated ?? entity?.last_changed ?? "");
    return Number.isFinite(value) ? value : null;
}`;
const semanticObservedAt = `function observedAt(entity) {
    const locationObservedAt = Date.parse(
        entity?.attributes?.location_observed_at ?? ""
    );
    if (Number.isFinite(locationObservedAt)) return locationObservedAt;
    const value = Date.parse(entity?.last_updated ?? entity?.last_changed ?? "");
    return Number.isFinite(value) ? value : null;
}`;
if (normalizer.func.includes(legacyObservedAt)) {
  normalizer.func = normalizer.func.replace(
    legacyObservedAt,
    semanticObservedAt,
  );
}
if (!normalizer.func.includes("entity?.attributes?.location_observed_at")) {
  throw new Error("Timestamp semântico de localização não foi instalado");
}

const legacyArrivalDedupe = `    const eventAt = vehicle_primary.updated_at ?? Date.now();
    const key = ["vehicle_primary", arrival.payload.arrival_stage, triggerState ?? "?", eventAt].join(":");
    const previousAt = Number(recovery.last_arrival_at ?? 0);
    const duplicate = recovery.last_arrival_key === key && previousAt <= Date.now() + FUTURE_TOLERANCE_MS && Date.now() - previousAt < 10 * 60 * 1000;
    if (duplicate) arrival = null;
    else {
        recovery.last_arrival_key = key;
        recovery.last_arrival_at = Date.now();
    }`;
const stableArrivalDedupe = `    const stage = arrival.payload.arrival_stage;
    const key = ["vehicle_primary", stage].join(":");
    const previousAt = Number(recovery.last_arrival_at ?? 0);
    const previousKey = String(recovery.last_arrival_key ?? "");
    const duplicate =
        (previousKey === key || previousKey.startsWith(\`\${key}:\`)) &&
        previousAt <= Date.now() + FUTURE_TOLERANCE_MS &&
        Date.now() - previousAt < 10 * 60 * 1000;
    if (duplicate) arrival = null;
    else {
        recovery.last_arrival_key = key;
        recovery.last_arrival_at = Date.now();
    }`;
if (normalizer.func.includes(legacyArrivalDedupe)) {
  normalizer.func = normalizer.func.replace(
    legacyArrivalDedupe,
    stableArrivalDedupe,
  );
}
if (!normalizer.func.includes("previousKey.startsWith(`${key}:`)")) {
  throw new Error("Deduplicação estável de chegada não foi instalada");
}
const locationOrTelemetryEvent = required("46c2142f93cfc3e1");
locationOrTelemetryEvent.name = "Localização ou telemetria do vehicle_primary mudou";
locationOrTelemetryEvent.entities = {
  entity: [
    "device_tracker.vehicle_primary",
    "sensor.vehicle_primary_last_updated_at",
    "sensor.vehicle_primary_last_scanned_at",
  ],
  substring: [],
  regex: [],
};
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
      '$1,"vehicle_primary_last_updated":$entities("sensor.vehicle_primary_last_updated_at"),"vehicle_primary_last_scanned":$entities("sensor.vehicle_primary_last_scanned_at")',
    );
  }
  if (!payload.value.includes('"vehicle_primary_last_scanned"')) {
    payload.value = payload.value.replace(
      /("vehicle_primary_last_updated"\s*:\s*\$entities\("sensor\.vehicle_primary_last_updated_at"\))/,
      '$1,"vehicle_primary_last_scanned":$entities("sensor.vehicle_primary_last_scanned_at")',
    );
  }
  if (!payload.value.includes('"vehicle_primary_last_updated"') ||
      !payload.value.includes('"vehicle_primary_last_scanned"')) {
    throw new Error(`Timestamps semânticos não inseridos no nó ${id}`);
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
        ),
        vehicle_primary_last_scanned: testEntity(
            "sensor.vehicle_primary_last_scanned_at",
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
  "Date.now() - lastAttemptAt <= 5 * 60 * 1000;",
  `Date.now() - lastAttemptAt <=
        15 * 60 * 1000 + FUTURE_TOLERANCE_MS;`,
);
if (
  !normalizer.func.includes("15 * 60 * 1000 + FUTURE_TOLERANCE_MS") &&
  !normalizer.func.includes("20 * 60 * 1000 + FUTURE_TOLERANCE_MS")
) {
  throw new Error("Normalizer sem janela para telemetria BR atrasada");
}
if (
  !normalizer.func.includes("cache_probe_evidence_window_v1") &&
  !normalizer.func.includes("cache_probe_evidence_window_v2")
) {
  normalizer.func = normalizer.func.replace(
    `        const attemptCurrent =
            lastAttemptAt > 0 &&
            lastAttemptAt <= Date.now() + FUTURE_TOLERANCE_MS &&
            Date.now() - lastAttemptAt <=
        15 * 60 * 1000 + FUTURE_TOLERANCE_MS;`,
    `        /* cache_probe_evidence_window_v2: a sondagem permite observar a
         * resposta atrasada, mas nunca remove o limite causal do wake. */
        const cacheProbeCurrentForAttempt =
            Number(refreshState.cache_probe_completed_for_request_at ?? 0) ===
                requestAt &&
            Number(refreshState.cache_probe_accepted_at ?? 0) > 0;
        const attemptCurrent =
            lastAttemptAt > 0 &&
            lastAttemptAt <= Date.now() + FUTURE_TOLERANCE_MS &&
            Date.now() - lastAttemptAt <=
                20 * 60 * 1000 + FUTURE_TOLERANCE_MS;`,
  );
}
normalizer.func = normalizer.func
  .replace(
    `cache_probe_evidence_window_v1: uma sondagem concluída torna
         * válida a evidência semântica do wake correspondente mesmo se o
         * tick do agendador chegou ligeiramente depois da janela nominal.`,
    `cache_probe_evidence_window_v2: a sondagem permite observar a
         * resposta atrasada, mas nunca remove o limite causal do wake.`,
  )
  .replace(
    `            (
                Date.now() - lastAttemptAt <=
                    15 * 60 * 1000 + FUTURE_TOLERANCE_MS ||
                cacheProbeCurrentForAttempt
            );`,
    `            Date.now() - lastAttemptAt <=
                20 * 60 * 1000 + FUTURE_TOLERANCE_MS;`,
  );
if (
  !normalizer.func.includes("cache_probe_evidence_window_v2") ||
  !normalizer.func.includes("20 * 60 * 1000 + FUTURE_TOLERANCE_MS")
) {
  throw new Error("Normalizer sem janela vinculada à sondagem de cache");
}
const readinessMarker =
  "semantic_wake_confirmation_independent_of_derived_readiness_v2";
if (!normalizer.func.includes(readinessMarker)) {
  const previousReadinessGate = normalizer.func.includes(
    "semantic_wake_confirmation_independent_of_derived_readiness_v1",
  )
    ? `        /* semantic_wake_confirmation_independent_of_derived_readiness_v1:
         * telemetria semântica nova confirma um wake comum mesmo quando
         * motor/trava mantêm o mesmo estado no Home Assistant. Readiness
         * derivado continua obrigatório somente quando a iluminação pediu
         * explicitamente essa recuperação. */
        const targetReady =
            refreshState.require_lighting_ready !== true ||
            (
                vehicleContext.ready === true &&
                vehicleContext.lighting_ready === true
            );`
    : `        const targetReady =
            vehicleContext.ready === true &&
            (
                refreshState.require_lighting_ready !== true ||
                vehicleContext.lighting_ready === true
            );`;
  const semanticReadinessGate = `        /* ${readinessMarker}:
         * telemetria semântica nova confirma que o wake respondeu. A
         * idade do evento do motor é apenas diagnóstica; a confiança é
         * determinada pelo estado conhecido e pela saúde da API. */
        const lightingReadyAfterWake =
            vehicleContext.ready === true &&
            vehicleContext.engine_state_valid === true;`;
  if (!normalizer.func.includes(previousReadinessGate)) {
    throw new Error("Gate de readiness do wake não encontrado");
  }
  normalizer.func = normalizer.func.replace(
    previousReadinessGate,
    semanticReadinessGate,
  );
  normalizer.func = normalizer.func.replace(
    "        if (evidenceObserved && targetReady) {",
    "        if (evidenceObserved) {",
  );
  normalizer.func = normalizer.func.replace(
    `                last_evidence_domains: changedDomains,
                last_success_reason:
                    refreshState.require_lighting_ready === true
                        ? "fresh_entities_lighting_ready"
                        : "fresh_entities_context_ready",`,
    `                last_evidence_domains: changedDomains,
                lighting_ready_after_wake: lightingReadyAfterWake,
                last_success_reason:
                    lightingReadyAfterWake
                        ? "fresh_telemetry_engine_state_known"
                        : "fresh_telemetry_context_ready",`,
  );

  const partialStart = normalizer.func.indexOf(
    "        } else if (evidenceObserved) {",
  );
  const refreshContractStart = normalizer.func.indexOf(
    "    }\n}\n/* refresh_state_contract_v1",
    partialStart,
  );
  if (partialStart < 0 || refreshContractStart < 0) {
    throw new Error("Bloco legado de evidência parcial não encontrado");
  }
  normalizer.func =
    normalizer.func.slice(0, partialStart) +
    "        }\n" +
    normalizer.func.slice(refreshContractStart);
}
if (!normalizer.func.includes(readinessMarker)) {
  throw new Error("Confirmação semântica independente de readiness ausente");
}
const engineTrustMarker = "engine_state_trust_by_api_health_v1";
if (!normalizer.func.includes(engineTrustMarker)) {
  const previousEngineSignals = `const engineFresh = fresh(msg.payload?.vehicle_primary_engine, SIGNAL_FRESH_MS);
const lockFresh = fresh(msg.payload?.vehicle_primary_lock, SIGNAL_FRESH_MS);
const engineOn = engineFresh && ["on", "running"].includes(engineState);
const engineOff = engineFresh && ["off", "stopped", "idle"].includes(engineState);
const unlocked = lockFresh && lockState === "unlocked";`;
  const trustedEngineSignals = `/* ${engineTrustMarker}:
 * ON/OFF conhecidos continuam válidos independentemente da idade. A idade
 * permanece diagnóstica e pode motivar wake; somente uma falha real da API
 * torna o motor não confiável para a iluminação. */
const engineFresh = fresh(msg.payload?.vehicle_primary_engine, SIGNAL_FRESH_MS);
const lockFresh = fresh(msg.payload?.vehicle_primary_lock, SIGNAL_FRESH_MS);
const engineStateKnown = [
    "on", "running", "off", "stopped", "idle"
].includes(engineState);
const engineOn = ["on", "running"].includes(engineState);
const engineOff = ["off", "stopped", "idle"].includes(engineState);
const unlocked = lockFresh && lockState === "unlocked";
const refreshHealthState = TEST_MODE
    ? flow.get("security_vehicle_primary_refresh_v1__test") ?? {}
    : flow.get("security_vehicle_primary_refresh_v1", PERSISTENT) ?? {};
const engineFailureClasses = new Set([
    "integration_unavailable",
    "provider_backoff",
    "authentication",
    "timeout",
    "no_fresh_data",
    "api_error"
]);
const engineCommunicationFailed =
    typeof refreshHealthState.engine_communication_failed === "boolean"
        ? refreshHealthState.engine_communication_failed
        : engineFailureClasses.has(refreshHealthState.last_failure_class);`;
  if (!normalizer.func.includes(previousEngineSignals)) {
    throw new Error("Sinais atuais do motor não encontrados no normalizador");
  }
  normalizer.func = normalizer.func.replace(
    previousEngineSignals,
    trustedEngineSignals,
  );
  normalizer.func = normalizer.func
    .replaceAll('inUseReason = "fresh_engine_on";', 'inUseReason = "known_engine_on";')
    .replaceAll('inUseReason = "fresh_engine_off";', 'inUseReason = "known_engine_off";');

  const previousLightingReady = `const lightingReady =
    vehicle_primary.ready === true &&
    engineFresh === true &&
    (engineOn || engineOff);`;
  const trustedLightingReady = `const lightingReady =
    vehicle_primary.ready === true &&
    engineStateKnown &&
    !engineCommunicationFailed;`;
  if (!normalizer.func.includes(previousLightingReady)) {
    throw new Error("Readiness atual do motor não encontrado no normalizador");
  }
  normalizer.func = normalizer.func.replace(
    previousLightingReady,
    trustedLightingReady,
  );
  normalizer.func = normalizer.func.replace(
    `    engine_state_valid: engineOn || engineOff,
    engine_stale: !engineFresh,`,
    `    engine_state_valid: engineStateKnown,
    engine_stale: !engineFresh,
    engine_communication_failed: engineCommunicationFailed,`,
  );
  normalizer.func = normalizer.func.replace(
    `        const lightingReadyAfterWake =
            vehicleContext.ready === true &&
            vehicleContext.lighting_ready === true;`,
    `        const lightingReadyAfterWake =
            vehicleContext.ready === true &&
            vehicleContext.engine_state_valid === true;`,
  );
  normalizer.func = normalizer.func.replace(
    `                last_evidence_domains: changedDomains,
                lighting_ready_after_wake: lightingReadyAfterWake,
                last_success_reason:
                    lightingReadyAfterWake
                        ? (
                            refreshState.require_lighting_ready === true
                                ? "fresh_entities_lighting_ready"
                                : "fresh_entities_context_ready"
                        )
                        : "fresh_telemetry_engine_unreliable",`,
    `                last_evidence_domains: changedDomains,
                engine_communication_failed: false,
                engine_bypass_recovery_pending:
                    refreshState.engine_bypass_recovery_pending === true ||
                    engineCommunicationFailed,
                lighting_ready_after_wake: lightingReadyAfterWake,
                last_success_reason:
                    lightingReadyAfterWake
                        ? "fresh_telemetry_engine_state_known"
                        : "fresh_telemetry_context_ready",`,
  );
  normalizer.func = normalizer.func.replace(
    `            setRefreshState(refreshState);

            node.log?.(`,
    `            setRefreshState(refreshState);
            vehicleContext.engine_communication_failed = false;
            vehicleContext.lighting_ready = lightingReadyAfterWake;

            node.log?.(`,
  );
}
if (!normalizer.func.includes(engineTrustMarker)) {
  throw new Error("Confiança do motor ainda depende apenas de freshness");
}
if (!normalizer.func.includes('    "no_fresh_data",\n    "api_error"')) {
  const legacyFailureClasses = `    "timeout",
    "api_error"
]);`;
  if (!normalizer.func.includes(legacyFailureClasses)) {
    throw new Error("Classes de falha do motor não encontradas");
  }
  normalizer.func = normalizer.func.replace(
    legacyFailureClasses,
    `    "timeout",
    "no_fresh_data",
    "api_error"
]);`,
  );
}
const preserveBypassRecoveryMarker =
  "preserve_bypass_recovery_on_semantic_success_v1";
if (!normalizer.func.includes(preserveBypassRecoveryMarker)) {
  const legacyBypassRecovery =
    "                engine_bypass_recovery_pending: engineCommunicationFailed,";
  if (!normalizer.func.includes(legacyBypassRecovery)) {
    throw new Error("Estado pendente de recuperação do bypass não encontrado");
  }
  normalizer.func = normalizer.func.replace(
    legacyBypassRecovery,
    `                /* ${preserveBypassRecoveryMarker}: uma resposta HTTP
                 * aceita já pode ter agendado a remoção do bypass antes de
                 * a evidência semântica chegar. */
                engine_bypass_recovery_pending:
                    refreshState.engine_bypass_recovery_pending === true ||
                    engineCommunicationFailed,`,
  );
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
  '                in_flight_until: null,\n                failure_notified_at: null,',
  '                in_flight_until: null,\n                cache_probe_in_flight: false,\n                cache_probe_in_flight_until: null,\n                cache_probe_for_request_at: null,\n                cache_probe_completed_for_request_at: null,\n                cache_probe_settle_until: null,\n                failure_notified_at: null,',
);
if (!normalizer.func.includes("cache_probe_completed_for_request_at: null")) {
  throw new Error("Normalizer sem limpeza do estado da sondagem de cache");
}
if (!normalizer.func.includes("refresh_failure_recovery_cleanup_v1")) {
  normalizer.func = normalizer.func.replace(
    `        if (evidenceObserved && targetReady) {
            refreshState = {`,
    `        if (evidenceObserved && targetReady) {
            /* refresh_failure_recovery_cleanup_v1: sucesso confirmado
             * remove detalhes antigos e agenda o fechamento do aviso no HA. */
            const failureWasNotified =
                Number(refreshState.failure_notified_at ?? 0) > 0;
            refreshState = {`,
  );
  normalizer.func = normalizer.func.replace(
    `                failure_notified_at: null,
                last_failure_class: null,`,
    `                failure_notified_at: null,
                failure_notification_key: null,
                recovery_notification_pending: failureWasNotified,
                last_failure_class: null,
                failure_at: null,
                failure_source: null,
                failure_endpoint: null,
                failure_stage: null,`,
  );
}
if (!normalizer.func.includes("refresh_failure_recovery_cleanup_v1")) {
  throw new Error("Normalizer sem limpeza de alerta após recuperação");
}
if (!normalizer.func.includes("evidence_wait_started_at: null")) {
  normalizer.func = normalizer.func.replace(
    "                awaiting_evidence: false,\n                request_in_flight: false,",
    "                awaiting_evidence: false,\n                evidence_wait_started_at: null,\n                request_in_flight: false,",
  );
}
if (!normalizer.func.includes("evidence_wait_started_at: null")) {
  throw new Error("Normalizer sem limpeza do início da espera semântica");
}
normalizer.func = normalizer.func.replace(
  '                cooldown_until: Date.now() + 15 * 60 * 1000,',
  '                cooldown_until: Math.max(\n                    Date.now(),\n                    Number(refreshState.last_request_at ?? Date.now()) +\n                        15 * 60 * 1000\n                ),',
);
const dispatchAnchoredDeadline =
  'Math.max(\n                    Date.now(),\n                    Number(refreshState.last_request_at ?? Date.now()) +\n                        15 * 60 * 1000\n                )';
const acceptedAnchoredDeadline =
  'Math.max(\n                    Date.now(),\n                    Number(refreshState.next_allowed_at ?? 0),\n                    Number(refreshState.last_request_at ?? Date.now()) +\n                        15 * 60 * 1000\n                )';
const cacheProbeAnchoredDeadline =
  'Math.max(\n                    Date.now(),\n                    Number(refreshState.next_allowed_at ?? 0),\n                    Number(refreshState.last_request_at ?? Date.now()) +\n                        15 * 60 * 1000,\n                    cacheProbeCurrentForAttempt\n                        ? Date.now() + 15 * 60 * 1000\n                        : 0\n                )';
normalizer.func = normalizer.func.replaceAll(
  acceptedAnchoredDeadline,
  cacheProbeAnchoredDeadline,
);
normalizer.func = normalizer.func.replaceAll(
  dispatchAnchoredDeadline,
  cacheProbeAnchoredDeadline,
);
if (!normalizer.func.includes("Number(refreshState.next_allowed_at ?? 0)")) {
  throw new Error("Não foi possível preservar o deadline após o despacho");
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

/* O normalizador pode confirmar evidência semântica depois do aceite da API,
 * mas não escolhe mais um intervalo próprio. O prazo usa exclusivamente o
 * intervalo que os blocos visuais gravaram no estado do coordenador. */
if (!normalizer.func.includes("refresh_policy_interval_passthrough_v1")) {
  const stateWriter = `    const setRefreshState = (value) => TEST_MODE
        ? flow.set(refreshKey, value)
        : flow.set(refreshKey, value, "persistent");`;
  if (!normalizer.func.includes(stateWriter)) {
    throw new Error("Normalizer sem acesso ao estado único de refresh");
  }
  normalizer.func = normalizer.func.replace(
    stateWriter,
    `${stateWriter}
    /* refresh_policy_interval_passthrough_v1 */
    const configuredRefreshIntervalMs = Number(
        refreshState?.interval_ms
    );
    const selectedRefreshIntervalMs =
        Number.isFinite(configuredRefreshIntervalMs) &&
        configuredRefreshIntervalMs > 0
            ? configuredRefreshIntervalMs
            : 0;`,
  );
}
normalizer.func = normalizer.func.replaceAll(
  `Number(refreshState.last_request_at ?? Date.now()) +
                        15 * 60 * 1000`,
  `Number(refreshState.last_request_at ?? Date.now()) +
                        selectedRefreshIntervalMs`,
);
normalizer.func = normalizer.func.replaceAll(
  "Date.now() + 15 * 60 * 1000",
  "Date.now() + selectedRefreshIntervalMs",
);
if (
  !normalizer.func.includes("refresh_policy_interval_passthrough_v1") ||
  normalizer.func.includes(
    "Number(refreshState.last_request_at ?? Date.now()) +\n                        15 * 60 * 1000",
  )
) {
  throw new Error("Normalizer ainda recalcula o intervalo de refresh");
}
}

// O lifecycle visual atual usa nós dedicados, portanto estes eventos não podem
// depender do normalizador legado acima para receber a consulta ao cache.
const lifecycleTelemetryEvent = required("46c2142f93cfc3e1");
lifecycleTelemetryEvent.name = "Localização ou telemetria do vehicle_primary mudou";
lifecycleTelemetryEvent.entities = {
  entity: [
    "device_tracker.vehicle_primary",
    "sensor.vehicle_primary_last_updated_at",
    "sensor.vehicle_primary_last_scanned_at",
  ],
  substring: [],
  regex: [],
};
for (const id of [
  "46c2142f93cfc3e1",
  "94164ea9e4f5c8d1",
  "vehicle_primary_engine_on_event_v1",
  "9bbff0058231747f",
  "2ff44a30d0a2cf18",
  "f673b02282a47d31",
]) {
  const payload = required(id).outputProperties?.find(
    (property) => property.property === "payload",
  );
  if (!payload || typeof payload.value !== "string") {
    throw new Error(`Payload JSONata ausente no nó ${id}`);
  }
  if (!payload.value.includes('"vehicle_primary_last_scanned"')) {
    payload.value = payload.value.replace(
      /("vehicle_primary_last_updated"\s*:\s*\$entities\("sensor\.vehicle_primary_last_updated_at"\))/,
      '$1,"vehicle_primary_last_scanned":$entities("sensor.vehicle_primary_last_scanned_at")',
    );
  }
  if (!payload.value.includes('"vehicle_primary_last_scanned"')) {
    throw new Error(`Consulta ao cache não inserida no nó ${id}`);
  }
}

const errorLogger = required("vehicle_primary_api_error_log_v1");
errorLogger.func = source("vehicle-primary-refresh-error.js");
Object.assign(errorLogger, {
  outputs: 2,
  wires: [
    ["vehicle_primary_refresh_error_notification_out_v1"],
    ["vehicle_primary_api_error_bypass_out_v1"],
  ],
  x: 1520,
  y: 960,
});
const errorCatch = required("vehicle_primary_api_error_catch_v1");
Object.assign(errorCatch, {
  name: "Erros do refresh e cache do vehicle_primary",
  scope: [
    "8907830bb7f6c40c",
    "vehicle_primary_cache_probe_call_v1",
    "16396e34ff530ac7",
  ],
  x: 1240,
  y: 920,
});

upsert({
  id: "vehicle_primary_api_error_bypass_out_v1",
  type: "link out",
  z: "c22d8b12055e87f7",
  g: "43a2bc9c218353ae",
  name: "Falha da API → comando de bypass",
  mode: "link",
  links: ["vehicle_primary_api_error_bypass_in_v1"],
  x: 1745,
  y: 1000,
  wires: [],
});

upsert({
  id: "vehicle_primary_api_error_bypass_in_v1",
  type: "link in",
  z: "c22d8b12055e87f7",
  g: "43a2bc9c218353ae",
  name: "Receber falha da API para bypass",
  links: ["vehicle_primary_api_error_bypass_out_v1"],
  x: 850,
  y: 1175,
  wires: [["vehicle_primary_provider_bypass_command_v1"]],
});

upsert({
  id: "vehicle_primary_provider_backoff_state_v1",
  type: "server-state-changed",
  z: "c22d8b12055e87f7",
  g: "43a2bc9c218353ae",
  name: "Prazo de backoff do provedor",
  server: "4126427d5e161a03",
  version: 6,
  outputs: 1,
  exposeAsEntityConfig: "",
  entities: {
    entity: ["sensor.vehicle_primary_api_retry_at"],
    substring: [],
    regex: [],
  },
  outputInitially: true,
  stateType: "str",
  ifState: "",
  ifStateType: "str",
  ifStateOperator: "is",
  outputOnlyOnStateChange: true,
  for: "0",
  forType: "num",
  forUnits: "minutes",
  ignorePrevStateNull: false,
  ignorePrevStateUnknown: false,
  ignorePrevStateUnavailable: false,
  ignoreCurrentStateUnknown: false,
  ignoreCurrentStateUnavailable: false,
  outputProperties: [
    {
      property: "payload",
      propertyType: "msg",
      value: '({"state":$entity().state,"attributes":{"status":$entity().attributes.status,"retry_after_seconds":$entity().attributes.retry_after_seconds}})',
      valueType: "jsonata",
    },
  ],
  x: 365,
  y: 1140,
  wires: [["vehicle_primary_provider_backoff_sync_v1"]],
});

upsert({
  id: "vehicle_primary_provider_backoff_sync_v1",
  type: "function",
  z: "c22d8b12055e87f7",
  g: "43a2bc9c218353ae",
  name: "Sincronizar backoff do provedor",
  func: source("vehicle-primary-provider-backoff-sync.js"),
  outputs: 1,
  timeout: 0,
  noerr: 0,
  initialize: "",
  finalize: "",
  libs: [],
  x: 730,
  y: 1140,
  wires: [["vehicle_primary_provider_bypass_command_v1"]],
});

upsert({
  id: "vehicle_primary_provider_bypass_command_v1",
  type: "mqtt out",
  z: "c22d8b12055e87f7",
  g: "43a2bc9c218353ae",
  name: "Comandar bypass durante falha da API",
  topic: "",
  qos: "",
  retain: "",
  respTopic: "",
  contentType: "",
  userProps: "",
  correl: "",
  expiry: "",
  broker: "721c47f31046b8bc",
  x: 1040,
  y: 1175,
  wires: [],
});

if (!byId.has("arrival_context_manual_event_gate")) {
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
  ignorePrevStateNull: false,
  ignorePrevStateUnknown: false,
  ignorePrevStateUnavailable: false,
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
}

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
  outputs: 3,
  timeout: 0,
  noerr: 0,
  initialize: "",
  finalize: "",
  libs: [],
  x: 650,
  y: 1000,
  wires: [
    ["vehicle_primary_refresh_mqtt_v1"],
    ["vehicle_primary_refresh_notification_guard_v1"],
    ["vehicle_primary_provider_bypass_command_v1"],
  ],
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
  id: "vehicle_primary_manual_blocked_route_out_v1",
  type: "link out",
  z: "c22d8b12055e87f7",
  g: "43a2bc9c218353ae",
  name: "Bloqueio manual → aviso",
  mode: "link",
  links: ["vehicle_primary_manual_blocked_route_in_v1"],
  x: 520,
  y: 740,
  wires: [],
});

upsert({
  id: "vehicle_primary_manual_blocked_route_in_v1",
  type: "link in",
  z: "c22d8b12055e87f7",
  g: "43a2bc9c218353ae",
  name: "Receber bloqueio manual",
  links: ["vehicle_primary_manual_blocked_route_out_v1"],
  x: 650,
  y: 940,
  wires: [["vehicle_primary_manual_refresh_blocked_notification_v1"]],
});

upsert({
  id: "vehicle_primary_post_refresh_route_out_v1",
  type: "link out",
  z: "c22d8b12055e87f7",
  g: "43a2bc9c218353ae",
  name: "Bluelink concluído → rechecagem",
  mode: "link",
  links: ["vehicle_primary_post_refresh_route_in_v1"],
  x: 1740,
  y: 700,
  wires: [],
});

upsert({
  id: "vehicle_primary_post_refresh_route_in_v1",
  type: "link in",
  z: "c22d8b12055e87f7",
  g: "43a2bc9c218353ae",
  name: "Receber rechecagem pós-refresh",
  mode: "link",
  links: ["vehicle_primary_post_refresh_route_out_v1"],
  x: 1160,
  y: 780,
  wires: [["ba55143f392aa361"]],
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
  y: 620,
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
  outputs: 4,
  timeout: 0,
  noerr: 0,
  initialize: "",
  finalize: "",
  libs: [],
  x: 1010,
  y: 1060,
  wires: [
    ["vehicle_primary_refresh_notify_primary_v1"],
    ["vehicle_primary_refresh_notify_persistent_v1"],
    ["vehicle_primary_refresh_notification_dry_run_out_v1"],
    ["vehicle_primary_refresh_dismiss_persistent_v1"],
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
  x: 1390,
  y: 1000,
  wires: [[]],
});

upsert({
  id: "vehicle_primary_refresh_notify_persistent_v1",
  type: "api-call-service",
  z: "c22d8b12055e87f7",
  g: "43a2bc9c218353ae",
  name: "Registrar alerta no Home Assistant",
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
  queue: "all",
  blockInputOverrides: true,
  domain: "persistent_notification",
  service: "create",
  x: 1390,
  y: 1060,
  wires: [[]],
});

upsert({
  id: "vehicle_primary_refresh_dismiss_persistent_v1",
  type: "api-call-service",
  z: "c22d8b12055e87f7",
  g: "43a2bc9c218353ae",
  name: "Remover alerta recuperado do Home Assistant",
  server: "4126427d5e161a03",
  version: 7,
  debugenabled: false,
  action: "persistent_notification.dismiss",
  floorId: [],
  areaId: [],
  deviceId: [],
  entityId: [],
  labelId: [],
  data: '{"notification_id":notification.id}',
  dataType: "jsonata",
  mergeContext: "",
  mustacheAltTags: false,
  outputProperties: [],
  queue: "all",
  blockInputOverrides: true,
  domain: "persistent_notification",
  service: "dismiss",
  x: 1210,
  y: 1140,
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
  x: 1390,
  y: 1120,
  wires: [],
});

upsert({
  id: "vehicle_primary_remote_request_group_v1",
  type: "group",
  z: "c22d8b12055e87f7",
  name: "6. Intenção, disponibilidade e efeito dos comandos remotos",
  style: {
    label: true,
    stroke: "#5b8ff9",
    color: "#a4a4a4",
  },
  nodes: [],
  x: 174,
  y: 1199,
  w: 2262,
  h: 302,
});

const remoteRequestSnapshot = (command) => `({
  "command":"${command}",
  "test_mode":false,
  "requested_at":$now(),
  "target":$entities("lock.vehicle_primary_door_lock"),
  "remote_status":$entities("sensor.garagem_vehicle_primary_remote_command_status"),
  "preconditions":{
    "front_left_door":$entities("binary_sensor.vehicle_primary_front_left_door"),
    "front_right_door":$entities("binary_sensor.vehicle_primary_front_right_door"),
    "back_left_door":$entities("binary_sensor.vehicle_primary_back_left_door"),
    "back_right_door":$entities("binary_sensor.vehicle_primary_back_right_door"),
    "trunk":$entities("binary_sensor.vehicle_primary_trunk"),
    "engine":$entities("binary_sensor.vehicle_primary_engine"),
    "lock":$entities("lock.vehicle_primary_door_lock"),
    "telemetry":$entities("sensor.vehicle_primary_last_updated_at")
  }
})`;

for (const [id, name, entityId, command, y] of [
  [
    "vehicle_primary_lock_intent_v1",
    "Dashboard solicitou TRAVAR",
    "input_button.vehicle_primary_lock_now",
    "lock",
    1260,
  ],
  [
    "vehicle_primary_unlock_intent_v1",
    "Dashboard solicitou DESTRAVAR",
    "input_button.vehicle_primary_unlock_now",
    "unlock",
    1320,
  ],
]) {
  upsert({
    id,
    type: "server-state-changed",
    z: "c22d8b12055e87f7",
    g: "vehicle_primary_remote_request_group_v1",
    name,
    server: "4126427d5e161a03",
    version: 6,
    outputs: 1,
    exposeAsEntityConfig: "",
    entities: { entity: [entityId], substring: [], regex: [] },
    outputInitially: false,
    stateType: "str",
    ifState: "",
    ifStateType: "str",
    ifStateOperator: "is",
    outputOnlyOnStateChange: true,
    for: "0",
    forType: "num",
    forUnits: "minutes",
    ignorePrevStateNull: false,
    ignorePrevStateUnknown: false,
    ignorePrevStateUnavailable: false,
    ignoreCurrentStateUnknown: true,
    ignoreCurrentStateUnavailable: true,
    outputProperties: [
      {
        property: "payload",
        propertyType: "msg",
        value: remoteRequestSnapshot(command),
        valueType: "jsonata",
      },
    ],
    x: 330,
    y,
    wires: [["vehicle_primary_remote_request_command_v1"]],
  });
}

upsert({
  id: "vehicle_primary_remote_request_test_in_v1",
  type: "link in",
  z: "c22d8b12055e87f7",
  g: "vehicle_primary_remote_request_group_v1",
  name: "Receber intenção remota de TESTE",
  links: ["vehicle_primary_remote_request_test_out_v1"],
  x: 325,
  y: 1380,
  wires: [["vehicle_primary_remote_request_command_v1"]],
});

upsert({
  id: "vehicle_primary_remote_request_command_v1",
  type: "switch",
  z: "c22d8b12055e87f7",
  g: "vehicle_primary_remote_request_group_v1",
  name: "Comando é TRAVAR ou DESTRAVAR?",
  property: "payload.command",
  propertyType: "msg",
  rules: [
    { t: "eq", v: "lock", vt: "str" },
    { t: "eq", v: "unlock", vt: "str" },
    { t: "else" },
  ],
  checkall: "true",
  repair: false,
  outputs: 3,
  x: 660,
  y: 1320,
  wires: [
    ["vehicle_primary_remote_target_available_v1"],
    ["vehicle_primary_remote_target_available_v1"],
    ["vehicle_primary_remote_request_invalid_v1"],
  ],
});

upsert({
  id: "vehicle_primary_remote_target_available_v1",
  type: "switch",
  z: "c22d8b12055e87f7",
  g: "vehicle_primary_remote_request_group_v1",
  name: "Fechadura está disponível?",
  property: "payload.target.state",
  propertyType: "msg",
  rules: [
    { t: "eq", v: "locked", vt: "str" },
    { t: "eq", v: "unlocked", vt: "str" },
    { t: "else" },
  ],
  checkall: "true",
  repair: false,
  outputs: 3,
  x: 940,
  y: 1300,
  wires: [
    ["vehicle_primary_remote_not_busy_v1"],
    ["vehicle_primary_remote_not_busy_v1"],
    ["vehicle_primary_remote_request_unavailable_v1"],
  ],
});

upsert({
  id: "vehicle_primary_remote_not_busy_v1",
  type: "switch",
  z: "c22d8b12055e87f7",
  g: "vehicle_primary_remote_request_group_v1",
  name: "Outro comando está em andamento?",
  property: "payload.remote_status.state",
  propertyType: "msg",
  rules: [
    { t: "eq", v: "requesting", vt: "str" },
    { t: "else" },
  ],
  checkall: "true",
  repair: false,
  outputs: 2,
  x: 1210,
  y: 1280,
  wires: [
    ["vehicle_primary_remote_request_busy_v1"],
    ["vehicle_primary_remote_test_mode_v1"],
  ],
});

upsert({
  id: "vehicle_primary_remote_test_mode_v1",
  type: "switch",
  z: "c22d8b12055e87f7",
  g: "vehicle_primary_remote_request_group_v1",
  name: "test_mode termina em dry-run?",
  property: "payload.test_mode",
  propertyType: "msg",
  rules: [{ t: "true" }, { t: "else" }],
  checkall: "true",
  repair: false,
  outputs: 2,
  x: 1490,
  y: 1260,
  wires: [
    ["vehicle_primary_remote_request_dry_run_v1"],
    ["vehicle_primary_remote_effect_select_v1"],
  ],
});

upsert({
  id: "vehicle_primary_remote_effect_select_v1",
  type: "switch",
  z: "c22d8b12055e87f7",
  g: "vehicle_primary_remote_request_group_v1",
  name: "Qual efeito remoto executar?",
  property: "payload.command",
  propertyType: "msg",
  rules: [
    { t: "eq", v: "lock", vt: "str" },
    { t: "eq", v: "unlock", vt: "str" },
    { t: "else" },
  ],
  checkall: "true",
  repair: false,
  outputs: 3,
  x: 1730,
  y: 1260,
  wires: [
    ["vehicle_primary_remote_request_call_v1"],
    ["vehicle_primary_remote_request_unlock_call_v1"],
    ["vehicle_primary_remote_effect_invalid_out_v1"],
  ],
});

upsert({
  id: "vehicle_primary_remote_effect_invalid_out_v1",
  type: "link out",
  z: "c22d8b12055e87f7",
  g: "vehicle_primary_remote_request_group_v1",
  name: "Efeito desconhecido → falhar fechado",
  mode: "link",
  links: ["vehicle_primary_remote_effect_invalid_in_v1"],
  x: 1975,
  y: 1200,
  wires: [],
});

upsert({
  id: "vehicle_primary_remote_effect_invalid_in_v1",
  type: "link in",
  z: "c22d8b12055e87f7",
  g: "vehicle_primary_remote_request_group_v1",
  name: "Receber efeito desconhecido",
  links: ["vehicle_primary_remote_effect_invalid_out_v1"],
  x: 705,
  y: 1440,
  wires: [["vehicle_primary_remote_request_invalid_v1"]],
});

upsert({
  id: "vehicle_primary_remote_request_call_v1",
  type: "api-call-service",
  z: "c22d8b12055e87f7",
  g: "vehicle_primary_remote_request_group_v1",
  name: "EFEITO: enviar TRAVAR ao Bluelink",
  server: "4126427d5e161a03",
  version: 7,
  debugenabled: false,
  action: "public_bindings.call",
  floorId: [],
  areaId: [],
  deviceId: [],
  entityId: [],
  labelId: [],
  data: '{"role":"vehicle_primary","action":"lock"}',
  dataType: "json",
  mergeContext: "",
  mustacheAltTags: false,
  outputProperties: [],
  queue: "none",
  blockInputOverrides: true,
  domain: "public_bindings",
  service: "call",
  x: 2000,
  y: 1240,
  wires: [["vehicle_primary_remote_request_accepted_v1"]],
});

upsert({
  id: "vehicle_primary_remote_request_unlock_call_v1",
  type: "api-call-service",
  z: "c22d8b12055e87f7",
  g: "vehicle_primary_remote_request_group_v1",
  name: "EFEITO: enviar DESTRAVAR ao Bluelink",
  server: "4126427d5e161a03",
  version: 7,
  debugenabled: false,
  action: "public_bindings.call",
  floorId: [],
  areaId: [],
  deviceId: [],
  entityId: [],
  labelId: [],
  data: '{"role":"vehicle_primary","action":"unlock"}',
  dataType: "json",
  mergeContext: "",
  mustacheAltTags: false,
  outputProperties: [],
  queue: "none",
  blockInputOverrides: true,
  domain: "public_bindings",
  service: "call",
  x: 2000,
  y: 1300,
  wires: [["vehicle_primary_remote_request_accepted_v1"]],
});

upsert({
  id: "vehicle_primary_remote_request_accepted_v1",
  type: "change",
  z: "c22d8b12055e87f7",
  g: "vehicle_primary_remote_request_group_v1",
  name: "Pedido entregue; aguardar resultado final",
  rules: [
    { t: "set", p: "payload.request_dispatched", pt: "msg", to: "true", tot: "bool" },
  ],
  action: "",
  property: "",
  from: "",
  to: "",
  reg: false,
  x: 2280,
  y: 1270,
  wires: [[]],
});

const remoteFailurePayload = (stage, reason) => `({
  "entity":{
    "state":"failed",
    "attributes":{
      "command":payload.command,
      "failure_stage":"${stage}",
      "reason":${reason},
      "failed_at":$now()
    }
  },
  "preconditions":payload.preconditions,
  "test_mode":payload.test_mode
})`;

for (const [id, name, stage, reason, x, y, outputId] of [
  [
    "vehicle_primary_remote_request_invalid_v1",
    "Falhar fechado: comando desconhecido",
    "validation",
    '"Comando remoto não reconhecido pela política canônica"',
    940,
    1440,
    "vehicle_primary_remote_request_invalid_out_v1",
  ],
  [
    "vehicle_primary_remote_request_unavailable_v1",
    "Falhar fechado: Bluelink indisponível",
    "preflight_availability",
    '"A fechadura do Bluelink está unavailable, unknown ou ausente"',
    1210,
    1380,
    "vehicle_primary_remote_request_unavailable_out_v1",
  ],
  [
    "vehicle_primary_remote_request_busy_v1",
    "Falhar fechado: comando já em andamento",
    "preflight_concurrency",
    '"Outro comando remoto ainda está em andamento"',
    1490,
    1380,
    "vehicle_primary_remote_request_busy_out_v1",
  ],
  [
    "vehicle_primary_remote_request_service_failure_v1",
    "Falhar fechado: chamada de serviço",
    "service_call",
    '$substring(error.message ? error.message : "Falha na chamada do serviço",0,220)',
    2000,
    1440,
    "vehicle_primary_remote_request_failure_out_v1",
  ],
]) {
  upsert({
    id,
    type: "change",
    z: "c22d8b12055e87f7",
    g: "vehicle_primary_remote_request_group_v1",
    name,
    rules: [
      {
        t: "set",
        p: "_vehicle_primary_remote_command_test",
        pt: "msg",
        to: "payload.test_mode",
        tot: "msg",
      },
      {
        t: "set",
        p: "payload",
        pt: "msg",
        to: remoteFailurePayload(stage, reason),
        tot: "jsonata",
      },
    ],
    action: "",
    property: "",
    from: "",
    to: "",
    reg: false,
    x,
    y,
    wires: [[outputId]],
  });
}

for (const [id, name, sourceId, x, y] of [
  [
    "vehicle_primary_remote_request_invalid_out_v1",
    "Comando inválido → resultado canônico",
    "vehicle_primary_remote_request_invalid_v1",
    1165,
    1440,
  ],
  [
    "vehicle_primary_remote_request_unavailable_out_v1",
    "Indisponível → resultado canônico",
    "vehicle_primary_remote_request_unavailable_v1",
    1465,
    1320,
  ],
  [
    "vehicle_primary_remote_request_busy_out_v1",
    "Concorrência → resultado canônico",
    "vehicle_primary_remote_request_busy_v1",
    1745,
    1380,
  ],
]) {
  upsert({
    id,
    type: "link out",
    z: "c22d8b12055e87f7",
    g: "vehicle_primary_remote_request_group_v1",
    name,
    mode: "link",
    links: ["vehicle_primary_remote_request_failure_in_v1"],
    x,
    y,
    wires: [],
  });
}

upsert({
  id: "vehicle_primary_remote_request_call_catch_v1",
  type: "catch",
  z: "c22d8b12055e87f7",
  g: "vehicle_primary_remote_request_group_v1",
  name: "Capturar falha antes do aceite",
  scope: [
    "vehicle_primary_remote_request_call_v1",
    "vehicle_primary_remote_request_unlock_call_v1",
  ],
  uncaught: false,
  x: 1730,
  y: 1440,
  wires: [["vehicle_primary_remote_request_service_failure_v1"]],
});

upsert({
  id: "vehicle_primary_remote_request_failure_out_v1",
  type: "link out",
  z: "c22d8b12055e87f7",
  g: "vehicle_primary_remote_request_group_v1",
  name: "Falha prévia → resultado canônico",
  mode: "link",
  links: ["vehicle_primary_remote_request_failure_in_v1"],
  x: 2305,
  y: 1440,
  wires: [],
});

upsert({
  id: "vehicle_primary_remote_request_dry_run_v1",
  type: "change",
  z: "c22d8b12055e87f7",
  g: "vehicle_primary_remote_request_group_v1",
  name: "Terminal: simular sem enviar ao veículo",
  rules: [
    { t: "set", p: "payload.simulated", pt: "msg", to: "true", tot: "bool" },
    { t: "set", p: "payload.dispatched", pt: "msg", to: "false", tot: "bool" },
    { t: "set", p: "payload.side_effect", pt: "msg", to: "vehicle_remote_command", tot: "str" },
  ],
  action: "",
  property: "",
  from: "",
  to: "",
  reg: false,
  x: 1970,
  y: 1360,
  wires: [["vehicle_primary_remote_request_dry_run_out_v1"]],
});

upsert({
  id: "vehicle_primary_remote_request_dry_run_out_v1",
  type: "link out",
  z: "c22d8b12055e87f7",
  g: "vehicle_primary_remote_request_group_v1",
  name: "Comando TESTE → terminal dry-run",
  mode: "link",
  links: ["vehicle_primary_dry_run_in_v1"],
  x: 2305,
  y: 1360,
  wires: [],
});

upsert({
  id: "vehicle_primary_remote_command_group_v1",
  type: "group",
  z: "c22d8b12055e87f7",
  name: "7. Resultado final dos comandos remotos",
  style: {
    label: true,
    stroke: "#5b8ff9",
    color: "#a4a4a4",
  },
  nodes: [],
  x: 2658,
  y: 1199,
  w: 1306,
  h: 302,
});

upsert({
  id: "vehicle_primary_remote_command_event_v1",
  type: "server-state-changed",
  z: "c22d8b12055e87f7",
  g: "vehicle_primary_remote_command_group_v1",
  name: "Resultado remoto mudou",
  server: "4126427d5e161a03",
  version: 6,
  outputs: 1,
  exposeAsEntityConfig: "",
  entities: {
    entity: ["sensor.garagem_vehicle_primary_remote_command_status"],
    substring: [],
    regex: [],
  },
  outputInitially: false,
  stateType: "str",
  ifState: "failed",
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
    {
      property: "payload",
      propertyType: "msg",
      value: `({
        "entity": $entities("sensor.garagem_vehicle_primary_remote_command_status"),
        "preconditions": {
          "front_left_door": $entities("binary_sensor.vehicle_primary_front_left_door"),
          "front_right_door": $entities("binary_sensor.vehicle_primary_front_right_door"),
          "back_left_door": $entities("binary_sensor.vehicle_primary_back_left_door"),
          "back_right_door": $entities("binary_sensor.vehicle_primary_back_right_door"),
          "trunk": $entities("binary_sensor.vehicle_primary_trunk"),
          "engine": $entities("binary_sensor.vehicle_primary_engine"),
          "lock": $entities("lock.vehicle_primary_door_lock"),
          "telemetry": $entities("sensor.vehicle_primary_last_updated_at")
        }
      })`,
      valueType: "jsonata",
    },
  ],
  x: 390,
  y: 1260,
  wires: [["vehicle_primary_remote_command_monitor_v1"]],
});

upsert({
  id: "vehicle_primary_remote_command_test_in_v1",
  type: "link in",
  z: "c22d8b12055e87f7",
  g: "vehicle_primary_remote_command_group_v1",
  name: "Receber resultado remoto de TESTE",
  links: ["vehicle_primary_remote_command_test_out_v1"],
  x: 385,
  y: 1340,
  wires: [["vehicle_primary_remote_command_monitor_v1"]],
});

upsert({
  id: "vehicle_primary_remote_request_failure_in_v1",
  type: "link in",
  z: "c22d8b12055e87f7",
  g: "vehicle_primary_remote_command_group_v1",
  name: "Receber falha anterior ao provedor",
  links: [
    "vehicle_primary_remote_request_failure_out_v1",
    "vehicle_primary_remote_request_invalid_out_v1",
    "vehicle_primary_remote_request_unavailable_out_v1",
    "vehicle_primary_remote_request_busy_out_v1",
  ],
  x: 385,
  y: 1400,
  wires: [["vehicle_primary_remote_command_monitor_v1"]],
});

upsert({
  id: "vehicle_primary_remote_command_monitor_v1",
  type: "function",
  z: "c22d8b12055e87f7",
  g: "vehicle_primary_remote_command_group_v1",
  name: "Classificar, deduplicar e compor alerta",
  func: source("vehicle-primary-remote-command-monitor.js"),
  outputs: 1,
  timeout: 0,
  noerr: 0,
  initialize: "",
  finalize: "",
  libs: [],
  x: 710,
  y: 1300,
  wires: [["vehicle_primary_remote_command_guard_v1"]],
});

upsert({
  id: "vehicle_primary_remote_command_guard_v1",
  type: "function",
  z: "c22d8b12055e87f7",
  g: "vehicle_primary_remote_command_group_v1",
  name: "Separar notificações reais e dry-run",
  func: source("vehicle-primary-remote-command-dispatch-guard.js"),
  outputs: 3,
  timeout: 0,
  noerr: 0,
  initialize: "",
  finalize: "",
  libs: [],
  x: 1040,
  y: 1300,
  wires: [
    ["vehicle_primary_remote_command_notify_primary_v1"],
    ["vehicle_primary_remote_command_notify_persistent_v1"],
    ["vehicle_primary_remote_command_dry_run_out_v1"],
  ],
});

upsert({
  id: "vehicle_primary_remote_command_notify_primary_v1",
  type: "api-call-service",
  z: "c22d8b12055e87f7",
  g: "vehicle_primary_remote_command_group_v1",
  name: "Avisar falha no celular",
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
  x: 1350,
  y: 1260,
  wires: [[]],
});

upsert({
  id: "vehicle_primary_remote_command_notify_persistent_v1",
  type: "api-call-service",
  z: "c22d8b12055e87f7",
  g: "vehicle_primary_remote_command_group_v1",
  name: "Criar aviso persistente no Home Assistant",
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
  queue: "all",
  blockInputOverrides: true,
  domain: "persistent_notification",
  service: "create",
  x: 1430,
  y: 1320,
  wires: [[]],
});

upsert({
  id: "vehicle_primary_remote_command_dry_run_out_v1",
  type: "link out",
  z: "c22d8b12055e87f7",
  g: "vehicle_primary_remote_command_group_v1",
  name: "Alertas remotos TESTE → terminal dry-run",
  mode: "link",
  links: ["vehicle_primary_dry_run_in_v1"],
  x: 1395,
  y: 1380,
  wires: [],
});

upsert({
  id: "vehicle_primary_remote_command_architecture_v1",
  type: "comment",
  z: "c22d8b12055e87f7",
  g: "vehicle_primary_remote_command_group_v1",
  name: "Aceite do request não basta: somente failed final gera alerta; celular e Notifications recebem o mesmo incidente deduplicado",
  info: "",
  x: 840,
  y: 1440,
  wires: [],
});

upsert({
  id: "vehicle_primary_remote_command_test_group_v1",
  type: "group",
  z: "c22d8b12055e87f7",
  name: "8. TESTE — resultado remoto sem efeitos",
  style: {
    label: true,
    stroke: "#ffb300",
    color: "#a4a4a4",
  },
  nodes: [],
  x: 1234,
  y: 1619,
  w: 602,
  h: 422,
});

upsert({
  id: "vehicle_primary_remote_command_test_help_v1",
  type: "comment",
  z: "c22d8b12055e87f7",
  g: "vehicle_primary_remote_command_test_group_v1",
  name: "1) RESETAR  2) sucesso nominal não alerta  3) falha chega ao terminal dry-run",
  info: "",
  x: 1530,
  y: 1660,
  wires: [],
});

for (const [id, name, y, payload] of [
  [
    "vehicle_primary_remote_command_test_reset_v1",
    "RESETAR teste de comando remoto",
    1720,
    { event: "reset", test_mode: true },
  ],
  [
    "vehicle_primary_remote_command_test_success_v1",
    "TESTE: comando confirmado",
    1780,
    {
      test_mode: true,
      state: "accepted",
      attributes: {
        command: "unlock",
        result_stage: "confirmed",
        updated_at: "test-success",
      },
      preconditions: {
        front_left_door: { state: "off" },
        front_right_door: { state: "off" },
        back_left_door: { state: "off" },
        back_right_door: { state: "off" },
        trunk: { state: "off" },
        engine: { state: "off" },
        lock: { state: "unlocked" },
        telemetry: { state: "2026-08-17T02:59:00Z" },
      },
    },
  ],
  [
    "vehicle_primary_remote_command_test_failure_v1",
    "TESTE: falha assíncrona",
    1840,
    {
      test_mode: true,
      state: "failed",
      attributes: {
        command: "lock",
        failure_stage: "confirmation",
        reason: "falha simulada após o aceite",
        updated_at: "test-failure",
      },
      preconditions: {
        front_left_door: { state: "off" },
        front_right_door: { state: "off" },
        back_left_door: { state: "on" },
        back_right_door: { state: "off" },
        trunk: { state: "off" },
        engine: { state: "off" },
        lock: { state: "unlocked" },
        telemetry: { state: "2026-08-17T02:45:00Z" },
      },
    },
  ],
]) {
  upsert({
    id,
    type: "inject",
    z: "c22d8b12055e87f7",
    g: "vehicle_primary_remote_command_test_group_v1",
    name,
    props: [{ p: "payload" }, { p: "_vehicle_primary_remote_command_test", v: "true", vt: "bool" }],
    repeat: "",
    crontab: "",
    once: false,
    onceDelay: 0.1,
    topic: "",
    payload: JSON.stringify(payload),
    payloadType: "json",
    x: 1420,
    y,
    wires: [["vehicle_primary_remote_command_test_out_v1"]],
  });
}

upsert({
  id: "vehicle_primary_remote_command_test_out_v1",
  type: "link out",
  z: "c22d8b12055e87f7",
  g: "vehicle_primary_remote_command_test_group_v1",
  name: "Resultado TESTE → monitor remoto",
  mode: "link",
  links: ["vehicle_primary_remote_command_test_in_v1"],
  x: 1745,
  y: 1780,
  wires: [],
});

const remoteRequestTestPreconditions = {
  front_left_door: { state: "off" },
  front_right_door: { state: "off" },
  back_left_door: { state: "off" },
  back_right_door: { state: "off" },
  trunk: { state: "off" },
  engine: { state: "off" },
  lock: { state: "unlocked" },
  telemetry: { state: "2026-08-17T02:59:00Z" },
};
for (const [id, name, y, targetState] of [
  [
    "vehicle_primary_remote_request_test_available_v1",
    "TESTE: intenção com alvo disponível",
    1900,
    "unlocked",
  ],
  [
    "vehicle_primary_remote_request_test_unavailable_v1",
    "TESTE: intenção com alvo unavailable",
    1960,
    "unavailable",
  ],
]) {
  upsert({
    id,
    type: "inject",
    z: "c22d8b12055e87f7",
    g: "vehicle_primary_remote_command_test_group_v1",
    name,
    props: [
      { p: "payload" },
      { p: "_vehicle_primary_remote_command_test", v: "true", vt: "bool" },
    ],
    repeat: "",
    crontab: "",
    once: false,
    onceDelay: 0.1,
    topic: "",
    payload: JSON.stringify({
      command: "lock",
      test_mode: true,
      requested_at: "test-request",
      target: { state: targetState },
      remote_status: { state: "idle" },
      preconditions: remoteRequestTestPreconditions,
    }),
    payloadType: "json",
    x: 1420,
    y,
    wires: [["vehicle_primary_remote_request_test_out_v1"]],
  });
}

upsert({
  id: "vehicle_primary_remote_request_test_out_v1",
  type: "link out",
  z: "c22d8b12055e87f7",
  g: "vehicle_primary_remote_command_test_group_v1",
  name: "Intenção TESTE → política remota",
  mode: "link",
  links: ["vehicle_primary_remote_request_test_in_v1"],
  x: 1745,
  y: 1930,
  wires: [],
});

addToGroup(
  "vehicle_primary_remote_request_group_v1",
  "vehicle_primary_lock_intent_v1",
  "vehicle_primary_unlock_intent_v1",
  "vehicle_primary_remote_request_test_in_v1",
  "vehicle_primary_remote_request_command_v1",
  "vehicle_primary_remote_target_available_v1",
  "vehicle_primary_remote_not_busy_v1",
  "vehicle_primary_remote_test_mode_v1",
  "vehicle_primary_remote_effect_select_v1",
  "vehicle_primary_remote_effect_invalid_out_v1",
  "vehicle_primary_remote_effect_invalid_in_v1",
  "vehicle_primary_remote_request_call_v1",
  "vehicle_primary_remote_request_unlock_call_v1",
  "vehicle_primary_remote_request_accepted_v1",
  "vehicle_primary_remote_request_invalid_v1",
  "vehicle_primary_remote_request_unavailable_v1",
  "vehicle_primary_remote_request_busy_v1",
  "vehicle_primary_remote_request_service_failure_v1",
  "vehicle_primary_remote_request_invalid_out_v1",
  "vehicle_primary_remote_request_unavailable_out_v1",
  "vehicle_primary_remote_request_busy_out_v1",
  "vehicle_primary_remote_request_call_catch_v1",
  "vehicle_primary_remote_request_failure_out_v1",
  "vehicle_primary_remote_request_dry_run_v1",
  "vehicle_primary_remote_request_dry_run_out_v1",
);

addToGroup(
  "vehicle_primary_remote_command_group_v1",
  "vehicle_primary_remote_command_event_v1",
  "vehicle_primary_remote_command_test_in_v1",
  "vehicle_primary_remote_request_failure_in_v1",
  "vehicle_primary_remote_command_monitor_v1",
  "vehicle_primary_remote_command_guard_v1",
  "vehicle_primary_remote_command_notify_primary_v1",
  "vehicle_primary_remote_command_notify_persistent_v1",
  "vehicle_primary_remote_command_dry_run_out_v1",
  "vehicle_primary_remote_command_architecture_v1",
);
addToGroup(
  "vehicle_primary_remote_command_test_group_v1",
  "vehicle_primary_remote_command_test_help_v1",
  "vehicle_primary_remote_command_test_reset_v1",
  "vehicle_primary_remote_command_test_success_v1",
  "vehicle_primary_remote_command_test_failure_v1",
  "vehicle_primary_remote_command_test_out_v1",
  "vehicle_primary_remote_request_test_available_v1",
  "vehicle_primary_remote_request_test_unavailable_v1",
  "vehicle_primary_remote_request_test_out_v1",
);

addToGroup(
  "vehicle_primary_refresh_config_group_v1",
  "vehicle_primary_refresh_config_help_v1",
  "vehicle_primary_refresh_arrival_armed_minutes_v1",
  "vehicle_primary_refresh_approaching_minutes_v1",
  "vehicle_primary_refresh_away_minutes_v1",
  "vehicle_primary_refresh_home_minutes_v1",
  "vehicle_primary_refresh_quiet_start_v1",
  "vehicle_primary_refresh_quiet_end_v1",
  "vehicle_primary_refresh_policy_config_apply_v1",
);
addToGroup(
  "vehicle_primary_refresh_policy_group_v1",
  "25ca02f8c1de32d0",
  "vehicle_primary_arrival_refresh_in_v1",
  "vehicle_primary_refresh_policy_select_v1",
  "vehicle_primary_refresh_use_arrival_armed_interval_v1",
  "vehicle_primary_refresh_use_approaching_interval_v1",
  "vehicle_primary_refresh_use_away_interval_v1",
  "vehicle_primary_refresh_use_home_interval_v1",
  "vehicle_primary_refresh_use_unknown_interval_v1",
  "vehicle_primary_refresh_quiet_hours_v1",
  "vehicle_primary_refresh_policy_out_v1",
);

if (byId.has("790bea5f55d43bd0")) {
  addToGroup(
    "790bea5f55d43bd0",
    "vehicle_primary_manual_refresh_button_v1",
    "vehicle_primary_manual_refresh_request_v1",
  );
}
addToGroup(
  "43a2bc9c218353ae",
  "vehicle_primary_refresh_dispatch_guard_v1",
  "vehicle_primary_cache_probe_dispatch_guard_v1",
  "vehicle_primary_cache_probe_call_v1",
  "vehicle_primary_cache_probe_accepted_v1",
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
  "vehicle_primary_manual_blocked_route_out_v1",
  "vehicle_primary_manual_blocked_route_in_v1",
  "vehicle_primary_post_refresh_route_out_v1",
  "vehicle_primary_post_refresh_route_in_v1",
  "vehicle_primary_refresh_notification_requested_out_v1",
  "vehicle_primary_refresh_error_notification_out_v1",
  "vehicle_primary_refresh_notification_in_v1",
  "vehicle_primary_refresh_notification_guard_v1",
  "vehicle_primary_refresh_notify_primary_v1",
  "vehicle_primary_refresh_notify_persistent_v1",
  "vehicle_primary_refresh_dismiss_persistent_v1",
  "vehicle_primary_refresh_notification_dry_run_out_v1",
  "vehicle_primary_api_error_bypass_out_v1",
  "vehicle_primary_api_error_bypass_in_v1",
  "vehicle_primary_provider_backoff_state_v1",
  "vehicle_primary_provider_backoff_sync_v1",
  "vehicle_primary_provider_bypass_command_v1",
  "vehicle_primary_refresh_policy_in_v1",
);

const refreshGroup = required("43a2bc9c218353ae");
refreshGroup.nodes = (refreshGroup.nodes ?? []).filter(
  (id) => ![
    "25ca02f8c1de32d0",
    "vehicle_primary_arrival_refresh_in_v1",
  ].includes(id),
);
refreshGroup.name = "5. Execução do refresh e viagens";
Object.assign(refreshGroup, { x: 174, y: 579, w: 1662, h: 618 });

const remoteCommandGroup = required("vehicle_primary_remote_command_group_v1");
remoteCommandGroup.name = "7. Resultado final dos comandos remotos";
const remoteCommandShiftX = remoteCommandGroup.x - 174;
const remoteCommandShift = 1259 - remoteCommandGroup.y;
remoteCommandGroup.y += remoteCommandShift;
for (const id of remoteCommandGroup.nodes ?? []) {
  const node = required(id);
  node.x += remoteCommandShiftX;
  node.y += remoteCommandShift;
}

const remoteRequestGroup = required("vehicle_primary_remote_request_group_v1");
remoteRequestGroup.y += 140;
for (const id of remoteRequestGroup.nodes ?? []) {
  required(id).y += 140;
}

const manualTestGroup = required("5df25064f701ecd2");
manualTestGroup.name = "8. Testes manuais — motor e localização sintéticos/cumulativos";
const manualTestShift = Math.max(0, 1619 - manualTestGroup.y);
if (manualTestShift > 0) {
  manualTestGroup.y += manualTestShift;
  for (const id of manualTestGroup.nodes ?? []) {
    const node = required(id);
    node.y += manualTestShift;
  }
}

const remoteCommandTestGroup = required("vehicle_primary_remote_command_test_group_v1");
remoteCommandTestGroup.name = "9. TESTE — intenções e resultado remoto sem efeitos";
remoteCommandTestGroup.y += 80;
for (const id of remoteCommandTestGroup.nodes ?? []) {
  required(id).y += 80;
}
const refreshOrchestrationGroup = required("vehicle_visual_refresh_decision_group_v2");
refreshOrchestrationGroup.name =
  "10. Orquestração visual do refresh — gates, cooldown, cache e dry-run";

const immediateRecovery = required("6473697c19342f07");
Object.assign(immediateRecovery, { x: 570, y: 240 });

fs.writeFileSync(flowOutputPath, `${JSON.stringify(installNotificationHubs(flows), null, 4)}\n`);
console.log("Controles e telemetria do vehicle_primary instalados sem duplicar o coordenador.");
