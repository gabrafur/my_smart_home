#!/usr/bin/env node
// Regression for the Tailscale key-expiry routine in atualizacoes_diarias.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const flowsPath = path.resolve(process.argv[2] ?? path.join(here, "..", "flows.json"));
const flows = JSON.parse(fs.readFileSync(flowsPath, "utf8"));
const byId = new Map(flows.map((node) => [node.id, node]));
const P = "daily_update_vpn_key_";
const DAY = 86400000;

function runner(id) {
  const node = byId.get(id);
  assert.ok(node, `${id} ausente`);
  const run = new Function("msg", "flow", "node", "Buffer", node.func);
  return (msg, store) => {
    const status = [];
    const flow = {
      get: (key, scope) => store.get(`${scope ?? "memory"}:${key}`),
      set: (key, value, scope) => (value === undefined ? store.delete(`${scope ?? "memory"}:${key}`) : store.set(`${scope ?? "memory"}:${key}`, value)),
    };
    const result = run(structuredClone(msg), flow, { status: (s) => status.push(s), warn() {} }, Buffer);
    return { result, status: status.at(-1) };
  };
}

// Wiring: schedule, policy, decision, gate and both exits.
assert.equal(byId.get(P + "daily").crontab, "00 09 * * *");
assert.equal(byId.get(P + "report_in").topic, "nodered/infrastructure/vpn/host-health");
assert.deepEqual(byId.get(P + "gate").wires, [[P + "dry_out"], [P + "alert_out"]]);
assert.deepEqual(byId.get(P + "alert_out").links, ["global_observer_alert_to_dispatch_in"]);
assert.ok(byId.get("global_observer_alert_to_dispatch_in").links.includes(P + "alert_out"));
assert.ok(byId.get("daily_update_dry_run_in").links.includes(P + "dry_out"));
for (const id of ["test_expiring", "test_expired", "test_renewed"]) {
  const inject = byId.get(P + id);
  assert.equal(inject.props.find((p) => p.p === "_ha_updates_test")?.v, "true", `${id} precisa ser TESTE`);
}
const policy = JSON.parse(byId.get(P + "policy").rules[0].to);

// Ingest keeps only sanitized fields and ignores reports without key data.
const ingest = runner(P + "ingest");
const store = new Map();
ingest({ payload: JSON.stringify({ schema_version: 1, vpns: [] }) }, store);
assert.equal(store.size, 0);
ingest({ payload: JSON.stringify({
  schema_version: 1, checked_at: "2026-12-01T12:00:00.000Z",
  key_expiry: [{ scope: "device", platform: "ios", shared: false, expires_at: "2026-12-10T12:00:00Z", name: "private" }],
}) }, store);
const saved = store.get("persistent:vpn_key_expiry_report_v1");
assert.doesNotMatch(JSON.stringify(saved), /private/);
assert.equal(saved.entries.length, 1);

// Decision: one notice per key and band; renewal dismisses without push.
const evaluate = runner(P + "evaluate");
const now = Date.UTC(2026, 11, 1, 12);
const at = (days) => new Date(now + days * DAY + 3600000).toISOString();
const report = (entries, checked = now) => ({ checked_at: new Date(checked).toISOString(), entries });
const iphone = (days) => ({ scope: "device", platform: "ios", shared: false, expires_at: at(days) });
const prod = new Map();
const decide = (entries, when = now, checked = when) => {
  prod.set("persistent:vpn_key_expiry_report_v1", report(entries, checked));
  const { result } = evaluate({ monitor_now: when, vpn_key_policy: policy }, prod);
  return result?.[0] ?? null;
};

assert.deepEqual(decide([iphone(30)]), [], "fora da janela não avisa");
let out = decide([iphone(14)]);
assert.equal(out.length, 1);
assert.equal(out[0].payload.persistent_notification_operation, "create");
assert.equal(out[0].payload.mobile_notification, true);
assert.equal(out[0].payload.test_mode, false);
assert.match(out[0].alert.message, /iPhone\/iPad vence em 14 dias/);
assert.match(out[0].alert.message, /Disable key expiry/);
const incident = out[0].payload.incident_key;
assert.deepEqual(decide([iphone(14)], now + 3600000, now + 3600000), [], "mesma faixa não repete");
out = decide([iphone(14)], now + 8 * DAY, now + 8 * DAY);
assert.equal(out.length, 1, "faixa de 7 dias avisa de novo");
assert.equal(out[0].payload.incident_key, incident);
out = decide([{ ...iphone(14), expires_at: new Date(now + 7 * DAY).toISOString() }], now + 7 * DAY + 1000, now + 7 * DAY + 1000);
assert.equal(out.length, 2, "nova chave venceu e a anterior some");
assert.ok(out.some((m) => m.alert.title === "VPN: chave do Tailscale venceu"));
assert.ok(out.some((m) => m.payload.incident_key === incident && m.payload.persistent_notification_operation === "dismiss" && m.payload.mobile_notification === false));

// Renewal: the expired notice is dismissed, with no push.
out = decide([iphone(180)], now + 8 * DAY, now + 8 * DAY);
assert.equal(out.length, 1);
assert.equal(out[0].payload.persistent_notification_operation, "dismiss");
assert.equal(out[0].payload.observer_kind, "domain_recovery");
assert.equal(out[0].payload.mobile_notification, false);
assert.deepEqual(prod.get("persistent:vpn_key_expiry_notices_v1"), {});

// Host and shared devices get their own consequence and remedy.
out = decide([
  { scope: "host", platform: "linux", shared: false, expires_at: at(3) },
  { scope: "device", platform: "other", shared: true, expires_at: at(1) },
]);
assert.match(out.find((m) => /Raspberry Pi/.test(m.alert.message)).alert.message, /todo o acesso remoto/);
assert.match(out.find((m) => /compartilhado/.test(m.alert.message)).alert.message, /dono desse aparelho/);

// Stale report decides nothing and never dismisses open notices.
const before = structuredClone(prod.get("persistent:vpn_key_expiry_notices_v1"));
assert.equal(decide([], now + 5 * DAY, now), null);
assert.deepEqual(prod.get("persistent:vpn_key_expiry_notices_v1"), before);

// Invalid policy decides nothing.
assert.equal(evaluate({ monitor_now: now, vpn_key_policy: { notify_days: [] } }, prod).result, null);

// TESTE path uses its own memory and leaves production state untouched.
const testStore = new Map(prod);
const testResult = evaluate({
  _ha_updates_test: true, monitor_now: now, vpn_key_policy: policy,
  vpn_key_report: report([iphone(14)]),
}, testStore).result[0];
assert.equal(testResult[0].payload.test_mode, true);
assert.ok(testStore.has("memory:vpn_key_expiry_notices_v1__test"));
assert.deepEqual(testStore.get("persistent:vpn_key_expiry_notices_v1"), prod.get("persistent:vpn_key_expiry_notices_v1"));

console.log("vpn key expiry flow: ok");
