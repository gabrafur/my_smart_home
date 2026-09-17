#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.resolve(process.argv[2] ?? path.resolve(here, "..", "flows.json"));
const outputPath = path.resolve(process.argv[3] ?? sourcePath);
const functionDir = path.join(here, "functions");
const TAB = "host_memory_guardian_tab";
const flows = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
const source = (name) => fs.readFileSync(path.join(functionDir, name), "utf8").trimEnd();
const owned = (node) => node.id === TAB || node.z === TAB || node.id.startsWith("host_memory_guardian_");
const removed = new Set(flows.filter(owned).map((node) => node.id));
const next = flows.filter((node) => !owned(node));
for (const node of next) {
  for (const field of ["nodes", "scope", "links"]) {
    if (Array.isArray(node[field])) node[field] = node[field].filter((id) => !removed.has(id));
  }
  if (Array.isArray(node.wires)) node.wires = node.wires.map((wire) =>
    Array.isArray(wire) ? wire.filter((id) => !removed.has(id)) : wire
  );
}

const nodes = [];
const add = (node) => { nodes.push(node); return node.id; };
const group = (id, name, x, y, w, h, stroke, fill) => add({
  id, type: "group", z: TAB, name,
  style: { label: true, "label-position": "nw", color: "#1f2937", stroke, "stroke-opacity": "1", fill, "fill-opacity": "0.35" },
  nodes: [], x, y, w, h,
});
const groups = {
  input: group("host_memory_guardian_input_group", "0. Parâmetros, agendas e fonte sanitizada", 64, 20, 1100, 510, "#2563eb", "#dbeafe"),
  decision: group("host_memory_guardian_decision_group", "1. Normalização, estado e decisões visuais", 1200, 20, 3200, 510, "#0f766e", "#ccfbf1"),
  effect: group("host_memory_guardian_effect_group", "2. Fronteiras de efeito e observabilidade", 4440, 20, 1600, 510, "#dc2626", "#fee2e2"),
  test: group("host_memory_guardian_test_group", "3. Replay manual completo — dry-run", 64, 580, 2600, 440, "#0891b2", "#cffafe"),
};
const grouped = (g, node) => { add(node); nodes.find((entry) => entry.id === g).nodes.push(node.id); return node.id; };
const fn = (id, g, name, file, outputs, x, y, wires) => grouped(g, {
  id, type: "function", z: TAB, g, name, func: source(file), outputs,
  timeout: 0, noerr: 0, initialize: "", finalize: "", libs: [], x, y, wires,
});
const terminal = (id, g, name, status, x, y) => grouped(g, {
  id, type: "function", z: TAB, g, name,
  func: `node.status(${JSON.stringify(status)});\nreturn null;`, outputs: 0,
  timeout: 0, noerr: 0, initialize: "", finalize: "", libs: [], x, y, wires: [],
});
const inject = (id, g, name, props, x, y, wires, extra = {}) => grouped(g, {
  id, type: "inject", z: TAB, g, name, props, repeat: "", crontab: "", once: false,
  onceDelay: 0.1, topic: "", payload: "", payloadType: "date", x, y, wires, ...extra,
});
const sw = (id, g, name, property, propertyType, rules, x, y, wires) => grouped(g, {
  id, type: "switch", z: TAB, g, name, property, propertyType, rules,
  checkall: "true", repair: false, outputs: rules.length, x, y, wires,
});
const change = (id, g, name, rules, x, y, wires) => grouped(g, {
  id, type: "change", z: TAB, g, name, rules, action: "", property: "", from: "", to: "", reg: false, x, y, wires,
});
const linkOut = (id, g, name, targets, x, y) => grouped(g, {
  id, type: "link out", z: TAB, g, name, mode: "link", links: Array.isArray(targets) ? targets : [targets], x, y, wires: [],
});
const linkIn = (id, g, name, origins, destination, x, y) => grouped(g, {
  id, type: "link in", z: TAB, g, name, links: Array.isArray(origins) ? origins : [origins], x, y, wires: [[destination]],
});
const execNode = (id, g, name, command, x, y, wires) => grouped(g, {
  id, type: "exec", z: TAB, g, name, command, addpay: "", append: "", useSpawn: "false",
  timer: "15", winHide: false, oldrc: false, x, y, wires,
});

add({
  id: TAB, type: "tab", label: "guardiao_memoria_host", disabled: false,
  info: "Node-RED agenda, valida, deduplica e observa. O helper allowlisted conserva a decisão de segurança junto ao acesso privilegiado ao host. Testes atravessam o mesmo caminho e terminam em dry-run.", env: [],
});

grouped(groups.input, {
  id: "host_memory_guardian_architecture", type: "comment", z: TAB, g: groups.input,
  name: "Parâmetros: solicitar 60 s; ler 30 s; resultado válido por 180 s; temporários com idade mínima de 2 h.",
  info: "O Node-RED nunca recebe /proc, sudo, CAP_KILL ou PID namespace. O worker usa allowlist fechada para sessões remotas e temporários do repositório, valida proprietário, idade, uso ativo, symlinks, limites por ciclo, dois ciclos ociosos, revalidação e proteção de serviços essenciais.",
  x: 580, y: 60, wires: [],
});
inject("host_memory_guardian_tick", groups.input, "POLÍTICA: solicitar a cada 60 s", [{ p: "payload" }], 235, 140, [["host_memory_guardian_request_schedule_out"]], { repeat: "60", once: true, onceDelay: "75" });
linkOut("host_memory_guardian_request_schedule_out", groups.input, "Agenda → validar pedido", "host_memory_guardian_request_in", 600, 140);
inject("host_memory_guardian_result_tick", groups.input, "POLÍTICA: ler resultado a cada 30 s", [{ p: "payload" }], 245, 250, [["host_memory_guardian_read_result"]], { repeat: "30", once: true, onceDelay: "90" });
execNode("host_memory_guardian_read_result", groups.input, "FONTE: ler resultado (timeout 15 s)", "/opt/read-host-memory-guardian-result.sh", 540, 250, [["host_memory_guardian_result_out"], ["host_memory_guardian_result_error"], ["host_memory_guardian_result_complete"]]);
linkOut("host_memory_guardian_result_out", groups.input, "Resultado → normalização", "host_memory_guardian_result_in", 1010, 210);
fn("host_memory_guardian_result_error", groups.input, "Falha de leitura", "host-memory-guardian-result-error.js", 0, 830, 280, []);
fn("host_memory_guardian_result_complete", groups.input, "Adaptar código da leitura", "host-memory-guardian-completion-normalize.js", 1, 560, 390, [["host_memory_guardian_result_complete_switch"]]);
sw("host_memory_guardian_result_complete_switch", groups.input, "Leitura terminou com código zero?", "guardian_exit_code", "msg", [{ t: "eq", v: "0", vt: "num" }, { t: "else" }], 800, 390, [["host_memory_guardian_read_ok"], ["host_memory_guardian_read_failed"]]);
terminal("host_memory_guardian_read_ok", groups.input, "Leitura concluída", { fill: "green", shape: "dot", text: "leitura concluída" }, 1050, 350);
terminal("host_memory_guardian_read_failed", groups.input, "Leitura retornou falha", { fill: "red", shape: "ring", text: "leitura falhou" }, 1050, 440);

linkIn("host_memory_guardian_request_in", groups.decision, "Receber pedido agendado ou TESTE", ["host_memory_guardian_request_schedule_out", "host_memory_guardian_test_request_out"], "host_memory_guardian_prepare_request", 1250, 110);
fn("host_memory_guardian_prepare_request", groups.decision, "Adaptar pedido ao contrato", "host-memory-guardian-prepare-request.js", 1, 1510, 110, [["host_memory_guardian_request_contract"]]);
sw("host_memory_guardian_request_contract", groups.decision, "Contrato do pedido é válido?", "payload.event", "msg", [{ t: "eq", v: "host_memory_guardian_requested", vt: "str" }, { t: "else" }], 1800, 110, [["host_memory_guardian_side_effect_guard"], ["host_memory_guardian_invalid_request"]]);
sw("host_memory_guardian_side_effect_guard", groups.decision, "Pedido está em TESTE?", "_host_memory_guardian_test", "msg", [{ t: "true" }, { t: "else" }], 2100, 90, [["host_memory_guardian_request_dry_out"], ["host_memory_guardian_request_host_out"]]);
terminal("host_memory_guardian_invalid_request", groups.decision, "Rejeitar pedido inválido", { fill: "red", shape: "ring", text: "pedido inválido rejeitado" }, 2100, 150);
linkOut("host_memory_guardian_request_dry_out", groups.decision, "Pedido TESTE → dry-run", "host_memory_guardian_dry_in", 2420, 60);
linkOut("host_memory_guardian_request_host_out", groups.decision, "Produção → worker allowlisted", "host_memory_guardian_request_host_in", 2500, 100);

linkIn("host_memory_guardian_result_in", groups.decision, "Receber resultado real ou sintético", ["host_memory_guardian_result_out", "host_memory_guardian_test_healthy_out", "host_memory_guardian_test_reclaimed_out", "host_memory_guardian_test_candidate_out", "host_memory_guardian_test_terminated_out", "host_memory_guardian_test_duplicate_out", "host_memory_guardian_test_result_out", "host_memory_guardian_test_stale_out"], "host_memory_guardian_parse_result", 1250, 285);
fn("host_memory_guardian_parse_result", groups.decision, "Adaptar resposta estrutural", "host-memory-guardian-result-normalize.js", 1, 1510, 285, [["host_memory_guardian_result_presence"]]);
sw("host_memory_guardian_result_presence", groups.decision, "Existe resultado novo para avaliar?", "guardian_result_present", "msg", [{ t: "true" }, { t: "else" }], 1800, 285, [["host_memory_guardian_result_protocol"], ["host_memory_guardian_no_result"]]);
terminal("host_memory_guardian_no_result", groups.decision, "Sem resultado — encerrar ciclo", { fill: "grey", shape: "ring", text: "nenhum resultado novo" }, 2100, 240);
sw("host_memory_guardian_result_protocol", groups.decision, "Resposta respeita o contrato?", "guardian_protocol_valid", "msg", [{ t: "true" }, { t: "else" }], 2100, 310, [["host_memory_guardian_result_age_policy"], ["host_memory_guardian_protocol_error_out"]]);
linkOut("host_memory_guardian_protocol_error_out", groups.decision, "Contrato inválido → erro", "host_memory_guardian_protocol_error_in", 2350, 350);
linkIn("host_memory_guardian_protocol_error_in", groups.decision, "Receber erro estrutural", "host_memory_guardian_protocol_error_out", "host_memory_guardian_mark_error", 3810, 315);
change("host_memory_guardian_result_age_policy", groups.decision, "POLÍTICA: resultado com até 180 s", [{ t: "set", p: "guardian_max_age_seconds", pt: "msg", to: "180", tot: "num" }], 2380, 285, [["host_memory_guardian_result_freshness"]]);
fn("host_memory_guardian_result_freshness", groups.decision, "Classificar idade do resultado", "host-memory-guardian-result-freshness.js", 1, 2660, 285, [["host_memory_guardian_result_freshness_switch"]]);
sw("host_memory_guardian_result_freshness_switch", groups.decision, "Resultado ainda está vigente?", "guardian_result_fresh", "msg", [{ t: "true" }, { t: "else" }], 2930, 285, [["host_memory_guardian_result_state"], ["host_memory_guardian_mark_stale"]]);
change("host_memory_guardian_mark_stale", groups.decision, "Marcar resultado vencido", [{ t: "set", p: "payload.original_status", pt: "msg", to: "payload.status", tot: "msg" }, { t: "set", p: "payload.status", pt: "msg", to: "failed", tot: "str" }, { t: "set", p: "payload.reason", pt: "msg", to: "stale_result", tot: "str" }, { t: "set", p: "guardian_status", pt: "msg", to: "failed", tot: "str" }], 3210, 335, [["host_memory_guardian_result_state"]]);
fn("host_memory_guardian_result_state", groups.decision, "Manter assinatura persistente", "host-memory-guardian-result-dedupe.js", 1, 3210, 285, [["host_memory_guardian_duplicate_switch"]]);
sw("host_memory_guardian_duplicate_switch", groups.decision, "Assinatura já foi processada?", "guardian_duplicate", "msg", [{ t: "true" }, { t: "else" }], 3490, 285, [["host_memory_guardian_duplicate_mode"], ["host_memory_guardian_status_switch"]]);
sw("host_memory_guardian_duplicate_mode", groups.decision, "Duplicata pertence a TESTE?", "_host_memory_guardian_test", "msg", [{ t: "true" }, { t: "else" }], 3750, 220, [["host_memory_guardian_mark_duplicate"], ["host_memory_guardian_duplicate_terminal"]]);
change("host_memory_guardian_mark_duplicate", groups.decision, "Marcar deduplicação simulada", [{ t: "set", p: "payload.status", pt: "msg", to: "duplicate", tot: "str" }], 4010, 200, [["host_memory_guardian_duplicate_dry_out"]]);
linkOut("host_memory_guardian_duplicate_dry_out", groups.decision, "Duplicata TESTE → dry-run", "host_memory_guardian_dry_in", 4290, 200);
terminal("host_memory_guardian_duplicate_terminal", groups.decision, "Duplicata descartada", { fill: "grey", shape: "ring", text: "resultado duplicado" }, 4010, 250);
sw("host_memory_guardian_status_switch", groups.decision, "Status: falha, recuperação, saudável ou pressão?", "guardian_status", "msg", [{ t: "eq", v: "failed", vt: "str" }, { t: "eq", v: "cleanup_partial", vt: "str" }, { t: "eq", v: "terminated", vt: "str" }, { t: "eq", v: "reclaimed", vt: "str" }, { t: "eq", v: "healthy", vt: "str" }, { t: "eq", v: "running", vt: "str" }, { t: "else" }], 3750, 390, [["host_memory_guardian_mark_error"], ["host_memory_guardian_mark_error"], ["host_memory_guardian_mark_audit"], ["host_memory_guardian_mark_audit"], ["host_memory_guardian_mark_healthy"], ["host_memory_guardian_mark_healthy"], ["host_memory_guardian_mark_pressure"]]);
change("host_memory_guardian_mark_error", groups.decision, "Decisão: registrar erro", [{ t: "set", p: "guardian_effect", pt: "msg", to: "error", tot: "str" }], 4040, 310, [["host_memory_guardian_effect_mode"]]);
change("host_memory_guardian_mark_audit", groups.decision, "Decisão: auditar memória recuperada", [{ t: "set", p: "guardian_effect", pt: "msg", to: "audit", tot: "str" }], 4040, 355, [["host_memory_guardian_effect_mode"]]);
change("host_memory_guardian_mark_healthy", groups.decision, "Decisão: estado saudável", [{ t: "set", p: "guardian_effect", pt: "msg", to: "healthy", tot: "str" }], 4040, 410, [["host_memory_guardian_effect_mode"]]);
change("host_memory_guardian_mark_pressure", groups.decision, "Decisão: observar pressão", [{ t: "set", p: "guardian_effect", pt: "msg", to: "pressure", tot: "str" }], 4040, 465, [["host_memory_guardian_effect_mode"]]);
sw("host_memory_guardian_effect_mode", groups.decision, "Efeito pertence a TESTE?", "_host_memory_guardian_test", "msg", [{ t: "true" }, { t: "else" }], 4280, 380, [["host_memory_guardian_dry_out"], ["host_memory_guardian_effect_out"]]);
linkOut("host_memory_guardian_effect_out", groups.decision, "Produção → observabilidade", "host_memory_guardian_effect_in", 4370, 420);
linkOut("host_memory_guardian_dry_out", groups.decision, "TESTE → terminal dry-run", "host_memory_guardian_dry_in", 4370, 480);

linkIn("host_memory_guardian_request_host_in", groups.effect, "Receber pedido de produção", "host_memory_guardian_request_host_out", "host_memory_guardian_request_host", 4490, 100);
execNode("host_memory_guardian_request_host", groups.effect, "EFEITO: solicitar worker (timeout 15 s)", "/opt/request-host-memory-guardian.sh", 4790, 100, [["host_memory_guardian_request_ack"], ["host_memory_guardian_request_error"], ["host_memory_guardian_request_complete"]]);
fn("host_memory_guardian_request_ack", groups.effect, "Adaptar aceite da ponte", "host-memory-guardian-request-response-normalize.js", 1, 5080, 75, [["host_memory_guardian_request_ack_switch"]]);
sw("host_memory_guardian_request_ack_switch", groups.effect, "Ponte aceitou, coalesceu ou rejeitou?", "guardian_request_status", "msg", [{ t: "eq", v: "accepted", vt: "str" }, { t: "eq", v: "coalesced", vt: "str" }, { t: "else" }], 5390, 75, [["host_memory_guardian_request_accepted"], ["host_memory_guardian_request_coalesced"], ["host_memory_guardian_request_invalid"]]);
terminal("host_memory_guardian_request_accepted", groups.effect, "Solicitação aceita", { fill: "green", shape: "dot", text: "verificação aceita" }, 5800, 45);
terminal("host_memory_guardian_request_coalesced", groups.effect, "Solicitação já pendente", { fill: "yellow", shape: "dot", text: "verificação já pendente" }, 5800, 95);
fn("host_memory_guardian_request_invalid", groups.effect, "Resposta da ponte inválida", "host-memory-guardian-request-invalid.js", 0, 5800, 145, []);
fn("host_memory_guardian_request_error", groups.effect, "Falha da ponte", "host-memory-guardian-request-error.js", 0, 5080, 155, []);
fn("host_memory_guardian_request_complete", groups.effect, "Adaptar código da solicitação", "host-memory-guardian-completion-normalize.js", 1, 5100, 225, [["host_memory_guardian_request_complete_switch"]]);
sw("host_memory_guardian_request_complete_switch", groups.effect, "Solicitação terminou com código zero?", "guardian_exit_code", "msg", [{ t: "eq", v: "0", vt: "num" }, { t: "else" }], 5400, 225, [["host_memory_guardian_request_ok"], ["host_memory_guardian_request_failed"]]);
terminal("host_memory_guardian_request_ok", groups.effect, "Worker solicitado", { fill: "green", shape: "dot", text: "worker solicitado" }, 5800, 205);
terminal("host_memory_guardian_request_failed", groups.effect, "Solicitação retornou falha", { fill: "red", shape: "ring", text: "solicitação falhou" }, 5800, 255);

linkIn("host_memory_guardian_effect_in", groups.effect, "Receber decisão canônica", "host_memory_guardian_effect_out", "host_memory_guardian_effect_switch", 4490, 370);
sw("host_memory_guardian_effect_switch", groups.effect, "Executar erro, auditoria ou status", "guardian_effect", "msg", [{ t: "eq", v: "error", vt: "str" }, { t: "eq", v: "audit", vt: "str" }, { t: "eq", v: "healthy", vt: "str" }, { t: "eq", v: "pressure", vt: "str" }, { t: "else" }], 4790, 370, [["host_memory_guardian_effect_error"], ["host_memory_guardian_effect_log"], ["host_memory_guardian_effect_healthy"], ["host_memory_guardian_effect_pressure"], ["host_memory_guardian_effect_invalid"]]);
fn("host_memory_guardian_effect_error", groups.effect, "OBSERVAR: falha canônica", "host-memory-guardian-effect-error.js", 0, 5180, 315, []);
fn("host_memory_guardian_effect_log", groups.effect, "AUDITAR: memória recuperada", "host-memory-guardian-effect-log.js", 0, 5180, 365, []);
terminal("host_memory_guardian_effect_healthy", groups.effect, "OBSERVAR: memória saudável", { fill: "green", shape: "dot", text: "memória saudável" }, 5180, 415);
terminal("host_memory_guardian_effect_pressure", groups.effect, "OBSERVAR: pressão segura", { fill: "yellow", shape: "dot", text: "pressão sem ação insegura" }, 5180, 465);
terminal("host_memory_guardian_effect_invalid", groups.effect, "Rejeitar efeito desconhecido", { fill: "red", shape: "ring", text: "efeito desconhecido" }, 5180, 510);

grouped(groups.test, {
  id: "host_memory_guardian_test_instructions", type: "comment", z: TAB, g: groups.test,
  name: "Ordem: reset → pedido → saudável → temporários → candidato → encerramento → duplicata → falha → vencido.",
  info: "Os resultados percorrem o adaptador, validação estrutural, vigência, estado persistente isolado, dedupe, classificação e gate de efeitos. Tudo termina com dispatched:false; o algoritmo do host mantém fixtures separadas.", x: 980, y: 620, wires: [],
});
inject("host_memory_guardian_test_reset", groups.test, "TESTE 1: reset", [{ p: "_host_memory_guardian_test", v: "true", vt: "bool" }], 180, 700, [["host_memory_guardian_reset_test"]]);
fn("host_memory_guardian_reset_test", groups.test, "Resetar estado sintético", "host-memory-guardian-reset-test.js", 0, 410, 700, []);
inject("host_memory_guardian_test_request", groups.test, "TESTE 2: solicitar limpeza", [{ p: "payload" }, { p: "_host_memory_guardian_test", v: "true", vt: "bool" }], 195, 770, [["host_memory_guardian_test_request_out"]]);
linkOut("host_memory_guardian_test_request_out", groups.test, "Pedido TESTE → decisões reais", "host_memory_guardian_request_in", 500, 770);
const resultProps = (payload) => [{ p: "payload", v: JSON.stringify(payload), vt: "json" }, { p: "_host_memory_guardian_test", v: "true", vt: "bool" }];
inject("host_memory_guardian_test_healthy", groups.test, "TESTE 3: memória saudável", resultProps({ status: "healthy", request_id: "test-healthy", checked_at: "2026-01-01T00:00:00Z", available_mib: 4096, available_percent: 50, terminated: 0, test_mode: true }), 190, 850, [["host_memory_guardian_test_healthy_out"]]);
linkOut("host_memory_guardian_test_healthy_out", groups.test, "Saudável → decisões", "host_memory_guardian_result_in", 400, 850);
inject("host_memory_guardian_test_reclaimed", groups.test, "TESTE 4: temporários recuperados", resultProps({ status: "reclaimed", request_id: "test-reclaimed", checked_at: "2026-01-01T00:00:30Z", available_mib: 4600, available_percent: 56, temp_removed: 12, temp_reclaimed_mib: 512, terminated: 0, test_mode: true }), 620, 930, [["host_memory_guardian_test_reclaimed_out"]]);
linkOut("host_memory_guardian_test_reclaimed_out", groups.test, "Recuperação → decisões", "host_memory_guardian_result_in", 860, 930);
inject("host_memory_guardian_test_candidate", groups.test, "TESTE 5: candidato observado", resultProps({ status: "candidate_observed", request_id: "test-candidate", checked_at: "2026-01-01T00:01:00Z", available_mib: 4096, available_percent: 50, candidate_pid: "synthetic", candidate_mib: 640, terminated: 0, test_mode: true }), 620, 850, [["host_memory_guardian_test_candidate_out"]]);
linkOut("host_memory_guardian_test_candidate_out", groups.test, "Candidato → decisões", "host_memory_guardian_result_in", 850, 850);
const terminated = { status: "terminated", request_id: "test-terminated", checked_at: "2026-01-01T00:02:00Z", available_mib: 4096, available_percent: 50, candidate_pid: "synthetic", candidate_mib: 640, terminated: 4, test_mode: true };
inject("host_memory_guardian_test_terminated", groups.test, "TESTE 6: encerramento aprovado", resultProps(terminated), 1060, 850, [["host_memory_guardian_test_terminated_out"]]);
linkOut("host_memory_guardian_test_terminated_out", groups.test, "Encerramento → decisões", "host_memory_guardian_result_in", 1300, 850);
inject("host_memory_guardian_test_duplicate", groups.test, "TESTE 7: repetir encerramento", resultProps(terminated), 1500, 850, [["host_memory_guardian_test_duplicate_out"]]);
linkOut("host_memory_guardian_test_duplicate_out", groups.test, "Duplicata → decisões", "host_memory_guardian_result_in", 1730, 850);
inject("host_memory_guardian_test_failed", groups.test, "TESTE 8: falha do worker", resultProps({ status: "failed", request_id: "test-failed", checked_at: "2026-01-01T00:03:00Z", available_mib: 900, available_percent: 11, terminated: 0, test_mode: true }), 1910, 850, [["host_memory_guardian_test_result_out"]]);
linkOut("host_memory_guardian_test_result_out", groups.test, "Falha → decisões", "host_memory_guardian_result_in", 2150, 850);
inject("host_memory_guardian_test_stale", groups.test, "TESTE 9: resultado vencido", [...resultProps({ status: "healthy", request_id: "test-stale", checked_at: "2020-01-01T00:00:00Z", available_mib: 4096, available_percent: 50, terminated: 0, test_mode: true }), { p: "_host_memory_guardian_force_stale", v: "true", vt: "bool" }], 1120, 930, [["host_memory_guardian_test_stale_out"]]);
linkOut("host_memory_guardian_test_stale_out", groups.test, "Vencido → decisões", "host_memory_guardian_result_in", 1360, 930);
linkIn("host_memory_guardian_dry_in", groups.test, "Receber efeito TESTE", ["host_memory_guardian_dry_out", "host_memory_guardian_request_dry_out", "host_memory_guardian_duplicate_dry_out"], "host_memory_guardian_dry_run_terminal", 1990, 760);
fn("host_memory_guardian_dry_run_terminal", groups.test, "TESTE FINAL: sinais e host bloqueados", "host-memory-guardian-dry-run.js", 0, 2260, 760, []);

next.push(...nodes);
fs.writeFileSync(outputPath, `${JSON.stringify(next, null, 4)}\n`);
console.log(`Host memory guardian visual flow installed in ${outputPath}`);
