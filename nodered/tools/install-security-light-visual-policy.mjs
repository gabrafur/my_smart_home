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
  "security_light_arrival_direction_blocked_v1"
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
  "security-light-context-cache.js", 1, 390, 1660, [["security_visual_pending_validate"]]);
fn("security_visual_pending_validate", decision.id, "Validar intenção pendente e retenção",
  "security-light-pending-validate.js", 1, 720, 1660, [["security_visual_replay_ready"]]);
sw("security_visual_replay_ready", decision.id, "Contextos permitem replay agora?",
  "_light_context.replay_ready", 1010, 1660,
  [["security_visual_replay_build"], ["48a5f40d806f6950"]]);
fn("security_visual_replay_build", decision.id, "Montar replay preservando o evento",
  "security-light-replay-build.js", 1, 1300, 1600, [["48a5f40d806f6950"]]);
const contextOutput = required("48a5f40d806f6950");
Object.assign(contextOutput, { g: decision.id, name: "Emitir contexto, reconciliação e replay",
  func: source("security-light-context-output.js"), outputs: 3, x: 1480, y: 1660 });
if (!decision.nodes.includes(contextOutput.id)) decision.nodes.push(contextOutput.id);
for (const [id, x, y] of [["77f539388438547c", 1840, 1600],
  ["68a67feb7cc57957", 1840, 1660], ["light_arrival_replay_route_out_v1", 1840, 1720]]) {
  Object.assign(required(id), { g: decision.id, x, y });
  if (!decision.nodes.includes(id)) decision.nodes.push(id);
}

required("light_arrival_replay_gate_in_v1").wires = [["security_visual_arrival_facts"]];
fn("security_visual_arrival_facts", decision.id, "Derivar fatos sem decidir efeitos",
  "security-light-arrival-facts.js", 1, 390, 1860, [["security_light_arrival_direction_gate_v1"]]);
sw("security_light_arrival_direction_gate_v1", decision.id, "Retorno externo está confirmado?",
  "_light_arrival.direction_valid", 700, 1860,
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
for (const [id, x, y] of [["e7542f3caa4a99e2", 3100, 1800],
  ["81994a8c6c38a4c1", 3100, 1880], ["54b3d667ae845416", 3100, 1960]]) {
  Object.assign(required(id), { g: decision.id, x, y });
  if (!decision.nodes.includes(id)) decision.nodes.push(id);
}
for (const [id, x, y] of [
  ["security_light_engine_bypass_reevaluate_in_v1", 160, 1600],
  ["light_arrival_replay_gate_in_v1", 160, 1820],
  ["light_arrival_replay_debug_in_v1", 2060, 1600],
  ["1bdb8c52397de8a9", 2310, 1600],
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

const markActive = required("354c9839bfca592f");
markActive.func = source("security-light-mark-active.js");
const canonicalPrelude = `const LOCATION_POLICY = global.get("location_policy_v1", "persistent");\nconst LIGHT_POLICY = global.get("security_light_policy_v1", "persistent");\nif (LOCATION_POLICY?.version !== 1 || LOCATION_POLICY?.complete !== true || LIGHT_POLICY?.version !== 1 || LIGHT_POLICY?.complete !== true) { node.error("iluminacao_seguranca: política canônica ausente", msg); return null; }\nconst FUTURE_TOLERANCE_MS = Number(LOCATION_POLICY.future_tolerance_seconds) * 1000;\nconst PHYSICAL_FRESH_MS = Number(LIGHT_POLICY.physical_fresh_seconds) * 1000;\n`;
const evaluateOff = required("374d4e39be0a30ac");
if (!evaluateOff.func.includes("LIGHT_POLICY = global.get")) evaluateOff.func = canonicalPrelude + evaluateOff.func;
evaluateOff.func = evaluateOff.func
  .replace("const GRACE_MS = 90 * 1000;", "const GRACE_MS = Number(LIGHT_POLICY.off_grace_seconds) * 1000;")
  .replaceAll("physicalObservedAt <= now + 60 * 1000", "physicalObservedAt <= now + FUTURE_TOLERANCE_MS")
  .replaceAll("now - physicalObservedAt <= 2 * 60 * 1000", "now - physicalObservedAt <= PHYSICAL_FRESH_MS");
const turnOff = required("84d450933e67b8c1");
if (!turnOff.func.includes("LIGHT_POLICY = global.get")) turnOff.func = canonicalPrelude + turnOff.func;
turnOff.func = turnOff.func
  .replaceAll("physicalObservedAt <= now + 60 * 1000", "physicalObservedAt <= now + FUTURE_TOLERANCE_MS")
  .replaceAll("now - physicalObservedAt <= 2 * 60 * 1000", "now - physicalObservedAt <= PHYSICAL_FRESH_MS")
  .replace("lifecycle.cooldown_until = now + 5 * 60 * 1000;",
    "lifecycle.cooldown_until = now + Number(LIGHT_POLICY.post_off_cooldown_minutes) * 60000;");

const reconcile = required("6013a28eaa95addd");
reconcile.name = "0. Startup e recovery visual do lifecycle";
reconcile.x = 64; reconcile.y = 2100; reconcile.w = 2690; reconcile.h = 322;
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
Object.assign(required("704af53cd84ba2a2"), { g: reconcile.id, x: 2410, y: 2200 });
Object.assign(required("2405a253853fa82e"), { g: reconcile.id, x: 2670, y: 2200 });
for (const id of ["704af53cd84ba2a2", "2405a253853fa82e"]) {
  if (!reconcile.nodes.includes(id)) reconcile.nodes.push(id);
}

required(TAB).info = "Decisões de contexto, replay, direção, recovery e políticas de tempo são visíveis. JavaScript remanescente adapta estruturas e aplica transações de estado; produção e teste divergem somente na fronteira final de efeitos.";
fs.writeFileSync(outputPath, `${JSON.stringify(flows, null, 4)}\n`);
console.log(`Security light visual policy installed in ${outputPath}`);
