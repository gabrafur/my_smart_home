// Daily Tailscale key-expiry routine inside atualizacoes_diarias. The host
// publisher sends only scope, platform, sharing and expiry (no names or
// addresses); this canvas decides when the household must be warned.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = (name) => fs.readFileSync(path.join(here, "functions", name), "utf8");

export const VPN_KEY_PREFIX = "daily_update_vpn_key_";
export const VPN_KEY_ALERT_OUT = VPN_KEY_PREFIX + "alert_out";
const BROKER = "721c47f31046b8bc";
const POLICY = { notify_days: [14, 7, 3, 1, 0], report_max_age_hours: 48 };

export function installVpnKeyExpiryFlow(nodes, previous) {
  const tab = "daily_host_updates_tab";
  const prefix = VPN_KEY_PREFIX;
  const y = Math.max(
    ...previous.filter((n) => n.z === tab && n.type === "group" && !n.id.startsWith(prefix)).map((n) => n.y + n.h),
    9000,
  ) + 100;
  const group = prefix + "group";
  const tests = prefix + "tests_group";
  const add = (n) => { nodes.push(n); return n.id; };
  add({
    id: group, type: "group", z: tab,
    name: "VPN: validade das chaves do Tailscale → aviso antes de deslogar",
    style: { label: true, stroke: "#1d4ed8", fill: "#dbeafe", "fill-opacity": "0.2" },
    nodes: [], x: 64, y, w: 1560, h: 320,
  });
  add({
    id: tests, type: "group", z: tab,
    name: "TESTES da validade das chaves — mesmo caminho até dry-run",
    style: { label: true, stroke: "#0891b2" },
    nodes: [], x: 64, y: y + 380, w: 1560, h: 160,
  });
  const grouped = (g, n) => { n.z = tab; n.g = g; nodes.find((v) => v.id === g).nodes.push(n.id); return add(n); };
  const fn = (id, g, name, func, x, py, wires, outputs = 1) => grouped(g, {
    id, type: "function", name, func, outputs, noerr: 0, timeout: 0, initialize: "", finalize: "", libs: [], x, y: py, wires,
  });

  grouped(group, {
    id: prefix + "architecture", type: "comment",
    name: "Chave vence em 180 dias e o aparelho é deslogado em silêncio. Avisa a 14, 7, 3, 1 e 0 dias; renovou → remove o aviso",
    info: "O publicador do host (scripts/vpn-health-publisher.mjs) envia por MQTT só escopo (host/aparelho), plataforma, compartilhado e data de vencimento — nunca nomes ou endereços. A avaliação roda todo dia às 09:00 e ao subir. Cada chave gera um aviso persistente e push uma vez por faixa; quando a chave é renovada ou deixa de vencer, o aviso persistente é removido sem push. Relatório velho não decide nada: a saúde do relatório é do monitoramento_vpn.",
    x: 760, y: y + 40, wires: [],
  });
  grouped(group, {
    id: prefix + "report_in", type: "mqtt in", name: "FONTE: relatório sanitizado da VPN (host)",
    topic: "nodered/infrastructure/vpn/host-health", qos: "1", datatype: "auto-detect", broker: BROKER,
    nl: false, rap: true, rh: 0, inputs: 0, x: 250, y: y + 100, wires: [[prefix + "ingest"]],
  });
  fn(prefix + "ingest", group, "Guardar só a validade das chaves", source("daily-update-vpn-key-ingest.js"), 620, y + 100, [], 0);
  grouped(group, {
    id: prefix + "daily", type: "inject", name: "Todo dia às 09:00", props: [{ p: "payload" }],
    repeat: "", crontab: "00 09 * * *", once: false, onceDelay: 0.1, topic: "", payload: "", payloadType: "date",
    x: 200, y: y + 180, wires: [[prefix + "policy"]],
  });
  grouped(group, {
    id: prefix + "startup", type: "inject", name: "Ao subir (após 120 s)", props: [{ p: "payload" }],
    repeat: "", crontab: "", once: true, onceDelay: "120", topic: "", payload: "", payloadType: "date",
    x: 210, y: y + 240, wires: [[prefix + "policy"]],
  });
  grouped(group, {
    id: prefix + "policy", type: "change", name: "PARÂMETRO: avisar a 14, 7, 3, 1 e 0 dias",
    rules: [{ t: "set", p: "vpn_key_policy", pt: "msg", to: JSON.stringify(POLICY), tot: "json" }],
    action: "", property: "", from: "", to: "", reg: false, x: 520, y: y + 210, wires: [[prefix + "evaluate"]],
  });
  fn(prefix + "evaluate", group, "Decidir aviso por chave e faixa", source("daily-update-vpn-key-evaluate.js"), 870, y + 210, [[prefix + "gate"]]);
  grouped(group, {
    id: prefix + "gate", type: "switch", name: "Aviso é TESTE?", property: "_ha_updates_test", propertyType: "msg",
    rules: [{ t: "true" }, { t: "else" }], checkall: "true", repair: false, outputs: 2,
    x: 1120, y: y + 210, wires: [[prefix + "dry_out"], [VPN_KEY_ALERT_OUT]],
  });
  grouped(group, {
    id: prefix + "dry_out", type: "link out", name: "TESTE → dry-run compartilhado", mode: "link",
    links: ["daily_update_dry_run_in"], x: 1380, y: y + 170, wires: [],
  });
  grouped(group, {
    id: VPN_KEY_ALERT_OUT, type: "link out", name: "Aviso → monitor global (HA + celulares)", mode: "link",
    links: ["global_observer_alert_to_dispatch_in"], x: 1400, y: y + 250, wires: [],
  });

  const now = Date.UTC(2026, 0, 1, 12);
  const day = 86400000;
  const report = (entries) => JSON.stringify({ checked_at: new Date(now).toISOString(), entries });
  const testInject = (id, name, entries, x) => {
    grouped(tests, {
      id: prefix + id + "_out", type: "link out", name: "→ política", mode: "link",
      links: [prefix + "test_in"], x: x + 40, y: y + 500, wires: [],
    });
    return grouped(tests, {
      id: prefix + id, type: "inject", name,
      props: [
        { p: "_ha_updates_test", v: "true", vt: "bool" },
        { p: "monitor_now", v: String(now), vt: "num" },
        { p: "vpn_key_report", v: report(entries), vt: "json" },
      ],
      repeat: "", crontab: "", once: false, onceDelay: 0.1, topic: "", x, y: y + 440, wires: [[prefix + id + "_out"]],
    });
  };
  grouped(group, {
    id: prefix + "test_in", type: "link in", name: "Receber TESTE",
    links: ["test_expiring", "test_expired", "test_renewed"].map((id) => prefix + id + "_out"),
    x: 360, y: y + 280, wires: [[prefix + "policy"]],
  });
  testInject("test_expiring", "TESTE 1: iPhone vence em 14 dias", [
    { scope: "device", platform: "ios", shared: false, expires_at: new Date(now + 14 * day + 3600000).toISOString() },
  ], 240);
  testInject("test_expired", "TESTE 2: chave do Pi venceu", [
    { scope: "host", platform: "linux", shared: false, expires_at: new Date(now - 3600000).toISOString() },
  ], 560);
  testInject("test_renewed", "TESTE 3: tudo renovado (remove avisos)", [
    { scope: "host", platform: "linux", shared: false, expires_at: new Date(now + 180 * day).toISOString() },
  ], 900);
  grouped(tests, {
    id: prefix + "test_reset", type: "inject", name: "RESET: somente estado de TESTE", props: [{ p: "payload" }],
    repeat: "", crontab: "", once: false, onceDelay: 0.1, topic: "", payload: "", payloadType: "date",
    x: 1230, y: y + 440, wires: [[prefix + "test_reset_apply"]],
  });
  fn(prefix + "test_reset_apply", tests, "Limpar estado de TESTE",
    "flow.set('vpn_key_expiry_notices_v1__test', undefined);node.status({fill:'grey',shape:'ring',text:'TESTE limpo'});return null;",
    1460, y + 440, [], 0);

  const dry = nodes.find((n) => n.id === "daily_update_dry_run_in");
  if (!dry) throw new Error("daily dry-run terminal missing");
  dry.links = [...new Set([...dry.links, prefix + "dry_out"])];
}
