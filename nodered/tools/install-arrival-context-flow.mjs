#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.resolve(process.argv[2] ?? path.resolve(here, "..", "flows.json"));
const outputPath = path.resolve(process.argv[3] ?? sourcePath);
const functionsDir = path.join(here, "functions");
const TAB = "62bb822e033d1623";
const PRESERVED = new Set(["3514854bb1279cbb", "45cb8ce559f5a522", "9f9a1fe3c4afc387", "1ba5ecf650ac79b8", "6473697c19342f07", "9f109b7076619124"]);
const flows = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
const source = (name) => fs.readFileSync(path.join(functionsDir, name), "utf8").trimEnd();
const owned = (node) => node.id === TAB || node.z === TAB;
const removed = new Set(flows.filter(owned).map((node) => node.id));
const next = flows.filter((node) => !owned(node));
for (const node of next) {
  for (const field of ["nodes", "scope"]) if (Array.isArray(node[field])) node[field] = node[field].filter((id) => !removed.has(id));
  if (Array.isArray(node.links)) node.links = node.links.filter((id) => !removed.has(id) || PRESERVED.has(id));
  if (Array.isArray(node.wires)) node.wires = node.wires.map((wire) => Array.isArray(wire) ? wire.filter((id) => !removed.has(id)) : wire);
}
const nodes = [];
const add = (node) => { nodes.push(node); return node.id; };
const group = (id, name, x, y, w, h, stroke, fill) => add({ id, type: "group", z: TAB, name,
  style: { label: true, "label-position": "nw", color: "#1f2937", stroke, "stroke-opacity": "1", fill, "fill-opacity": "0.35" }, nodes: [], x, y, w, h });
const groups = {
  input: group("arrival_context_input_group", "0. Política, agendas e contratos", 64, 20, 1100, 700, "#2563eb", "#dbeafe"),
  cycle: group("arrival_context_cycle_group", "1. Ciclo e coalescência", 1200, 20, 2600, 700, "#0f766e", "#ccfbf1"),
  snapshot: group("arrival_context_snapshot_group", "2. Validação monotônica do snapshot", 3840, 20, 3300, 700, "#7c3aed", "#ede9fe"),
  departure: group("arrival_context_departure_group", "3. Saída de morador", 64, 760, 3500, 500, "#b45309", "#ffedd5"),
  pending: group("arrival_context_pending_group", "4. Junção dos domínios e política conjunta", 3600, 760, 4400, 500, "#0f766e", "#ccfbf1"),
  home: group("arrival_context_home_refresh_group", "5. HOME confirmado — atualização extraordinária do veículo", 64, 1300, 5000, 500, "#be123c", "#ffe4e6"),
  test: group("arrival_context_test_group", "6. Teste coordenado — efeitos continuam até dry-run dos consumidores", 64, 1840, 3100, 380, "#0891b2", "#cffafe"),
};
const grouped = (g, node) => { add(node); nodes.find((entry) => entry.id === g).nodes.push(node.id); return node.id; };
const fn = (id, g, name, file, outputs, x, y, wires) => grouped(g, { id, type: "function", z: TAB, g, name,
  func: source(file), outputs, timeout: 0, noerr: 0, initialize: "", finalize: "", libs: [], x, y, wires });
const inject = (id, g, name, props, x, y, wires, extra = {}) => grouped(g, { id, type: "inject", z: TAB, g, name,
  props, repeat: "", crontab: "", once: false, onceDelay: 0.1, topic: "", payload: "", payloadType: "date", x, y, wires, ...extra });
const sw = (id, g, name, property, propertyType, rules, x, y, wires) => grouped(g, { id, type: "switch", z: TAB, g, name,
  property, propertyType, rules, checkall: "true", repair: false, outputs: rules.length, x, y, wires });
const change = (id, g, name, rules, x, y, wires) => grouped(g, { id, type: "change", z: TAB, g, name,
  rules, action: "", property: "", from: "", to: "", reg: false, x, y, wires });
const linkOut = (id, g, name, targets, x, y) => grouped(g, { id, type: "link out", z: TAB, g, name,
  mode: "link", links: Array.isArray(targets) ? targets : [targets], x, y, wires: [] });
const linkIn = (id, g, name, origins, destination, x, y) => grouped(g, { id, type: "link in", z: TAB, g, name,
  links: Array.isArray(origins) ? origins : [origins], x, y, wires: [[destination]] });
const terminal = (id, g, name, status, x, y) => grouped(g, { id, type: "function", z: TAB, g, name,
  func: `node.status(${JSON.stringify(status)});\nreturn null;`, outputs: 0, timeout: 0, noerr: 0, initialize: "", finalize: "", libs: [], x, y, wires: [] });
const setSnapshot = (actionName, reason) => [
  { t: "set", p: "context_snapshot_action", pt: "msg", to: actionName, tot: "str" },
  { t: "set", p: "context_rejected_reason", pt: "msg", to: reason, tot: "str" },
];
const policy = { inflight_timeout_s: 10, future_tolerance_s: 60,
  home_confirmation_delay_s: 90, home_confirmation_retry_s: 30,
  home_confirmation_expiry_min: 15 };
const pendingOrigins = [];
const continuePending = (id, name, x) => {
  pendingOrigins.push(id);
  return linkOut(id, groups.departure, name, "arrival_context_pending_in", x, 1190);
};

add({ id: TAB, type: "tab", label: "contexto_chegadas", disabled: false,
  info: "Coordena snapshots sem interpretar GPS bruto. Coalescência, monotonicidade, saída de morador e readiness ficam em decisões visuais.", env: [] });
grouped(groups.input, { id: "arrival_context_policy_note", type: "comment", z: TAB, g: groups.input,
  name: "Padrões: ciclo 30 s; HOME 90 s; retry 30 s; expiração 15 min.",
  info: "Limites: em voo 1–60 s, tolerância futura 0–300 s, HOME 30–300 s, retry 10–120 s e expiração 5–60 min. Candidato inválido não substitui a última política válida.", x: 530, y: 60, wires: [] });
inject("arrival_context_policy_default", groups.input, "CONFIG: aplicar política visual", [{ p: "payload", v: JSON.stringify(policy), vt: "json" }], 190, 120, [["arrival_context_policy_validate"]], { once: true, onceDelay: "1" });
fn("arrival_context_policy_validate", groups.input, "Validar unidades e limites", "arrival-context-policy-validate.js", 1, 460, 120, [["arrival_context_policy_switch"]]);
sw("arrival_context_policy_switch", groups.input, "Configuração é válida?", "policy_valid", "msg", [{ t: "true" }, { t: "else" }], 730, 120, [["arrival_context_policy_store"], ["arrival_context_policy_reject"]]);
fn("arrival_context_policy_store", groups.input, "Guardar última política válida", "arrival-context-policy-store.js", 0, 1010, 90, []);
fn("arrival_context_policy_reject", groups.input, "Rejeitar sem substituir", "arrival-context-policy-reject.js", 0, 1010, 150, []);
inject("95b96f6148078491", groups.input, "POLÍTICA: reavaliar a cada 30 s", [{ p: "payload", v: JSON.stringify({ kind: "refresh_tick", reason: "startup_or_periodic_reconciliation" }), vt: "json" }], 220, 250, [["arrival_context_periodic_request_out"]], { repeat: "30", once: true, onceDelay: "2" });
linkOut("arrival_context_periodic_request_out", groups.input, "Agenda → ciclo canônico", "arrival_context_cycle_input_in", 520, 250);
linkIn("6473697c19342f07", groups.input, "Solicitar reavaliação/recovery imediato", ["aa9889d5766ce5a0", "54b3d667ae845416", "f3bc2e5083769579"], "arrival_context_recovery_request_out", 180, 320);
linkIn("9f109b7076619124", groups.input, "Iniciar ciclo coordenado de teste", ["bc2afbce89f5a9d5", "2ff281276fc1d020"], "arrival_context_recovery_request_out", 180, 380);
linkOut("arrival_context_recovery_request_out", groups.input, "Recovery/teste externo → ciclo", "arrival_context_cycle_input_in", 520, 350);
grouped(groups.input, { id: "vehicle_primary_manual_refresh_button_v1", type: "server-state-changed", z: TAB, g: groups.input,
  name: "Forçar atualização pelo dashboard", server: "4126427d5e161a03", version: 6, outputs: 1,
  entities: { entity: ["input_button.vehicle_primary_force_refresh_now"], substring: [], regex: [] }, outputInitially: false,
  stateType: "str", ifState: "", ifStateType: "str", ifStateOperator: "is", outputOnlyOnStateChange: true,
  for: "0", forType: "num", forUnits: "minutes", ignorePrevStateNull: false, ignorePrevStateUnknown: false,
  ignorePrevStateUnavailable: false, ignoreCurrentStateUnknown: false, ignoreCurrentStateUnavailable: false,
  outputProperties: [{ property: "payload", propertyType: "msg", value: "event", valueType: "eventData" }], x: 240, y: 460, wires: [["arrival_context_manual_event_gate"]] });
sw("arrival_context_manual_event_gate", groups.input, "Evento do dashboard é produção?", "payload.event_type", "msg", [{ t: "neq", v: "test", vt: "str" }, { t: "else" }], 520, 460, [["arrival_context_manual_request"], ["arrival_context_manual_test_ignore"]]);
change("arrival_context_manual_request", groups.input, "Montar pedido manual_force", [
  { t: "set", p: "payload", pt: "msg", to: '{"kind":"refresh_tick","origin":"vehicle_primary_dashboard","reason":"manual_force","force_recovery":true,"require_lighting_ready":false}', tot: "json" },
], 790, 430, [["arrival_context_cycle_input_out"]]);
terminal("arrival_context_manual_test_ignore", groups.input, "Ignorar evento de teste do helper", { fill: "grey", shape: "ring", text: "evento test ignorado" }, 790, 490);
linkOut("arrival_context_cycle_input_out", groups.input, "Pedido → ciclo canônico", "arrival_context_cycle_input_in", 1090, 330);
linkIn("45cb8ce559f5a522", groups.input, "Receber contexto de pessoas v1", "487984b3aaa29663", "arrival_context_snapshot_out", 210, 570);
linkIn("9f9a1fe3c4afc387", groups.input, "Receber contexto do vehicle_primary v1", "c298447a6a2e3cef", "arrival_context_snapshot_out", 210, 640);
linkOut("arrival_context_snapshot_out", groups.input, "Contexto → validação monotônica", "arrival_context_snapshot_in", 520, 605);

linkIn("arrival_context_cycle_input_in", groups.cycle, "Receber agenda, recovery ou TESTE", ["arrival_context_periodic_request_out", "arrival_context_recovery_request_out", "arrival_context_cycle_input_out", "arrival_context_test_request_out", "arrival_context_test_reset_out", "arrival_context_home_refresh_command_out"], "arrival_context_cycle_policy_load", 1250, 310);
fn("arrival_context_cycle_policy_load", groups.cycle, "Carregar política canônica", "arrival-context-policy-load.js", 1, 1450, 310, [["arrival_context_cycle_policy_available"]]);
sw("arrival_context_cycle_policy_available", groups.cycle, "Existe política válida?", "policy_available", "msg", [{ t: "true" }, { t: "else" }], 1660, 310, [["arrival_context_kind_switch"], ["arrival_context_cycle_policy_missing"]]);
terminal("arrival_context_cycle_policy_missing", groups.cycle, "Falha fechada sem política", { fill: "red", shape: "ring", text: "política indisponível" }, 1880, 240);
sw("arrival_context_kind_switch", groups.cycle, "Pedido é reset de TESTE ou refresh?", "payload.kind", "msg", [{ t: "eq", v: "test_reset", vt: "str" }, { t: "eq", v: "refresh_tick", vt: "str" }, { t: "else" }], 1900, 320, [["arrival_context_reset_test_gate"], ["arrival_context_refresh_request_out"], ["arrival_context_kind_invalid"]]);
linkOut("arrival_context_refresh_request_out", groups.cycle, "Refresh válido → avaliar ciclo", "arrival_context_refresh_request_in", 2180, 330);
linkIn("arrival_context_refresh_request_in", groups.cycle, "Receber refresh validado", "arrival_context_refresh_request_out", "arrival_context_cycle_read", 2280, 330);
sw("arrival_context_reset_test_gate", groups.cycle, "Reset foi marcado como TESTE?", "_location_test = true or payload.test_mode = true", "jsonata", [{ t: "true" }, { t: "else" }], 2180, 210, [["arrival_context_test_reset"], ["arrival_context_reset_reject"]]);
fn("arrival_context_test_reset", groups.cycle, "Limpar somente caches sintéticos", "arrival-context-test-reset.js", 1, 2430, 180, [["arrival_context_cycle_read"]]);
terminal("arrival_context_reset_reject", groups.cycle, "Rejeitar reset sem test_mode", { fill: "red", shape: "ring", text: "reset de produção bloqueado" }, 2430, 240);
terminal("arrival_context_kind_invalid", groups.cycle, "Ignorar contrato desconhecido", { fill: "grey", shape: "ring", text: "kind inválido" }, 2180, 410);
fn("arrival_context_cycle_read", groups.cycle, "Ler ciclo em voo e intenção", "arrival-context-cycle-read.js", 1, 2500, 330, [["arrival_context_inflight_switch"]]);
sw("arrival_context_inflight_switch", groups.cycle, "Há ciclo não emitido nos últimos 10 s?", "context_cycle_inflight", "msg", [{ t: "true" }, { t: "else" }], 2760, 330, [["arrival_context_inflight_force"], ["arrival_context_cycle_start"]]);
sw("arrival_context_inflight_force", groups.cycle, "Pedido em voo exige recovery?", "context_force_recovery", "msg", [{ t: "true" }, { t: "else" }], 3030, 240, [["arrival_context_cycle_promote"], ["arrival_context_cycle_coalesced"]]);
fn("arrival_context_cycle_promote", groups.cycle, "Promover ciclo existente", "arrival-context-cycle-promote.js", 0, 3300, 210, []);
terminal("arrival_context_cycle_coalesced", groups.cycle, "Coalescer tick periódico", { fill: "yellow", shape: "ring", text: "ciclo em voo preservado" }, 3300, 270);
fn("arrival_context_cycle_start", groups.cycle, "Criar ciclo e pedido de snapshot", "arrival-context-cycle-start.js", 1, 3060, 410, [["3514854bb1279cbb"]]);
linkOut("3514854bb1279cbb", groups.cycle, "Solicitar snapshots dos domínios", ["203ccb69e0a6d24b", "26d6516f49329f7b"], 3380, 410);

linkIn("arrival_context_snapshot_in", groups.snapshot, "Receber pessoas ou vehicle_primary", ["arrival_context_snapshot_out", "arrival_context_home_test_snapshot_out"], "arrival_context_snapshot_policy_load", 3890, 330);
fn("arrival_context_snapshot_policy_load", groups.snapshot, "Carregar política canônica", "arrival-context-policy-load.js", 1, 4090, 330, [["arrival_context_snapshot_policy_available"]]);
sw("arrival_context_snapshot_policy_available", groups.snapshot, "Existe política válida?", "policy_available", "msg", [{ t: "true" }, { t: "else" }], 4310, 330, [["arrival_context_snapshot_read"], ["arrival_context_snapshot_policy_missing"]]);
terminal("arrival_context_snapshot_policy_missing", groups.snapshot, "Falha fechada sem política", { fill: "red", shape: "ring", text: "política indisponível" }, 4540, 250);
fn("arrival_context_snapshot_read", groups.snapshot, "Adaptar contrato e timestamps", "arrival-context-snapshot-read.js", 1, 4560, 330, [["arrival_context_snapshot_valid"]]);
sw("arrival_context_snapshot_valid", groups.snapshot, "Contrato de domínio é válido?", "context_snapshot_valid", "msg", [{ t: "true" }, { t: "else" }], 4800, 330, [["arrival_context_snapshot_future"], ["arrival_context_snapshot_invalid"]]);
terminal("arrival_context_snapshot_invalid", groups.snapshot, "Ignorar contrato inválido", { fill: "grey", shape: "ring", text: "snapshot inválido" }, 5040, 250);
sw("arrival_context_snapshot_future", groups.snapshot, "Timestamp excede 60 s no futuro?", "context_is_future", "msg", [{ t: "true" }, { t: "else" }], 5050, 350, [["arrival_context_reject_future"], ["arrival_context_snapshot_out_of_order"]]);
change("arrival_context_reject_future", groups.snapshot, "Rejeitar futuro", setSnapshot("reject", "future_timestamp"), 5300, 120, [["arrival_context_future_decision_out"]]);
linkOut("arrival_context_future_decision_out", groups.snapshot, "Futuro → aplicar decisão", "arrival_context_snapshot_decision_in", 5510, 120);
sw("arrival_context_snapshot_out_of_order", groups.snapshot, "É mais antigo que o cache?", "context_is_out_of_order", "msg", [{ t: "true" }, { t: "else" }], 5300, 350, [["arrival_context_reject_order"], ["arrival_context_snapshot_newer"]]);
change("arrival_context_reject_order", groups.snapshot, "Rejeitar fora de ordem", setSnapshot("reject", "out_of_order"), 5550, 180, [["arrival_context_order_decision_out"]]);
linkOut("arrival_context_order_decision_out", groups.snapshot, "Ordem → aplicar decisão", "arrival_context_snapshot_decision_in", 5760, 180);
sw("arrival_context_snapshot_missing_time", groups.snapshot, "Timestamp está ausente após já existir cache?", "context_missing_timestamp", "msg", [{ t: "true" }, { t: "else" }], 5800, 470, [["arrival_context_reject_missing"], ["arrival_context_snapshot_same_changed"]]);
change("arrival_context_reject_missing", groups.snapshot, "Rejeitar sem timestamp", setSnapshot("reject", "missing_timestamp"), 5800, 240, [["arrival_context_missing_decision_out"]]);
linkOut("arrival_context_missing_decision_out", groups.snapshot, "Ausente → aplicar decisão", "arrival_context_snapshot_decision_in", 6010, 240);
sw("arrival_context_snapshot_newer", groups.snapshot, "É primeiro snapshot ou mais novo?", "context_is_newer", "msg", [{ t: "true" }, { t: "else" }], 5550, 350, [["arrival_context_accept_newer"], ["arrival_context_snapshot_missing_time"]]);
change("arrival_context_accept_newer", groups.snapshot, "Aceitar snapshot monotônico", setSnapshot("accept", ""), 6000, 300, [["arrival_context_newer_decision_out"]]);
linkOut("arrival_context_newer_decision_out", groups.snapshot, "Novo → aplicar decisão", "arrival_context_snapshot_decision_in", 6270, 300);
sw("arrival_context_snapshot_same_changed", groups.snapshot, "Mesmo timestamp mudou conteúdo derivado?", "context_same_changed", "msg", [{ t: "true" }, { t: "else" }], 6060, 410, [["arrival_context_accept_same"], ["arrival_context_reject_duplicate"]]);
change("arrival_context_accept_same", groups.snapshot, "Aceitar mudança no mesmo instante", setSnapshot("accept", ""), 6330, 390, [["arrival_context_same_decision_out"]]);
linkOut("arrival_context_same_decision_out", groups.snapshot, "Mesmo instante → aplicar", "arrival_context_snapshot_decision_in", 6550, 390);
change("arrival_context_reject_duplicate", groups.snapshot, "Preservar cache idêntico", setSnapshot("reject", "duplicate"), 6330, 470, [["arrival_context_duplicate_decision_out"]]);
linkOut("arrival_context_duplicate_decision_out", groups.snapshot, "Duplicata → aplicar", "arrival_context_snapshot_decision_in", 6550, 470);
linkIn("arrival_context_snapshot_decision_in", groups.snapshot, "Receber aceitação ou rejeição", ["arrival_context_future_decision_out", "arrival_context_order_decision_out", "arrival_context_missing_decision_out", "arrival_context_newer_decision_out", "arrival_context_same_decision_out", "arrival_context_duplicate_decision_out"], "arrival_context_cache_mutate", 6520, 610);
fn("arrival_context_cache_mutate", groups.snapshot, "Aplicar cache sem decisão oculta", "arrival-context-cache-mutate.js", 1, 6770, 610, [["arrival_context_departure_out"]]);
linkOut("arrival_context_departure_out", groups.snapshot, "Snapshot → regras de transição", ["arrival_context_departure_in", "arrival_context_home_refresh_in"], 7030, 580);

linkIn("arrival_context_departure_in", groups.departure, "Receber snapshot validado", "arrival_context_departure_out", "arrival_context_departure_read", 110, 960);
fn("arrival_context_departure_read", groups.departure, "Preparar fatos da transição", "arrival-context-departure-read.js", 1, 330, 960, [["arrival_context_departure_domain"]]);
sw("arrival_context_departure_domain", groups.departure, "Snapshot pertence a pessoas?", "context_domain", "msg", [{ t: "eq", v: "people", vt: "str" }, { t: "else" }], 570, 960, [["arrival_context_departure_accepted"], ["arrival_context_departure_no_domain"]]);
sw("arrival_context_departure_accepted", groups.departure, "Snapshot foi aceito como atual?", "context_snapshot_accepted", "msg", [{ t: "true" }, { t: "else" }], 820, 960, [["arrival_context_departure_source"], ["arrival_context_departure_no_accept"]]);
sw("arrival_context_departure_source", groups.departure, "Origem é resident_primary ou secondary?", 'departure_source = "resident_primary" or departure_source = "resident_secondary"', "jsonata", [{ t: "true" }, { t: "else" }], 1080, 960, [["arrival_context_departure_previous"], ["arrival_context_departure_no_source"]]);
sw("arrival_context_departure_previous", groups.departure, "Estado anterior era home?", "payload.trigger_prev_state", "msg", [{ t: "eq", v: "home", vt: "str" }, { t: "else" }], 1340, 960, [["arrival_context_departure_state"], ["arrival_context_departure_no_previous"]]);
sw("arrival_context_departure_state", groups.departure, "Novo estado é near_home ou not_home?", 'payload.trigger_state = "near_home" or payload.trigger_state = "not_home"', "jsonata", [{ t: "true" }, { t: "else" }], 1600, 960, [["arrival_context_departure_ready"], ["arrival_context_departure_no_state"]]);
sw("arrival_context_departure_ready", groups.departure, "Posição de origem está ready?", "departure_position.ready", "msg", [{ t: "true" }, { t: "else" }], 1860, 960, [["arrival_context_departure_away"], ["arrival_context_departure_no_ready"]]);
sw("arrival_context_departure_away", groups.departure, "Melhor localização confirma alguém fora?", "payload.context.best_location_away", "msg", [{ t: "true" }, { t: "else" }], 2110, 960, [["arrival_context_departure_duplicate"], ["arrival_context_departure_no_away"]]);
sw("arrival_context_departure_duplicate", groups.departure, "Assinatura da saída é nova?", "departure_previous_signature != departure_signature", "jsonata", [{ t: "true" }, { t: "else" }], 2380, 960, [["arrival_context_departure_build"], ["arrival_context_departure_no_duplicate"]]);
fn("arrival_context_departure_build", groups.departure, "Persistir dedupe e montar comando", "arrival-context-departure-build.js", 2, 2660, 960, [["arrival_context_departure_command_out"], ["arrival_context_departure_selected_out"]]);
linkOut("arrival_context_departure_command_out", groups.departure, "Saída confirmada → refresh", "arrival_context_refresh_merge_in", 2950, 920);
continuePending("arrival_context_departure_no_domain", "Outro domínio → junção", 570);
continuePending("arrival_context_departure_no_accept", "Rejeitado → junção", 820);
continuePending("arrival_context_departure_no_source", "Outra origem → junção", 1080);
continuePending("arrival_context_departure_no_previous", "Sem saída de home → junção", 1340);
continuePending("arrival_context_departure_no_state", "Outro destino → junção", 1600);
continuePending("arrival_context_departure_no_ready", "Origem pending → junção", 1860);
continuePending("arrival_context_departure_no_away", "Ninguém fora → junção", 2110);
continuePending("arrival_context_departure_no_duplicate", "Saída duplicada → junção", 2380);
continuePending("arrival_context_departure_selected_out", "Saída selecionada → concluir ciclo", 2950);

linkIn("arrival_context_pending_in", groups.pending, "Receber snapshot após regra de saída", pendingOrigins, "arrival_context_pending_read", 3650, 970);
fn("arrival_context_pending_read", groups.pending, "Ler ciclo aguardando domínios", "arrival-context-pending-read.js", 1, 3890, 970, [["arrival_context_cycle_match"]]);
sw("arrival_context_cycle_match", groups.pending, "Snapshot pertence ao ciclo em voo?", "context_cycle_match", "msg", [{ t: "true" }, { t: "else" }], 4200, 970, [["arrival_context_pending_update"], ["arrival_context_cycle_mismatch"]]);
terminal("arrival_context_cycle_mismatch", groups.pending, "Cache atualizado; ciclo não corresponde", { fill: "grey", shape: "ring", text: "fora do ciclo atual" }, 4500, 860);
fn("arrival_context_pending_update", groups.pending, "Marcar recebido e readiness", "arrival-context-pending-update.js", 1, 4510, 970, [["arrival_context_both_received"]]);
sw("arrival_context_both_received", groups.pending, "Pessoas e veículo responderam?", "context_both_received", "msg", [{ t: "true" }, { t: "else" }], 4800, 970, [["arrival_context_pending_emitted"], ["arrival_context_waiting_peer"]]);
terminal("arrival_context_waiting_peer", groups.pending, "Aguardar o outro domínio", { fill: "yellow", shape: "ring", text: "snapshot parcial" }, 5100, 860);
sw("arrival_context_pending_emitted", groups.pending, "Política conjunta já foi emitida?", "context_already_emitted", "msg", [{ t: "true" }, { t: "else" }], 5110, 970, [["arrival_context_already_done"], ["arrival_context_mark_emitted"]]);
terminal("arrival_context_already_done", groups.pending, "Não duplicar política conjunta", { fill: "grey", shape: "ring", text: "ciclo já concluído" }, 5410, 860);
fn("arrival_context_mark_emitted", groups.pending, "Concluir ciclo e carregar caches", "arrival-context-mark-emitted.js", 1, 5420, 970, [["arrival_context_departure_precedence"]]);
sw("arrival_context_departure_precedence", groups.pending, "Este snapshot já emitiu saída de morador?", "context_departure_selected", "msg", [{ t: "true" }, { t: "else" }], 5720, 970, [["arrival_context_departure_precedence_terminal"], ["arrival_context_refresh_facts"]]);
terminal("arrival_context_departure_precedence_terminal", groups.pending, "Preservar precedência da saída", { fill: "blue", shape: "dot", text: "saída prevaleceu" }, 6030, 860);
change("arrival_context_refresh_facts", groups.pending, "Calcular readiness sem rotear", [
  { t: "set", p: "context_people_recovery_needed", pt: "msg", to: "context_pending.people_ready != true", tot: "jsonata" },
  { t: "set", p: "context_contexts_ready", pt: "msg", to: "context_pending.people_ready = true and context_pending.vehicle_primary_ready = true", tot: "jsonata" },
  { t: "set", p: "context_recovery_needed", pt: "msg", to: "context_pending.vehicle_primary_ready != true or context_pending.force_recovery = true", tot: "jsonata" },
], 6030, 970, [["arrival_context_requested_reason"]]);
sw("arrival_context_requested_reason", groups.pending, "Ciclo trouxe motivo explícito?", "$length(context_pending.request_reason) > 0", "jsonata", [{ t: "true" }, { t: "else" }], 6330, 970, [["arrival_context_use_requested_reason"], ["arrival_context_recovery_reason"]]);
change("arrival_context_use_requested_reason", groups.pending, "Usar motivo do solicitante", [{ t: "set", p: "context_recovery_reason", pt: "msg", to: "context_pending.request_reason", tot: "msg" }], 6620, 890, [["arrival_context_requested_path_out"]]);
linkOut("arrival_context_requested_path_out", groups.pending, "Motivo solicitado → montar contrato", "arrival_context_refresh_build_in", 6900, 890);
sw("arrival_context_recovery_reason", groups.pending, "Veículo precisa recovery?", "context_recovery_needed", "msg", [{ t: "true" }, { t: "else" }], 6620, 1030, [["arrival_context_reason_vehicle"], ["arrival_context_people_reason"]]);
change("arrival_context_reason_vehicle", groups.pending, "Motivo: readiness do veículo", [{ t: "set", p: "context_recovery_reason", pt: "msg", to: "vehicle_readiness_recovery_needed", tot: "str" }], 6910, 990, [["arrival_context_vehicle_path_out"]]);
linkOut("arrival_context_vehicle_path_out", groups.pending, "Recovery veículo → montar contrato", "arrival_context_refresh_build_in", 7190, 990);
sw("arrival_context_people_reason", groups.pending, "Somente pessoas precisam recovery?", "context_people_recovery_needed", "msg", [{ t: "true" }, { t: "else" }], 6910, 1090, [["arrival_context_reason_people"], ["arrival_context_reason_ready"]]);
change("arrival_context_reason_people", groups.pending, "Motivo: recuperar localização", [{ t: "set", p: "context_recovery_reason", pt: "msg", to: "people_location_recovery_only", tot: "str" }], 7200, 1060, [["arrival_context_refresh_build"]]);
change("arrival_context_reason_ready", groups.pending, "Motivo: snapshots prontos", [{ t: "set", p: "context_recovery_reason", pt: "msg", to: "paired_ready_snapshots", tot: "str" }], 7200, 1130, [["arrival_context_refresh_build"]]);
linkIn("arrival_context_refresh_build_in", groups.pending, "Receber motivo distante", ["arrival_context_requested_path_out", "arrival_context_vehicle_path_out"], "arrival_context_refresh_build", 7310, 930);
fn("arrival_context_refresh_build", groups.pending, "Montar contrato conjunto", "arrival-context-refresh-build.js", 1, 7500, 960, [["arrival_context_paired_command_out"]]);
linkOut("arrival_context_paired_command_out", groups.pending, "Política conjunta → saída", "arrival_context_refresh_merge_in", 7780, 960);
linkIn("arrival_context_refresh_merge_in", groups.pending, "Unificar saída ou política conjunta", ["arrival_context_departure_command_out", "arrival_context_paired_command_out"], "1ba5ecf650ac79b8", 7500, 800);
linkOut("1ba5ecf650ac79b8", groups.pending, "Publicar política conjunta de refresh", ["7ab9921c55cb6acd", "25ca02f8c1de32d0"], 7780, 800);

linkIn("arrival_context_home_refresh_in", groups.home, "Observar transição HOME validada",
  "arrival_context_departure_out", "arrival_context_home_refresh_read", 110, 1490);
fn("arrival_context_home_refresh_read", groups.home, "Preparar fatos da confirmação HOME",
  "arrival-context-home-refresh-read.js", 1, 340, 1490, [["arrival_context_home_domain"]]);
sw("arrival_context_home_domain", groups.home, "Snapshot pertence a pessoas?", "home_refresh.domain_valid", "msg",
  [{ t: "true" }, { t: "else" }], 610, 1490, [["arrival_context_home_accepted"], ["arrival_context_home_ignore_domain_out"]]);
sw("arrival_context_home_accepted", groups.home, "Snapshot foi aceito como atual?", "home_refresh.snapshot_accepted", "msg",
  [{ t: "true" }, { t: "else" }], 880, 1490, [["arrival_context_home_source"], ["arrival_context_home_ignore_accepted_out"]]);
sw("arrival_context_home_source", groups.home, "Origem é um morador?", "home_refresh.source_valid", "msg",
  [{ t: "true" }, { t: "else" }], 1140, 1490, [["arrival_context_home_transition"], ["arrival_context_home_ignore_source_out"]]);
sw("arrival_context_home_transition", groups.home, "Mudou de fora/indisponível para home?", "home_refresh.transition_valid", "msg",
  [{ t: "true" }, { t: "else" }], 1410, 1490, [["arrival_context_home_current"], ["arrival_context_home_ignore_transition_out"]]);
sw("arrival_context_home_current", groups.home, "Localização HOME está atual?", "home_refresh.resident_current", "msg",
  [{ t: "true" }, { t: "else" }], 1690, 1490, [["arrival_context_home_duplicate"], ["arrival_context_home_ignore_current_out"]]);
sw("arrival_context_home_duplicate", groups.home, "Esta chegada já foi agendada?", "home_refresh.duplicate", "msg",
  [{ t: "true" }, { t: "else" }], 1960, 1490, [["arrival_context_home_duplicate_terminal"], ["arrival_context_home_refresh_store"]]);
terminal("arrival_context_home_ignore", groups.home, "Não é uma nova chegada HOME atual", { fill: "grey", shape: "ring", text: "sem nova chegada" }, 2220, 1400);
for (const [id, x] of [["arrival_context_home_ignore_domain_out", 610],
  ["arrival_context_home_ignore_accepted_out", 880],
  ["arrival_context_home_ignore_source_out", 1140],
  ["arrival_context_home_ignore_transition_out", 1410],
  ["arrival_context_home_ignore_current_out", 1690]]) {
  linkOut(id, groups.home, "Ignorar → terminal", "arrival_context_home_ignore_in", x, 1550);
}
linkIn("arrival_context_home_ignore_in", groups.home, "Receber transição ignorada",
  ["arrival_context_home_ignore_domain_out", "arrival_context_home_ignore_accepted_out",
    "arrival_context_home_ignore_source_out", "arrival_context_home_ignore_transition_out",
    "arrival_context_home_ignore_current_out"], "arrival_context_home_ignore", 2050, 1400);
terminal("arrival_context_home_duplicate_terminal", groups.home, "Preservar agendamento existente", { fill: "grey", shape: "ring", text: "chegada já registrada" }, 2220, 1460);
fn("arrival_context_home_refresh_store", groups.home, "Persistir deadline independente do refletor",
  "arrival-context-home-refresh-store.js", 0, 2250, 1540, []);

inject("arrival_context_home_refresh_tick", groups.home, "Verificar confirmação HOME a cada 5 s",
  [{ p: "payload", v: JSON.stringify({ kind: "home_confirmation_tick" }), vt: "json" }],
  240, 1660, [["arrival_context_home_due_policy_load"]], { repeat: "5", once: true, onceDelay: "4" });
linkIn("arrival_context_home_due_in", groups.home, "Receber relógio sintético",
  "arrival_context_home_test_due_out", "arrival_context_home_due_policy_load", 390, 1720);
fn("arrival_context_home_due_policy_load", groups.home, "Carregar política canônica",
  "arrival-context-policy-load.js", 1, 510, 1660, [["arrival_context_home_due_policy"]]);
sw("arrival_context_home_due_policy", groups.home, "Existe política válida?", "policy_available", "msg",
  [{ t: "true" }, { t: "else" }], 750, 1660, [["arrival_context_home_due_read"], ["arrival_context_home_policy_missing"]]);
terminal("arrival_context_home_policy_missing", groups.home, "Falha fechada sem política", { fill: "red", shape: "ring", text: "política indisponível" }, 1010, 1730);
fn("arrival_context_home_due_read", groups.home, "Ler deadline, morador, motor e aceite",
  "arrival-context-home-refresh-due-read.js", 1, 1020, 1660, [["arrival_context_home_pending"]]);
sw("arrival_context_home_pending", groups.home, "Há confirmação HOME pendente?", "home_refresh_due.exists", "msg",
  [{ t: "true" }, { t: "else" }], 1290, 1660, [["arrival_context_home_ack"], ["arrival_context_home_wait_pending_out"]]);
sw("arrival_context_home_ack", groups.home, "Pedido já apareceu no estado do veículo?", "home_refresh_due.request_observed", "msg",
  [{ t: "true" }, { t: "else" }], 1570, 1660, [["arrival_context_home_clear_ack_out"], ["arrival_context_home_expired"]]);
sw("arrival_context_home_expired", groups.home, "Confirmação expirou?", "home_refresh_due.expired", "msg",
  [{ t: "true" }, { t: "else" }], 1840, 1660, [["arrival_context_home_clear_expired_out"], ["arrival_context_home_away"]]);
sw("arrival_context_home_away", groups.home, "Morador saiu de home explicitamente?", "home_refresh_due.explicit_away", "msg",
  [{ t: "true" }, { t: "else" }], 2110, 1660, [["arrival_context_home_clear_away_out"], ["arrival_context_home_engine_off"]]);
sw("arrival_context_home_engine_off", groups.home, "Motor ficou OFF após a chegada?", "home_refresh_due.explicit_engine_off", "msg",
  [{ t: "true" }, { t: "else" }], 2390, 1660, [["arrival_context_home_clear"], ["arrival_context_home_due"]]);
sw("arrival_context_home_due", groups.home, "Já passaram 90 s desde HOME?", "home_refresh_due.due", "msg",
  [{ t: "true" }, { t: "else" }], 2660, 1660, [["arrival_context_home_engine_allows"], ["arrival_context_home_wait_due_out"]]);
sw("arrival_context_home_engine_allows", groups.home, "Motor estava ou permanece ON?", "home_refresh_due.engine_allows", "msg",
  [{ t: "true" }, { t: "else" }], 2930, 1660, [["arrival_context_home_retry_due"], ["arrival_context_home_wait_engine_out"]]);
sw("arrival_context_home_retry_due", groups.home, "Pode emitir ou repetir agora?", "home_refresh_due.retry_due", "msg",
  [{ t: "true" }, { t: "else" }], 3200, 1660, [["arrival_context_home_refresh_build"], ["arrival_context_home_wait"]]);
fn("arrival_context_home_refresh_build", groups.home, "Emitir refresh e manter até confirmação",
  "arrival-context-home-refresh-build.js", 1, 3470, 1660, [["arrival_context_home_refresh_command_out"]]);
linkOut("arrival_context_home_refresh_command_out", groups.home, "Refresh HOME → ciclo canônico",
  "arrival_context_cycle_input_in", 3760, 1660);
fn("arrival_context_home_clear", groups.home, "Encerrar confirmação concluída ou cancelada",
  "arrival-context-home-refresh-clear.js", 0, 2670, 1390, []);
for (const [id, x] of [["arrival_context_home_clear_ack_out", 1570],
  ["arrival_context_home_clear_expired_out", 1840],
  ["arrival_context_home_clear_away_out", 2110]]) {
  linkOut(id, groups.home, "Encerrar → terminal", "arrival_context_home_clear_in", x, 1720);
}
linkIn("arrival_context_home_clear_in", groups.home, "Receber encerramento",
  ["arrival_context_home_clear_ack_out", "arrival_context_home_clear_expired_out",
    "arrival_context_home_clear_away_out"], "arrival_context_home_clear", 2500, 1390);
terminal("arrival_context_home_wait", groups.home, "Aguardar deadline ou retry", { fill: "yellow", shape: "ring", text: "aguardando" }, 3480, 1410);
linkOut("arrival_context_home_wait_pending_out", groups.home, "Pendente ausente → aguardar",
  "arrival_context_home_wait_in", 1290, 1720);
linkOut("arrival_context_home_wait_due_out", groups.home, "Antes do prazo → aguardar",
  "arrival_context_home_wait_in", 2660, 1720);
linkIn("arrival_context_home_wait_in", groups.home, "Receber espera",
  ["arrival_context_home_wait_pending_out", "arrival_context_home_wait_due_out"],
  "arrival_context_home_wait", 3300, 1410);
terminal("arrival_context_home_wait_engine", groups.home, "Aguardar confirmação de motor ON", { fill: "yellow", shape: "ring", text: "motor ainda não confirmado" }, 3480, 1470);
linkOut("arrival_context_home_wait_engine_out", groups.home, "Motor pendente → aguardar",
  "arrival_context_home_wait_engine_in", 2930, 1720);
linkIn("arrival_context_home_wait_engine_in", groups.home, "Receber espera do motor",
  "arrival_context_home_wait_engine_out", "arrival_context_home_wait_engine", 3300, 1470);

grouped(groups.test, { id: "arrival_context_test_note", type: "comment", z: TAB, g: groups.test,
  name: "Ordem: reset → motor ON → morador HOME → avançar 90 s. Efeitos terminam em dry-run.",
  info: "Snapshots sintéticos atravessam validação monotônica e a regra independente de HOME. O último botão avança somente o relógio do teste.", x: 1000, y: 1890, wires: [] });
inject("arrival_context_test_reset_control", groups.test, "TESTE 1: reset coordenado", [{ p: "payload", v: JSON.stringify({ kind: "test_reset", test_mode: true, test_case: "context_coordinator" }), vt: "json" }, { p: "_location_test", v: "true", vt: "bool" }], 230, 1990, [["arrival_context_test_reset_out"]]);
linkOut("arrival_context_test_reset_out", groups.test, "Reset TESTE → ciclo canônico", "arrival_context_cycle_input_in", 520, 1990);
inject("arrival_context_test_vehicle_on_control", groups.test, "TESTE 2: motor ON", [{ p: "payload", v: "vehicle_on", vt: "str" }], 210, 2050, [["arrival_context_home_test_build"]]);
inject("arrival_context_test_home_control", groups.test, "TESTE 3: unavailable → HOME", [{ p: "payload", v: "resident_home", vt: "str" }], 230, 2110, [["arrival_context_home_test_build"]]);
inject("arrival_context_test_due_control", groups.test, "TESTE 4: avançar 90 s", [{ p: "payload", v: "due", vt: "str" }], 220, 2170, [["arrival_context_home_test_build"]]);
fn("arrival_context_home_test_build", groups.test, "Montar snapshots e relógio sintéticos",
  "arrival-context-home-refresh-test-snapshot.js", 2, 520, 2110,
  [["arrival_context_home_test_snapshot_out"], ["arrival_context_home_test_due_out"]]);
linkOut("arrival_context_home_test_snapshot_out", groups.test, "Snapshot TESTE → validação canônica", "arrival_context_snapshot_in", 820, 2070);
linkOut("arrival_context_home_test_due_out", groups.test, "Relógio TESTE → regra HOME", "arrival_context_home_due_in", 820, 2150);
inject("arrival_context_test_cycle_control", groups.test, "TESTE extra: ciclo recovery", [{ p: "payload", v: JSON.stringify({ kind: "refresh_tick", reason: "manual_context_recovery", force_recovery: true, require_lighting_ready: true, test_mode: true, test_case: "context_coordinator" }), vt: "json" }, { p: "_location_test", v: "true", vt: "bool" }], 1150, 2050, [["arrival_context_test_request_out"]]);
linkOut("arrival_context_test_request_out", groups.test, "Pedido TESTE → ciclo canônico", "arrival_context_cycle_input_in", 1450, 2050);

for (const [groupId, deltaY] of [[groups.home, 600], [groups.test, 600]]) {
  const targetGroup = nodes.find((node) => node.id === groupId);
  targetGroup.y += deltaY;
  for (const node of nodes.filter((entry) => entry.g === groupId && Number.isFinite(entry.y))) {
    node.y += deltaY;
  }
}

next.push(...nodes);
fs.writeFileSync(outputPath, `${JSON.stringify(next, null, 4)}\n`);
console.log(`Arrival context visual flow installed in ${outputPath}`);
