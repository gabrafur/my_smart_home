#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installNotificationHubs } from "./install-notification-hubs.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.resolve(process.argv[2] ?? path.resolve(here, "..", "flows.json"));
const outputPath = path.resolve(process.argv[3] ?? sourcePath);
const functionsDir = path.join(here, "functions");
const TAB = "monitoramento_internet_tab";
const MQTT = "721c47f31046b8bc";
const flows = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
const source = (name) => fs.readFileSync(path.join(functionsDir, name), "utf8").trimEnd();
const owned = (node) => node.id === TAB || node.z === TAB || node.id.startsWith("internet_") || node.id.startsWith("grp_internet_");
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
if (!next.some((node) => node.id === MQTT)) throw new Error("Configuração MQTT ausente");

const nodes = [];
const add = (node) => { nodes.push(node); return node.id; };
const group = (id, name, x, y, w, h, stroke, fill) => add({
  id, type: "group", z: TAB, name,
  style: { label: true, "label-position": "nw", color: "#1f2937", stroke, "stroke-opacity": "1", fill, "fill-opacity": "0.35" },
  nodes: [], x, y, w, h,
});
const groups = {
  input: group("grp_internet_triggers", "0. Política, agenda e fontes", 64, 20, 1100, 510, "#2563eb", "#dbeafe"),
  decision: group("grp_internet_state", "1. Quorum, estado e decisões visuais", 1200, 20, 3900, 510, "#0f766e", "#ccfbf1"),
  effect: group("grp_internet_publish", "2. Publicação, alerta e observabilidade", 5140, 20, 1700, 510, "#dc2626", "#fee2e2"),
  test: group("grp_internet_tests", "3. Replay manual completo — dry-run", 64, 580, 2500, 470, "#0891b2", "#cffafe"),
};
const grouped = (g, node) => { add(node); nodes.find((entry) => entry.id === g).nodes.push(node.id); return node.id; };
const fn = (id, g, name, file, outputs, x, y, wires, extra = {}) => grouped(g, {
  id, type: "function", z: TAB, g, name, func: source(file), outputs,
  timeout: 0, noerr: 0, initialize: "", finalize: "", libs: [], x, y, wires, ...extra,
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
const policy = {
  targets: [
    { name: "cloudflare", address: "1.1.1.1" },
    { name: "google", address: "8.8.8.8" },
    { name: "quad9", address: "9.9.9.9" },
  ],
  required_responses: 2,
  failure_cycles: 3,
  recovery_cycles: 2,
  ping_timeout_s: 2,
  exec_timeout_ms: 3000,
};

add({
  id: TAB, type: "tab", label: "monitoramento_internet", disabled: false,
  info: "Três destinos e quorum visual; estado persistente confirma 3 falhas e 2 sucessos. Testes percorrem as mesmas decisões até a fronteira MQTT/notificação e terminam em dry-run.", env: [],
});
grouped(groups.input, {
  id: "internet_policy_note", type: "comment", z: TAB, g: groups.input,
  name: "Padrões: 3 alvos; quorum 2; queda 3 ciclos; retorno 2; ping 2 s; execução 3 s; ciclo 30 s.",
  info: "Limites: quorum 1–3; falha/retorno 1–10 ciclos; ping 1–10 s; execução 1–15 s e maior que o timeout do ping. Configuração inválida não substitui a última válida.", x: 560, y: 60, wires: [],
});
inject("internet_policy_default", groups.input, "CONFIG: aplicar política visual", [{ p: "payload", v: JSON.stringify(policy), vt: "json" }], 220, 125, [["internet_policy_validate"]], { once: true, onceDelay: "1" });
fn("internet_policy_validate", groups.input, "Validar limites e alvos", "internet-policy-validate.js", 1, 450, 125, [["internet_policy_switch"]]);
sw("internet_policy_switch", groups.input, "Configuração é válida?", "policy_valid", "msg", [{ t: "true" }, { t: "else" }], 670, 125, [["internet_policy_store"], ["internet_policy_reject"]]);
fn("internet_policy_store", groups.input, "Guardar última política válida", "internet-policy-store.js", 0, 920, 95, []);
fn("internet_policy_reject", groups.input, "Rejeitar sem substituir", "internet-policy-reject.js", 0, 920, 155, []);
inject("internet_cycle", groups.input, "POLÍTICA: avaliar a cada 30 s", [{ p: "payload" }], 220, 260, [["internet_cycle_out"]], { repeat: "30", once: true, onceDelay: "5" });
linkOut("internet_cycle_out", groups.input, "Agenda → ciclo canônico", "internet_cycle_in", 500, 260);
grouped(groups.input, {
  id: "internet_history_retained", type: "mqtt in", z: TAB, g: groups.input,
  name: "Recuperar histórico retained", topic: "nodered/infrastructure/internet/attributes",
  qos: "1", datatype: "auto-detect", broker: MQTT, nl: false, rap: true, rh: 0, inputs: 0,
  x: 250, y: 350, wires: [["internet_restore_history"]],
});
fn("internet_restore_history", groups.input, "Restaurar somente histórico", "internet-history-restore.js", 0, 520, 350, []);
inject("internet_discovery_tick", groups.input, "Publicar discovery no startup", [{ p: "payload" }], 230, 440, [["internet_discovery"]], { once: true, onceDelay: "2" });
fn("internet_discovery", groups.input, "Adaptar discovery HA", "internet-discovery.js", 1, 500, 440, [["internet_discovery_out"]]);
linkOut("internet_discovery_out", groups.input, "Discovery → MQTT retained", "internet_discovery_in", 760, 440);

linkIn("internet_cycle_in", groups.decision, "Receber agenda ou TESTE", ["internet_cycle_out", "internet_test_out"], "internet_policy_load", 1250, 270);
fn("internet_policy_load", groups.decision, "Carregar política canônica", "internet-policy-load.js", 1, 1450, 270, [["internet_policy_available"]]);
sw("internet_policy_available", groups.decision, "Existe política válida?", "policy_available", "msg", [{ t: "true" }, { t: "else" }], 1660, 270, [["internet_source_switch"], ["internet_policy_missing"]]);
terminal("internet_policy_missing", groups.decision, "Falha fechada sem política", { fill: "red", shape: "ring", text: "política indisponível" }, 1880, 210);
sw("internet_source_switch", groups.decision, "Entrada é TESTE sintético?", "_internet_test", "msg", [{ t: "true" }, { t: "else" }], 1880, 300, [["internet_results_normalize"], ["internet_ping"]]);
fn("internet_ping", groups.decision, "FONTE: executar 3 pings", "internet-ping-adapter.js", 1, 2120, 335, [["internet_results_normalize"]], { finalize: "flow.set('internet_ping_cycle_running', false, 'memoryOnly');" });
fn("internet_results_normalize", groups.decision, "Normalizar resultados", "internet-results-normalize.js", 1, 2360, 280, [["internet_state_read"]]);
fn("internet_state_read", groups.decision, "Ler estado persistente", "internet-state-read.js", 1, 2580, 280, [["internet_reachable_switch"]]);
sw("internet_reachable_switch", groups.decision, "Quorum: ao menos 2 de 3 responderam?", "internet_targets_ok >= policy.required_responses", "jsonata", [{ t: "true" }, { t: "else" }], 2820, 280, [["internet_success_incident_switch"], ["internet_failure_incident_switch"]]);
sw("internet_success_incident_switch", groups.decision, "Há incidente aberto para recuperar?", "internet_incident_open", "msg", [{ t: "true" }, { t: "else" }], 3080, 220, [["internet_mark_success_incident"], ["internet_mark_healthy_baseline"]]);
change("internet_mark_success_incident", groups.decision, "Incrementar sucesso de recuperação", [{ t: "set", p: "internet_state_action", pt: "msg", to: "success_incident", tot: "str" }], 3340, 190, [["internet_mutate_out"]]);
change("internet_mark_healthy_baseline", groups.decision, "Estabelecer baseline online", [{ t: "set", p: "internet_state_action", pt: "msg", to: "healthy_baseline", tot: "str" }, { t: "set", p: "internet_event", pt: "msg", to: "none", tot: "str" }], 3340, 245, [["internet_mutate_out"]]);
sw("internet_failure_incident_switch", groups.decision, "A falha continua incidente aberto?", "internet_incident_open", "msg", [{ t: "true" }, { t: "else" }], 3080, 375, [["internet_mark_failure_open"], ["internet_mark_failure_candidate"]]);
change("internet_mark_failure_open", groups.decision, "Manter estado offline", [{ t: "set", p: "internet_state_action", pt: "msg", to: "failure_open", tot: "str" }, { t: "set", p: "internet_event", pt: "msg", to: "none", tot: "str" }], 3340, 350, [["internet_mutate_out"]]);
change("internet_mark_failure_candidate", groups.decision, "Incrementar falha candidata", [{ t: "set", p: "internet_state_action", pt: "msg", to: "failure_candidate", tot: "str" }], 3340, 410, [["internet_mutate_out"]]);
linkOut("internet_mutate_out", groups.decision, "Mutação solicitada → estado", "internet_mutate_in", 3580, 300);
linkIn("internet_mutate_in", groups.decision, "Receber mutação inicial/final", ["internet_mutate_out", "internet_mutate_again_out"], "internet_state_mutate", 3680, 300);
fn("internet_state_mutate", groups.decision, "Aplicar somente mutação de estado", "internet-state-mutate.js", 1, 3890, 300, [["internet_action_switch"]]);
sw("internet_action_switch", groups.decision, "Mutação exige limiar de queda ou retorno?", "internet_state_action", "msg", [{ t: "eq", v: "success_incident", vt: "str" }, { t: "eq", v: "failure_candidate", vt: "str" }, { t: "else" }], 4200, 300, [["internet_recovery_threshold"], ["internet_failure_threshold"], ["internet_finalize_route_out"]]);
sw("internet_recovery_threshold", groups.decision, "Atingiu 2 sucessos consecutivos?", "internet_state.consecutive_successes", "msg", [{ t: "gte", v: "policy.recovery_cycles", vt: "msg" }, { t: "else" }], 4370, 220, [["internet_mark_recovered"], ["internet_finalize_route_out"]]);
change("internet_mark_recovered", groups.decision, "Confirmar recuperação", [{ t: "set", p: "internet_state_action", pt: "msg", to: "recover_online", tot: "str" }, { t: "set", p: "internet_event", pt: "msg", to: "recovery", tot: "str" }], 4630, 200, [["internet_mutate_again_out"]]);
sw("internet_failure_threshold", groups.decision, "Atingiu 3 falhas consecutivas?", "internet_state.consecutive_failures", "msg", [{ t: "gte", v: "policy.failure_cycles", vt: "msg" }, { t: "else" }], 4370, 370, [["internet_mark_down"], ["internet_finalize_route_out"]]);
change("internet_mark_down", groups.decision, "Abrir incidente confirmado", [{ t: "set", p: "internet_state_action", pt: "msg", to: "open_failure", tot: "str" }, { t: "set", p: "internet_event", pt: "msg", to: "down", tot: "str" }], 4630, 350, [["internet_mutate_again_out"]]);
linkOut("internet_mutate_again_out", groups.decision, "Conclusão → aplicar estado", "internet_mutate_in", 4890, 275);
linkOut("internet_finalize_route_out", groups.decision, "Estado pronto → publicar", "internet_finalize_in", 4500, 465);
linkIn("internet_finalize_in", groups.decision, "Receber estado pronto", "internet_finalize_route_out", "internet_finalize", 4760, 440);
fn("internet_finalize", groups.decision, "Persistir e montar estado canônico", "internet-state-publish-build.js", 1, 4930, 440, [["internet_effect_out"]]);
linkOut("internet_effect_out", groups.decision, "Estado canônico → fronteiras", "internet_effect_in", 5040, 490);

grouped(groups.effect, {
  id: "internet_effect_in", type: "link in", z: TAB, g: groups.effect,
  name: "Receber estado canônico", links: ["internet_effect_out"], x: 5190, y: 270,
  wires: [["internet_phase_switch", "internet_notification_event", "internet_publications_expand"]],
});
sw("internet_phase_switch", groups.effect, "Estado publicado: online, offline ou transição?", "internet_state.phase", "msg", [{ t: "eq", v: "online", vt: "str" }, { t: "eq", v: "offline", vt: "str" }, { t: "else" }], 5440, 115, [["internet_status_online"], ["internet_status_offline"], ["internet_status_transition"]]);
terminal("internet_status_online", groups.effect, "OBSERVAR: online", { fill: "green", shape: "dot", text: "internet online" }, 5720, 70);
terminal("internet_status_offline", groups.effect, "OBSERVAR: offline", { fill: "red", shape: "ring", text: "internet offline" }, 5720, 115);
terminal("internet_status_transition", groups.effect, "OBSERVAR: confirmação em curso", { fill: "yellow", shape: "ring", text: "confirmando estado" }, 5720, 160);
sw("internet_notification_event", groups.effect, "Há alerta de queda ou recuperação?", "internet_event", "msg", [{ t: "eq", v: "down", vt: "str" }, { t: "eq", v: "recovery", vt: "str" }, { t: "else" }], 5440, 245, [["internet_notification_build"], ["internet_notification_build"], ["internet_notification_none"]]);
fn("internet_notification_build", groups.effect, "Montar envelope do alerta", "internet-notification-build.js", 1, 5710, 240, [["internet_notification_test_gate"]]);
terminal("internet_notification_none", groups.effect, "Sem novo alerta", { fill: "grey", shape: "ring", text: "sem notificação nova" }, 5710, 295);
sw("internet_notification_test_gate", groups.effect, "Alerta pertence a TESTE?", "_internet_test", "msg", [{ t: "true" }, { t: "else" }], 5990, 240, [["internet_dry_out"], ["internet_notify_route"]]);
sw("internet_notify_route", groups.effect, "Enviar queda ou recuperação?", "internet_event", "msg", [{ t: "eq", v: "down", vt: "str" }, { t: "eq", v: "recovery", vt: "str" }], 6240, 220, [["internet_notify_down"], ["internet_notify_recovery"]]);
grouped(groups.effect, { id: "internet_notify_down", type: "change", z: TAB, g: groups.effect, name: "Solicitar canais para queda", rules: [], action: "", property: "", from: "", to: "", reg: false, x: 6560, y: 195, wires: [[]] });
grouped(groups.effect, { id: "internet_notify_recovery", type: "change", z: TAB, g: groups.effect, name: "Solicitar canais para retorno", rules: [], action: "", property: "", from: "", to: "", reg: false, x: 6560, y: 245, wires: [[]] });
fn("internet_publications_expand", groups.effect, "Expandir 3 publicações MQTT", "internet-publications-expand.js", 1, 5440, 380, [["internet_publication_test_gate"]]);
sw("internet_publication_test_gate", groups.effect, "Publicação pertence a TESTE?", "_internet_test", "msg", [{ t: "true" }, { t: "else" }], 5710, 380, [["internet_publication_dry_out"], ["internet_mqtt_publish"]]);
linkOut("internet_publication_dry_out", groups.effect, "MQTT TESTE → dry-run", "internet_dry_in", 6000, 360);
linkIn("internet_discovery_in", groups.effect, "Receber discovery", "internet_discovery_out", "internet_mqtt_publish", 5960, 455);
grouped(groups.effect, {
  id: "internet_mqtt_publish", type: "mqtt out", z: TAB, g: groups.effect,
  name: "EFEITO: publicar MQTT retained", topic: "", qos: "1", retain: "true",
  respTopic: "", contentType: "", userProps: "", correl: "", expiry: "", broker: MQTT,
  x: 6150, y: 430, wires: [],
});
linkOut("internet_dry_out", groups.effect, "Alerta TESTE → dry-run", "internet_dry_in", 6250, 280);

grouped(groups.test, {
  id: "internet_test_note", type: "comment", z: TAB, g: groups.test,
  name: "Ordem: reset → falha 1 → falha 2 → falha 3 → sucesso 1 → sucesso 2. MQTT e alertas ficam bloqueados.",
  info: "Cada amostra percorre política, quorum, estado persistente isolado, limiares e fronteiras finais.", x: 930, y: 620, wires: [],
});
inject("internet_test_reset", groups.test, "TESTE 1: reset", [{ p: "_internet_test", v: "true", vt: "bool" }], 170, 700, [["internet_test_reset_state"]]);
fn("internet_test_reset_state", groups.test, "Resetar estado sintético", "internet-test-reset.js", 0, 390, 700, []);
const failed = { test_mode: true, checked_at: "2026-01-01T00:00:00Z", results: policy.targets.map((target) => ({ ...target, ok: false })) };
const success = { test_mode: true, checked_at: "2026-01-01T00:01:00Z", results: policy.targets.map((target) => ({ ...target, ok: true })) };
for (const [id, name, payload, x, y] of [
  ["internet_test_fail_1", "TESTE 2: falha 1/3", failed, 170, 780],
  ["internet_test_fail_2", "TESTE 3: falha 2/3", failed, 170, 835],
  ["internet_test_fail_3", "TESTE 4: falha 3/3", failed, 170, 890],
  ["internet_test_success_1", "TESTE 5: sucesso 1/2", success, 170, 945],
  ["internet_test_success_2", "TESTE 6: sucesso 2/2", success, 170, 1000],
]) inject(id, groups.test, name, [{ p: "payload", v: JSON.stringify(payload), vt: "json" }, { p: "_internet_test", v: "true", vt: "bool" }], x, y, [["internet_test_out"]]);
linkOut("internet_test_out", groups.test, "Amostra TESTE → ciclo real", "internet_cycle_in", 470, 890);
linkIn("internet_dry_in", groups.test, "Receber efeito TESTE", ["internet_dry_out", "internet_publication_dry_out"], "internet_dry_run_terminal", 780, 760);
fn("internet_dry_run_terminal", groups.test, "TESTE FINAL: MQTT e alertas bloqueados", "internet-dry-run.js", 0, 1080, 760, []);

next.push(...nodes);
fs.writeFileSync(outputPath, `${JSON.stringify(installNotificationHubs(next), null, 4)}\n`);
console.log(`Internet monitor visual flow installed in ${outputPath}`);
