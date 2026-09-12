#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const inputPath = path.resolve(process.argv[2] ?? path.resolve(here, "..", "flows.json"));
const outputPath = path.resolve(process.argv[3] ?? inputPath);
const functionsDir = path.join(here, "functions");
const PEOPLE_TAB = "ea0a6aa0d24ff863";
let flows = JSON.parse(fs.readFileSync(inputPath, "utf8"));
const source = (name) => fs.readFileSync(path.join(functionsDir, name), "utf8").trimEnd();
const generated = new Set(flows.filter((node) =>
  node.id.startsWith("people_visual_") || node.id === "people_location_lifecycle_config_group_v2"
).map((node) => node.id));
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
const group = (id, name, x, y, w, h, stroke = "#2563eb", fill = "#dbeafe") =>
  add({ id, type: "group", z: PEOPLE_TAB, name, style: {
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

const config = group(
  "people_location_lifecycle_config_group_v2",
  "0b. Tempos de lifecycle — padrão, unidade e limites no nome",
  2150, 59, 1190, 322, "#7c3aed", "#ede9fe"
);
grouped(config.id, {
  id: "people_visual_lifecycle_help", type: "comment", z: PEOPLE_TAB, g: config.id,
  name: "Valores inválidos são rejeitados; a última política válida permanece ativa para todos os consumidores.",
  info: "Dedupe: 1–60 min; graça: 1–60 min; futuro: 0–300 s; sinais: 1–30 min; recovery: 1–168 h.",
  x: 2740, y: 100, wires: []
});
inject("people_visual_arrival_dedupe", config.id, "Dedupe chegada — 10 min [1..60]", "arrival_dedupe_minutes", 10, 2370, 160, "people_visual_lifecycle_config_left_out");
inject("people_visual_primary_home_grace", config.id, "Graça home — 10 min [1..60]", "primary_home_grace_minutes", 10, 2370, 210, "people_visual_lifecycle_config_left_out");
inject("people_visual_future_tolerance", config.id, "Tolerância futura — 60 s [0..300]", "future_tolerance_seconds", 60, 2740, 160, "people_visual_lifecycle_config_middle_out");
inject("people_visual_vehicle_signal_fresh", config.id, "Sinal do veículo — 5 min [1..30]", "vehicle_signal_fresh_minutes", 5, 2740, 210, "people_visual_lifecycle_config_middle_out");
inject("people_visual_vehicle_recovery", config.id, "Recovery veículo — 24 h [1..168]", "vehicle_recovery_hours", 24, 3110, 160, "people_visual_lifecycle_config_right_out");
linkOut("people_visual_lifecycle_config_left_out", config.id, "Tempos de chegada → política", "people_location_values_route_in_v1", 2550, 270);
linkOut("people_visual_lifecycle_config_middle_out", config.id, "Validade → política", "people_location_values_route_in_v1", 2920, 270);
linkOut("people_visual_lifecycle_config_right_out", config.id, "Recovery → política", "people_location_values_route_in_v1", 3290, 270);

const policyIn = required("people_location_values_route_in_v1");
policyIn.links = Array.from(new Set([...(policyIn.links ?? []),
  "people_visual_lifecycle_config_left_out",
  "people_visual_lifecycle_config_middle_out",
  "people_visual_lifecycle_config_right_out"
]));
policyIn.wires = [["people_visual_policy_validate"]];
const policyGroup = required("people_location_policy_group_v1");
policyGroup.w = 1510;
policyGroup.nodes = policyGroup.nodes.filter((id) => id !== "people_location_policy_apply_v1");
const store = required("people_location_policy_apply_v1");
store.name = "Guardar última política válida";
store.func = source("location-policy-store.js");
store.outputs = 1;
store.x = 1300;
store.y = 180;
store.wires = store.wires?.length ? store.wires : [["people_location_policy_out_v1"]];
store.g = policyGroup.id;
policyGroup.nodes.push(store.id);
fn("people_visual_policy_validate", policyGroup.id, "Validar valor, unidade e limites", "location-policy-validate.js", 2, 1140, 260,
  [["people_location_policy_apply_v1"], ["people_visual_policy_reject"]]);
fn("people_visual_policy_reject", policyGroup.id, "Rejeitar sem substituir", "location-policy-reject.js", 0, 1400, 340, []);
Object.assign(required("people_location_policy_out_v1"), { x: 1530, y: 180 });
moveGroup("global_observer_coverage__ea0a6aa0d24ff863__group", 3400, 59);

const lifecycle = required("8e1c3a19399ad44d");
lifecycle.name = "3. Lifecycle visual de presença e chegada canônica";
lifecycle.x = 2050;
lifecycle.y = 419;
lifecycle.w = 3400;
lifecycle.h = 322;
lifecycle.nodes = lifecycle.nodes.filter((id) => !generated.has(id));
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
finalizer.name = "Persistir contexto e emitir contratos";
finalizer.func = source("people-lifecycle-finalize.js");
finalizer.outputs = 4; finalizer.x = 4910; finalizer.y = 590;
for (const [id, x, y] of [
  ["487984b3aaa29663", 5230, 480],
  ["397c6032b3dad342", 5230, 540],
  ["people_lighting_tracker_recovery_arrival_out", 5230, 600],
  ["people_arrival_departure_blocked_v1", 5230, 660]
]) {
  const node = required(id); node.x = x; node.y = y; node.g = lifecycle.id;
  if (!lifecycle.nodes.includes(id)) lifecycle.nodes.push(id);
}
required(PEOPLE_TAB).info = "Seleção de fontes, parâmetros, direção, armamento, dedupe, recovery e saídas são visíveis. JavaScript remanescente apenas normaliza estruturas e persiste contratos sem efeitos.";

fs.writeFileSync(outputPath, `${JSON.stringify(flows, null, 4)}\n`);
console.log(`Location lifecycle visual flow installed in ${outputPath}`);
