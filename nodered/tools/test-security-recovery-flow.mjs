import assert from "node:assert/strict";
import fs from "node:fs";

const flows = JSON.parse(fs.readFileSync(new URL("../flows.json", import.meta.url), "utf8"));
const byId = new Map(flows.map((item) => [item.id, item]));
const NOW = Date.parse("2026-08-13T12:00:00.000Z");
const originalNow = Date.now;
Date.now = () => NOW;

function memoryFlow(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    get: (key) => values.get(key),
    set: (key, value) => values.set(key, value),
    values,
  };
}

function run(id, msg, flow = memoryFlow(), warnings = []) {
  const target = byId.get(id);
  assert(target, `node ausente: ${id}`);
  const execute = new Function("msg", "node", "context", "flow", "global", "env", "setTimeout", "clearTimeout", target.func);
  const env = { get: (key) => ({ HOME_LAT: "0", HOME_LON: "0", GATE_LAT: "0", GATE_LON: "0" })[key] };
  return execute(msg, { warn: (text) => warnings.push(text), error() {}, status() {} }, {}, flow, {}, env, setTimeout, clearTimeout);
}

function iso(offset = 0) {
  return new Date(NOW + offset).toISOString();
}

function entity(state, distance = 20, age = 0, accuracy = 10) {
  const attributes = { gps_accuracy: accuracy };
  if (distance !== null) {
    attributes.latitude = distance / 111_200;
    attributes.longitude = 0;
  }
  return { state, last_changed: iso(-age), last_updated: iso(-age), attributes };
}

function signal(state, age = 0) {
  return { state, last_changed: iso(-age), last_updated: iso(-age), attributes: {} };
}

function peopleInput({ source = "gabriel", state = "home", previous = "not_home", distance = 20, age = 0, event = "context_snapshot", cycle } = {}) {
  const home = entity("home", 20);
  const selected = entity(state, distance, age);
  return { payload: {
    event, source, trigger_state: state, trigger_prev_state: previous, refresh_cycle_id: cycle,
    gabriel: source === "gabriel" ? selected : home,
    gabriel_icloud: source === "gabriel" ? selected : home,
    valeria: source === "valeria" ? selected : home,
    valeria_icloud: source === "valeria" ? selected : home,
  } };
}

function cretaInput({ state = "home", previous = "not_home", distance = 20, locationAge = 0, engine = "off", engineAge = 0, lock = "locked", lockAge = 0, event = "context_snapshot", cycle } = {}) {
  return { payload: {
    event, source: "creta", trigger_state: state, trigger_prev_state: previous, refresh_cycle_id: cycle,
    creta: entity(state, distance, locationAge), creta_engine: signal(engine, engineAge), creta_lock: signal(lock, lockAge),
  } };
}

function arrival(source = "gabriel", stage = "approach", eventAt = NOW) {
  return { payload: { contract: "security.arrival.v1", kind: "arrival", source, arriving: [source], arrival_source_type: source === "creta" ? "creta" : "person", arrival_stage: stage, event_at: eventAt } };
}

function lifecycle(overrides = {}) {
  return { version: 1, active_by_arrival: true, on_since: NOW - 60_000, force_off_at: NOW + 14 * 60_000, updated_at: NOW - 60_000, ...overrides };
}

function readyFlow(extra = {}) {
  return memoryFlow({
    people_context_v1: { ready: true, updated_at: NOW, gabriel: { current_home: true, primary_home: true }, valeria: { current_home: true, primary_home: true } },
    creta_context_v1: { ready: true, updated_at: NOW, home: true, in_use: true },
    sun_ready: true, sun_below_horizon: true, light_reconciled: true, security_light_ready: true,
    security_light_physical_observed_at: NOW,
    security_light_physical_state: "on", security_light_lifecycle_v1: lifecycle(),
    ...extra,
  });
}

const passed = [];
function scenario(name, callback) {
  callback();
  passed.push(name);
}

scenario("01 restart com todos em casa e refletor desligado", () => {
  const people = run("people_normalize", peopleInput(), memoryFlow())[0].payload.context;
  const creta = run("creta_normalize", cretaInput(), memoryFlow())[0].payload.context;
  const flow = memoryFlow({ people_context_v1: people, creta_context_v1: creta, sun_ready: true });
  assert.equal(run("light_reconcile", { payload: { kind: "light_physical", state: "off" } }, flow), null);
  assert.equal(flow.get("security_light_ready"), true);
});

scenario("02 restart durante viagem", () => {
  const flow = memoryFlow({ security_creta_recovery_v1: { version: 1, in_use: true, trip_active: true, last_confirmed_at: NOW - 60_000 } });
  const result = run("creta_normalize", cretaInput({ state: "not_home", distance: 5_000, engineAge: 10 * 60_000 }), flow)[0].payload.context;
  assert.equal(result.in_use, true);
  assert.equal(result.trip_active, true);
});

scenario("03 restart durante aproximação", () => {
  const flow = memoryFlow({ security_people_recovery_v1: { version: 1, arrival_armed: { gabriel: true } } });
  const result = run("people_normalize", peopleInput({ event: "location_update", state: "chegando", distance: 1_400 }), flow);
  assert.equal(result[1].payload.arrival_stage, "approach");
});

scenario("04 restart dentro do anel de 1500 m", () => {
  const result = run("creta_normalize", cretaInput({ event: "location_update", state: "chegando", distance: 1_400, engine: "on" }), memoryFlow());
  assert.equal(result[1].payload.request_creta_wake, true);
});

scenario("05 restart após chegada", () => {
  const flow = readyFlow();
  const recovered = run("light_reconcile", { payload: { kind: "light_physical", state: "on" } }, flow);
  assert(recovered[0].some((msg) => msg.payload.deadline_type === "backstop"));
});

scenario("06 restart durante cooldown de 5 minutos", () => {
  const flow = memoryFlow({ security_light_lifecycle_v1: lifecycle({ active_by_arrival: false, cooldown_until: NOW + 120_000 }) });
  assert.equal(run("light_check_creta_in_use", { payload: { creta_in_use: true } }, flow), null);
});

scenario("07 restart durante carência de 90 segundos", () => {
  const flow = readyFlow({ security_light_lifecycle_v1: lifecycle({ pending_off_at: NOW + 30_000, pending_off_source: "gabriel" }) });
  const recovered = run("light_reconcile", { payload: { kind: "light_physical", state: "on" } }, flow)[0];
  assert.equal(recovered.find((msg) => msg.payload.deadline_type === "pending_off").delay, 30_000);
});

scenario("08 restart durante timeout de 15 minutos", () => {
  const flow = readyFlow({ security_light_lifecycle_v1: lifecycle({ force_off_at: NOW + 120_000 }) });
  const recovered = run("light_reconcile", { payload: { kind: "light_physical", state: "on" } }, flow)[0];
  assert.equal(recovered.find((msg) => msg.payload.deadline_type === "backstop").delay, 120_000);
});

scenario("09 restart com refletor ligado pela automação", () => {
  const flow = readyFlow();
  run("light_reconcile", { payload: { kind: "light_physical", state: "on" } }, flow);
  assert.equal(flow.get("security_light_lifecycle_v1").active_by_arrival, true);
});

scenario("10 restart com refletor ligado manualmente", () => {
  const flow = readyFlow({ security_light_lifecycle_v1: { version: 1, active_by_arrival: false, updated_at: NOW } });
  assert.equal(run("light_reconcile", { payload: { kind: "light_physical", state: "on" } }, flow), null);
  assert.equal(flow.get("security_light_physical_state"), "on");
});

scenario("11 refletor OFF e contexto persistido ON", () => {
  const flow = readyFlow();
  run("light_reconcile", { payload: { kind: "light_physical", state: "off" } }, flow);
  assert.equal(flow.get("security_light_lifecycle_v1").active_by_arrival, false);
  assert.equal(flow.get("security_light_lifecycle_v1").cooldown_until, NOW + 5 * 60_000);
});

scenario("12 restart com Creta stale", () => {
  const output = run("creta_normalize", cretaInput({ event: "location_update", state: "chegando", distance: 1_400, locationAge: 31 * 60_000, engineAge: 10 * 60_000 }), memoryFlow());
  assert.equal(output[0].payload.context.ready, false);
  assert.equal(output[0].payload.context.in_use, null);
  assert.equal(output[1], null);
});

scenario("13 restart com iPhone Gabriel stale", () => {
  const output = run("people_normalize", peopleInput({ source: "gabriel", event: "location_update", state: "chegando", distance: 1_400, age: 16 * 60_000 }), memoryFlow());
  assert.equal(output[0].payload.context.gabriel.stale, true);
  assert.equal(output[0].payload.context.ready, false);
  assert.equal(output[1], null);
});

scenario("14 restart com iPhone Valéria stale", () => {
  const output = run("people_normalize", peopleInput({ source: "valeria", event: "location_update", state: "chegando", distance: 1_400, age: 16 * 60_000 }), memoryFlow());
  assert.equal(output[0].payload.context.valeria.stale, true);
  assert.equal(output[0].payload.context.ready, false);
  assert.equal(output[1], null);
  assert.equal(output[2], null);
});

scenario("15 restart com HA indisponível", () => {
  const flow = memoryFlow({ people_context_v1: { ready: false }, creta_context_v1: { ready: false }, sun_ready: false });
  run("light_reconcile", { payload: { kind: "light_physical", state: "unavailable" } }, flow);
  assert.equal(flow.get("security_light_ready"), false);
  assert.equal(flow.get("light_reconciled"), false);
});

scenario("16 HA recuperando após Node-RED", () => {
  const flow = readyFlow({ light_reconciled: false });
  run("light_reconcile", { payload: { kind: "light_physical", state: "off" } }, flow);
  assert.equal(flow.get("security_light_ready"), true);
});

scenario("17 Node-RED recuperando após HA", () => {
  const flow = readyFlow({ security_light_lifecycle_v1: { version: 1, active_by_arrival: false, updated_at: NOW } });
  run("light_reconcile", { payload: { kind: "light_physical", state: "off", source: "startup_query" } }, flow);
  assert.equal(flow.get("light_reconciled"), true);
});

scenario("18 snapshots chegando fora de ordem", () => {
  const flow = memoryFlow({ people_context_v1: { updated_at: NOW, anyone_away: false } });
  run("context_coordinator", { payload: { kind: "people_context", updated_at: NOW - 1_000, context: { updated_at: NOW - 1_000, anyone_away: true } } }, flow);
  assert.equal(flow.get("people_context_v1").anyone_away, false);
  const light = readyFlow({ security_light_lifecycle_v1: { version: 1, active_by_arrival: false, updated_at: NOW } });
  run("light_reconcile", { payload: { kind: "light_physical", state: "on", updated_at: NOW } }, light);
  run("light_reconcile", { payload: { kind: "light_physical", state: "off", updated_at: NOW - 1_000 } }, light);
  assert.equal(light.get("security_light_physical_state"), "on");
});

scenario("19 snapshot persistido mais novo que entidade stale", () => {
  const flow = memoryFlow({ security_creta_recovery_v1: { version: 1, in_use: true, trip_active: true, last_confirmed_at: NOW - 60_000 } });
  const result = run("creta_normalize", cretaInput({ state: "not_home", distance: 5_000, locationAge: 31 * 60_000, engineAge: 10 * 60_000 }), flow)[0].payload.context;
  assert.equal(result.in_use, null);
  assert.equal(flow.get("security_creta_recovery_v1").in_use, true);
});

scenario("20 entidade atual mais nova que snapshot persistido", () => {
  const flow = memoryFlow({ security_creta_recovery_v1: { version: 1, in_use: false, last_confirmed_at: NOW - 60_000 } });
  const result = run("creta_normalize", cretaInput({ state: "not_home", distance: 5_000, engine: "on" }), flow)[0].payload.context;
  assert.equal(result.in_use, true);
  assert.equal(flow.get("security_creta_recovery_v1").in_use, true);
});

scenario("21 duas reinicializações em sequência", () => {
  const flow = readyFlow();
  assert(run("light_reconcile", { payload: { kind: "light_physical", state: "on" } }, flow));
  assert.equal(run("light_reconcile", { payload: { kind: "light_physical", state: "on" } }, flow), null);
});

scenario("22 restart durante retry do Creta", () => {
  const flow = memoryFlow({ creta_context_v1: { away: true }, security_creta_refresh_v1: { attempts: 2, next_allowed_at: NOW + 60_000, last_success_at: 0 } });
  assert.equal(run("creta_refresh_decide", { payload: { kind: "refresh_command", anyone_away: true } }, flow), null);
});

scenario("23 restart após início da condição antes dos 90 s", () => {
  const flow = readyFlow({ security_light_lifecycle_v1: lifecycle({ pending_off_at: NOW + 45_000, pending_off_source: "gabriel" }) });
  const messages = run("light_reconcile", { payload: { kind: "light_physical", state: "on" } }, flow)[0];
  assert.equal(messages.find((msg) => msg.payload.deadline_type === "pending_off").delay, 45_000);
});

scenario("24 restart após os 90 segundos expirarem", () => {
  const flow = readyFlow({ security_light_lifecycle_v1: lifecycle({ pending_off_at: NOW - 1_000, pending_off_source: "gabriel" }) });
  const messages = run("light_reconcile", { payload: { kind: "light_physical", state: "on" } }, flow)[0];
  assert.equal(messages.find((msg) => msg.payload.deadline_type === "pending_off").delay, 0);
});

scenario("25 restart após os 15 minutos expirarem", () => {
  const flow = readyFlow({ security_light_lifecycle_v1: lifecycle({ on_since: NOW - 16 * 60_000, force_off_at: NOW - 60_000, updated_at: NOW - 60_000 }) });
  const messages = run("light_reconcile", { payload: { kind: "light_physical", state: "on" } }, flow)[0];
  assert.equal(messages.find((msg) => msg.payload.deadline_type === "backstop").delay, 0);
});

scenario("26 restart dentro da janela de supressão", () => {
  const flow = memoryFlow({ security_light_lifecycle_v1: { version: 1, active_by_arrival: false, cooldown_until: NOW + 10_000, updated_at: NOW } });
  assert.equal(run("light_check_creta_in_use", { payload: { creta_in_use: true } }, flow), null);
});

scenario("27 refletor unknown no startup", () => {
  const flow = readyFlow();
  assert.equal(run("light_reconcile", { payload: { kind: "light_physical", state: "unknown" } }, flow), null);
  assert.equal(flow.get("light_reconciled"), false);
});

scenario("28 Creta unknown no startup", () => {
  const flow = memoryFlow({ security_creta_recovery_v1: { version: 1, in_use: true } });
  const result = run("creta_normalize", cretaInput({ state: "unknown", distance: null, engine: "unknown", lock: "unknown" }), flow)[0].payload.context;
  assert.equal(result.ready, false);
  assert.equal(result.in_use, null);
});

scenario("29 chegada recebida antes de readiness completo", () => {
  assert.equal(run("light_prepare_arrival", arrival(), memoryFlow()), null);
});

scenario("30 snapshots duplicados no startup", () => {
  const flow = memoryFlow();
  const request = run("context_coordinator", { payload: { kind: "refresh_tick" } }, flow)[0];
  const cycle = request.payload.refresh_cycle_id;
  run("context_coordinator", { payload: { kind: "people_context", ready: true, refresh_cycle_id: cycle, context: { ready: true } } }, flow);
  const first = run("context_coordinator", { payload: { kind: "creta_context", ready: true, refresh_cycle_id: cycle, context: { ready: true } } }, flow);
  const duplicate = run("context_coordinator", { payload: { kind: "creta_context", ready: true, refresh_cycle_id: cycle, context: { ready: true } } }, flow);
  assert(first[1]);
  assert.equal(duplicate, null);
});

scenario("31 snapshot antigo chegando após snapshot novo", () => {
  const flow = memoryFlow();
  run("light_merge_context", { payload: { kind: "creta_context", updated_at: NOW, context: { updated_at: NOW, ready: true, in_use: true } } }, flow);
  run("light_merge_context", { payload: { kind: "creta_context", updated_at: NOW - 1, context: { updated_at: NOW - 1, ready: true, in_use: false } } }, flow);
  assert.equal(flow.get("creta_context_v1").in_use, true);
});

scenario("32 retry repetido de Bluelink", () => {
  const flow = memoryFlow({ creta_context_v1: { away: true } });
  run("creta_refresh_decide", { payload: { kind: "refresh_command", anyone_away: true } }, flow);
  const state = flow.get("security_creta_refresh_v1");
  assert.equal(state.attempts, 1);
  assert.equal(state.next_allowed_at, NOW + 60_000);
});

scenario("33 recuperação posterior do Bluelink", () => {
  const flow = memoryFlow({ security_creta_refresh_v1: { attempts: 4, next_allowed_at: NOW } });
  run("creta_refresh_ack", { payload: {} }, flow);
  assert.equal(flow.get("security_creta_refresh_v1").attempts, 0);
});

scenario("34 viagem ativa com motor stale off", () => {
  const flow = memoryFlow({ security_creta_recovery_v1: { version: 1, in_use: true, trip_active: true, last_confirmed_at: NOW - 60_000 } });
  const result = run("creta_normalize", cretaInput({ state: "not_home", distance: 10_000, engine: "off", engineAge: 10 * 60_000 }), flow)[0].payload.context;
  assert.equal(result.in_use_reason, "persisted_trip_revalidated_by_fresh_away_location");
});

scenario("35 viagem terminando durante restart", () => {
  const flow = memoryFlow({ security_creta_recovery_v1: { version: 1, in_use: true, trip_active: true, last_confirmed_at: NOW - 60_000 } });
  const result = run("creta_normalize", cretaInput({ state: "home", distance: 20, engine: "off", lock: "unlocked" }), flow)[0].payload.context;
  assert.equal(result.in_use, false);
  assert.equal(result.trip_active, false);
});

scenario("36 evento de chegada duplicado após restart", () => {
  const flow = memoryFlow({ security_people_recovery_v1: { version: 1, arrival_armed: { gabriel: true } } });
  const input = peopleInput({ event: "location_update", state: "chegando", distance: 1_400 });
  assert(run("people_normalize", structuredClone(input), flow)[1]);
  assert.equal(run("people_normalize", structuredClone(input), flow)[1], null);
});

scenario("37 aviso da Valéria duplicado após restart", () => {
  const firstFlow = memoryFlow({ security_people_recovery_v1: { version: 1, arrival_armed: { valeria: true } } });
  const input = peopleInput({ source: "valeria", event: "location_update", state: "chegando", distance: 1_400 });
  assert(run("people_normalize", structuredClone(input), firstFlow)[2]);
  const restartFlow = memoryFlow({ security_people_recovery_v1: structuredClone(firstFlow.get("security_people_recovery_v1")) });
  assert.equal(run("people_normalize", structuredClone(input), restartFlow)[2], null);
});

scenario("38 condição de desligamento desaparece durante 90 s", () => {
  const flow = readyFlow({
    people_context_v1: { ready: true, gabriel: { current_home: false } },
    security_light_lifecycle_v1: lifecycle({ pending_off_at: NOW - 1, pending_off_source: "gabriel" }),
  });
  assert.equal(run("light_turn_off_if_active", { payload: { deadline_type: "pending_off" } }, flow), null);
  assert.equal(flow.get("security_light_lifecycle_v1").pending_off_at, null);
});

scenario("39 timeout expirou enquanto Node-RED estava offline", () => {
  const flow = readyFlow({ security_light_lifecycle_v1: lifecycle({ force_off_at: NOW - 1 }) });
  assert(run("light_turn_off_if_active", { payload: { deadline_type: "backstop" } }, flow));
  assert.equal(flow.get("security_light_lifecycle_v1").active_by_arrival, false);
});

scenario("40 cooldown expirou enquanto Node-RED estava offline", () => {
  const flow = readyFlow({ security_light_lifecycle_v1: { version: 1, active_by_arrival: false, cooldown_until: NOW - 1, updated_at: NOW } });
  run("light_reconcile", { payload: { kind: "light_physical", state: "off" } }, flow);
  assert.equal(flow.get("security_light_lifecycle_v1").cooldown_until, null);
  const corrupt = readyFlow({ security_light_lifecycle_v1: { version: 1, active_by_arrival: false, cooldown_until: "corrupt", updated_at: NOW } });
  run("light_reconcile", { payload: { kind: "light_physical", state: "off" } }, corrupt);
  assert.equal(corrupt.get("security_light_lifecycle_v1").cooldown_until, null);
});

Date.now = originalNow;
assert.equal(passed.length, 40);
console.log(`security recovery replay: ${passed.length} cenarios OK`);
for (const name of passed) console.log(name);
