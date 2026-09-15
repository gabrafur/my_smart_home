#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const inputPath = path.resolve(process.argv[2] ?? path.resolve(here, "..", "flows.json"));
const outputPath = path.resolve(process.argv[3] ?? inputPath);
const functionsDir = path.join(here, "functions");
const TAB = "6b7552efb85343f4";
const source = (name) => fs.readFileSync(path.join(functionsDir, name), "utf8").trimEnd();
let flows = JSON.parse(fs.readFileSync(inputPath, "utf8"));
const fixedGenerated = new Set([
  "security_light_arrival_direction_gate_v1",
  "security_light_arrival_direction_blocked_v1",
  "71976ffe382e6d7d",
]);
const generated = new Set(flows.filter((node) =>
  node.id.startsWith("security_visual_") || fixedGenerated.has(node.id)
).map((node) => node.id));
flows = flows.filter((node) => !generated.has(node.id));
for (const node of flows) {
  for (const field of ["nodes", "scope", "links"]) {
    if (Array.isArray(node[field])) node[field] = node[field].filter((id) => !generated.has(id));
  }
  if (Array.isArray(node.wires)) node.wires = node.wires.map((wire) =>
    Array.isArray(wire) ? wire.filter((id) => !generated.has(id)) : wire);
}
const byId = new Map(flows.map((node) => [node.id, node]));
const required = (id) => {
  const node = byId.get(id);
  if (!node) throw new Error(`Nó obrigatório ausente: ${id}`);
  return node;
};
const add = (node) => { flows.push(node); byId.set(node.id, node); return node; };
const group = (id, name, x, y, w, h, stroke, fill) => add({
  id, type: "group", z: TAB, name,
  style: { label: true, "label-position": "nw", color: "#1f2937", stroke,
    "stroke-opacity": "1", fill, "fill-opacity": "0.35" },
  nodes: [], x, y, w, h
});
const grouped = (groupId, node) => { add(node); required(groupId).nodes.push(node.id); return node; };
const fn = (id, groupId, name, file, outputs, x, y, wires) => grouped(groupId, {
  id, type: "function", z: TAB, g: groupId, name, func: source(file), outputs,
  timeout: 0, noerr: 0, initialize: "", finalize: "", libs: [], x, y, wires
});
const sw = (id, groupId, name, property, x, y, wires) => grouped(groupId, {
  id, type: "switch", z: TAB, g: groupId, name, property, propertyType: "msg",
  rules: [{ t: "true" }, { t: "else" }], checkall: "false", repair: false,
  outputs: 2, x, y, wires
});
const swRules = (id, groupId, name, property, rules, x, y, wires) => grouped(groupId, {
  id, type: "switch", z: TAB, g: groupId, name, property, propertyType: "msg",
  rules, checkall: "false", repair: false, outputs: rules.length, x, y, wires
});
const linkOut = (id, groupId, name, target, x, y) => grouped(groupId, {
  id, type: "link out", z: TAB, g: groupId, name, mode: "link", links: [target], x, y, wires: []
});
const linkIn = (id, groupId, name, origins, destination, x, y) => grouped(groupId, {
  id, type: "link in", z: TAB, g: groupId, name, links: origins, x, y, wires: [[destination]]
});
const inject = (id, groupId, name, topic, payload, x, y, destination) => grouped(groupId, {
  id, type: "inject", z: TAB, g: groupId, name,
  props: [{ p: "payload" }, { p: "topic", vt: "str" }], repeat: "", crontab: "",
  once: true, onceDelay: "0.8", topic, payload: String(payload), payloadType: "num",
  x, y, wires: [[destination]]
});
const broker = required("security_light_engine_bypass_mqtt_out_v1").broker;

const bypass = required("security_light_engine_bypass_group_v1");
Object.assign(bypass, {
  name: "6. Bypass do motor — comando, posse e recuperação visíveis",
  x: 64, y: 1019, w: 2000, h: 442,
});
bypass.nodes = bypass.nodes.filter((id) => !generated.has(id));
for (const [id, x, y] of [
  ["security_light_engine_bypass_startup_v1", 280, 1080],
  ["security_light_engine_bypass_command_v1", 280, 1140],
  ["security_light_engine_bypass_test_on_v1", 260, 1200],
  ["security_light_engine_bypass_test_off_v1", 260, 1260],
]) {
  const node = required(id);
  Object.assign(node, { g: bypass.id, x, y, wires: [["security_light_engine_bypass_function_v1"]] });
  if (!bypass.nodes.includes(id)) bypass.nodes.push(id);
}
const bypassFacts = required("security_light_engine_bypass_function_v1");
Object.assign(bypassFacts, {
  g: bypass.id, name: "Normalizar comando e derivar fatos de posse",
  func: source("security-light-engine-bypass-facts.js"), outputs: 1,
  x: 610, y: 1160, wires: [["security_visual_bypass_branch"]],
});
if (!bypass.nodes.includes(bypassFacts.id)) bypass.nodes.push(bypassFacts.id);
swRules("security_visual_bypass_branch", bypass.id, "Qual comando de bypass?",
  "_engine_bypass.branch", [
    { t: "eq", v: "startup", vt: "str" },
    { t: "eq", v: "automatic_activation", vt: "str" },
    { t: "eq", v: "automatic_recovery", vt: "str" },
    { t: "eq", v: "manual_enable", vt: "str" },
    { t: "eq", v: "manual_disable", vt: "str" },
    { t: "else" },
  ], 880, 1160, [
    ["security_visual_bypass_startup"],
    ["security_visual_bypass_auto_enable"],
    ["security_visual_bypass_auto_owned"],
    ["security_visual_bypass_manual_enable"],
    ["security_visual_bypass_manual_disable"],
    ["security_visual_bypass_invalid"],
  ]);
fn("security_visual_bypass_startup", bypass.id, "Restaurar último estado válido",
  "security-light-engine-bypass-startup.js", 1, 1140, 1060,
  [["security_visual_bypass_result_out"]]);
fn("security_visual_bypass_auto_enable", bypass.id, "Ativar por falha sem roubar posse manual",
  "security-light-engine-bypass-auto-enable.js", 1, 1160, 1120,
  [["security_visual_bypass_result_out"]]);
sw("security_visual_bypass_auto_owned", bypass.id, "Ativação atual pertence à automação?",
  "_engine_bypass.automatic_owned", 1140, 1200,
  [["security_visual_bypass_auto_recover"], ["security_visual_bypass_preserve_manual"]]);
fn("security_visual_bypass_auto_recover", bypass.id, "Desativar após recovery da API",
  "security-light-engine-bypass-auto-recover.js", 1, 1410, 1180,
  [["security_visual_bypass_result_out"]]);
fn("security_visual_bypass_preserve_manual", bypass.id, "Preservar ON de posse manual",
  "security-light-engine-bypass-preserve-manual.js", 0, 1410, 1240, []);
fn("security_visual_bypass_manual_enable", bypass.id, "Ativar com posse manual",
  "security-light-engine-bypass-manual-enable.js", 1, 1160, 1300,
  [["security_visual_bypass_result_out"]]);
fn("security_visual_bypass_manual_disable", bypass.id, "Desativar e liberar posse",
  "security-light-engine-bypass-manual-disable.js", 1, 1160, 1360,
  [["security_visual_bypass_result_out"]]);
fn("security_visual_bypass_invalid", bypass.id, "Rejeitar comando inválido",
  "security-light-engine-bypass-invalid.js", 0, 1150, 1420, []);
linkOut("security_visual_bypass_result_out", bypass.id, "Estado decidido → publicação",
  "security_visual_bypass_result_in", 1510, 1060);
linkIn("security_visual_bypass_result_in", bypass.id, "Receber estado decidido",
  ["security_visual_bypass_result_out"], "security_visual_bypass_output", 1620, 1160);
fn("security_visual_bypass_output", bypass.id, "Publicar estado e pedir reavaliação",
  "security-light-engine-bypass-output.js", 2, 1800, 1160,
  [["security_light_engine_bypass_mqtt_out_v1"], ["security_light_engine_bypass_reevaluate_out_v1"]]);
for (const [id, x, y] of [
  ["security_light_engine_bypass_mqtt_out_v1", 1930, 1120],
  ["security_light_engine_bypass_reevaluate_out_v1", 1980, 1200],
]) {
  const node = required(id);
  Object.assign(node, { g: bypass.id, x, y });
  if (!bypass.nodes.includes(id)) bypass.nodes.push(id);
}

const locationPolicy = required("light_location_policy_group_v1");
Object.assign(locationPolicy, { x: 3740, y: 1019, w: 602, h: 142 });
Object.assign(required("light_location_policy_in_v1"), { x: 3835, y: 1100 });
Object.assign(required("light_location_policy_status_v1"), { x: 4130, y: 1100 });

const policy = group("security_visual_policy_group_v1",
  "7. Política da iluminação — padrão, unidade e limites no nome",
  2180, 1019, 1510, 482, "#7c3aed", "#ede9fe");
grouped(policy.id, { id: "security_visual_policy_help", type: "comment", z: TAB, g: policy.id,
  name: "Inválidos são rejeitados sem substituir a última política completa.",
  info: "Frescor 30–600 s; recovery 5–300 s; carência 10–300 s; backstop 2–60 min; cooldown 1–30 min; retenção 1–168 h.",
  x: 2920, y: 1060, wires: [] });
const specs = [
  ["physical_fresh_seconds", "Frescor físico — 120 s [30..600]", 120],
  ["recovery_request_throttle_seconds", "Throttle recovery — 30 s [5..300]", 30],
  ["off_grace_seconds", "Carência OFF — 90 s [10..300]", 90],
  ["backstop_minutes", "Backstop — 15 min [2..60]", 15],
  ["post_off_cooldown_minutes", "Cooldown pós-OFF — 5 min [1..30]", 5],
  ["lifecycle_retention_hours", "Retenção lifecycle — 24 h [1..168]", 24],
  ["deadline_slack_minutes", "Folga deadline — 1 min [0..10]", 1],
  ["unavailable_dedupe_seconds", "Dedupe indisponível — 10 s [1..120]", 10],
  ["cooldown_max_minutes", "Cooldown máximo — 30 min [5..120]", 30]
];
for (let index = 0; index < specs.length; index += 1) {
  const [topic, name, value] = specs[index];
  const column = index % 3;
  const row = Math.floor(index / 3);
  inject(`security_visual_policy_${topic}`, policy.id, name, topic, value,
    2420 + column * 420, 1130 + row * 60, `security_visual_policy_out_${column}`);
}
for (let column = 0; column < 3; column += 1) {
  linkOut(`security_visual_policy_out_${column}`, policy.id, "Parâmetros → validação",
    "security_visual_policy_in", 2580 + column * 420, 1340);
}
linkIn("security_visual_policy_in", policy.id, "Receber parâmetro ajustável",
  [0, 1, 2].map((column) => `security_visual_policy_out_${column}`),
  "security_visual_policy_validate", 2260, 1420);
fn("security_visual_policy_validate", policy.id, "Validar valor, unidade e limites",
  "security-light-policy-validate.js", 2, 2500, 1420,
  [["security_visual_policy_store"], ["security_visual_policy_reject"]]);
fn("security_visual_policy_store", policy.id, "Guardar última política válida",
  "security-light-policy-store.js", 1, 2820, 1390, [[]]);
fn("security_visual_policy_reject", policy.id, "Rejeitar sem substituir",
  "security-light-policy-reject.js", 0, 2820, 1460, []);

const decision = required("32a89192d93735b1");
decision.name = "2. Contexto, replay e decisão visual de acendimento";
decision.x = 64; decision.y = 1540; decision.w = 6500; decision.h = 502;
decision.nodes = decision.nodes.filter((id) => !generated.has(id));
const inputs = required("e53f5ed6c320c591");
grouped(inputs.id, { id: "security_visual_context_route_out", type: "link out", z: TAB,
  g: inputs.id, name: "Contextos → decisão visual", mode: "link",
  links: ["security_visual_context_route_in"], x: 390, y: 200, wires: [] });
grouped(inputs.id, { id: "security_visual_arrival_route_out",
  type: "link out", z: TAB, g: inputs.id, name: "Chegada → decisão visual", mode: "link",
  links: ["security_visual_arrival_route_in"], x: 390, y: 280, wires: [] });
for (const id of ["519b09225c268695", "fad81d855058dad1", "336b58c50f842082"]) {
  required(id).wires = [["security_visual_context_route_out"]];
}
required("cf9bc321e0ec89f9").wires = [["security_visual_arrival_route_out"]];
required("security_light_engine_bypass_reevaluate_in_v1").wires = [["security_visual_context_cache"]];
linkIn("security_visual_context_route_in", decision.id, "Receber contextos canônicos",
  ["security_visual_context_route_out"], "security_visual_context_cache", 160, 1660);
linkIn("security_visual_arrival_route_in", decision.id, "Receber chegada canônica",
  ["security_visual_arrival_route_out"], "security_visual_arrival_facts", 160, 1900);
fn("security_visual_context_cache", decision.id, "Normalizar e atualizar cache monotônico",
  "security-light-context-cache.js", 1, 390, 1660, [["security_visual_local_excursion"]]);
fn("security_visual_local_excursion", decision.id,
  "Retorno local: OFF → novo ON",
  "security-light-local-excursion.js", 1, 650, 1660,
  [["security_visual_engine_on_near_home"]]);
fn("security_visual_engine_on_near_home", decision.id,
  "Motor ON reavalia chegada armada?",
  "security-light-engine-on-near-home.js", 1, 910, 1660,
  [["security_visual_arrival_watch"]]);
fn("security_visual_arrival_watch", decision.id,
  "Vigiar GPS da aproximação",
  "security-light-arrival-watch.js", 1, 1160, 1660,
  [["security_visual_pending_validate"]]);
fn("security_visual_pending_validate", decision.id, "Validar intenção pendente",
  "security-light-pending-validate.js", 1, 1420, 1660, [["security_visual_replay_ready"]]);
sw("security_visual_replay_ready", decision.id,
  "Pendente ou motor ON permitem avaliar agora?",
  "_light_context.replay_ready", 1710, 1660,
  [["security_visual_replay_build"], ["48a5f40d806f6950"]]);
fn("security_visual_replay_build", decision.id, "Montar replay preservando o evento",
  "security-light-replay-build.js", 1, 1920, 1600, [["48a5f40d806f6950"]]);
const contextOutput = required("48a5f40d806f6950");
Object.assign(contextOutput, { g: decision.id, name: "Emitir contexto, reconciliação e replay",
  func: source("security-light-context-output.js"), outputs: 4, x: 2160, y: 1660 });
contextOutput.wires = [
  contextOutput.wires?.[0] ?? [], contextOutput.wires?.[1] ?? [],
  contextOutput.wires?.[2] ?? [],
  ["security_visual_people_refresh_out", "security_visual_context_decision_out"]
];
if (!decision.nodes.includes(contextOutput.id)) decision.nodes.push(contextOutput.id);
for (const [id, x, y] of [["77f539388438547c", 2460, 1560],
  ["68a67feb7cc57957", 2460, 1620], ["light_arrival_replay_route_out_v1", 2460, 1680]]) {
  Object.assign(required(id), { g: decision.id, x, y });
  if (!decision.nodes.includes(id)) decision.nodes.push(id);
}
linkOut("security_visual_people_refresh_out", decision.id,
  "Atualizar iPhone da chegada", "people_visual_arrival_refresh_in", 2460, 1740);
required("people_visual_arrival_refresh_in").links = Array.from(new Set([
  ...(required("people_visual_arrival_refresh_in").links ?? []),
  "security_visual_people_refresh_out"
]));
linkOut("security_visual_context_decision_out", decision.id,
  "Espera GPS → histórico", "security_visual_decision_route_in", 2700, 1740);

required("light_arrival_replay_gate_in_v1").wires = [["security_visual_arrival_facts"]];
fn("security_visual_arrival_facts", decision.id, "Derivar fatos sem decidir efeitos",
  "security-light-arrival-facts.js", 1, 390, 1860, [["security_light_arrival_direction_gate_v1"]]);
sw("security_light_arrival_direction_gate_v1", decision.id,
  "Morador atual veio de away e permanece em near_home?",
  "_light_arrival.direction_valid and _light_arrival.resident_approach_valid", 700, 1860,
  [["security_visual_arrival_pending"], ["security_light_arrival_direction_blocked_v1"]]);
fn("security_light_arrival_direction_blocked_v1", decision.id, "BLOQUEADO: sem direção de retorno",
  "security-light-arrival-blocked.js", 1, 990, 1980, [["security_visual_arrival_blocked_out"]]);
fn("security_visual_arrival_pending", decision.id, "Guardar intenção de chegada mais nova",
  "security-light-arrival-pending.js", 1, 990, 1840, [["security_visual_arrival_logic_ready"]]);
sw("security_visual_arrival_logic_ready", decision.id, "Luminosidade e veículo estão prontos?",
  "_light_arrival.logic_ready", 1280, 1840,
  [["security_visual_arrival_ready"], ["security_visual_arrival_recovery_needed"]]);
fn("security_visual_arrival_ready", decision.id, "Montar decisão pronta para os gates",
  "security-light-arrival-ready.js", 1, 1560, 1780, [["security_visual_arrival_ready_out"]]);
sw("security_visual_arrival_recovery_needed", decision.id, "Vehicle/motor exigem recovery?",
  "_light_arrival.recovery_needed", 1560, 1900,
  [["security_visual_arrival_recovery_allowed"], ["security_visual_arrival_pending_only"]]);
fn("security_visual_arrival_pending_only", decision.id, "Manter pendente sem novo efeito",
  "security-light-arrival-pending-only.js", 1, 1840, 1980, [["security_visual_arrival_pending_out"]]);
sw("security_visual_arrival_recovery_allowed", decision.id, "Throttle permite pedir refresh?",
  "_light_arrival.recovery_allowed", 1840, 1880,
  [["security_visual_arrival_recovery"], ["security_visual_arrival_throttled"]]);
fn("security_visual_arrival_recovery", decision.id, "Montar refresh de recovery",
  "security-light-arrival-recovery.js", 1, 2140, 1840, [["security_visual_arrival_recovery_out"]]);
fn("security_visual_arrival_throttled", decision.id, "Registrar recovery deduplicado",
  "security-light-arrival-throttled.js", 1, 2140, 1940, [["security_visual_arrival_throttled_out"]]);
const arrivalResultOuts = [
  ["security_visual_arrival_ready_out", "Pronto → resultado", 1840, 1780],
  ["security_visual_arrival_recovery_out", "Recovery → resultado", 2380, 1840],
  ["security_visual_arrival_throttled_out", "Throttle → resultado", 2380, 1940],
  ["security_visual_arrival_pending_out", "Pendente → resultado", 2080, 2020],
  ["security_visual_arrival_blocked_out", "Bloqueio → resultado", 1280, 2000]
];
for (const [id, name, x, y] of arrivalResultOuts) linkOut(id, decision.id, name,
  "security_visual_arrival_result_in", x, y);
linkIn("security_visual_arrival_result_in", decision.id, "Convergir um único caminho",
  arrivalResultOuts.map(([id]) => id), "62f77a1ad440639d", 2510, 1880);
const arrivalOutput = required("62f77a1ad440639d");
Object.assign(arrivalOutput, { g: decision.id, name: "Emitir decisão, diagnóstico e recovery",
  func: source("security-light-arrival-output.js"), outputs: 3, x: 2760, y: 1880 });
if (!decision.nodes.includes(arrivalOutput.id)) decision.nodes.push(arrivalOutput.id);
arrivalOutput.wires[1] = Array.from(new Set([
  ...(arrivalOutput.wires?.[1] ?? []), "security_visual_arrival_decision_out"
]));
linkOut("security_visual_arrival_decision_out", decision.id,
  "Decisão de chegada → histórico", "security_visual_decision_route_in", 3260, 1880);
for (const [id, x, y] of [["e7542f3caa4a99e2", 3100, 1800],
  ["81994a8c6c38a4c1", 3100, 1880], ["54b3d667ae845416", 3100, 1960]]) {
  Object.assign(required(id), { g: decision.id, x, y });
  if (!decision.nodes.includes(id)) decision.nodes.push(id);
}
for (const [id, x, y] of [
  ["security_light_engine_bypass_reevaluate_in_v1", 160, 1600],
  ["light_arrival_replay_gate_in_v1", 160, 1820],
  ["light_arrival_replay_debug_in_v1", 2400, 1600],
  ["1bdb8c52397de8a9", 2850, 1600],
  ["e10a4b1a9880e827", 3100, 1720],
  ["276ba50ad0e36bab", 3380, 1800]
]) Object.assign(required(id), { x, y, g: decision.id });
const vehicleGate = required("276ba50ad0e36bab");
vehicleGate.func = source("security-light-vehicle-gate.js");
vehicleGate.wires = [["security_visual_availability_facts"]];
fn("security_visual_availability_facts", decision.id, "Derivar fatos do atuador sem efeitos",
  "security-light-availability-facts.js", 1, 3670, 1800, [["security_visual_availability_latched"]]);
sw("security_visual_availability_latched", decision.id, "Aviso de ON já foi reservado?",
  "_light_availability.latched", 3960, 1660, [[], ["security_visual_availability_on"]]);
sw("security_visual_availability_on", decision.id, "Refletor já está ON e reconciliado?",
  "_light_availability.physical_known_on", 4230, 1740, [[], ["security_visual_availability_cycle"]]);
sw("security_visual_availability_cycle", decision.id, "Lifecycle de chegada já está ativo?",
  "_light_availability.cycle_active", 4500, 1820, [[], ["security_visual_availability_ready"]]);
sw("security_visual_availability_ready", decision.id, "Refletor OFF está disponível?",
  "_light_availability.available", 4770, 1820,
  [["security_visual_availability_ready_build"], ["security_visual_availability_duplicate"]]);
fn("security_visual_availability_ready_build", decision.id, "Autorizar acendimento",
  "security-light-availability-ready.js", 1, 5050, 1720, [["security_visual_availability_ready_out"]]);
sw("security_visual_availability_duplicate", decision.id, "Diagnóstico indisponível já foi emitido?",
  "_light_availability.duplicate_unavailable", 5050, 1920,
  [[], ["security_visual_availability_unavailable_build"]]);
fn("security_visual_availability_unavailable_build", decision.id, "Montar aviso sem chamar o atuador",
  "security-light-availability-unavailable.js", 1, 5350, 1900,
  [["security_visual_availability_unavailable_out"]]);
linkOut("security_visual_availability_ready_out", decision.id, "Disponível → resultado",
  "security_visual_availability_result_in", 5300, 1720);
linkOut("security_visual_availability_unavailable_out", decision.id, "Indisponível → resultado",
  "security_visual_availability_result_in", 5620, 1900);
linkIn("security_visual_availability_result_in", decision.id, "Convergir disponibilidade",
  ["security_visual_availability_ready_out", "security_visual_availability_unavailable_out"],
  "87b2f8eb75cb6359", 5680, 1800);
const availabilityOutput = required("87b2f8eb75cb6359");
Object.assign(availabilityOutput, { g: decision.id, name: "Rotear disponibilidade do refletor",
  func: source("security-light-availability-output.js"), outputs: 3, x: 5900, y: 1800 });
if (!decision.nodes.includes(availabilityOutput.id)) decision.nodes.push(availabilityOutput.id);
for (const [id, x, y] of [
  ["light_available_to_output_out_v1", 6220, 1720],
  ["light_unavailable_to_output_out_v1", 6220, 1800],
  ["light_unavailable_test_dry_run_out_v1", 6220, 1880]
]) Object.assign(required(id), { x, y, g: decision.id });

const effects = required("95e7527bc7a0a9a1");
const markActive = required("354c9839bfca592f");
markActive.func = source("security-light-mark-active.js");
markActive.outputs = 2;
markActive.wires = [
  Array.from(new Set([...(markActive.wires[0] ?? []), "security_visual_turned_on_decision_out"])),
  Array.from(new Set([...(markActive.wires[1] ?? []), "security_visual_turned_on_decision_out"])),
];
grouped(effects.id, {
  id: "security_visual_turned_on_decision_out", type: "link out", z: TAB,
  g: effects.id, name: "Acendimento → histórico", mode: "link",
  links: ["security_visual_decision_route_in"], x: 1280, y: 300, wires: []
});

const diagnostic = group("security_visual_decision_diagnostic_group_v1",
  "8. Última decisão — estado canônico para histórico",
  4400, 1019, 1900, 302, "#0f766e", "#ccfbf1");
grouped(diagnostic.id, {
  id: "security_visual_decision_discovery", type: "inject", z: TAB, g: diagnostic.id,
  name: "Publicar sensor no startup", props: [{ p: "payload" }, { p: "topic", vt: "str" }],
  repeat: "", crontab: "", once: true, onceDelay: "2",
  topic: "security_light_decision_discovery", payload: "", payloadType: "str",
  x: 4660, y: 1120, wires: [["security_visual_decision_publish"]]
});
linkIn("security_visual_decision_route_in", diagnostic.id,
  "Receber decisões operacionais", ["security_visual_context_decision_out",
    "security_visual_arrival_decision_out", "security_visual_turned_on_decision_out"],
  "security_visual_decision_publish", 4660, 1240);
fn("security_visual_decision_publish", diagnostic.id,
  "Classificar e publicar decisão", "security-light-decision-publish.js", 1,
  5040, 1180, [["security_visual_decision_mqtt"]]);
grouped(diagnostic.id, {
  id: "security_visual_decision_mqtt", type: "mqtt out", z: TAB, g: diagnostic.id,
  name: "Histórico da decisão", topic: "", qos: "1", retain: "true",
  respTopic: "", contentType: "", userProps: "", correl: "", expiry: "",
  broker, x: 5420, y: 1180, wires: []
});
const offGroup = required("a610d085d27ea80d");
offGroup.name = "4. Confirmar carro e decidir desligamento";
const evaluateOff = required("374d4e39be0a30ac");
evaluateOff.name = "Desligar quando o carro confirmar OFF";
evaluateOff.func = source("security-light-off-decision.js");
evaluateOff.outputs = 1;
evaluateOff.wires = [["light_off_decision_route_out_v1"]];
const turnOff = required("84d450933e67b8c1");
turnOff.func = source("security-light-turn-off-if-active.js");

const reconcile = required("6013a28eaa95addd");
reconcile.name = "0. Startup e recovery visual do lifecycle";
reconcile.x = 64; reconcile.y = 2100; reconcile.w = 3150; reconcile.h = 322;
reconcile.nodes = reconcile.nodes.filter((id) => !generated.has(id));
for (const id of ["bfcddf998d4e3a53", "eb9ffff62431e1c3", "cd40f5f8e40b07af"]) {
  required(id).wires = [["security_visual_lifecycle_load"]];
}
for (const [id, x, y] of [
  ["78753a34fe418682", 210, 2160], ["bfcddf998d4e3a53", 470, 2160],
  ["eb9ffff62431e1c3", 210, 2300], ["cd40f5f8e40b07af", 470, 2340]
]) Object.assign(required(id), { x, y, g: reconcile.id });
fn("security_visual_lifecycle_load", reconcile.id, "Validar lifecycle persistido e limites",
  "security-light-lifecycle-load.js", 1, 690, 2280, [["security_visual_physical_apply"]]);
fn("security_visual_physical_apply", reconcile.id, "Aplicar leitura física monotônica",
  "security-light-physical-apply.js", 1, 1040, 2240, [["security_visual_recovery_facts"]]);
fn("security_visual_recovery_facts", reconcile.id, "Derivar readiness e deadlines",
  "security-light-recovery-facts.js", 1, 1340, 2240, [["security_visual_recovery_needed"]]);
sw("security_visual_recovery_needed", reconcile.id, "Há deadline seguro para recuperar?",
  "_light_reconcile.recovery_needed", 1620, 2240,
  [["security_visual_recovery_build"], []]);
fn("security_visual_recovery_build", reconcile.id, "Reconstruir timers sem duplicar",
  "security-light-recovery-build.js", 1, 1900, 2200, [["a0a4977052d1ce06"]]);
const recoveryOutput = required("a0a4977052d1ce06");
Object.assign(recoveryOutput, { g: reconcile.id, name: "Emitir deadlines reconstruídos",
  func: source("security-light-recovery-output.js"), outputs: 1, x: 2170, y: 2200 });
if (!reconcile.nodes.includes(recoveryOutput.id)) reconcile.nodes.push(recoveryOutput.id);
Object.assign(required("704af53cd84ba2a2"), { g: reconcile.id, x: 2450, y: 2200 });
Object.assign(required("2405a253853fa82e"), { g: reconcile.id, x: 3020, y: 2240 });
for (const id of ["704af53cd84ba2a2", "2405a253853fa82e"]) {
  if (!reconcile.nodes.includes(id)) reconcile.nodes.push(id);
}
Object.assign(required("704af53cd84ba2a2"), {
  x: 2450, wires: [["2405a253853fa82e"]],
});
reconcile.y += 60;
for (const id of reconcile.nodes ?? []) {
  const node = required(id);
  if (Number.isFinite(node.y)) node.y += 60;
}
required(TAB).info = "Decisões de contexto, replay, direção, recovery e políticas de tempo são visíveis. A confirmação HOME de 90 s e o refresh extraordinário pertencem a contexto_chegadas; este tab apenas usa o contexto atualizado para decidir o desligamento. JavaScript remanescente adapta estruturas e aplica transações de estado; produção e teste divergem somente na fronteira final de efeitos.";
fs.writeFileSync(outputPath, `${JSON.stringify(flows, null, 4)}\n`);
console.log(`Security light visual policy installed in ${outputPath}`);
