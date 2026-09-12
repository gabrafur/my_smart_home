#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.resolve(process.argv[2] ?? path.resolve(here, "..", "flows.json"));
const outputPath = path.resolve(process.argv[3] ?? sourcePath);
const functionsDir = path.join(here, "functions");
const TAB = "monitoramento_zigbee_tab";
const MQTT = "721c47f31046b8bc";
const NOTIFY = "infra_notify_all_mobiles";
const flows = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
const source = (name) => fs.readFileSync(path.join(functionsDir, name), "utf8").trimEnd();
const owned = (node) => node.id === TAB || node.z === TAB || node.id.startsWith("zigbee_") || node.id.startsWith("grp_zigbee_");
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
if (!next.some((node) => node.id === NOTIFY)) throw new Error("Subflow de notificação ausente");

const nodes = [];
const add = (node) => { nodes.push(node); return node.id; };
const group = (id, name, x, y, w, h, stroke, fill) => add({
  id, type: "group", z: TAB, name,
  style: { label: true, "label-position": "nw", color: "#1f2937", stroke, "stroke-opacity": "1", fill, "fill-opacity": "0.35" },
  nodes: [], x, y, w, h,
});
const groups = {
  input: group("grp_zigbee_triggers", "0. Política, agenda e fontes", 64, 20, 1100, 700, "#2563eb", "#dbeafe"),
  network: group("grp_zigbee_state", "1. Rede: decisões e estado", 1200, 20, 3900, 700, "#0f766e", "#ccfbf1"),
  component: group("grp_zigbee_detect", "2. Componentes: dedupe e lembretes", 1200, 760, 3900, 540, "#7c3aed", "#ede9fe"),
  effect: group("grp_zigbee_notify", "3. Efeitos, estados e observabilidade", 5140, 20, 1860, 1280, "#dc2626", "#fee2e2"),
  test: group("grp_zigbee_tests", "4. Replay manual completo — dry-run", 64, 1360, 3200, 560, "#0891b2", "#cffafe"),
};
const grouped = (g, node) => { add(node); nodes.find((entry) => entry.id === g).nodes.push(node.id); return node.id; };
const fn = (id, g, name, file, outputs, x, y, wires) => grouped(g, {
  id, type: "function", z: TAB, g, name, func: source(file), outputs,
  timeout: 0, noerr: 0, initialize: "", finalize: "", libs: [], x, y, wires,
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
const terminal = (id, g, name, status, x, y) => grouped(g, {
  id, type: "function", z: TAB, g, name, func: `node.status(${JSON.stringify(status)});\nreturn null;`,
  outputs: 0, timeout: 0, noerr: 0, initialize: "", finalize: "", libs: [], x, y, wires: [],
});
const policy = { failure_confirmation_s: 30, recovery_confirmation_s: 60, reminder_interval_h: 24 };
const setAction = (action, event) => [
  { t: "set", p: "zigbee_state_action", pt: "msg", to: action, tot: "str" },
  { t: "set", p: "zigbee_event", pt: "msg", to: event, tot: "str" },
];
const setComponentAction = (action, event) => [
  { t: "set", p: "zigbee_component_action", pt: "msg", to: action, tot: "str" },
  { t: "set", p: "zigbee_component_event", pt: "msg", to: event, tot: "str" },
];

add({ id: TAB, type: "tab", label: "monitoramento_zigbee", disabled: false,
  info: "Política visual confirma queda e retorno da rede e deduplica componentes. Produção publica MQTT/notifica; todo replay termina no dry-run compartilhado.", env: [] });
grouped(groups.input, { id: "zigbee_policy_note", type: "comment", z: TAB, g: groups.input,
  name: "Padrões: queda 30 s; retorno 60 s; lembrete 24 h; avaliação 10 s.",
  info: "Limites: queda 1–300 s, retorno 1–600 s e lembrete 1–168 h. Valor inválido não substitui a última política válida.", x: 540, y: 60, wires: [] });
inject("zigbee_policy_default", groups.input, "CONFIG: aplicar política visual", [{ p: "payload", v: JSON.stringify(policy), vt: "json" }], 190, 120, [["zigbee_policy_validate"]], { once: true, onceDelay: "1" });
fn("zigbee_policy_validate", groups.input, "Validar unidades e limites", "zigbee-policy-validate.js", 1, 470, 120, [["zigbee_policy_switch"]]);
sw("zigbee_policy_switch", groups.input, "Configuração é válida?", "policy_valid", "msg", [{ t: "true" }, { t: "else" }], 760, 120, [["zigbee_policy_store"], ["zigbee_policy_reject"]]);
fn("zigbee_policy_store", groups.input, "Guardar última política válida", "zigbee-policy-store.js", 0, 1030, 90, []);
fn("zigbee_policy_reject", groups.input, "Rejeitar sem substituir", "zigbee-policy-reject.js", 0, 1030, 150, []);
grouped(groups.input, { id: "zigbee_bridge_state", type: "mqtt in", z: TAB, g: groups.input,
  name: "FONTE: zigbee2mqtt/bridge/state", topic: "zigbee2mqtt/bridge/state", qos: "1", datatype: "auto-detect",
  broker: MQTT, nl: false, rap: true, rh: 0, inputs: 0, x: 230, y: 250, wires: [["zigbee_network_observation_normalize"]] });
grouped(groups.input, { id: "zigbee_broker_status", type: "status", z: TAB, g: groups.input,
  name: "FONTE: conexão MQTT", scope: ["zigbee_bridge_state"], x: 220, y: 310, wires: [["zigbee_network_observation_normalize"]] });
linkIn("zigbee_test_network_input_in", groups.input, "Receber estado TESTE", "zigbee_test_network_input_out", "zigbee_network_observation_normalize", 370, 355);
fn("zigbee_network_observation_normalize", groups.input, "Adaptar observação MQTT", "zigbee-network-observation-normalize.js", 1, 510, 280, [["zigbee_network_observation_valid"]]);
sw("zigbee_network_observation_valid", groups.input, "Estado é online ou offline?", "zigbee_observation_valid", "msg", [{ t: "true" }, { t: "else" }], 750, 280, [["zigbee_network_observation_store"], ["zigbee_observation_invalid"]]);
fn("zigbee_network_observation_store", groups.input, "Guardar observação e instante", "zigbee-network-observation-store.js", 1, 930, 210, [["zigbee_network_cycle_out"]]);
terminal("zigbee_observation_invalid", groups.input, "Ignorar payload desconhecido", { fill: "grey", shape: "ring", text: "observação inválida" }, 980, 320);
linkOut("zigbee_network_cycle_out", groups.input, "Observação → ciclo da rede", "zigbee_network_cycle_in", 1110, 250);
inject("zigbee_tick", groups.input, "POLÍTICA: avaliar a cada 10 s", [{ p: "payload" }], 230, 420, [["zigbee_tick_network_out", "zigbee_tick_components_out"]], { repeat: "10", once: true, onceDelay: "5" });
linkOut("zigbee_tick_network_out", groups.input, "Agenda → rede", "zigbee_network_cycle_in", 500, 400);
linkOut("zigbee_tick_components_out", groups.input, "Agenda → lembretes", "zigbee_component_reminder_in", 500, 450);
grouped(groups.input, { id: "zigbee_component_availability", type: "mqtt in", z: TAB, g: groups.input,
  name: "FONTE: .../availability", topic: "zigbee2mqtt/#", qos: "1", datatype: "auto-detect",
  broker: MQTT, nl: false, rap: true, rh: 0, inputs: 0, x: 230, y: 520, wires: [["zigbee_component_input_out"]] });
linkOut("zigbee_component_input_out", groups.input, "Disponibilidade → componentes", "zigbee_component_input_in", 500, 520);
grouped(groups.input, { id: "zigbee_history_retained", type: "mqtt in", z: TAB, g: groups.input,
  name: "Recuperar histórico retained", topic: "nodered/infrastructure/zigbee/attributes", qos: "1", datatype: "auto-detect",
  broker: MQTT, nl: false, rap: true, rh: 0, inputs: 0, x: 250, y: 600, wires: [["zigbee_restore_history"]] });
fn("zigbee_restore_history", groups.input, "Restaurar somente histórico", "zigbee-history-restore.js", 0, 530, 600, []);
inject("zigbee_discovery_tick", groups.input, "Publicar discovery no startup", [{ p: "payload" }], 240, 670, [["zigbee_discovery"]], { once: true, onceDelay: "2" });
fn("zigbee_discovery", groups.input, "Adaptar discovery HA", "zigbee-discovery.js", 1, 500, 670, [["zigbee_discovery_out"]]);
linkOut("zigbee_discovery_out", groups.input, "Discovery → MQTT retained", "zigbee_discovery_in", 750, 670);

linkIn("zigbee_network_cycle_in", groups.network, "Receber observação, agenda ou TESTE", ["zigbee_network_cycle_out", "zigbee_tick_network_out", "zigbee_test_network_tick_out"], "zigbee_network_policy_load", 1250, 310);
fn("zigbee_network_policy_load", groups.network, "Carregar política canônica", "zigbee-policy-load.js", 1, 1430, 310, [["zigbee_network_policy_available"]]);
sw("zigbee_network_policy_available", groups.network, "Existe política válida?", "policy_available", "msg", [{ t: "true" }, { t: "else" }], 1700, 310, [["zigbee_network_state_read"], ["zigbee_network_policy_missing"]]);
terminal("zigbee_network_policy_missing", groups.network, "Falha fechada sem política", { fill: "red", shape: "ring", text: "política indisponível" }, 1850, 240);
fn("zigbee_network_state_read", groups.network, "Ler observação e estado persistente", "zigbee-network-state-read.js", 1, 1880, 390, [["zigbee_network_raw_switch"]]);
sw("zigbee_network_raw_switch", groups.network, "Observação atual é online, offline ou desconhecida?", "zigbee_raw_state", "msg", [{ t: "eq", v: "online", vt: "str" }, { t: "eq", v: "offline", vt: "str" }, { t: "else" }], 2160, 310, [["zigbee_network_online_incident"], ["zigbee_network_offline_incident"], ["zigbee_network_offline_incident"]]);
sw("zigbee_network_online_incident", groups.network, "Existe incidente para recuperar?", "zigbee_state.incident_open", "msg", [{ t: "true" }, { t: "else" }], 2440, 190, [["zigbee_network_recovery_stable"], ["zigbee_baseline_online"]]);
sw("zigbee_network_recovery_stable", groups.network, "Online estável atingiu 60 s?", "zigbee_stable_for_ms >= policy.recovery_confirmation_s * 1000", "jsonata", [{ t: "true" }, { t: "else" }], 2720, 145, [["zigbee_recover_online"], ["zigbee_mark_recovering"]]);
change("zigbee_recover_online", groups.network, "Confirmar recuperação", setAction("recover_online", "network_recovery"), 3010, 110, [["zigbee_network_mutate_out"]]);
change("zigbee_mark_recovering", groups.network, "Aguardar estabilidade de retorno", setAction("mark_recovering", "none"), 3010, 170, [["zigbee_network_mutate_out"]]);
change("zigbee_baseline_online", groups.network, "Estabelecer baseline online", setAction("baseline_online", "none"), 2720, 235, [["zigbee_network_mutate_top_out"]]);
linkOut("zigbee_network_mutate_top_out", groups.network, "Baseline → estado", "zigbee_network_mutate_in", 3140, 235);
sw("zigbee_network_offline_incident", groups.network, "Offline/desconhecido já é incidente aberto?", "zigbee_state.incident_open", "msg", [{ t: "true" }, { t: "else" }], 2440, 410, [["zigbee_network_reminder_due"], ["zigbee_network_failure_stable"]]);
sw("zigbee_network_reminder_due", groups.network, "Lembrete de 24 h está vencido?", "zigbee_now >= zigbee_next_reminder_ms", "jsonata", [{ t: "true" }, { t: "else" }], 2720, 355, [["zigbee_network_reminder"], ["zigbee_keep_offline"]]);
change("zigbee_network_reminder", groups.network, "Registrar lembrete devido", setAction("network_reminder", "network_reminder"), 3010, 330, [["zigbee_network_mutate_out"]]);
change("zigbee_keep_offline", groups.network, "Manter incidente sem duplicar", setAction("keep_offline", "none"), 3010, 390, [["zigbee_network_mutate_out"]]);
sw("zigbee_network_failure_stable", groups.network, "Offline estável atingiu 30 s?", "zigbee_stable_for_ms >= policy.failure_confirmation_s * 1000", "jsonata", [{ t: "true" }, { t: "else" }], 2720, 475, [["zigbee_open_failure"], ["zigbee_mark_checking"]]);
change("zigbee_open_failure", groups.network, "Abrir incidente confirmado", setAction("open_failure", "network_down"), 3010, 465, [["zigbee_network_mutate_out"]]);
change("zigbee_mark_checking", groups.network, "Aguardar confirmação ou fonte", setAction("mark_checking", "none"), 2720, 555, [["zigbee_network_mutate_bottom_out"]]);
linkOut("zigbee_network_mutate_bottom_out", groups.network, "Confirmação → estado", "zigbee_network_mutate_in", 3140, 555);
linkOut("zigbee_network_mutate_out", groups.network, "Decisão → mutação de estado", "zigbee_network_mutate_in", 3270, 310);
linkIn("zigbee_network_mutate_in", groups.network, "Receber decisão", ["zigbee_network_mutate_out", "zigbee_network_mutate_top_out", "zigbee_network_mutate_bottom_out"], "zigbee_network_state_mutate", 3380, 310);
fn("zigbee_network_state_mutate", groups.network, "Aplicar somente mutação", "zigbee-network-state-mutate.js", 1, 3590, 310, [["zigbee_network_finalize"]]);
fn("zigbee_network_finalize", groups.network, "Persistir e montar estado canônico", "zigbee-network-publish-build.js", 1, 3860, 310, [["zigbee_network_effect_out"]]);
linkOut("zigbee_network_effect_out", groups.network, "Estado canônico → fronteiras", "zigbee_network_effect_in", 4130, 310);

linkIn("zigbee_component_input_in", groups.component, "Receber disponibilidade ou TESTE", ["zigbee_component_input_out", "zigbee_test_component_out"], "zigbee_component_policy_load", 1250, 910);
fn("zigbee_component_policy_load", groups.component, "Carregar política canônica", "zigbee-policy-load.js", 1, 1450, 910, [["zigbee_component_policy_available"]]);
sw("zigbee_component_policy_available", groups.component, "Existe política válida?", "policy_available", "msg", [{ t: "true" }, { t: "else" }], 1660, 910, [["zigbee_component_normalize"], ["zigbee_component_policy_missing"]]);
terminal("zigbee_component_policy_missing", groups.component, "Falha fechada sem política", { fill: "red", shape: "ring", text: "política indisponível" }, 1880, 850);
fn("zigbee_component_normalize", groups.component, "Adaptar tópico e disponibilidade", "zigbee-component-normalize.js", 1, 1870, 990, [["zigbee_component_valid"]]);
sw("zigbee_component_valid", groups.component, "É availability online/offline válido?", "zigbee_component_valid", "msg", [{ t: "true" }, { t: "else" }], 2180, 910, [["zigbee_component_state_read"], ["zigbee_component_invalid"]]);
terminal("zigbee_component_invalid", groups.component, "Ignorar tópico ou valor inválido", { fill: "grey", shape: "ring", text: "componente ignorado" }, 2470, 850);
fn("zigbee_component_state_read", groups.component, "Ler incidente do componente", "zigbee-component-state-read.js", 1, 2470, 990, [["zigbee_component_availability_switch"]]);
sw("zigbee_component_availability_switch", groups.component, "Componente está online ou offline?", "zigbee_component_availability", "msg", [{ t: "eq", v: "offline", vt: "str" }, { t: "eq", v: "online", vt: "str" }], 2630, 910, [["zigbee_component_offline_incident"], ["zigbee_component_online_incident"]]);
sw("zigbee_component_offline_incident", groups.component, "Offline já foi notificado?", "zigbee_component_current.offline", "msg", [{ t: "true" }, { t: "else" }], 2910, 840, [["zigbee_component_touch"], ["zigbee_component_open"]]);
change("zigbee_component_touch", groups.component, "Atualizar presença sem duplicar", setComponentAction("touch", "none"), 3160, 810, [["zigbee_component_mutate_out"]]);
change("zigbee_component_open", groups.component, "Abrir incidente do componente", setComponentAction("open", "down"), 3160, 870, [["zigbee_component_mutate_out"]]);
sw("zigbee_component_online_incident", groups.component, "Havia incidente para encerrar?", "zigbee_component_current.offline", "msg", [{ t: "true" }, { t: "else" }], 2910, 990, [["zigbee_component_recover"], ["zigbee_component_baseline"]]);
change("zigbee_component_recover", groups.component, "Confirmar recuperação do componente", setComponentAction("recover", "recovery"), 3180, 965, [["zigbee_component_mutate_out"]]);
change("zigbee_component_baseline", groups.component, "Estabelecer baseline disponível", setComponentAction("baseline", "none"), 3180, 1025, [["zigbee_component_mutate_out"]]);
linkIn("zigbee_component_reminder_in", groups.component, "Receber agenda de lembretes", ["zigbee_tick_components_out", "zigbee_test_component_reminder_out"], "zigbee_component_reminder_policy_load", 1250, 1160);
fn("zigbee_component_reminder_policy_load", groups.component, "Carregar política para lembretes", "zigbee-policy-load.js", 1, 1450, 1160, [["zigbee_component_reminder_policy_available"]]);
sw("zigbee_component_reminder_policy_available", groups.component, "Política de lembrete existe?", "policy_available", "msg", [{ t: "true" }, { t: "else" }], 1750, 1160, [["zigbee_component_reminders_expand"], ["zigbee_component_policy_missing"]]);
fn("zigbee_component_reminders_expand", groups.component, "Enumerar incidentes persistidos", "zigbee-component-reminders-expand.js", 1, 2050, 1160, [["zigbee_component_reminder_offline"]]);
sw("zigbee_component_reminder_offline", groups.component, "Componente ainda está offline?", "zigbee_component_current.offline", "msg", [{ t: "true" }, { t: "else" }], 2360, 1160, [["zigbee_component_reminder_due"], ["zigbee_component_no_reminder"]]);
sw("zigbee_component_reminder_due", groups.component, "Lembrete de 24 h está vencido?", "zigbee_now >= zigbee_component_next_reminder_ms", "jsonata", [{ t: "true" }, { t: "else" }], 2460, 1240, [["zigbee_component_mark_reminder"], ["zigbee_component_no_reminder"]]);
change("zigbee_component_mark_reminder", groups.component, "Registrar lembrete do componente", setComponentAction("reminder", "reminder"), 2740, 1130, [["zigbee_component_reminder_mutate_out"]]);
linkOut("zigbee_component_reminder_mutate_out", groups.component, "Lembrete → estado", "zigbee_component_mutate_in", 3140, 1130);
terminal("zigbee_component_no_reminder", groups.component, "Sem lembrete devido", { fill: "grey", shape: "ring", text: "sem lembrete" }, 2740, 1200);
linkOut("zigbee_component_mutate_out", groups.component, "Decisão → estado do componente", "zigbee_component_mutate_in", 3440, 930);
linkIn("zigbee_component_mutate_in", groups.component, "Receber mutação", ["zigbee_component_mutate_out", "zigbee_component_reminder_mutate_out"], "zigbee_component_state_mutate", 3560, 930);
fn("zigbee_component_state_mutate", groups.component, "Persistir estado por componente", "zigbee-component-state-mutate.js", 1, 3790, 930, [["zigbee_component_effect_out"]]);
linkOut("zigbee_component_effect_out", groups.component, "Evento do componente → fronteira", "zigbee_component_effect_in", 4040, 930);

linkIn("zigbee_network_effect_in", groups.effect, "Receber estado da rede", "zigbee_network_effect_out", "zigbee_phase_switch", 5190, 250);
sw("zigbee_phase_switch", groups.effect, "Estado canônico: online, offline ou transição?", "zigbee_state.phase", "msg", [{ t: "eq", v: "online", vt: "str" }, { t: "eq", v: "offline", vt: "str" }, { t: "else" }], 5430, 120, [["zigbee_status_online"], ["zigbee_status_offline"], ["zigbee_status_transition"]]);
terminal("zigbee_status_online", groups.effect, "OBSERVAR: rede online", { fill: "green", shape: "dot", text: "Zigbee online" }, 5690, 70);
terminal("zigbee_status_offline", groups.effect, "OBSERVAR: rede offline", { fill: "red", shape: "ring", text: "Zigbee offline" }, 5690, 120);
terminal("zigbee_status_transition", groups.effect, "OBSERVAR: confirmação", { fill: "yellow", shape: "ring", text: "confirmando Zigbee" }, 5690, 170);
sw("zigbee_network_event_switch", groups.effect, "Há queda, lembrete ou recuperação?", "zigbee_event", "msg", [{ t: "eq", v: "network_down", vt: "str" }, { t: "eq", v: "network_reminder", vt: "str" }, { t: "eq", v: "network_recovery", vt: "str" }, { t: "else" }], 5450, 300, [["zigbee_network_notification_build"], ["zigbee_network_notification_build"], ["zigbee_network_notification_build"], ["zigbee_no_notification"]]);
fn("zigbee_network_notification_build", groups.effect, "Montar alerta da rede", "zigbee-network-notification-build.js", 1, 5710, 285, [["zigbee_notification_test_gate"]]);
terminal("zigbee_no_notification", groups.effect, "Sem novo alerta", { fill: "grey", shape: "ring", text: "sem notificação nova" }, 5710, 350);
fn("zigbee_publications_expand", groups.effect, "Expandir 3 publicações MQTT", "zigbee-publications-expand.js", 1, 5440, 465, [["zigbee_publication_test_gate"]]);
sw("zigbee_publication_test_gate", groups.effect, "Publicação pertence a TESTE?", "_zigbee_test", "msg", [{ t: "true" }, { t: "else" }], 5720, 465, [["zigbee_publication_dry_out"], ["zigbee_mqtt_publish"]]);
linkOut("zigbee_publication_dry_out", groups.effect, "MQTT TESTE → dry-run", "zigbee_dry_in", 5980, 440);
linkIn("zigbee_discovery_in", groups.effect, "Receber discovery HA", "zigbee_discovery_out", "zigbee_mqtt_publish", 5720, 540);
grouped(groups.effect, { id: "zigbee_mqtt_publish", type: "mqtt out", z: TAB, g: groups.effect,
  name: "EFEITO: publicar MQTT retained", topic: "", qos: "1", retain: "true", respTopic: "", contentType: "",
  userProps: "", correl: "", expiry: "", broker: MQTT, x: 6200, y: 500, wires: [] });
linkIn("zigbee_component_effect_in", groups.effect, "Receber evento de componente", "zigbee_component_effect_out", "zigbee_component_event_switch", 5190, 760);
sw("zigbee_component_event_switch", groups.effect, "Há queda, retorno ou lembrete de componente?", "zigbee_component_event", "msg", [{ t: "eq", v: "down", vt: "str" }, { t: "eq", v: "recovery", vt: "str" }, { t: "eq", v: "reminder", vt: "str" }, { t: "else" }], 5460, 760, [["zigbee_component_notification_build"], ["zigbee_component_notification_build"], ["zigbee_component_notification_build"], ["zigbee_component_no_event"]]);
fn("zigbee_component_notification_build", groups.effect, "Montar alerta do componente", "zigbee-component-notification-build.js", 1, 5750, 745, [["zigbee_component_notification_route_out"]]);
linkOut("zigbee_component_notification_route_out", groups.effect, "Alerta de componente → gate único", "zigbee_component_notification_route_in", 6010, 745);
linkIn("zigbee_component_notification_route_in", groups.effect, "Receber alerta de componente", "zigbee_component_notification_route_out", "zigbee_notification_test_gate", 5880, 365);
terminal("zigbee_component_no_event", groups.effect, "Componente sem transição", { fill: "grey", shape: "ring", text: "dedupe ativo" }, 5750, 820);
sw("zigbee_notification_test_gate", groups.effect, "Alerta pertence a TESTE?", "_zigbee_test", "msg", [{ t: "true" }, { t: "else" }], 6060, 300, [["zigbee_notification_dry_out"], ["zigbee_notify_effect"]]);
grouped(groups.effect, { id: "zigbee_notify_effect", type: `subflow:${NOTIFY}`, z: TAB, g: groups.effect,
  name: "EFEITO ÚNICO: notificar infraestrutura", env: [], x: 6500, y: 300, wires: [[]] });
linkOut("zigbee_notification_dry_out", groups.effect, "Alerta TESTE → dry-run", "zigbee_dry_in", 6300, 380);

grouped(groups.test, { id: "zigbee_test_note", type: "comment", z: TAB, g: groups.test,
  name: "Ordem: reset; rede 2–8; componente 9–12. MQTT e notificações terminam em dry-run.",
  info: "Os eventos sintéticos atravessam parsing, política, estado persistente isolado, limiares, dedupe e as mesmas fronteiras finais da produção.", x: 1060, y: 1400, wires: [] });
inject("zigbee_test_reset", groups.test, "TESTE 1: reset", [{ p: "_zigbee_test", v: "true", vt: "bool" }], 170, 1490, [["zigbee_test_reset_state"]]);
fn("zigbee_test_reset_state", groups.test, "Resetar apenas estado sintético", "zigbee-test-reset.js", 0, 410, 1490, []);
const t0 = Date.UTC(2026, 0, 1, 0, 0, 0);
for (const [id, name, payload, at, y] of [
  ["zigbee_test_net_online", "TESTE 2: rede online", "online", t0, 1490],
  ["zigbee_test_net_offline", "TESTE 3: iniciar offline", "offline", t0 + 10000, 1545],
  ["zigbee_test_net_online_recovery", "TESTE 6: iniciar retorno", "online", t0 + 50000, 1710],
]) inject(id, groups.test, name, [{ p: "payload", v: payload, vt: "str" }, { p: "monitor_now", v: String(at), vt: "num" }, { p: "_zigbee_test", v: "true", vt: "bool" }], 720, y, [["zigbee_test_network_input_out"]]);
linkOut("zigbee_test_network_input_out", groups.test, "Estado TESTE → mesma fonte", "zigbee_test_network_input_in", 1000, 1560);
for (const [id, name, at, y] of [
  ["zigbee_test_net_29", "TESTE 4: 29 s offline", t0 + 39000, 1600],
  ["zigbee_test_net_30", "TESTE 5: 30 s offline", t0 + 40000, 1655],
  ["zigbee_test_net_59", "TESTE 7: 59 s online", t0 + 109000, 1765],
  ["zigbee_test_net_60", "TESTE 8: 60 s online", t0 + 110000, 1820],
]) inject(id, groups.test, name, [{ p: "monitor_now", v: String(at), vt: "num" }, { p: "_zigbee_test", v: "true", vt: "bool" }], 1250, y, [["zigbee_test_network_tick_out"]]);
linkOut("zigbee_test_network_tick_out", groups.test, "Tick TESTE → mesma decisão", "zigbee_network_cycle_in", 1530, 1710);
for (const [id, name, payload, at, y] of [
  ["zigbee_test_component_down", "TESTE 9: componente offline", "offline", t0, 1490],
  ["zigbee_test_component_duplicate", "TESTE 10: offline duplicado", "offline", t0 + 1000, 1550],
  ["zigbee_test_component_up", "TESTE 12: componente online", "online", t0 + 86401000, 1765],
]) inject(id, groups.test, name, [{ p: "payload", v: payload, vt: "str" }, { p: "topic", v: "zigbee2mqtt/teste_visual/availability", vt: "str" }, { p: "monitor_now", v: String(at), vt: "num" }, { p: "_zigbee_test", v: "true", vt: "bool" }], 1910, y, [["zigbee_test_component_out"]]);
linkOut("zigbee_test_component_out", groups.test, "Componente TESTE → mesma fonte", "zigbee_component_input_in", 2220, 1560);
inject("zigbee_test_component_reminder", groups.test, "TESTE 11: lembrete após 24 h", [{ p: "monitor_now", v: String(t0 + 86400000), vt: "num" }, { p: "_zigbee_test", v: "true", vt: "bool" }], 1930, 1710, [["zigbee_test_component_reminder_out"]]);
linkOut("zigbee_test_component_reminder_out", groups.test, "Tick TESTE → lembretes", "zigbee_component_reminder_in", 2240, 1710);
linkIn("zigbee_dry_in", groups.test, "Receber qualquer efeito TESTE", ["zigbee_notification_dry_out", "zigbee_publication_dry_out"], "zigbee_dry_run_terminal", 2600, 1540);
fn("zigbee_dry_run_terminal", groups.test, "TESTE FINAL: efeito bloqueado", "zigbee-dry-run.js", 0, 2860, 1540, []);

next.push(...nodes);
fs.writeFileSync(outputPath, `${JSON.stringify(next, null, 4)}\n`);
console.log(`Zigbee monitor visual flow installed in ${outputPath}`);
