#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { reconcileGeneratedFlows } from "./reconcile-generated-flows.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const inputPath = path.resolve(process.argv[2] ?? path.resolve(here, "..", "flows.json"));
const outputPath = path.resolve(process.argv[3] ?? inputPath);
const functionsDir = path.join(here, "functions");
const PEOPLE_TAB = "ea0a6aa0d24ff863";
const VEHICLE_TAB = "c22d8b12055e87f7";
let flows = JSON.parse(fs.readFileSync(inputPath, "utf8"));
const originalFlows = structuredClone(flows);
const source = (name) => fs.readFileSync(path.join(functionsDir, name), "utf8").trimEnd();
const generated = new Set(flows.filter((node) =>
  node.id.startsWith("people_visual_") || node.id.startsWith("vehicle_visual_") ||
  node.id === "people_location_lifecycle_config_group_v2" ||
  node.id === "people_location_fast_refresh_radius_v1"
).map((node) => node.id));
for (const node of flows) {
  const route = node.notification_hub_wire_route;
  if (route && (generated.has(route.source) || generated.has(route.target))) {
    generated.add(node.id);
  }
}
flows = flows.filter((node) => !generated.has(node.id));
for (const node of flows) {
  for (const field of ["nodes", "scope", "links"]) {
    if (Array.isArray(node[field])) node[field] = node[field].filter((id) => !generated.has(id));
  }
  if (Array.isArray(node.wires)) {
    node.wires = node.wires.map((wire) => Array.isArray(wire)
      ? wire.filter((id) => !generated.has(id)) : wire);
  }
}
const byId = new Map(flows.map((node) => [node.id, node]));
const required = (id) => {
  const node = byId.get(id);
  if (!node) throw new Error(`Nó obrigatório ausente: ${id}`);
  return node;
};
const add = (node) => { flows.push(node); byId.set(node.id, node); return node; };
const moveGroup = (id, x, y) => {
  const target = required(id);
  const dx = x - target.x;
  const dy = y - target.y;
  target.x = x; target.y = y;
  for (const nodeId of target.nodes ?? []) {
    const node = required(nodeId);
    if (Number.isFinite(node.x)) node.x += dx;
    if (Number.isFinite(node.y)) node.y += dy;
  }
};
const group = (id, name, x, y, w, h, stroke = "#2563eb", fill = "#dbeafe", z = PEOPLE_TAB) =>
  add({ id, type: "group", z, name, style: {
    label: true, "label-position": "nw", color: "#1f2937", stroke,
    "stroke-opacity": "1", fill, "fill-opacity": "0.35"
  }, nodes: [], x, y, w, h });
const grouped = (g, node) => { add(node); required(g).nodes.push(node.id); return node; };
const fn = (id, g, name, file, outputs, x, y, wires) => grouped(g, {
  id, type: "function", z: PEOPLE_TAB, g, name, func: source(file), outputs,
  timeout: 0, noerr: 0, initialize: "", finalize: "", libs: [], x, y, wires
});
const sw = (id, g, name, property, propertyType, rules, checkall, x, y, wires) => grouped(g, {
  id, type: "switch", z: PEOPLE_TAB, g, name, property, propertyType,
  rules, checkall, repair: false, outputs: rules.length, x, y, wires
});
const linkOut = (id, g, name, target, x, y) => grouped(g, {
  id, type: "link out", z: PEOPLE_TAB, g, name, mode: "link",
  links: [target], x, y, wires: []
});
const linkIn = (id, g, name, origins, destination, x, y) => grouped(g, {
  id, type: "link in", z: PEOPLE_TAB, g, name, links: origins,
  x, y, wires: [[destination]]
});
const inject = (id, g, name, topic, payload, x, y, destination) => grouped(g, {
  id, type: "inject", z: PEOPLE_TAB, g, name,
  props: [{ p: "payload" }, { p: "topic", vt: "str" }],
  repeat: "", crontab: "", once: true, onceDelay: "0.5",
  topic, payload: String(payload), payloadType: "num", x, y,
  wires: [[destination]]
});

required("402fd0cc609443b7").func = source("people-refresh-decide.js");
required("people_location_publish_state_v1").func = source("people-location-publish.js");
required("b35563e0f73e5b64").name =
  "3. Localização nativa + fallback dos iPhones (máx. 2/h)";
Object.assign(required("b35563e0f73e5b64"), { h: 382 });
linkIn("people_visual_arrival_refresh_in", "b35563e0f73e5b64",
  "Refresh da chegada por morador", ["security_visual_people_refresh_out"],
  "people_visual_arrival_refresh_dispatch", 100, 1030);
fn("people_visual_arrival_refresh_dispatch", "b35563e0f73e5b64",
  "Direcionar somente ao iPhone da chegada", "people-arrival-refresh-dispatch.js", 2,
  330, 1030, [["564fdc36031eaef8"], ["e0b7c0ecf1d8ee28"]]);

const config = group(
  "people_location_lifecycle_config_group_v2",
  "0b. Tempos de lifecycle — padrão, unidade e limites no nome",
  2150, 59, 1190, 382, "#7c3aed", "#ede9fe"
);
grouped(config.id, {
  id: "people_visual_lifecycle_help", type: "comment", z: PEOPLE_TAB, g: config.id,
  name: "Valores inválidos são rejeitados; a última política válida permanece ativa para todos os consumidores.",
  info: "Dedupe: 1–60 min; graça: 1–60 min; retorno local: 15–180 min; ciclo externo: 15–600 s; futuro: 0–300 s; sinais: 1–30 min; recovery: 1–168 h.",
  x: 2740, y: 100, wires: []
});
inject("people_visual_arrival_dedupe_config", config.id, "Dedupe chegada — 10 min [1..60]", "arrival_dedupe_minutes", 10, 2370, 160, "people_visual_lifecycle_config_left_out");
inject("people_visual_primary_home_grace", config.id, "Graça home — 10 min [1..60]", "primary_home_grace_minutes", 10, 2370, 210, "people_visual_lifecycle_config_left_out");
inject("people_visual_local_excursion", config.id, "Retorno local — 90 min [15..180]", "local_excursion_minutes", 90, 2370, 260, "people_visual_lifecycle_config_left_out");
inject("people_visual_future_tolerance", config.id, "Tolerância futura — 60 s [0..300]", "future_tolerance_seconds", 60, 2740, 160, "people_visual_lifecycle_config_middle_out");
inject("people_visual_vehicle_signal_fresh", config.id, "Sinal do veículo — 5 min [1..30]", "vehicle_signal_fresh_minutes", 5, 2740, 210, "people_visual_lifecycle_config_middle_out");
const nearHomeRefresh = inject("people_visual_near_home_refresh", config.id,
  "Refresh near_home — 10 min [3..14]", "near_home_refresh_minutes", 10,
  2740, 260, "people_visual_lifecycle_config_middle_out");
nearHomeRefresh.onceDelay = "1.6";
inject("people_visual_vehicle_recovery", config.id, "Recovery veículo — 24 h [1..168]", "vehicle_recovery_hours", 24, 3110, 160, "people_visual_lifecycle_config_right_out");
inject("people_visual_external_confirm", config.id, "Confirmar ciclo externo — 60 s [15..600]", "external_cycle_confirm_seconds", 60, 3110, 210, "people_visual_lifecycle_config_right_out");
linkOut("people_visual_lifecycle_config_left_out", config.id, "Tempos de chegada → política", "people_location_values_route_in_v1", 2550, 330);
linkOut("people_visual_lifecycle_config_middle_out", config.id, "Validade → política", "people_location_values_route_in_v1", 2920, 330);
linkOut("people_visual_lifecycle_config_right_out", config.id, "Recovery → política", "people_location_values_route_in_v1", 3290, 330);

const policyIn = required("people_location_values_route_in_v1");
policyIn.x = 900;
policyIn.y = 300;
policyIn.links = Array.from(new Set([...(policyIn.links ?? []),
  "people_visual_lifecycle_config_left_out",
  "people_visual_lifecycle_config_middle_out",
  "people_visual_lifecycle_config_right_out"
]));
policyIn.wires = [["people_visual_policy_validate"]];
const policyGroup = required("people_location_policy_group_v1");
policyGroup.x = 64;
policyGroup.y = 59;
policyGroup.w = 1510;
policyGroup.h = 342;
policyGroup.nodes = policyGroup.nodes.filter((id) => id !== "people_location_policy_apply_v1");
Object.assign(required("people_location_recovery_minutes_v1"), {
  name: "Reter chegada — 15 min", payload: "15", onceDelay: "1.5"
});
const store = required("people_location_policy_apply_v1");
store.name = "Guardar última política válida";
store.func = source("location-policy-store.js");
store.outputs = 1;
store.x = 1300;
store.y = 180;
store.wires = store.wires?.length ? store.wires : [["people_location_policy_out_v1"]];
store.g = policyGroup.id;
policyGroup.nodes.push(store.id);
fn("people_visual_policy_validate", policyGroup.id, "Validar valor, unidade e limites", "location-policy-validate.js", 2, 1140, 340,
  [["people_location_policy_apply_v1"], ["people_visual_policy_reject"]]);
fn("people_visual_policy_reject", policyGroup.id, "Rejeitar sem substituir", "location-policy-reject.js", 0, 1400, 360, []);
Object.assign(required("people_location_policy_out_v1"), { x: 1530, y: 180 });
moveGroup("global_observer_coverage__ea0a6aa0d24ff863__group", 3400, 59);

const selectionGroup = required("people_location_selection_group_v1");
selectionGroup.x = 620;
selectionGroup.y = 419;
selectionGroup.w = 1390;
selectionGroup.h = 302;

const lifecycle = required("8e1c3a19399ad44d");
lifecycle.name = "3. Lifecycle visual de presença e chegada canônica";
lifecycle.x = 2050;
lifecycle.y = 419;
lifecycle.w = 3400;
lifecycle.h = 322;
lifecycle.nodes = lifecycle.nodes.filter((id) => !generated.has(id));
Object.assign(required("people_arrival_direction_note_v1"), {
  name: "RETORNO: away→near_home; salto away→home recuperado; SAÍDA bloqueada",
  x: 2700,
  y: 700,
});
const input = required("people_location_to_normalizer_in_v1");
input.x = 2120; input.y = 560; input.wires = [["people_visual_test_adapter"]];
fn("people_visual_test_adapter", lifecycle.id, "Adaptar somente o estado sintético", "people-lifecycle-test-adapter.js", 1, 2360, 560, [["people_visual_normalize"]]);
fn("people_visual_normalize", lifecycle.id, "Normalizar decisão canônica em fatos", "people-lifecycle-normalize.js", 1, 2670, 560, [["people_visual_state_load"]]);
fn("people_visual_state_load", lifecycle.id, "Recuperar armamento e dedupe", "people-lifecycle-state-load.js", 1, 3000, 560, [["people_visual_facts"]]);
fn("people_visual_facts", lifecycle.id, "Derivar direção, proximidade e validade", "people-lifecycle-facts.js", 1, 3330, 560, [["people_visual_decision"]]);
const arrivalRule = '_people.is_location_event = true and _people.facts.source_ready = true and _people.facts.trigger_prev_valid = true and _people.facts.departure != true and _people.facts.stale_catchup != true and _people.facts.external_cycle_confirmed = true and (_people.facts.approach_entry = true or _people.facts.near_home = true)';
const recoveryRule = '_people.is_location_event = true and _people.facts.source_ready = true and _people.facts.trigger_prev_unavailable = true and _people.trigger_state = "near_home" and _people.people[_people.source].current_home != true and _people.facts.external_cycle_confirmed = true';
const blockedRule = '_people.is_location_event = true and _people.facts.directional_candidate = true';
sw("people_visual_decision", lifecycle.id, "Qual caminho de chegada é válido?", arrivalRule, "jsonata", [
  { t: "true" }, { t: "else" }
], "false", 3690, 480, [["people_visual_arrival_gate"], ["people_visual_recovery_gate"]]);
sw("people_visual_recovery_gate", lifecycle.id, "Recovery após unavailable é legítimo?", recoveryRule, "jsonata", [
  { t: "true" }, { t: "else" }
], "false", 3690, 560, [["people_visual_recovery_build"], ["people_visual_blocked_gate"]]);
sw("people_visual_blocked_gate", lifecycle.id, "Transição direcional foi bloqueada?", blockedRule, "jsonata", [
  { t: "true" }, { t: "else" }
], "false", 3690, 640, [["people_visual_blocked_build"], ["people_visual_unchanged_out"]]);
fn("people_visual_arrival_gate", lifecycle.id, "Montar retorno confirmado", "people-lifecycle-arrival-build.js", 1, 4070, 480, [["people_visual_arrival_dedupe"]]);
fn("people_visual_recovery_build", lifecycle.id, "Montar recovery só para iluminação", "people-lifecycle-recovery-build.js", 1, 4070, 560, [["people_visual_recovery_dedupe"]]);
fn("people_visual_blocked_build", lifecycle.id, "Registrar motivo do bloqueio", "people-lifecycle-blocked-build.js", 1, 4070, 640, [["people_visual_blocked_out"]]);
fn("people_visual_arrival_dedupe", lifecycle.id, "Deduplicar retorno pelo evento", "people-lifecycle-dedupe.js", 1, 4400, 480, [["people_visual_arrival_out"]]);
fn("people_visual_recovery_dedupe", lifecycle.id, "Deduplicar recovery pelo evento", "people-lifecycle-dedupe.js", 1, 4400, 560, [["people_visual_recovery_out"]]);
linkOut("people_visual_arrival_out", lifecycle.id, "Retorno → estado canônico", "people_visual_finalize_in", 4620, 480);
linkOut("people_visual_recovery_out", lifecycle.id, "Recovery → estado canônico", "people_visual_finalize_in", 4620, 540);
linkOut("people_visual_blocked_out", lifecycle.id, "Bloqueio → estado canônico", "people_visual_finalize_in", 4400, 640);
linkOut("people_visual_unchanged_out", lifecycle.id, "Sem chegada → estado canônico", "people_visual_finalize_in", 4070, 700);
linkIn("people_visual_finalize_in", lifecycle.id, "Convergir exatamente um caminho", [
  "people_visual_arrival_out", "people_visual_recovery_out",
  "people_visual_blocked_out", "people_visual_unchanged_out"
], "554cb653b2fa4504", 4680, 590);
const finalizer = required("554cb653b2fa4504");
const notificationOut = required("people_location_notification_out_v1");
const peopleClassifier = required("people_location_classify_near_home_v1");
peopleClassifier.wires = (peopleClassifier.wires ?? []).map((wire) =>
  Array.isArray(wire) ? wire.filter((id) => id !== notificationOut.id) : wire
);
for (const candidate of flows.filter((node) => node.type === "group")) {
  if (candidate.id !== lifecycle.id && Array.isArray(candidate.nodes)) {
    candidate.nodes = candidate.nodes.filter((id) => id !== notificationOut.id);
  }
}
finalizer.name = "Persistir contexto e emitir contratos";
finalizer.func = source("people-lifecycle-finalize.js");
finalizer.outputs = 4; finalizer.x = 4910; finalizer.y = 590;
finalizer.wires = [
  ["487984b3aaa29663"],
  ["397c6032b3dad342", "people_location_notification_out_v1"],
  ["people_lighting_tracker_recovery_arrival_out"],
  ["people_arrival_departure_blocked_v1"],
];
for (const [id, x, y] of [
  ["487984b3aaa29663", 5230, 480],
  ["397c6032b3dad342", 5230, 520],
  ["people_location_notification_out_v1", 5230, 560],
  ["people_lighting_tracker_recovery_arrival_out", 5230, 610],
  ["people_arrival_departure_blocked_v1", 5230, 670]
]) {
  const node = required(id); node.x = x; node.y = y; node.g = lifecycle.id;
  if (!lifecycle.nodes.includes(id)) lifecycle.nodes.push(id);
}
notificationOut.name = "RETORNO confirmado → avisos de residentes";
required(PEOPLE_TAB).info = "Seleção de fontes, parâmetros, direção, armamento, dedupe, recovery e saídas são visíveis. JavaScript remanescente apenas normaliza estruturas e persiste contratos sem efeitos. Teste do retorno local: resete pessoas e veículo, execute NEG SAÍDA 1/2 (home → near_home), depois Motor sintético OFF e Motor sintético ON; o efeito termina no dry-run.";

const vehicleLifecycle = required("d860cb4ad0d1fd89");
vehicleLifecycle.name = "2. Lifecycle visual do veículo, chegada e confirmação de refresh";
vehicleLifecycle.x = 1940;
vehicleLifecycle.y = 620;
vehicleLifecycle.w = 6360;
vehicleLifecycle.h = 502;
vehicleLifecycle.nodes = vehicleLifecycle.nodes.filter((id) => !generated.has(id));
const vgrouped = (node) => { add(node); vehicleLifecycle.nodes.push(node.id); return node; };
const vfn = (id, name, file, outputs, x, y, wires) => vgrouped({
  id, type: "function", z: VEHICLE_TAB, g: vehicleLifecycle.id, name,
  func: source(file), outputs, timeout: 0, noerr: 0,
  initialize: "", finalize: "", libs: [], x, y, wires
});
const vsw = (id, name, property, propertyType, x, y, wires) => vgrouped({
  id, type: "switch", z: VEHICLE_TAB, g: vehicleLifecycle.id, name,
  property, propertyType, rules: [{ t: "true" }, { t: "else" }],
  checkall: "false", repair: false, outputs: 2, x, y, wires
});
const vchange = (id, name, rules, x, y, wires) => vgrouped({
  id, type: "change", z: VEHICLE_TAB, g: vehicleLifecycle.id, name,
  rules, action: "", property: "", from: "", to: "", reg: false, x, y, wires
});
const vlinkOut = (id, name, target, x, y) => vgrouped({
  id, type: "link out", z: VEHICLE_TAB, g: vehicleLifecycle.id, name,
  mode: "link", links: [target], x, y, wires: []
});
const vlinkIn = (id, name, origins, destination, x, y) => vgrouped({
  id, type: "link in", z: VEHICLE_TAB, g: vehicleLifecycle.id, name,
  links: origins, x, y, wires: [[destination]]
});
const vehicleEvents = required("c1e3fc50d8ed0093");
const vehicleEventRoute = grouped.bind(null, vehicleEvents.id);
vehicleEventRoute({
  id: "vehicle_visual_event_out", type: "link out", z: VEHICLE_TAB,
  g: vehicleEvents.id, name: "Eventos e snapshots → lifecycle",
  mode: "link", links: ["vehicle_visual_event_in"], x: 690, y: 300, wires: []
});
for (const node of flows.filter((candidate) => candidate.z === VEHICLE_TAB)) {
  if (node.id === "vehicle_visual_event_out" || !Array.isArray(node.wires)) continue;
  node.wires = node.wires.map((wire) => wire.map((id) =>
    id === "vehicle_primary_classify_near_home_v1" ? "vehicle_visual_event_out" : id));
}
for (const id of [
  "46c2142f93cfc3e1", "94164ea9e4f5c8d1", "vehicle_primary_engine_on_event_v1",
  "9bbff0058231747f", "2ff44a30d0a2cf18", "f673b02282a47d31"
]) required(id).wires = [["vehicle_visual_event_out"]];
vlinkIn("vehicle_visual_event_in", "Receber eventos e snapshots", ["vehicle_visual_event_out"],
  "vehicle_primary_classify_near_home_v1", 1960, 860);
const classifier = required("vehicle_primary_classify_near_home_v1");
classifier.func = classifier.func.replace(
  'if (state === previousState) msg.payload.event = "context_update";',
  "msg.payload.canonical_state_changed = state !== previousState;"
);
classifier.x = 2110; classifier.y = 860; classifier.wires = [["vehicle_visual_test_adapter"]];
vfn("vehicle_visual_test_adapter", "Adaptar somente o estado sintético", "vehicle-lifecycle-test-adapter.js", 1, 2390, 860, [["vehicle_visual_normalize"]]);
vfn("vehicle_visual_normalize", "Normalizar localização, motor e trava", "vehicle-lifecycle-normalize.js", 1, 2700, 860, [["vehicle_visual_movement"]]);
vfn("vehicle_visual_movement", "Calcular deslocamento e guardar observação", "vehicle-lifecycle-movement.js", 1, 3020, 860, [["vehicle_visual_state_load"]]);
vfn("vehicle_visual_state_load", "Recuperar viagem, armamento e uso", "vehicle-lifecycle-state-load.js", 1, 3340, 860, [["vehicle_visual_engine_on"]]);
vsw("vehicle_visual_engine_on", "Motor conhecido está ligado?", "_vehicle.engine_on", "msg", 3600, 760,
  [["vehicle_visual_use_engine_on"], ["vehicle_visual_engine_off"]]);
vsw("vehicle_visual_engine_off", "Motor conhecido está desligado?", "_vehicle.engine_off", "msg", 3780, 840,
  [["vehicle_visual_use_engine_off"], ["vehicle_visual_persisted_trip"]]);
vsw("vehicle_visual_persisted_trip", "Viagem persistida foi revalidada fora?",
  '_vehicle.recovery.in_use = true and _vehicle.location.ready = true and ((_vehicle.location.distance_m != null and _vehicle.location.distance_m > _vehicle.policy.home_radius_m) or (_vehicle.location.distance_m = null and _vehicle.location.state = "not_home"))',
  "jsonata", 4050, 920, [["vehicle_visual_use_persisted"], ["vehicle_visual_unlocked_home"]]);
vsw("vehicle_visual_unlocked_home", "Destravado e perto confirma fim de uso?",
  '_vehicle.lock_fresh = true and _vehicle.unlocked = true and _vehicle.location.ready = true and ((_vehicle.location.gate_distance_m != null and _vehicle.location.gate_distance_m <= _vehicle.policy.near_home_radius_m) or (_vehicle.location.distance_m != null and _vehicle.location.distance_m <= _vehicle.policy.near_home_radius_m) or (_vehicle.location.distance_m = null and _vehicle.location.gate_distance_m = null and _vehicle.location.state = "home"))',
  "jsonata", 4320, 1000, [["vehicle_visual_use_unlocked"], ["vehicle_visual_use_pending"]]);
const setUse = (id, name, value, valueType, reason, x, y, output) => {
  vchange(id, name, [
    { t: "set", p: "_vehicle.in_use", pt: "msg", to: value, tot: valueType },
    { t: "set", p: "_vehicle.in_use_reason", pt: "msg", to: reason, tot: "str" }
  ], x, y, [[output]]);
};
setUse("vehicle_visual_use_engine_on", "USO: sim — motor ligado", "true", "bool", "known_engine_on", 3780, 700, "vehicle_visual_use_engine_on_out");
setUse("vehicle_visual_use_engine_off", "USO: não — motor desligado", "false", "bool", "known_engine_off", 4050, 780, "vehicle_visual_use_engine_off_out");
setUse("vehicle_visual_use_persisted", "USO: sim — viagem revalidada", "true", "bool", "persisted_trip_revalidated_by_fresh_away_location", 4320, 860, "vehicle_visual_use_persisted_out");
setUse("vehicle_visual_use_unlocked", "USO: não — chegada destravada", "false", "bool", "fresh_home_unlocked_engine_pending", 4590, 940, "vehicle_visual_use_unlocked_out");
setUse("vehicle_visual_use_pending", "USO: pendente — evidência insuficiente", "null", "json", "insufficient_current_evidence", 4590, 1040, "vehicle_visual_use_pending_out");
vlinkOut("vehicle_visual_use_engine_on_out", "Motor ON → contexto", "vehicle_visual_in_use_in", 4000, 700);
vlinkOut("vehicle_visual_use_engine_off_out", "Motor OFF → contexto", "vehicle_visual_in_use_in", 4270, 780);
vlinkOut("vehicle_visual_use_persisted_out", "Viagem → contexto", "vehicle_visual_in_use_in", 4540, 860);
vlinkOut("vehicle_visual_use_unlocked_out", "Destravado → contexto", "vehicle_visual_in_use_in", 4810, 940);
vlinkOut("vehicle_visual_use_pending_out", "Pendente → contexto", "vehicle_visual_in_use_in", 4810, 1040);
vlinkIn("vehicle_visual_in_use_in", "Convergir evidência de uso", [
  "vehicle_visual_use_engine_on_out", "vehicle_visual_use_engine_off_out",
  "vehicle_visual_use_persisted_out", "vehicle_visual_use_unlocked_out",
  "vehicle_visual_use_pending_out"
], "vehicle_visual_arrival_facts", 4880, 860);
vfn("vehicle_visual_arrival_facts", "Derivar direção, proximidade e armamento", "vehicle-lifecycle-arrival-facts.js", 1, 5140, 860, [["vehicle_visual_arrival_gate"]]);
vsw("vehicle_visual_arrival_gate", "Retorno externo confirmado?", "_vehicle.facts.arrival_eligible", "msg", 5410, 780,
  [["vehicle_visual_arrival_build"], ["vehicle_visual_blocked_gate"]]);
vsw("vehicle_visual_blocked_gate", "Transição para casa foi bloqueada?", "_vehicle.facts.blocked_candidate", "msg", 5410, 940,
  [["vehicle_visual_blocked_build"], ["vehicle_visual_no_arrival_out"]]);
vfn("vehicle_visual_arrival_build", "Montar retorno confirmado", "vehicle-lifecycle-arrival-build.js", 1, 5680, 760, [["vehicle_visual_arrival_dedupe"]]);
vfn("vehicle_visual_arrival_dedupe", "Deduplicar pela etapa e janela", "vehicle-lifecycle-arrival-dedupe.js", 1, 5960, 760, [["vehicle_visual_arrival_out"]]);
vfn("vehicle_visual_blocked_build", "Registrar motivo do bloqueio", "vehicle-lifecycle-blocked-build.js", 1, 5680, 920, [["vehicle_visual_blocked_out"]]);
vlinkOut("vehicle_visual_arrival_out", "Retorno → estado", "vehicle_visual_arrival_result_in", 6180, 760);
vlinkOut("vehicle_visual_blocked_out", "Bloqueio → estado", "vehicle_visual_arrival_result_in", 5960, 920);
vlinkOut("vehicle_visual_no_arrival_out", "Sem chegada → estado", "vehicle_visual_arrival_result_in", 5680, 1020);
vlinkIn("vehicle_visual_arrival_result_in", "Convergir lifecycle de chegada", [
  "vehicle_visual_arrival_out", "vehicle_visual_blocked_out", "vehicle_visual_no_arrival_out"
], "vehicle_visual_state_finalize", 6240, 860);
vfn("vehicle_visual_state_finalize", "Persistir viagem e montar contexto", "vehicle-lifecycle-state-finalize.js", 1, 6480, 860, [["vehicle_visual_evidence_read"]]);
vfn("vehicle_visual_evidence_read", "Comparar telemetria com baseline do wake", "vehicle-lifecycle-evidence-read.js", 1, 6770, 860, [["vehicle_visual_awaiting_evidence"]]);
vsw("vehicle_visual_awaiting_evidence", "Wake aguarda evidência semântica?", "_vehicle.evidence.awaiting", "msg", 7060, 800,
  [["vehicle_visual_evidence_confirmed"], ["vehicle_visual_evidence_idle_out"]]);
vsw("vehicle_visual_evidence_confirmed", "Timestamp novo pertence à tentativa?", "_vehicle.evidence.confirmed", "msg", 7340, 760,
  [["vehicle_visual_evidence_confirm"], ["vehicle_visual_evidence_pending_out"]]);
vfn("vehicle_visual_evidence_confirm", "Confirmar sucesso e limpar falha", "vehicle-lifecycle-evidence-confirm.js", 1, 7620, 700, [["vehicle_visual_evidence_success_out"]]);
vlinkOut("vehicle_visual_evidence_success_out", "Sucesso → saída", "vehicle_visual_output_in", 7840, 700);
vlinkOut("vehicle_visual_evidence_pending_out", "Ainda pendente → saída", "vehicle_visual_output_in", 7620, 820);
vlinkOut("vehicle_visual_evidence_idle_out", "Sem wake pendente → saída", "vehicle_visual_output_in", 7340, 900);
vlinkIn("vehicle_visual_output_in", "Convergir confirmação do refresh", [
  "vehicle_visual_evidence_success_out", "vehicle_visual_evidence_pending_out",
  "vehicle_visual_evidence_idle_out"
], "092625f2eb5cc156", 7890, 820);
const vehicleOutput = required("092625f2eb5cc156");
vehicleOutput.name = "Persistir contexto e emitir contratos";
vehicleOutput.func = source("vehicle-lifecycle-output.js");
vehicleOutput.outputs = 4; vehicleOutput.x = 8080; vehicleOutput.y = 820;
for (const [id, x, y] of [
  ["c298447a6a2e3cef", 8260, 700],
  ["2aa1b0c2907d4017", 8260, 760],
  ["67d24b1f56447c94", 8260, 820],
  ["aa9889d5766ce5a0", 8260, 880],
  ["vehicle_primary_arrival_departure_blocked_v1", 8080, 1040],
  ["vehicle_primary_arrival_direction_note_v1", 7700, 1040]
]) {
  const node = required(id); node.x = x; node.y = y; node.g = vehicleLifecycle.id;
  if (!vehicleLifecycle.nodes.includes(id)) vehicleLifecycle.nodes.push(id);
}
moveGroup("vehicle_location_panel_group_v1", 3300, 259);
moveGroup("global_observer_coverage__c22d8b12055e87f7__group", 4350, 40);

const safetyConfig = group(
  "vehicle_visual_refresh_safety_config_group_v2",
  "3b. Proteções do refresh — padrão, unidade e limites no nome",
  5120, 40, 1510, 482, "#b45309", "#fef3c7", VEHICLE_TAB
);
const safetyInject = (id, name, topic, payload, x, y, destination) => grouped(safetyConfig.id, {
  id, type: "inject", z: VEHICLE_TAB, g: safetyConfig.id, name,
  props: [{ p: "payload" }, { p: "topic", vt: "str" }], repeat: "", crontab: "",
  once: true, onceDelay: "0.5", topic, payload: String(payload), payloadType: "num",
  x, y, wires: [[destination]]
});
grouped(safetyConfig.id, {
  id: "vehicle_visual_refresh_safety_help", type: "comment", z: VEHICLE_TAB,
  g: safetyConfig.id,
  name: "Inválidos são rejeitados; a última configuração completa permanece ativa.",
  info: "Lease 30–600 s; settle 5–120 s; backoff 1–24 h; evidência 5–60 min; janela desconhecida 0–24 h.",
  x: 5860, y: 80, wires: []
});
safetyInject("vehicle_visual_refresh_lease", "Lease em voo — 120 s [30..600]", "in_flight_lease_seconds", 120, 5380, 150, "vehicle_visual_refresh_safety_left_out");
safetyInject("vehicle_visual_refresh_settle", "Assentar cache — 15 s [5..120]", "cache_probe_settle_seconds", 15, 5380, 210, "vehicle_visual_refresh_safety_left_out");
safetyInject("vehicle_visual_refresh_backoff", "Backoff máximo — 6 h [1..24]", "provider_backoff_max_hours", 6, 5800, 150, "vehicle_visual_refresh_safety_middle_out");
safetyInject("vehicle_visual_refresh_evidence", "Evidência — 20 min [5..60]", "semantic_evidence_window_minutes", 20, 5800, 210, "vehicle_visual_refresh_safety_middle_out");
safetyInject("vehicle_visual_refresh_unknown_start", "Sem localização: início 7 h [0..23]", "unknown_location_start_hour", 7, 6220, 150, "vehicle_visual_refresh_safety_right_out");
safetyInject("vehicle_visual_refresh_unknown_end", "Sem localização: fim 22 h [1..24]", "unknown_location_end_hour", 22, 6220, 210, "vehicle_visual_refresh_safety_right_out");
for (const [id, name, x] of [
  ["vehicle_visual_refresh_safety_left_out", "Leases → política", 5580],
  ["vehicle_visual_refresh_safety_middle_out", "Backoff/evidência → política", 6000],
  ["vehicle_visual_refresh_safety_right_out", "Janela desconhecida → política", 6420]
]) {
  grouped(safetyConfig.id, { id, type: "link out", z: VEHICLE_TAB, g: safetyConfig.id,
    name, mode: "link", links: ["vehicle_visual_refresh_config_in"], x, y: 300, wires: [] });
}
const refreshConfigGroup = required("vehicle_primary_refresh_config_group_v1");
grouped(refreshConfigGroup.id, {
  id: "vehicle_visual_refresh_config_in", type: "link in", z: VEHICLE_TAB,
  g: refreshConfigGroup.id, name: "Receber proteções do refresh",
  links: ["vehicle_visual_refresh_safety_left_out", "vehicle_visual_refresh_safety_middle_out",
    "vehicle_visual_refresh_safety_right_out"], x: 1190, y: 420,
  wires: [["vehicle_primary_refresh_policy_config_apply_v1"]]
});
Object.assign(required("vehicle_primary_refresh_policy_config_apply_v1"), {
  func: source("vehicle-primary-refresh-policy-config.js")
});
Object.assign(required("vehicle_primary_refresh_policy_select_v1"), {
  func: source("vehicle-primary-refresh-policy.js")
});

const refreshDecisionGroup = group(
  "vehicle_visual_refresh_decision_group_v2",
  "10. Orquestração visual do refresh — gates, cooldown, cache e dry-run",
  64, 2080, 4140, 700, "#0f766e", "#ccfbf1", VEHICLE_TAB
);
const refreshGrouped = (node) => grouped(refreshDecisionGroup.id, node);
const rfn = (id, name, file, outputs, x, y, wires) => refreshGrouped({
  id, type: "function", z: VEHICLE_TAB, g: refreshDecisionGroup.id, name,
  func: source(file), outputs, timeout: 0, noerr: 0,
  initialize: "", finalize: "", libs: [], x, y, wires
});
const rsw = (id, name, property, propertyType, x, y, wires) => refreshGrouped({
  id, type: "switch", z: VEHICLE_TAB, g: refreshDecisionGroup.id, name,
  property, propertyType, rules: [{ t: "true" }, { t: "else" }],
  checkall: "false", repair: false, outputs: 2, x, y, wires
});
const rchange = (id, name, value, x, y, wires) => refreshGrouped({
  id, type: "change", z: VEHICLE_TAB, g: refreshDecisionGroup.id, name,
  rules: [{ t: "set", p: "_refresh.suppress_reason", pt: "msg", to: value, tot: "str" }],
  action: "", property: "", from: "", to: "", reg: false, x, y, wires
});
const rlinkOut = (id, name, x, y) => refreshGrouped({
  id, type: "link out", z: VEHICLE_TAB, g: refreshDecisionGroup.id, name,
  mode: "link", links: ["vehicle_visual_refresh_result_in"], x, y, wires: []
});
const executionGroup = required("43a2bc9c218353ae");
const policyInput = required("vehicle_primary_refresh_policy_in_v1");
policyInput.wires = [["vehicle_visual_refresh_command_out"]];
grouped(executionGroup.id, {
  id: "vehicle_visual_refresh_command_out", type: "link out", z: VEHICLE_TAB,
  g: executionGroup.id, name: "Política → orquestração visual", mode: "link",
  links: ["vehicle_visual_refresh_command_in"], x: 390, y: 680, wires: []
});
refreshGrouped({
  id: "vehicle_visual_refresh_command_in", type: "link in", z: VEHICLE_TAB,
  g: refreshDecisionGroup.id, name: "Receber comando com política",
  links: ["vehicle_visual_refresh_command_out"], x: 110, y: 2410,
  wires: [["vehicle_visual_refresh_load"]]
});
rfn("vehicle_visual_refresh_load", "Validar política e recuperar estado", "vehicle-refresh-state-load.js", 1, 330, 2410, [["vehicle_visual_refresh_facts"]]);
rfn("vehicle_visual_refresh_facts", "Derivar recovery, intervalo e gates", "vehicle-refresh-facts.js", 1, 620, 2410, [["vehicle_visual_refresh_cache_active"]]);
rsw("vehicle_visual_refresh_cache_active", "Cache probe ainda está em voo?", "_refresh.flags.cache_active", "msg", 900, 2200,
  [["vehicle_visual_refresh_reason_cache_active"], ["vehicle_visual_refresh_cache_settling"]]);
rchange("vehicle_visual_refresh_reason_cache_active", "Bloquear: cache em voo", "cache_probe_in_flight", 1170, 2160, [["vehicle_visual_refresh_suppress_cache_active"]]);
rfn("vehicle_visual_refresh_suppress_cache_active", "Calcular espera sem novo efeito", "vehicle-refresh-suppress.js", 1, 1440, 2160, [["vehicle_visual_refresh_result_cache_active"]]);
rlinkOut("vehicle_visual_refresh_result_cache_active", "Bloqueio → resultado", 1650, 2160);
rsw("vehicle_visual_refresh_cache_settling", "Cache ainda está assentando?", "_refresh.flags.cache_settling", "msg", 1170, 2280,
  [["vehicle_visual_refresh_reason_cache_settle"], ["vehicle_visual_refresh_request_active"]]);
rchange("vehicle_visual_refresh_reason_cache_settle", "Bloquear: cache assentando", "cache_probe_settling", 1440, 2240, [["vehicle_visual_refresh_suppress_cache_settle"]]);
rfn("vehicle_visual_refresh_suppress_cache_settle", "Calcular espera sem novo efeito", "vehicle-refresh-suppress.js", 1, 1710, 2240, [["vehicle_visual_refresh_result_cache_settle"]]);
rlinkOut("vehicle_visual_refresh_result_cache_settle", "Settle → resultado", 1920, 2240);
rsw("vehicle_visual_refresh_request_active", "Wake ainda está em voo?", "_refresh.flags.request_active", "msg", 1440, 2400,
  [["vehicle_visual_refresh_reason_request_active"], ["vehicle_visual_refresh_departure_covered"]]);
rchange("vehicle_visual_refresh_reason_request_active", "Bloquear: wake em voo", "in_flight", 1710, 2360, [["vehicle_visual_refresh_suppress_request_active"]]);
rfn("vehicle_visual_refresh_suppress_request_active", "Calcular espera sem novo efeito", "vehicle-refresh-suppress.js", 1, 1980, 2360, [["vehicle_visual_refresh_result_request_active"]]);
rlinkOut("vehicle_visual_refresh_result_request_active", "Wake em voo → resultado", 2190, 2360);
rsw("vehicle_visual_refresh_departure_covered", "Saída já foi coberta por refresh?", "_refresh.flags.departure_covered", "msg", 1710, 2520,
  [["vehicle_visual_refresh_departure_done"], ["vehicle_visual_refresh_enabled"]]);
rfn("vehicle_visual_refresh_departure_done", "Manter lifecycle já coberto", "vehicle-refresh-departure-covered.js", 1, 1980, 2480, [["vehicle_visual_refresh_result_departure"]]);
rlinkOut("vehicle_visual_refresh_result_departure", "Saída coberta → resultado", 2190, 2480);
rsw("vehicle_visual_refresh_enabled", "Há motivo seguro para consultar?", "_refresh.flags.enabled", "msg", 1980, 2600,
  [["vehicle_visual_refresh_deadline"], ["vehicle_visual_refresh_wait_location"]]);
rfn("vehicle_visual_refresh_wait_location", "Aguardar localização dos residentes", "vehicle-refresh-wait-location.js", 1, 2250, 2700, [["vehicle_visual_refresh_result_wait"]]);
rlinkOut("vehicle_visual_refresh_result_wait", "Aguardar → resultado", 2460, 2700);
rsw("vehicle_visual_refresh_deadline", "Intervalo mínimo ainda está ativo?", "_refresh.flags.deadline_blocked", "msg", 2250, 2580,
  [["vehicle_visual_refresh_waiting_evidence"], ["vehicle_visual_refresh_cache_needed"]]);
rsw("vehicle_visual_refresh_waiting_evidence", "Cooldown aguarda evidência?", "_refresh.flags.waiting_evidence", "msg", 2510, 2460,
  [["vehicle_visual_refresh_reason_backoff"], ["vehicle_visual_refresh_reason_minimum"]]);
rchange("vehicle_visual_refresh_reason_backoff", "Bloquear: backoff", "backoff", 2770, 2410, [["vehicle_visual_refresh_suppress_backoff"]]);
rchange("vehicle_visual_refresh_reason_minimum", "Bloquear: intervalo mínimo", "minimum_interval", 2770, 2490, [["vehicle_visual_refresh_suppress_minimum"]]);
rfn("vehicle_visual_refresh_suppress_backoff", "Calcular retry sem novo efeito", "vehicle-refresh-suppress.js", 1, 3040, 2410, [["vehicle_visual_refresh_result_backoff"]]);
rfn("vehicle_visual_refresh_suppress_minimum", "Calcular cooldown sem novo efeito", "vehicle-refresh-suppress.js", 1, 3040, 2490, [["vehicle_visual_refresh_result_minimum"]]);
rlinkOut("vehicle_visual_refresh_result_backoff", "Backoff → resultado", 3250, 2410);
rlinkOut("vehicle_visual_refresh_result_minimum", "Cooldown → resultado", 3250, 2490);
rsw("vehicle_visual_refresh_cache_needed", "Evidência pendente exige releitura de cache?", "_refresh.flags.cache_probe_needed", "msg", 2510, 2620,
  [["vehicle_visual_refresh_cache_build"], ["vehicle_visual_refresh_dispatch_build"]]);
rfn("vehicle_visual_refresh_cache_build", "Preparar cache probe protegido", "vehicle-refresh-cache-build.js", 1, 2790, 2590, [["vehicle_visual_refresh_result_cache"]]);
rfn("vehicle_visual_refresh_dispatch_build", "Preparar wake e lease", "vehicle-refresh-dispatch-build.js", 1, 2790, 2670, [["vehicle_visual_refresh_result_dispatch"]]);
rlinkOut("vehicle_visual_refresh_result_cache", "Cache probe → resultado", 3010, 2590);
rlinkOut("vehicle_visual_refresh_result_dispatch", "Wake → resultado", 3010, 2670);
const resultOrigins = ["vehicle_visual_refresh_result_cache_active", "vehicle_visual_refresh_result_cache_settle",
  "vehicle_visual_refresh_result_request_active", "vehicle_visual_refresh_result_departure",
  "vehicle_visual_refresh_result_wait", "vehicle_visual_refresh_result_backoff",
  "vehicle_visual_refresh_result_minimum", "vehicle_visual_refresh_result_cache",
  "vehicle_visual_refresh_result_dispatch"];
refreshGrouped({
  id: "vehicle_visual_refresh_result_in", type: "link in", z: VEHICLE_TAB,
  g: refreshDecisionGroup.id, name: "Convergir exatamente um resultado", links: resultOrigins,
  x: 3330, y: 2580, wires: [["b33e117e55bdb5ed"]]
});
const refreshOutput = required("b33e117e55bdb5ed");
refreshOutput.name = "Persistir lifecycle e rotear pedido";
refreshOutput.func = source("vehicle-refresh-output.js");
refreshOutput.outputs = 5; refreshOutput.x = 3540; refreshOutput.y = 2580;
refreshOutput.g = refreshDecisionGroup.id;
if (!refreshDecisionGroup.nodes.includes(refreshOutput.id)) {
  refreshDecisionGroup.nodes.push(refreshOutput.id);
}
for (const id of ["eb4b8a519ab0bc28", "vehicle_primary_manual_blocked_route_out_v1",
  "vehicle_primary_refresh_notification_requested_out_v1"]) {
  const node = required(id);
  node.g = refreshDecisionGroup.id;
  if (!refreshDecisionGroup.nodes.includes(id)) refreshDecisionGroup.nodes.push(id);
}
Object.assign(required("eb4b8a519ab0bc28"), { x: 3880, y: 2500 });
Object.assign(required("vehicle_primary_manual_blocked_route_out_v1"), { x: 3880, y: 2580 });
Object.assign(required("vehicle_primary_refresh_notification_requested_out_v1"), { x: 3880, y: 2660 });
refreshGrouped({
  id: "vehicle_visual_refresh_dispatch_out", type: "link out", z: VEHICLE_TAB,
  g: refreshDecisionGroup.id, name: "Wake → gate final", mode: "link",
  links: ["vehicle_visual_refresh_dispatch_in"], x: 3880, y: 2420, wires: []
});
refreshGrouped({
  id: "vehicle_visual_refresh_cache_out", type: "link out", z: VEHICLE_TAB,
  g: refreshDecisionGroup.id, name: "Cache → gate final", mode: "link",
  links: ["vehicle_visual_refresh_cache_in"], x: 3880, y: 2740, wires: []
});
refreshOutput.wires = [
  ["vehicle_visual_refresh_dispatch_out"], ["eb4b8a519ab0bc28"],
  ["vehicle_primary_manual_blocked_route_out_v1"],
  ["vehicle_primary_refresh_notification_requested_out_v1"],
  ["vehicle_visual_refresh_cache_out"]
];
grouped(executionGroup.id, {
  id: "vehicle_visual_refresh_dispatch_in", type: "link in", z: VEHICLE_TAB,
  g: executionGroup.id, name: "Receber wake autorizado pela política",
  links: ["vehicle_visual_refresh_dispatch_out"], x: 550, y: 720,
  wires: [["vehicle_primary_refresh_dispatch_guard_v1"]]
});
grouped(executionGroup.id, {
  id: "vehicle_visual_refresh_cache_in", type: "link in", z: VEHICLE_TAB,
  g: executionGroup.id, name: "Receber cache probe autorizado",
  links: ["vehicle_visual_refresh_cache_out"], x: 550, y: 1080,
  wires: [["vehicle_primary_cache_probe_dispatch_guard_v1"]]
});
executionGroup.nodes = executionGroup.nodes.filter((id) => id !== "b33e117e55bdb5ed" &&
  !["eb4b8a519ab0bc28", "vehicle_primary_manual_blocked_route_out_v1",
    "vehicle_primary_refresh_notification_requested_out_v1"].includes(id));
required(VEHICLE_TAB).info = "Localização, evidência de uso, direção, armamento, dedupe e confirmação semântica do wake são explícitos. Funções apenas adaptam payloads, calculam distância e persistem contratos; efeitos permanecem em gates próprios.";

flows = reconcileGeneratedFlows(originalFlows, flows, {
  isOwned: (node) => generated.has(node.id),
});
fs.writeFileSync(outputPath, `${JSON.stringify(flows, null, 4)}\n`);
console.log(`Location lifecycle visual flow installed in ${outputPath}`);
