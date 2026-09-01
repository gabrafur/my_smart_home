import assert from "node:assert/strict";
import fs from "node:fs";

const flows = JSON.parse(fs.readFileSync(new URL("../flows.json", import.meta.url), "utf8"));
const byId = new Map(flows.map((item) => [item.id, item]));
const aliasesByName = {
  people_normalize: "Normalizar pessoas e detectar transições",
  vehicle_primary_normalize: "Normalizar vehicle_primary e detectar transições",
  vehicle_primary_refresh_decide: "Coordenar refresh do vehicle_primary",
  context_coordinator: "Coordenar snapshot e refresh",
  light_merge_context: "Atualizar contexto de alto nível",
  light_prepare_arrival: "Montar decisão de acendimento",
  light_check_vehicle_primary_in_use: "vehicle_primary está em uso?",
  light_turn_off_if_active: "Desativar somente se foi ligado por chegada",
  light_reconcile: "Revalidar lifecycle e estado físico",
};
for (const [alias, name] of Object.entries(aliasesByName)) {
  const node = flows.find((item) => item.name === name);
  assert(node, `node ausente pelo nome: ${name}`);
  byId.set(alias, node);
}
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

function peopleInput({ source = "resident_primary", state = "home", previous = "not_home", distance = 20, age = 0, event = "context_snapshot", cycle } = {}) {
  const home = entity("home", 20);
  const selected = entity(state, distance, age);
  return { payload: {
    event, source, trigger_state: state, trigger_prev_state: previous, refresh_cycle_id: cycle,
    resident_primary: source === "resident_primary" ? selected : home,
    resident_primary_icloud: source === "resident_primary" ? selected : home,
    resident_secondary: source === "resident_secondary" ? selected : home,
    resident_secondary_icloud: source === "resident_secondary" ? selected : home,
  } };
}

function vehicle_primaryInput({ state = "home", previous = "not_home", distance = 20, locationAge = 0, telemetryAge = locationAge, engine = "off", engineAge = 0, lock = "locked", lockAge = 0, event = "context_snapshot", cycle } = {}) {
  return { payload: {
    event, source: "vehicle_primary", trigger_state: state, trigger_prev_state: previous, refresh_cycle_id: cycle,
    vehicle_primary: entity(state, distance, locationAge), vehicle_primary_engine: signal(engine, engineAge), vehicle_primary_lock: signal(lock, lockAge),
    vehicle_primary_last_updated: signal(iso(-telemetryAge)),
  } };
}

function arrival(source = "resident_primary", stage = "approach", eventAt = NOW) {
  return { payload: { contract: "security.arrival.v1", kind: "arrival", source, arriving: [source], arrival_source_type: source === "vehicle_primary" ? "vehicle_primary" : "person", arrival_stage: stage, event_at: eventAt } };
}

function lifecycle(overrides = {}) {
  return { version: 1, active_by_arrival: true, on_since: NOW - 60_000, force_off_at: NOW + 14 * 60_000, updated_at: NOW - 60_000, ...overrides };
}

function readyFlow(extra = {}) {
  return memoryFlow({
    people_context_v1: { ready: true, updated_at: NOW, resident_primary: { current_home: true, primary_home: true }, resident_secondary: { current_home: true, primary_home: true } },
    vehicle_primary_context_v1: { ready: true, updated_at: NOW, home: true, in_use: true },
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
  const vehicle_primary = run("vehicle_primary_normalize", vehicle_primaryInput(), memoryFlow())[0].payload.context;
  const flow = memoryFlow({ people_context_v1: people, vehicle_primary_context_v1: vehicle_primary, sun_ready: true });
  assert.equal(run("light_reconcile", { payload: { kind: "light_physical", state: "off" } }, flow), null);
  assert.equal(flow.get("security_light_ready"), true);
});

scenario("02 restart durante viagem", () => {
  const flow = memoryFlow({ security_vehicle_primary_recovery_v1: { version: 1, in_use: true, trip_active: true, last_confirmed_at: NOW - 60_000 } });
  const result = run("vehicle_primary_normalize", vehicle_primaryInput({ state: "not_home", distance: 5_000, engineAge: 10 * 60_000 }), flow)[0].payload.context;
  assert.equal(result.in_use, true);
  assert.equal(result.trip_active, true);
});

scenario("03 restart durante aproximação", () => {
  const flow = memoryFlow({ security_people_recovery_v1: { version: 1, arrival_armed: { resident_primary: true } } });
  const result = run("people_normalize", peopleInput({ event: "location_update", state: "chegando", distance: 1_400 }), flow);
  assert.equal(result[1].payload.arrival_stage, "approach");
});

scenario("04 restart dentro do anel de 1500 m", () => {
  const result = run("vehicle_primary_normalize", vehicle_primaryInput({ event: "location_update", state: "chegando", distance: 1_400, engine: "on" }), memoryFlow());
  assert.equal(result[1].payload.request_vehicle_primary_wake, true);
});

scenario("05 restart após chegada", () => {
  const flow = readyFlow();
  const recovered = run("light_reconcile", { payload: { kind: "light_physical", state: "on" } }, flow);
  assert(recovered[0].some((msg) => msg.payload.deadline_type === "backstop"));
});

scenario("06 restart durante cooldown de 5 minutos", () => {
  const flow = memoryFlow({ security_light_lifecycle_v1: lifecycle({ active_by_arrival: false, cooldown_until: NOW + 120_000 }) });
  assert.equal(run("light_check_vehicle_primary_in_use", { payload: { vehicle_primary_in_use: true } }, flow), null);
});

scenario("07 restart durante carência de 90 segundos", () => {
  const flow = readyFlow({ security_light_lifecycle_v1: lifecycle({ pending_off_at: NOW + 30_000, pending_off_source: "resident_primary" }) });
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

scenario("12 restart com vehicle_primary stale", () => {
  const output = run("vehicle_primary_normalize", vehicle_primaryInput({ event: "location_update", state: "chegando", distance: 1_400, locationAge: 31 * 60_000, engineAge: 10 * 60_000 }), memoryFlow());
  assert.equal(output[0].payload.context.ready, false);
  assert.equal(output[0].payload.context.in_use, null);
  assert.equal(output[1], null);
});

scenario("13 restart com iPhone resident_primary stale", () => {
  const output = run("people_normalize", peopleInput({ source: "resident_primary", event: "location_update", state: "chegando", distance: 1_400, age: 16 * 60_000 }), memoryFlow());
  assert.equal(output[0].payload.context.resident_primary.stale, true);
  assert.equal(output[0].payload.context.ready, false);
  assert.equal(output[1], null);
});

scenario("14 restart com iPhone resident_secondary stale", () => {
  const output = run("people_normalize", peopleInput({ source: "resident_secondary", event: "location_update", state: "chegando", distance: 1_400, age: 16 * 60_000 }), memoryFlow());
  assert.equal(output[0].payload.context.resident_secondary.stale, true);
  assert.equal(output[0].payload.context.ready, false);
  assert.equal(output[1], null);
});

scenario("15 restart com HA indisponível", () => {
  const flow = memoryFlow({ people_context_v1: { ready: false }, vehicle_primary_context_v1: { ready: false }, sun_ready: false });
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
  const flow = memoryFlow({ security_vehicle_primary_recovery_v1: { version: 1, in_use: true, trip_active: true, last_confirmed_at: NOW - 60_000 } });
  const result = run("vehicle_primary_normalize", vehicle_primaryInput({ state: "not_home", distance: 5_000, locationAge: 31 * 60_000, engineAge: 10 * 60_000 }), flow)[0].payload.context;
  assert.equal(result.in_use, null);
  assert.equal(flow.get("security_vehicle_primary_recovery_v1").in_use, true);
});

scenario("20 entidade atual mais nova que snapshot persistido", () => {
  const flow = memoryFlow({ security_vehicle_primary_recovery_v1: { version: 1, in_use: false, last_confirmed_at: NOW - 60_000 } });
  const result = run("vehicle_primary_normalize", vehicle_primaryInput({ state: "not_home", distance: 5_000, engine: "on" }), flow)[0].payload.context;
  assert.equal(result.in_use, true);
  assert.equal(flow.get("security_vehicle_primary_recovery_v1").in_use, true);
});

scenario("21 duas reinicializações em sequência", () => {
  const flow = readyFlow();
  assert(run("light_reconcile", { payload: { kind: "light_physical", state: "on" } }, flow));
  assert.equal(run("light_reconcile", { payload: { kind: "light_physical", state: "on" } }, flow), null);
});

scenario("22 restart durante retry do vehicle_primary", () => {
  const flow = memoryFlow({ vehicle_primary_context_v1: { away: true }, security_vehicle_primary_refresh_v1: { attempts: 2, next_allowed_at: NOW + 60_000, last_success_at: 0 } });
  assert.equal(run("vehicle_primary_refresh_decide", { payload: { kind: "refresh_command", anyone_away: true } }, flow), null);
});

scenario("23 restart após início da condição antes dos 90 s", () => {
  const flow = readyFlow({ security_light_lifecycle_v1: lifecycle({ pending_off_at: NOW + 45_000, pending_off_source: "resident_primary" }) });
  const messages = run("light_reconcile", { payload: { kind: "light_physical", state: "on" } }, flow)[0];
  assert.equal(messages.find((msg) => msg.payload.deadline_type === "pending_off").delay, 45_000);
});

scenario("24 restart após os 90 segundos expirarem", () => {
  const flow = readyFlow({ security_light_lifecycle_v1: lifecycle({ pending_off_at: NOW - 1_000, pending_off_source: "resident_primary" }) });
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
  assert.equal(run("light_check_vehicle_primary_in_use", { payload: { vehicle_primary_in_use: true } }, flow), null);
});

scenario("27 refletor unknown no startup", () => {
  const flow = readyFlow();
  assert.equal(run("light_reconcile", { payload: { kind: "light_physical", state: "unknown" } }, flow), null);
  assert.equal(flow.get("light_reconciled"), false);
});

scenario("28 vehicle_primary unknown no startup", () => {
  const flow = memoryFlow({ security_vehicle_primary_recovery_v1: { version: 1, in_use: true } });
  const result = run("vehicle_primary_normalize", vehicle_primaryInput({ state: "unknown", distance: null, engine: "unknown", lock: "unknown" }), flow)[0].payload.context;
  assert.equal(result.ready, false);
  assert.equal(result.in_use, null);
});

scenario("29 chegada recebida antes de readiness completo", () => {
  const [physicalAction, pendingArrival, recovery] = run(
    "light_prepare_arrival",
    arrival(),
    memoryFlow(),
  );
  assert.equal(physicalAction, null);
  assert.equal(pendingArrival.payload.pending_arrival_queued, true);
  assert.equal(recovery.payload.kind, "refresh_tick");
  assert.equal(recovery.payload.require_lighting_ready, true);
});

scenario("30 snapshots duplicados no startup", () => {
  const flow = memoryFlow();
  const request = run("context_coordinator", { payload: { kind: "refresh_tick" } }, flow)[0];
  const cycle = request.payload.refresh_cycle_id;
  run("context_coordinator", { payload: {
    kind: "people_context",
    ready: true,
    refresh_cycle_id: cycle,
    context: {
      ready: true,
      resident_primary: { state: "home" },
      resident_secondary: { state: "chegando" },
    },
  } }, flow);
  const first = run("context_coordinator", { payload: { kind: "vehicle_primary_context", ready: true, refresh_cycle_id: cycle, context: { ready: true } } }, flow);
  const duplicate = run("context_coordinator", { payload: { kind: "vehicle_primary_context", ready: true, refresh_cycle_id: cycle, context: { ready: true } } }, flow);
  assert(first[1]);
  assert.equal(first[1].payload.resident_primary_state, "home");
  assert.equal(first[1].payload.resident_secondary_state, "chegando");
  assert.equal(duplicate, null);
});

scenario("31 snapshot antigo chegando após snapshot novo", () => {
  const flow = memoryFlow();
  run("light_merge_context", { payload: { kind: "vehicle_primary_context", updated_at: NOW, context: { updated_at: NOW, ready: true, in_use: true } } }, flow);
  run("light_merge_context", { payload: { kind: "vehicle_primary_context", updated_at: NOW - 1, context: { updated_at: NOW - 1, ready: true, in_use: false } } }, flow);
  assert.equal(flow.get("vehicle_primary_context_v1").in_use, true);
});

scenario("32 retry repetido de Bluelink", () => {
  const flow = memoryFlow({ vehicle_primary_context_v1: { away: true } });
  run("vehicle_primary_refresh_decide", { payload: { kind: "refresh_command", anyone_away: true } }, flow);
  const state = flow.get("security_vehicle_primary_refresh_v1");
  assert.equal(state.attempts, 1);
  assert.equal(state.next_allowed_at, NOW + 15 * 60_000);
});

scenario("33 recuperação posterior do Bluelink", () => {
  const flow = memoryFlow({
    security_vehicle_primary_refresh_v1: {
      attempts: 4,
      next_allowed_at: NOW,
      last_attempt_at: NOW - 1_000,
      awaiting_evidence: true,
      baseline_observed_at: {
        telemetry: NOW - 2_000,
      },
    },
  });
  run("vehicle_primary_normalize", vehicle_primaryInput(), flow);
  assert.equal(flow.get("security_vehicle_primary_refresh_v1").attempts, 0);
  assert.equal(flow.get("security_vehicle_primary_refresh_v1").awaiting_evidence, false);
});

scenario("34 viagem ativa com motor stale off", () => {
  const flow = memoryFlow({ security_vehicle_primary_recovery_v1: { version: 1, in_use: true, trip_active: true, last_confirmed_at: NOW - 60_000 } });
  const result = run("vehicle_primary_normalize", vehicle_primaryInput({ state: "not_home", distance: 10_000, engine: "off", engineAge: 10 * 60_000 }), flow)[0].payload.context;
  assert.equal(result.in_use_reason, "persisted_trip_revalidated_by_fresh_away_location");
});

scenario("35 viagem terminando durante restart", () => {
  const flow = memoryFlow({ security_vehicle_primary_recovery_v1: { version: 1, in_use: true, trip_active: true, last_confirmed_at: NOW - 60_000 } });
  const result = run("vehicle_primary_normalize", vehicle_primaryInput({ state: "home", distance: 20, engine: "off", lock: "unlocked" }), flow)[0].payload.context;
  assert.equal(result.in_use, false);
  assert.equal(result.trip_active, false);
});

scenario("36 evento de chegada duplicado após restart", () => {
  const flow = memoryFlow({ security_people_recovery_v1: { version: 1, arrival_armed: { resident_primary: true } } });
  const input = peopleInput({ event: "location_update", state: "chegando", distance: 1_400 });
  assert(run("people_normalize", structuredClone(input), flow)[1]);
  assert.equal(run("people_normalize", structuredClone(input), flow)[1], null);
});

scenario("37 normalizador de pessoas não envia notificações laterais", () => {
  const flow = memoryFlow({ security_people_recovery_v1: { version: 1, arrival_armed: { resident_secondary: true } } });
  const input = peopleInput({ source: "resident_secondary", event: "location_update", state: "chegando", distance: 1_400 });
  const result = run("people_normalize", structuredClone(input), flow);
  assert.equal(result.length, 3);
  assert(result[1]);
  assert.equal(result[2], null);
});

scenario("38 condição de desligamento desaparece durante 90 s", () => {
  const flow = readyFlow({
    people_context_v1: { ready: true, resident_primary: { current_home: false } },
    security_light_lifecycle_v1: lifecycle({ pending_off_at: NOW - 1, pending_off_source: "resident_primary" }),
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

scenario("41 tracker stale perde para localização alternativa atual", () => {
  const mobile = entity("chegando", 231, 3 * 24 * 60 * 60_000, 10);
  mobile.entity_id = "device_tracker.mobile_primary_source_1";
  const icloud = entity("home", 25, 0, 4);
  icloud.entity_id = "device_tracker.mobile_primary_source_2";
  const input = peopleInput({ event: "context_snapshot" });
  input.payload.resident_primary = mobile;
  input.payload.resident_primary_icloud = icloud;

  const context = run("people_normalize", input, memoryFlow())[0].payload.context;
  assert.equal(context.resident_primary.entity_id, icloud.entity_id);
  assert.equal(context.resident_primary.state, "home");
  assert.equal(context.resident_primary.distance_m, 25);
});

scenario("42 trackers quase simultâneos usam a melhor precisão", () => {
  const mobile = entity("chegando", 231, 5_000, 10);
  mobile.entity_id = "device_tracker.mobile_secondary_source_1";
  const icloud = entity("home", 25, 0, 4);
  icloud.entity_id = "device_tracker.mobile_secondary_source_2";
  const input = peopleInput({ event: "context_snapshot" });
  input.payload.resident_secondary = mobile;
  input.payload.resident_secondary_icloud = icloud;

  const context = run("people_normalize", input, memoryFlow())[0].payload.context;
  assert.equal(context.resident_secondary.entity_id, icloud.entity_id);
  assert.equal(context.resident_secondary.state, "home");
});

scenario("43 atualização materialmente mais nova vence precisão menor", () => {
  const mobile = entity("not_home", 2_000, 0, 10);
  mobile.entity_id = "device_tracker.mobile_primary_source_1";
  const icloud = entity("home", 25, 2 * 60_000, 4);
  icloud.entity_id = "device_tracker.mobile_primary_source_2";
  const input = peopleInput({ event: "context_snapshot" });
  input.payload.resident_primary = mobile;
  input.payload.resident_primary_icloud = icloud;

  const context = run("people_normalize", input, memoryFlow())[0].payload.context;
  assert.equal(context.resident_primary.entity_id, mobile.entity_id);
  assert.equal(context.resident_primary.state, "not_home");
});

scenario("44 coordenadas confiáveis vencem tracker impreciso", () => {
  const mobile = entity("chegando", 1_400, 0, 999);
  mobile.entity_id = "device_tracker.mobile_primary_source_1";
  const icloud = entity("home", 25, 0, 10);
  icloud.entity_id = "device_tracker.mobile_primary_source_2";
  const input = peopleInput({ event: "context_snapshot" });
  input.payload.resident_primary = mobile;
  input.payload.resident_primary_icloud = icloud;

  const context = run("people_normalize", input, memoryFlow())[0].payload.context;
  assert.equal(context.resident_primary.entity_id, icloud.entity_id);
  assert.equal(context.resident_primary.location_reliable, true);
});

scenario("45 tracker fora preserva evidência para ciclo de wake", () => {
  const mobile = entity("not_home", 2_000, 30 * 60_000, 40);
  mobile.entity_id = "device_tracker.mobile_secondary_source_1";
  const icloud = entity("home", 25, 0, 5);
  icloud.entity_id = "device_tracker.mobile_secondary_source_2";
  const input = peopleInput({ event: "context_snapshot" });
  input.payload.resident_secondary = mobile;
  input.payload.resident_secondary_icloud = icloud;

  const context = run("people_normalize", input, memoryFlow())[0].payload.context;
  assert.equal(context.resident_secondary.entity_id, icloud.entity_id);
  assert.equal(context.resident_secondary.state, "home");
  assert.equal(context.resident_secondary.any_tracker_away, true);
  assert.equal(context.any_tracker_away, true);
});

Date.now = originalNow;
assert.equal(passed.length, 45);
console.log(`security recovery replay: ${passed.length} cenarios OK`);
for (const name of passed) console.log(name);
