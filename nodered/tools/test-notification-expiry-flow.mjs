#!/usr/bin/env node
// 24 h expiry for persistent notifications without a resolution signal.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const flowPath = path.resolve(here, "..", "flows.json");
const flows = JSON.parse(fs.readFileSync(flowPath, "utf8"));
const byId = new Map(flows.map((node) => [node.id, node]));
const TAB = "notification_expiry_tab";

assert.equal(byId.get(TAB)?.label, "expiracao_notificacoes");
assert.equal(byId.get("notification_expiry_tick").repeat, "1800");
assert.equal(byId.get("notification_expiry_read").data, "{\"type\":\"persistent_notification/get\"}");
assert.deepEqual(byId.get("notification_expiry_hub_call").links, ["notification_hub_persistent_in"]);
assert.deepEqual(byId.get("notification_expiry_select").wires, [["notification_expiry_pace"]]);
assert.deepEqual(byId.get("notification_expiry_hub_call").wires, [["notification_expiry_mode"]]);
assert.deepEqual(byId.get("notification_expiry_mode").wires, [["notification_expiry_dry_run_terminal"], ["notification_expiry_result"]]);
for (const node of flows.filter((entry) => entry.z === TAB && entry.type !== "group")) {
  assert.ok(node.g, `nó fora de grupo: ${node.id}`);
}

const run = (code, msg) => {
  const status = [];
  const warnings = [];
  const result = vm.runInNewContext(`(function(){${code}\n})()`, {
    msg, Date, Number, Array, Set, node: { status: (value) => status.push(value), warn: (value) => warnings.push(value) },
  });
  const plain = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  return { result: plain(result), status: plain(status), warnings: plain(warnings) };
};
const select = byId.get("notification_expiry_select").func;
const now = Date.parse("2026-11-23T12:00:00Z");
const age = (hours) => new Date(now - hours * 3600000).toISOString();
const list = [
  { notification_id: "portao_garagem_rele_preso", created_at: age(25) },
  { notification_id: "vehicle_primary_remote_command_failed", created_at: age(24.01) },
  { notification_id: "vehicle_primary_refresh_blocked", created_at: age(23) },
  { notification_id: "codex_alert_credits_low", created_at: age(30) },
  { notification_id: "codex_alert_forecast", created_at: age(72) },
  { notification_id: "codex_alert_usage", created_at: age(72) },
  { notification_id: "git_backup_failure", created_at: age(72) },
  { notification_id: "nodered_observabilidade_global_node_error_flow_x", created_at: age(48) },
  { notification_id: "nodered_observabilidade_global_monitor_internal_error_src", created_at: age(48) },
  { notification_id: "nodered_observabilidade_global_domain_alert_local_ai_rtx_unavailable", created_at: age(48) },
  { notification_id: "zigbee_network_failure", created_at: age(48) },
  { notification_id: "portao_garagem_rele_preso_x", created_at: age(48) },
  { notification_id: "codex_alert_daily", created_at: "invalid" },
  { created_at: age(48) },
];
const production = run(select, { ha_notifications: list, expiry_now: now });
const ids = production.result[0].map((entry) => entry.notification.notification_id);
assert.deepEqual(ids, [
  "portao_garagem_rele_preso",
  "vehicle_primary_remote_command_failed",
  "codex_alert_credits_low",
  "nodered_observabilidade_global_node_error_flow_x",
  "nodered_observabilidade_global_monitor_internal_error_src",
]);
for (const entry of production.result[0]) {
  assert.deepEqual(entry.notification, {
    source: "expiracao_notificacoes", operation: "dismiss", delivery: "queued",
    notification_id: entry.notification.notification_id, test_mode: false,
  });
  assert.equal(entry.payload, "");
}
assert.equal(production.status.at(-1).fill, "yellow");

const test = run(select, { ha_notifications: list.slice(0, 1), expiry_now: now, test_mode: true });
assert.equal(test.result[0][0].notification.test_mode, true, "TESTE deve terminar no dry-run do hub");
assert.equal(run(select, { ha_notifications: [], expiry_now: now }).result[0].length, 0);
const missing = run(select, { expiry_now: now });
assert.equal(missing.result, null, "sem lista do HA não remove nada");
assert.equal(missing.status.at(-1).fill, "red");

// The injected test list must exercise expired, recent and resolved notifications.
const injected = byId.get("notification_expiry_test").props;
const testRun = run(select, Object.fromEntries(injected.map((prop) => [prop.p, prop.vt === "json" ? JSON.parse(prop.v) : prop.vt === "num" ? Number(prop.v) : prop.v === "true"])));
assert.deepEqual(testRun.result[0].map((entry) => entry.notification.notification_id), ["portao_garagem_rele_preso"]);
assert.equal(testRun.result[0][0].test_mode, true);

// Expiry is only for IDs that no other flow resolves.
const exact = [...select.matchAll(/^\s+"([a-z0-9_]+)",?$/gm)].map((match) => match[1]);
assert.ok(exact.length >= 7);
const others = flows.filter((node) => node.z !== TAB);
for (const id of exact) {
  const resolvers = others.filter((node) => {
    const text = JSON.stringify(node);
    return text.includes(`\\"notification_id\\":\\"${id}\\"`) && /\\"operation\\":\\"dismiss\\"/.test(text);
  });
  assert.deepEqual(resolvers.map((node) => node.id), [], `${id} ganhou resolução própria; tire-o da expiração`);
}

const result = byId.get("notification_expiry_result").func;
const ok = run(result, { _notification_expiry: { notification_id: "x" }, notification_delivery: { status: "accepted" } });
assert.equal(ok.status[0].fill, "green");
assert.equal(ok.warnings.length, 0);
const failed = run(result, { _notification_expiry: { notification_id: "x" }, notification_delivery: { status: "failed" } });
assert.equal(failed.status[0].fill, "red");
assert.equal(failed.warnings.length, 1);

const dryRun = run(byId.get("notification_expiry_dry_run_terminal").func, { _notification_expiry: { notification_id: "x", test_mode: true }, notification_delivery: { status: "simulated" } });
assert.equal(dryRun.result, null);
assert.equal(dryRun.status[0].fill, "blue");

// The generator converges and reproduces the persisted tab.
const temporary = path.join(os.tmpdir(), `node-red-expiry-${process.pid}.json`);
const repeated = path.join(os.tmpdir(), `node-red-expiry-repeated-${process.pid}.json`);
for (const [input, output] of [[flowPath, temporary], [temporary, repeated]]) {
  const generated = spawnSync(process.execPath, [path.join(here, "install-notification-expiry-flow.mjs"), input, output], { encoding: "utf8" });
  if (generated.status !== 0) throw new Error(generated.stderr || generated.stdout || "gerador falhou");
}
const digest = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
assert.equal(digest(temporary), digest(repeated), "gerador de expiração não converge");
const tabNodes = (file) => JSON.parse(fs.readFileSync(file, "utf8"))
  .filter((node) => node.id === TAB || node.id.startsWith("notification_expiry_"))
  .map((node) => { const copy = { ...node }; delete copy.x; delete copy.y; delete copy.w; delete copy.h; return copy; })
  .sort((left, right) => left.id.localeCompare(right.id));
assert.deepEqual(tabNodes(temporary), tabNodes(flowPath), "flows.json difere do gerador de expiração");
fs.unlinkSync(temporary);
fs.unlinkSync(repeated);

console.log("Notification expiry flow tests passed.");
