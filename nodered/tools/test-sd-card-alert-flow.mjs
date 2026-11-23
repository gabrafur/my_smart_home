#!/usr/bin/env node
// SD card stall alert: two slow guardian readings create, three normal ones dismiss.
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
const TAB = "sd_card_alert_tab";

assert.equal(byId.get(TAB)?.label, "alerta_cartao_sd");
assert.equal(byId.get("sd_card_alert_tick").repeat, "30");
assert.equal(byId.get("sd_card_alert_read").command, "/opt/read-host-memory-guardian-result.sh");
assert.deepEqual(byId.get("sd_card_alert_read").wires, [["sd_card_alert_evaluate"], [], []]);
assert.deepEqual(byId.get("sd_card_alert_hub_call").links, ["notification_hub_persistent_in"]);
assert.deepEqual(byId.get("sd_card_alert_evaluate").wires, [["sd_card_alert_hub_call"]]);
assert.deepEqual(byId.get("sd_card_alert_mode").wires, [["sd_card_alert_dry_run_terminal"], ["sd_card_alert_result"]]);
for (const node of flows.filter((entry) => entry.z === TAB && entry.type !== "group")) {
  assert.ok(node.g, `nó fora de grupo: ${node.id}`);
}

const plain = (value) => value === undefined || value === null ? value : JSON.parse(JSON.stringify(value));
const makeFlow = () => {
  const stores = { memory: new Map(), persistent: new Map() };
  return {
    stores,
    get: (key, store = "memory") => stores[store].get(key),
    set: (key, value, store = "memory") => { if (value === undefined) stores[store].delete(key); else stores[store].set(key, value); },
  };
};
const run = (code, msg, flow = makeFlow()) => {
  const status = [];
  const warnings = [];
  const result = vm.runInNewContext(`(function(){${code}\n})()`, {
    msg, flow, Math, Number, node: { status: (value) => status.push(value), warn: (value) => warnings.push(value) },
  });
  return { result: plain(result), status: plain(status), warnings: plain(warnings) };
};
const evaluate = byId.get("sd_card_alert_evaluate").func;
let minute = 0;
const reading = (writeMs, blocked) => {
  minute += 1;
  return `host-memory-guardian status=healthy available_mib=4000 sd_read_ms=1 sd_write_ms=${writeMs} sd_busy_percent=50 blocked_tasks=${blocked} request_id=r${minute} checked_at=2026-11-23T10:${String(minute).padStart(2, "0")}:00Z`;
};

// Production: isolated spikes (seen several times per hour) never alert.
const flow = makeFlow();
const step = (writeMs, blocked, extra = {}) => run(evaluate, { payload: reading(writeMs, blocked), ...extra }, flow);
for (const [writeMs, blocked] of [[1585, 0], [9, 0], [61, 8], [74, 1], [1245, 0], [10, 0]]) {
  assert.equal(step(writeMs, blocked).result, null, `pico isolado ${writeMs}/${blocked} não avisa`);
}
assert.equal(step(900, 0).result, null);
const created = step(40, 9).result;
assert.equal(created.notification.operation, "create");
assert.deepEqual(created.notification, {
  source: "alerta_cartao_sd", operation: "create", delivery: "queued",
  notification_id: "raspberry_pi_cartao_sd_lento", test_mode: false, title: "Cartão SD do Raspberry Pi lento",
});
assert.match(created.payload, /até 900 ms, 9 processo\(s\)/);
assert.match(created.payload, /some sozinho depois de 3 leituras normais/);
assert.equal(flow.stores.persistent.get("sd_card_alert_state_v1").active, true);
assert.equal(step(2000, 0).result, null, "aviso ativo não se repete");
assert.equal(step(10, 0).result, null);
assert.equal(step(10, 0).result, null);
assert.equal(step(3000, 0).result, null, "pico durante a recuperação zera a contagem normal");
assert.equal(step(10, 0).result, null);
assert.equal(step(10, 0).result, null);
const dismissed = step(10, 0).result;
assert.equal(dismissed.notification.operation, "dismiss");
assert.equal(dismissed.payload, "");
assert.equal(flow.stores.persistent.get("sd_card_alert_state_v1").active, false);

// The same reading is evaluated once; unknown metrics and invalid lines change nothing.
const repeated = reading(2000, 0);
assert.equal(run(evaluate, { payload: repeated }, flow).result, null);
const before = plain(flow.stores.persistent.get("sd_card_alert_state_v1"));
assert.equal(run(evaluate, { payload: repeated }, flow).result, null);
assert.deepEqual(plain(flow.stores.persistent.get("sd_card_alert_state_v1")), before, "leitura repetida não conta duas vezes");
assert.equal(step("unknown", "unknown").result, null);
assert.equal(flow.stores.persistent.get("sd_card_alert_state_v1").slow, 1, "unknown não zera nem soma");
const invalid = run(evaluate, { payload: "lixo sd_write_ms=9000" }, flow);
assert.equal(invalid.result, null);
assert.equal(invalid.status.at(-1).text, "sem leitura do guardião");
assert.equal(run(evaluate, {}, flow).result, null);

// TESTE uses its own memory-only state and reaches the hub with test_mode.
const testFlow = makeFlow();
testFlow.set("sd_card_alert_state_v1", { version: 1, active: true, slow: 5, normal: 0 }, "persistent");
const test = (writeMs, blocked) => run(evaluate, { payload: reading(writeMs, blocked), test_mode: true }, testFlow);
assert.equal(test(1500, 8).result, null);
const testCreated = test(1500, 8).result;
assert.equal(testCreated.notification.test_mode, true);
assert.equal(testCreated._sd_card_alert.test_mode, true);
assert.equal(testFlow.stores.persistent.get("sd_card_alert_state_v1").slow, 5, "TESTE não toca o estado real");
const reset = run(evaluate, { test_mode: true, sd_card_alert_reset: true }, testFlow);
assert.equal(reset.result, null);
assert.equal(testFlow.get("sd_card_alert_state_v1__test"), undefined);
assert.equal(run(evaluate, { sd_card_alert_reset: true, payload: reading(10, 0) }, testFlow).result, null, "reset só vale em TESTE");
assert.ok(testFlow.stores.persistent.get("sd_card_alert_state_v1"), "produção não é zerada pelo reset");

// The manual test injects are TESTE, and their JSONata lines are slow and normal readings.
for (const id of ["sd_card_alert_test_reset", "sd_card_alert_test_slow", "sd_card_alert_test_normal"]) {
  assert.ok(byId.get(id).props.some((prop) => prop.p === "test_mode" && prop.v === "true" && prop.vt === "bool"), `${id} sem test_mode`);
}
assert.match(byId.get("sd_card_alert_test_slow").props.find((prop) => prop.p === "payload").v, /sd_write_ms=1500 .*blocked_tasks=8 checked_at=" & \$now\(\)$/);
assert.match(byId.get("sd_card_alert_test_normal").props.find((prop) => prop.p === "payload").v, /sd_write_ms=10 .*blocked_tasks=0 checked_at=" & \$now\(\)$/);

const result = byId.get("sd_card_alert_result").func;
const ok = run(result, { _sd_card_alert: { operation: "create" }, notification_delivery: { status: "accepted" } });
assert.equal(ok.status[0].fill, "green");
assert.equal(ok.warnings.length, 0);
const failed = run(result, { _sd_card_alert: { operation: "dismiss" }, notification_delivery: { status: "failed" } });
assert.equal(failed.status[0].fill, "red");
assert.equal(failed.warnings.length, 1);
const dryRun = run(byId.get("sd_card_alert_dry_run_terminal").func, { _sd_card_alert: { operation: "create", test_mode: true }, notification_delivery: { status: "simulated" } });
assert.equal(dryRun.result, null);
assert.equal(dryRun.status[0].fill, "blue");

// The generator converges and reproduces the persisted tab.
const temporary = path.join(os.tmpdir(), `node-red-sd-alert-${process.pid}.json`);
const repeatedOutput = path.join(os.tmpdir(), `node-red-sd-alert-repeated-${process.pid}.json`);
for (const [input, output] of [[flowPath, temporary], [temporary, repeatedOutput]]) {
  const generated = spawnSync(process.execPath, [path.join(here, "install-sd-card-alert-flow.mjs"), input, output], { encoding: "utf8" });
  if (generated.status !== 0) throw new Error(generated.stderr || generated.stdout || "gerador falhou");
}
const digest = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
assert.equal(digest(temporary), digest(repeatedOutput), "gerador do alerta do SD não converge");
const tabNodes = (file) => JSON.parse(fs.readFileSync(file, "utf8"))
  .filter((node) => node.id === TAB || node.id.startsWith("sd_card_alert_"))
  .map((node) => { const copy = { ...node }; delete copy.x; delete copy.y; delete copy.w; delete copy.h; return copy; })
  .sort((left, right) => left.id.localeCompare(right.id));
assert.deepEqual(tabNodes(temporary), tabNodes(flowPath), "flows.json difere do gerador do alerta do SD");
fs.unlinkSync(temporary);
fs.unlinkSync(repeatedOutput);

console.log("SD card alert flow tests passed.");
