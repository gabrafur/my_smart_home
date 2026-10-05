#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const file = path.resolve(process.argv[2] || path.join(here, "../flows.json"));
const flows = JSON.parse(fs.readFileSync(file, "utf8"));
const TAB = "rtx_metrics_tab", HA = "4126427d5e161a03";
const nodes = [{ id: TAB, type: "tab", label: "metricas_rtx", disabled: false, info: "Fatos: sensores brutos do bridge. Cálculos e classificações: este canvas. Consumidor: painel RTX. Sondas passivas; nenhum recovery. Hoje/semana/mês usam as janelas UTC do produtor." }];
function group(id, name, x, y, w, h, fill) {
    nodes.push({ id, type: "group", z: TAB, name, nodes: [], x, y, w, h, style: { label: true, "label-position": "nw", color: "#1f2937", stroke: "#64748b", fill, "fill-opacity": "0.35" } });
    return id;
}
function add(id, type, g, name, x, y, wires = [], extra = {}) {
    nodes.push({ id, type, z: TAB, g, name, x, y, wires, ...extra });
    nodes.find(n => n.id === g).nodes.push(id);
}
function fn(id, g, name, file, x, y, target, inline) {
    add(id, "function", g, name, x, y, target ? [[target]] : [], { func: inline || fs.readFileSync(path.join(here, "functions", file), "utf8").trimEnd(), outputs: target ? 1 : 0, timeout: 0, noerr: 0, initialize: "", finalize: "", libs: [] });
}
function inject(id, g, name, x, y, target, payload = {}, extra = {}) {
    add(id, "inject", g, name, x, y, [[target]], { props: [{ p: "payload" }], payload: JSON.stringify(payload), payloadType: "json", topic: "", repeat: "", crontab: "", once: false, onceDelay: 0.2, ...extra });
}
function out(id, g, name, x, y, target) { add(id, "link out", g, name, x, y, [], { mode: "link", links: [target] }); }
function input(id, g, name, x, y, sources, target) { add(id, "link in", g, name, x, y, [[target]], { links: sources }); }

const p = group("rtx_metrics_policy_group", "0. Parâmetros · segundos / registros · limites no validador", 64, 20, 720, 210, "#dbeafe");
const policy = { usage_max_age_s: 30, live_max_age_s: 15, history_max_age_s: 90, host_max_age_s: 90, history_limit: 15 };
inject("rtx_metrics_policy_set", p, "Validade 30/15/90/90 s · até 15 jobs", 280, 100, "rtx_metrics_policy", policy, { once: true });
fn("rtx_metrics_policy", p, "Validar e preservar último válido", "rtx-metrics-policy.js", 600, 100);
add("rtx_metrics_policy_help", "comment", p, "Uso 15–300 s; live 5–60 s; histórico 30–600 s; host 35–300 s; jobs 1–30", 410, 170, [], { info: "Idades máximas de cada observação; rejeitar configuração inválida sem sobrescrever a anterior. Agenda fixa de leitura: 2 s; validade MQTT: 45 s; discovery retido: 60 s. Não acorda a RTX." });

const s = group("rtx_metrics_sources_group", "1. Ler fatos do Home Assistant · sem acordar nem recuperar a RTX", 64, 270, 1830, 180, "#ccfbf1");
inject("rtx_metrics_tick", s, "Atualizar a cada 2 s", 230, 360, "rtx_metrics_usage", {}, { once: true, onceDelay: 3, repeat: "2" });
const entities = [["usage", "sensor.codex_usage_raw", "Contadores e recibos"], ["live", "sensor.codex_rtx_live_raw", "Atividade atual"], ["history", "sensor.codex_rtx_historico_48h_raw", "Histórico de 48 horas"], ["host", "sensor.codex_rtx_host_reachability_raw", "Computador: online/offline/unknown"]];
entities.forEach(([key, entity, name], i) => add(`rtx_metrics_${key}`, "api-current-state", s, name, 530 + i * 340, 360, [[i === entities.length - 1 ? "rtx_metrics_snapshot_out" : `rtx_metrics_${entities[i + 1][0]}`]], {
    server: HA, version: 3, outputs: 1, halt_if: "", halt_if_type: "str", halt_if_compare: "is", entity_id: entity, state_type: "str", blockInputOverrides: true,
    outputProperties: [{ property: key, propertyType: "msg", value: "", valueType: "entity" }], for: "0", forType: "num", forUnits: "minutes", override_topic: false,
}));
out("rtx_metrics_snapshot_out", s, "Snapshot → métricas", 1820, 360, "rtx_metrics_calculate_in");

const c = group("rtx_metrics_calculation_group", "2. Contrato canônico · validade → disponibilidade → taxas e saldo → histórico", 64, 490, 1830, 180, "#ede9fe");
input("rtx_metrics_calculate_in", c, "Fatos reais ou sintéticos", 120, 580, ["rtx_metrics_snapshot_out", "rtx_metrics_test_out"], "rtx_metrics_normalize");
fn("rtx_metrics_normalize", c, "Validar fontes e idades", "rtx-metrics-normalize.js", 350, 580, "rtx_metrics_health");
fn("rtx_metrics_health", c, "Classificar disponibilidade", "rtx-metrics-health.js", 690, 580, "rtx_metrics_periods");
fn("rtx_metrics_periods", c, "Calcular saldo, etapas e taxas", "rtx-metrics-periods.js", 1050, 580, "rtx_metrics_jobs");
fn("rtx_metrics_jobs", c, "Classificar histórico limitado", "rtx-metrics-history.js", 1430, 580, "rtx_metrics_result_out");
out("rtx_metrics_result_out", c, "Contrato → gate de publicação", 1820, 580, "rtx_metrics_publish_in");

const e = group("rtx_metrics_effect_group", "3. Publicar somente métricas · TESTE termina antes do MQTT", 64, 710, 1830, 260, "#dcfce7");
input("rtx_metrics_publish_in", e, "Receber contrato", 120, 800, ["rtx_metrics_result_out"], "rtx_metrics_serialize");
fn("rtx_metrics_serialize", e, "Serializar estado e discovery", "rtx-metrics-publish.js", 350, 800, "rtx_metrics_test_gate");
add("rtx_metrics_test_gate", "switch", e, "Gate final: é TESTE?", 700, 800, [["rtx_metrics_dry_run"], ["rtx_metrics_mqtt"]], { property: "test_mode", propertyType: "msg", rules: [{ t: "true" }, { t: "else" }], checkall: "true", repair: false, outputs: 2 });
fn("rtx_metrics_dry_run", e, "TESTE: simulado, não publicado", "rtx-metrics-dry-run.js", 1090, 770);
add("rtx_metrics_mqtt", "mqtt out", e, "Sensores do painel · MQTT retido", 1090, 870, [], { topic: "", qos: "", retain: "", respTopic: "", contentType: "", userProps: "", correl: "", expiry: "", broker: "721c47f31046b8bc" });

const t = group("rtx_metrics_test_group", "4. TESTE completo · reset → nominal → indisponível → stale → recuperação", 64, 1010, 1830, 420, "#fef3c7");
inject("rtx_metrics_test_reset", t, "TESTE 0: reset isolado", 260, 1090, "rtx_metrics_reset", { scenario: "reset" });
fn("rtx_metrics_reset", t, "Limpar somente estado de TESTE", null, 680, 1090, null, 'flow.set("rtx_metrics_test_result", undefined); flow.set("rtx_metrics_test_snapshot", undefined); flow.set("rtx_metrics_test_policy", undefined); node.status({fill:"green",shape:"dot",text:"TESTE reiniciado"}); return null;');
for (const [i, scenario, label] of [[1, "nominal", "com uso confirmado"], [2, "offline", "computador offline"], [3, "stale", "dados antigos / unknown"], [4, "empty", "disponível sem amostra"], [5, "invalid", "fonte indisponível"]]) {
    inject(`rtx_metrics_test_${scenario}`, t, `TESTE ${i}: ${label}`, 310, 1120 + i * 50, `rtx_metrics_test_${scenario}_out`, { scenario });
    out(`rtx_metrics_test_${scenario}_out`, t, `TESTE ${i} → fatos`, 570, 1120 + i * 50, "rtx_metrics_test_merge");
}
input("rtx_metrics_test_merge", t, "Receber cenário sintético", 710, 1270, ["nominal", "offline", "stale", "empty", "invalid"].map(s => `rtx_metrics_test_${s}_out`), "rtx_metrics_fixture");
fn("rtx_metrics_fixture", t, "Acumular fatos sintéticos isolados", "rtx-metrics-fixture.js", 920, 1270, "rtx_metrics_test_out");
out("rtx_metrics_test_out", t, "TESTE → mesmo cálculo e gate", 1200, 1270, "rtx_metrics_calculate_in");
add("rtx_metrics_test_help", "comment", t, "Repetir TESTE 1 após 2/3/5: recuperação sem publicar sensores", 1460, 1360, [], { info: "A ordem é livre após reset. TESTE 1 cobre recuperação. Inspecione rtx_metrics_test_result; simulated=true, dispatched=false. Falhas de nós/status têm replay pelo observador global compartilhado. Nenhum teste altera produção." });

// Preserve every unrelated node and observer coverage; stable indices on regeneration.
const byId = new Map(nodes.map(n => [n.id, n]));
const next = flows.filter(n => n.z !== TAB || n.id.startsWith("global_observer_coverage__") || byId.has(n.id)).map(n => {
    const desired = byId.get(n.id); if (!desired) return n; byId.delete(n.id); return desired;
});
next.push(...byId.values());
fs.writeFileSync(file, JSON.stringify(next, null, 4) + "\n");
console.log(`RTX metrics: ${nodes.length} managed nodes`);
