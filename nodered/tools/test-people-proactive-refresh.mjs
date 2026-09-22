import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = file => fs.readFileSync(new URL("functions/" + file, import.meta.url), "utf8");
const values = new Map();
const flow = { get: k => values.get(k), set: (k, v) => values.set(k, structuredClone(v)) };
const policy = vm.runInNewContext(`(()=>{${source("location-policy-validate.js")}})()`, {
  msg: { topic: "near_home_refresh_minutes", payload: 5 },
  global: { get() {} }, Date,
})[0].location_policy_candidate;
assert.equal(policy.people_refresh_minutes, 10);
assert.equal(policy.people_refresh_attempts, 3);
const start = Date.parse("2026-09-01T12:00:00Z");
let now = start;
const KEY = "security_people_location_refresh_v2__test";
function run(payload = {}, test = true) {
  class Clock extends Date { static now() { return now; } }
  return vm.runInNewContext(`(()=>{${source("people-refresh-decide.js")}})()`, {
    msg: { _location_test: test, payload: { kind: "refresh_command", ...payload } },
    global: { get: () => policy }, flow, Date: Clock, node: { status() {} },
  });
}
function setup(state, age) {
  values.clear(); now = start;
  flow.set("people_context_v1__test", {
    resident_primary: { state, ready: age <= 15, stale: age > 15, updated_at: start - age * 60000 },
    resident_secondary: { state: "home", ready: true, updated_at: start },
  });
}
setup("near_home", 4.9); assert.equal(run(), null);
now += 6000; assert(run()[0], "aproximação renova aos cinco minutos");
setup("home", 9.9); assert.equal(run(), null);
now += 6000; assert(run()[0], "home renova aos dez minutos");
setup("not_home", 10); assert(run()[0], "fora também renova antes do vencimento");
assert.equal(run(), null, "tick duplicado não repete serviço");
assert.equal(run({ kind: "arrival_location_refresh", source: "resident_primary" }), null,
  "vigília/anel e timer compartilham dedupe");
now += 60000; assert.equal(run()[0].payload.refresh_attempt, 2);
now += 60000; assert.equal(run()[0].payload.refresh_attempt, 3);
now += 60000;
assert.equal(run(), null, "três pedidos sem resposta não geram aviso enquanto o GPS é atual");
assert.equal(flow.get(KEY).residents.resident_primary.diagnostic_reason,
  "location_refresh_without_new_evidence");
assert.equal(run(), null, "diagnóstico silencioso inclusive após recriar a função");
assert.equal(values.has("security_people_location_refresh_v2"), false, "produção isolada");
const guard = new Function("msg", source("global-flow-observer-dispatch-guard.js"));
now += 28 * 60000; assert.equal(run()?.[0] ?? null, null);
now += 60000; assert.equal(run()[0].payload.refresh_attempt, 4);
const people = flow.get("people_context_v1__test");
people.resident_primary = { state: "near_home", ready: false, stale: true, updated_at: now - 20 * 60000 };
assert.equal(run()?.[0] ?? null, null, "republicação mais nova porém vencida não zera o backoff");
people.resident_primary = { state: "near_home", ready: true, stale: false, updated_at: now };
assert.equal(run()?.[0] ?? null, null);
assert.equal(flow.get(KEY).residents.resident_primary.attempts, 0);
assert.equal(flow.get(KEY).residents.resident_primary.failure_notified, false);
now += 5 * 60000; assert.equal(run()[0].payload.refresh_attempt, 1);
setup("home", 60);
assert.equal(run({ reason: "resident_departure", resident_departure_force: true }), null);
let targeted = run({ kind: "arrival_location_refresh", source: "resident_secondary" });
assert.equal(targeted[0], null); assert(targeted[1]);
assert.equal(run({ kind: "arrival_location_refresh", source: "invalid" }), null);
setup("near_home", 0);
flow.get("people_context_v1__test").resident_primary.updated_at = now + 120000;
assert(run()[0], "timestamp futuro não comprova frescor");
values.clear(); assert.equal(run(), null, "sem snapshot não acusa telefone indisponível");
for (const zone of ["home", "near_home", "not_home", "unavailable"]) {
  for (const test of [true, false]) {
    setup(zone, 60);
    if (!test) flow.set("people_context_v1", flow.get("people_context_v1__test"));
    const key = test ? KEY : "security_people_location_refresh_v2";
    const snapshot = structuredClone(flow.get(test ? "people_context_v1__test" : "people_context_v1"));
    for (let attempt = 1; attempt <= 3; attempt++) {
      const out = run({}, test);
      assert.equal(out[0].payload.refresh_attempt, attempt);
      assert.equal(out[2], null, "não criar alerta rotineiro em nenhuma zona");
      now += 60000;
    }
    assert.equal(run({}, test), null, "GPS vencido sem callback é diagnóstico, não erro de serviço");
    const old = flow.get(key).residents.resident_primary;
    const lastSuccess = old.last_success_at;
    const observed = old.observed_at_before_request;
    old.failure_notified = true; // Incident created by the prior deployed policy.
    const removal = run({}, test);
    assert.equal(removal[0], null);
    assert.equal(removal[2].length, 1);
    const notice = removal[2][0];
    assert.equal(notice.payload.persistent_notification_operation, "dismiss");
    assert.equal(notice.payload.resolution, "routine_location_notice_retired");
    assert.equal(notice.payload.mobile_notification, false);
    const guarded = guard(notice);
    assert.equal(guarded[0], null, "nem a limpeza gera push");
    assert(test ? guarded[2] : guarded[1], "teste permanece no dry-run; produção somente dismiss");
    const after = flow.get(key).residents.resident_primary;
    assert.equal(after.attempts, 3);
    assert.equal(after.awaiting_evidence, true);
    assert.equal(after.last_success_at, lastSuccess);
    assert.equal(after.observed_at_before_request, observed);
    assert.deepEqual(flow.get(test ? "people_context_v1__test" : "people_context_v1"), snapshot);
    assert.equal(run({}, test), null, "migração silenciosa só uma vez, inclusive após restart lógico");
  }
}
console.log("People GPS: 5/10 min, silent retries, legacy dismissal, bounded backoff, recovery and dry-run passed.");
