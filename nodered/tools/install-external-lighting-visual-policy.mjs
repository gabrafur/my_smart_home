#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const inputPath = path.resolve(process.argv[2] ?? path.resolve(here, "..", "flows.json"));
const outputPath = path.resolve(process.argv[3] ?? inputPath);
const functionDir = path.join(here, "functions");
const TAB = "ce258dec9814b96b";
const source = (name) => fs.readFileSync(path.join(functionDir, name), "utf8").trimEnd();
let flows = JSON.parse(fs.readFileSync(inputPath, "utf8"));
const generated = new Set(flows.filter((node) => node.id.startsWith("external_visual_")).map((node) => node.id));
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
const grouped = (groupId, node) => { add(node); required(groupId).nodes.push(node.id); return node; };
const group = (id, name, x, y, w, h, color) => add({ id, type: "group", z: TAB, name,
  style: { label: true, color }, nodes: [], x, y, w, h });
const fn = (id, groupId, name, file, outputs, x, y, wires) => grouped(groupId, {
  id, type: "function", z: TAB, g: groupId, name, func: source(file), outputs,
  timeout: 0, noerr: 0, initialize: "", finalize: "", libs: [], x, y, wires,
});
const sw = (id, groupId, name, property, x, y, wires) => grouped(groupId, {
  id, type: "switch", z: TAB, g: groupId, name, property, propertyType: "msg",
  rules: [{ t: "true" }, { t: "else" }], checkall: "false", repair: false,
  outputs: 2, x, y, wires,
});
const linkOut = (id, groupId, name, target, x, y) => grouped(groupId, {
  id, type: "link out", z: TAB, g: groupId, name, mode: "link", links: [target], x, y, wires: [],
});
const linkIn = (id, groupId, name, origins, destination, x, y) => grouped(groupId, {
  id, type: "link in", z: TAB, g: groupId, name, links: origins, x, y, wires: [[destination]],
});

const main = required("external_lighting_full_flow_group");
Object.assign(main, {
  name: "1. Entradas, disponibilidade, efeitos e confirmação",
  x: 64, y: -1, w: 3400, h: 562,
});
main.nodes = main.nodes.filter((id) => !generated.has(id));
for (const id of ["d940e2132bca7ecc", "c7fe1a52ffe5091d", "943c87e6b17f0d68"]) {
  required(id).wires = [["ext_zigbee_command_gate"]];
}
const commandFacts = required("ext_zigbee_command_gate");
Object.assign(commandFacts, { name: "Ler política e disponibilidade Zigbee",
  func: source("external-lighting-command-facts.js"), outputs: 1, x: 1180, y: 160,
  wires: [["external_visual_zigbee_available"]] });
sw("external_visual_zigbee_available", main.id, "Rede Zigbee está offline?",
  "_external_command.zigbee_offline", 1430, 160,
  [["external_visual_command_blocked"], ["external_visual_command_allowed"]]);
fn("external_visual_command_allowed", main.id, "Preparar confirmação pelo tempo visual",
  "external-lighting-command-allowed.js", 1, 1680, 120,
  [["external_visual_command_mode"]]);
fn("external_visual_command_blocked", main.id, "Bloquear e cancelar confirmação pendente",
  "external-lighting-command-blocked.js", 1, 1700, 220,
  [["external_visual_cancel_confirmation_out", "external_visual_notification_mode"]]);
sw("external_visual_command_mode", main.id, "Comando de produção ou TESTE?",
  "_external_command.test_mode", 1930, 120,
  [["ext_wait_confirm"], ["88e6fc3e56fa347c", "ext_wait_confirm"]]);
sw("external_visual_notification_mode", main.id, "Aviso de produção ou TESTE?",
  "_external_command.test_mode", 2000, 260,
  [["external_visual_notification_dry_out"], ["external_visual_alexa_out"]]);
linkOut("external_visual_cancel_confirmation_out", main.id, "Bloqueio → cancelar confirmação",
  "external_visual_cancel_confirmation_in", 1980, 200);
linkIn("external_visual_cancel_confirmation_in", main.id, "Receber cancelamento pendente",
  ["external_visual_cancel_confirmation_out"], "ext_wait_confirm", 2260, 220);

const distributor = required("88e6fc3e56fa347c");
Object.assign(distributor, { x: 2240, y: 80 });
for (const [id, x, y] of [
  ["205cde805aa5e22c", 2620, 40], ["c6d4a518b02043a0", 2630, 100],
  ["864f90600b6a19ec", 2620, 160], ["a5ae2c780bbcef08", 2630, 220],
]) Object.assign(required(id), { x, y });
const confirmation = required("ext_wait_confirm");
Object.assign(confirmation, {
  type: "trigger", name: "Aguardar confirmação mais recente — 5 s padrão",
  op1: "", op2: "", op1type: "nul", op2type: "payl", duration: "5",
  extend: true, overrideDelay: true, units: "s", reset: "", bytopic: "all",
  topic: "topic", outputs: 1, x: 2190, y: 180,
  wires: [["external_visual_confirmation_mode"]],
});
for (const field of ["func", "timeout", "noerr", "initialize", "finalize", "libs"]) delete confirmation[field];
sw("external_visual_confirmation_mode", main.id, "Confirmar em produção ou TESTE?",
  "_external_command.test_mode", 2460, 300,
  [["external_visual_command_dry_out"], ["ext_check_states"]]);
Object.assign(required("ext_check_states"), { x: 2730, y: 300 });
Object.assign(required("ext_build_alexa_message"), { x: 3010, y: 300 });
Object.assign(required("9d81b75a18d482f1"), { x: 3290, y: 300 });
linkOut("external_visual_alexa_out", main.id, "Avisos → Alexa",
  "external_visual_alexa_in", 2180, 300);
linkIn("external_visual_alexa_in", main.id, "Receber aviso confirmado",
  ["external_visual_alexa_out"], "9d81b75a18d482f1", 3120, 380);
linkOut("external_visual_command_dry_out", main.id, "Comando TESTE → terminal",
  "external_visual_dry_in", 2680, 360);
linkOut("external_visual_notification_dry_out", main.id, "Aviso TESTE → terminal",
  "external_visual_dry_in", 2260, 220);

const recoveryPrepare = required("ext_prepare_recovery_confirmation");
Object.assign(recoveryPrepare, { func: source("external-lighting-recovery-prepare.js"),
  name: "Validar data e dedupe da confirmação", outputs: 1, wires: [["external_visual_recovery_mode"]] });
sw("external_visual_recovery_mode", main.id, "Pergunta de recovery: produção ou TESTE?",
  "_external_lighting_test", 1180, 360,
  [["external_visual_recovery_dry_out"], ["ext_send_recovery_mobile"]]);
linkOut("external_visual_recovery_dry_out", main.id, "Recovery TESTE → terminal",
  "external_visual_dry_in", 1430, 340);
Object.assign(required("ext_send_recovery_mobile"), { x: 1500, y: 440 });
Object.assign(required("ext_commit_recovery_confirmation"), { x: 1800, y: 440 });
required("ext_commit_recovery_confirmation").wires = [["external_visual_alexa_out"]];
linkIn("external_visual_test_command_in", main.id, "Receber comandos TESTE",
  ["external_visual_test_command_out"], "ext_zigbee_command_gate", 910, 260);
linkIn("external_visual_test_recovery_in", main.id, "Receber recovery TESTE",
  ["external_visual_test_recovery_out"], "ext_prepare_recovery_confirmation", 660, 360);
linkOut("external_visual_sunset_out", main.id, "Pôr do sol → comando ON",
  "external_visual_sunset_in", 520, 340);
linkOut("external_visual_confirmed_sunset_out", main.id, "Confirmação válida → comando ON",
  "external_visual_sunset_in", 1110, 520);
linkIn("external_visual_sunset_in", main.id, "Receber comando automático ON",
  ["external_visual_sunset_out", "external_visual_confirmed_sunset_out"],
  "943c87e6b17f0d68", 700, 220);
required("24743bc9f254d1c1").wires = [["external_visual_sunset_out"], []];
required("ext_confirm_recovery_sun_check").wires = [["external_visual_confirmed_sunset_out"], []];

const policy = group("external_visual_policy_group", "2. Política visual — confirmação e recovery",
  64, 619, 1100, 262, "#b58b3f");
grouped(policy.id, { id: "external_visual_policy_note", type: "comment", z: TAB, g: policy.id,
  name: "Padrões e limites; inválidos preservam a última política válida.",
  info: "Confirmação: 5 s [1..30]. TTL do recovery: 12 h [1..24]. Valores inteiros.",
  x: 550, y: 660, wires: [] });
for (const [id, name, topic, payload, y] of [
  ["external_visual_policy_settle", "Confirmação = 5 s [1..30]", "confirmation_settle_seconds", "5", 720],
  ["external_visual_policy_ttl", "TTL recovery = 12 h [1..24]", "recovery_ttl_hours", "12", 780],
]) grouped(policy.id, { id, type: "inject", z: TAB, g: policy.id, name,
  props: [{ p: "payload" }, { p: "topic", vt: "str" }], repeat: "", crontab: "",
  once: true, onceDelay: "0.2", topic, payload, payloadType: "num", x: 260, y,
  wires: [["external_visual_policy_validate"]] });
fn("external_visual_policy_validate", policy.id, "Validar valor e limites",
  "external-lighting-policy-validate.js", 2, 570, 750,
  [["external_visual_policy_store"], ["external_visual_policy_reject"]]);
fn("external_visual_policy_store", policy.id, "Guardar política canônica",
  "external-lighting-policy-store.js", 0, 850, 720, []);
fn("external_visual_policy_reject", policy.id, "Rejeitar sem substituir",
  "external-lighting-policy-reject.js", 0, 850, 790, []);

const tests = group("external_visual_test_group", "3. TESTES — pipeline real até dry-run",
  1220, 619, 1700, 302, "#4b93d1");
grouped(tests.id, { id: "external_visual_test_note", type: "comment", z: TAB, g: tests.id,
  name: "Ordem: reset; comando online; bloqueio offline; recovery. Nenhum MQTT, push ou Alexa.",
  x: 2020, y: 660, wires: [] });
grouped(tests.id, { id: "external_visual_test_reset", type: "inject", z: TAB, g: tests.id,
  name: "TESTE 1: reset", props: [{ p: "payload" }], repeat: "", crontab: "", once: false,
  onceDelay: 0.1, topic: "", payload: "", payloadType: "date", x: 1370, y: 720,
  wires: [["external_visual_test_reset_state"]] });
fn("external_visual_test_reset_state", tests.id, "Resetar somente estado sintético",
  "external-lighting-test-reset.js", 0, 1630, 720, []);
for (const [id, name, state, y] of [
  ["external_visual_test_online", "TESTE 2: Zigbee online", "online", 780],
  ["external_visual_test_offline", "TESTE 3: Zigbee offline", "offline", 840],
]) grouped(tests.id, { id, type: "inject", z: TAB, g: tests.id, name,
  props: [{ p: "payload", v: "ON", vt: "str" }, { p: "expected_state", v: "on", vt: "str" },
    { p: "_external_lighting_test", v: "true", vt: "bool" },
    { p: "_external_test_zigbee_state", v: state, vt: "str" }],
  repeat: "", crontab: "", once: false, onceDelay: 0.1, topic: "", payload: "", payloadType: "date",
  x: 1390, y, wires: [["external_visual_test_command_out"]] });
linkOut("external_visual_test_command_out", tests.id, "Comando TESTE → pipeline",
  "external_visual_test_command_in", 1680, 810);
grouped(tests.id, { id: "external_visual_test_recovery", type: "inject", z: TAB, g: tests.id,
  name: "TESTE 4: recovery pós-pôr do sol", props: [
    { p: "sun_last_changed", v: "", vt: "date" },
    { p: "_external_lighting_test", v: "true", vt: "bool" },
  ], repeat: "", crontab: "", once: false, onceDelay: 0.1, topic: "", payload: "", payloadType: "date",
  x: 2030, y: 780, wires: [["external_visual_test_recovery_out"]] });
linkOut("external_visual_test_recovery_out", tests.id, "Recovery TESTE → pipeline",
  "external_visual_test_recovery_in", 2290, 780);
linkIn("external_visual_dry_in", tests.id, "Receber efeitos simulados",
  ["external_visual_command_dry_out", "external_visual_notification_dry_out", "external_visual_recovery_dry_out"],
  "external_visual_dry_terminal", 2470, 840);
fn("external_visual_dry_terminal", tests.id, "TESTE FINAL: nenhum efeito enviado",
  "external-lighting-dry-run.js", 0, 2730, 840, []);

required(TAB).info = "Iluminação externa com disponibilidade, produção/teste e confirmação visíveis. A política visual controla settle e TTL; funções remanescentes adaptam payloads, datas e tokens. Testes percorrem o pipeline canônico e terminam antes de MQTT, push e Alexa.";
fs.writeFileSync(outputPath, `${JSON.stringify(flows, null, 4)}\n`);
console.log(`External lighting visual policy installed in ${outputPath}`);
