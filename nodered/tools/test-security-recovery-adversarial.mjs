import assert from "node:assert/strict";
import fs from "node:fs";

const flows = JSON.parse(fs.readFileSync(new URL("../flows.json", import.meta.url), "utf8"));
const byId = new Map(flows.map((node) => [node.id, node]));
const aliasesByName = {
  people_normalize: "Normalizar pessoas e detectar transições",
  people_refresh_decide: "Atualizar iPhones agora?",
  vehicle_primary_normalize: "Normalizar vehicle_primary e detectar transições",
  vehicle_primary_refresh_decide: "Coordenar refresh do vehicle_primary",
  vehicle_primary_arrival_actions: "Acordar carro e fechar viagem",
  vehicle_primary_trip_refresh: "Atualizar viagens do dia após chegada",
  vehicle_primary_unlock_event: "Porta destravada por 5 s",
  context_coordinator: "Coordenar snapshot e refresh",
  context_tick: "Reavaliar contextos a cada 30 s",
  light_merge_context: "Atualizar contexto de alto nível",
  light_prepare_arrival: "Montar decisão de acendimento",
  light_check_vehicle_primary_in_use: "vehicle_primary está em uso?",
  light_mark_active: "Marcar refletor ativo por chegada",
  light_evaluate_off: "Alguma condição de desligamento ocorreu?",
  light_turn_off_if_active: "Desativar somente se foi ligado por chegada",
  light_reconcile: "Revalidar lifecycle e estado físico",
  light_auto_off: "Aguardar backstop de 15 min",
  light_check_inactive: "Refletor disponível para acender?",
  light_off_grace: "Respeitar carência de 90 s",
  light_sun_event: "Luminosidade mudou",
  light_timeout: "Solicitar desligamento por timeout",
};
for (const [alias, name] of Object.entries(aliasesByName)) {
  const node = flows.find((item) => item.name === name);
  assert(node, `node ausente pelo nome: ${name}`);
  byId.set(alias, node);
}


function wireNames(alias, output = 0) {
  return (byId.get(alias).wires[output] ?? []).map((id) => byId.get(id)?.name ?? id);
}
const BASE_NOW = Date.parse("2026-08-13T12:00:00.000Z");
let clock = BASE_NOW;
const originalNow = Date.now;
Date.now = () => clock;

function memoryFlow(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    get: (key) => values.get(key),
    set: (key, value) => values.set(key, value),
    values,
  };
}

function run(id, msg, flow = memoryFlow(), diagnostics = []) {
  const target = byId.get(id);
  assert(target, `node ausente: ${id}`);
  assert.equal(target.type, "function", `${id} nao e Function node`);
  const execute = new Function("msg", "node", "context", "flow", "global", "env", "setTimeout", "clearTimeout", target.func);
  const env = { get: (key) => ({ HOME_LAT: "0", HOME_LON: "0", GATE_LAT: "0", GATE_LON: "0" })[key] };
  const node = {
    warn: (text) => diagnostics.push({ level: "warn", text }),
    log: (text) => diagnostics.push({ level: "log", text }),
    error: (text) => diagnostics.push({ level: "error", text }),
    status() {},
  };
  return execute(msg, node, {}, flow, {}, env, setTimeout, clearTimeout);
}

function iso(offset = 0) {
  return new Date(clock + offset).toISOString();
}

function entity(state, distance = 20, offset = 0, accuracy = 10) {
  const attributes = { gps_accuracy: accuracy };
  if (distance !== null) {
    attributes.latitude = distance / 111_200;
    attributes.longitude = 0;
  }
  return { state, last_changed: iso(offset), last_updated: iso(offset), attributes };
}

function signal(state, offset = 0) {
  return { state, last_changed: iso(offset), last_updated: iso(offset), attributes: {} };
}

function peopleInput({ source = "resident_primary", state = "chegando", previous = "not_home", distance = 1_400, offset = 0, event = "location_update" } = {}) {
  const home = entity("home", 20);
  const selected = entity(state, distance, offset);
  return { payload: {
    event, source, trigger_state: state, trigger_prev_state: previous,
    resident_primary: source === "resident_primary" ? selected : home,
    resident_primary_icloud: source === "resident_primary" ? selected : home,
    resident_secondary: source === "resident_secondary" ? selected : home,
    resident_secondary_icloud: source === "resident_secondary" ? selected : home,
  } };
}

function vehicle_primaryInput({ state = "not_home", distance = 5_000, locationOffset = 0, engine = "off", engineOffset = -10 * 60_000, lock = "locked", lockOffset = 0, event = "context_snapshot" } = {}) {
  return { payload: {
    event, source: "vehicle_primary", trigger_state: state, trigger_prev_state: "not_home",
    vehicle_primary: entity(state, distance, locationOffset),
    vehicle_primary_engine: signal(engine, engineOffset),
    vehicle_primary_lock: signal(lock, lockOffset),
  } };
}

function lifecycle(overrides = {}) {
  return {
    version: 1,
    active_by_arrival: true,
    on_since: clock - 60_000,
    force_off_at: clock + 14 * 60_000,
    updated_at: clock - 60_000,
    ...overrides,
  };
}

function readyLight(overrides = {}) {
  return memoryFlow({
    people_context_v1: { ready: true, updated_at: clock, resident_primary: { current_home: true } },
    vehicle_primary_context_v1: { ready: true, lighting_ready: true, engine_on: true, engine_state_valid: true, updated_at: clock, home: true, in_use: true },
    sun_ready: true,
    sun_below_horizon: true,
    light_reconciled: true,
    security_light_ready: true,
    security_light_physical_state: "on",
    security_light_physical_observed_at: clock,
    security_light_lifecycle_v1: lifecycle(),
    ...overrides,
  });
}

const passed = [];
function scenario(name, callback) {
  clock = BASE_NOW;
  callback();
  passed.push(name);
}

scenario("01 timestamp uma hora no futuro fica stale e nao gera chegada", () => {
  const output = run("people_normalize", peopleInput({ offset: 60 * 60_000 }), memoryFlow());
  assert.equal(output[0].payload.context.ready, false);
  assert.equal(output[1], null);
});

scenario("02 timestamp muito antigo nao revalida viagem", () => {
  const flow = memoryFlow({ security_vehicle_primary_recovery_v1: { version: 1, in_use: true, trip_active: true, last_confirmed_at: clock - 60_000 } });
  const output = run("vehicle_primary_normalize", vehicle_primaryInput({ locationOffset: -31 * 60_000 }), flow);
  assert.equal(output[0].payload.context.in_use, null);
  assert.equal(output[0].payload.context.trip_active, false);
});

scenario("03 persistencia parcialmente corrompida falha sem side effect", () => {
  const diagnostics = [];
  const flow = readyLight({ security_light_lifecycle_v1: { version: 1, active_by_arrival: true, updated_at: "broken" } });
  assert.equal(run("light_reconcile", { payload: { kind: "light_physical", state: "on", updated_at: clock } }, flow, diagnostics), null);
  assert.equal(flow.get("security_light_lifecycle_v1").active_by_arrival, false);
  assert(diagnostics.some(({ text }) => text.includes("descartado")));
});

scenario("04 estado v1 com campo ausente permanece pendente", () => {
  const flow = memoryFlow({ security_vehicle_primary_recovery_v1: { version: 1, arrival_armed: true } });
  const context = run("vehicle_primary_normalize", vehicle_primaryInput(), flow)[0].payload.context;
  assert.equal(context.in_use, null);
  assert.equal(context.ready, false);
});

scenario("05 tipo errado em ownership nao autoriza desligamento", () => {
  const flow = readyLight({ security_light_lifecycle_v1: lifecycle({ active_by_arrival: "true" }) });
  assert.equal(run("light_reconcile", { payload: { kind: "light_physical", state: "on", updated_at: clock } }, flow), null);
  assert.equal(flow.get("security_light_lifecycle_v1").active_by_arrival, false);
});

scenario("06 vehicle_primary_in_use string false nao vira boolean false", () => {
  const flow = memoryFlow({ security_vehicle_primary_recovery_v1: { version: 1, in_use: "false", trip_active: true, last_confirmed_at: clock - 60_000 } });
  const context = run("vehicle_primary_normalize", vehicle_primaryInput(), flow)[0].payload.context;
  assert.equal(context.in_use, null);
  assert.equal(flow.get("security_vehicle_primary_recovery_v1").in_use, undefined);
});

scenario("07 deadline negativo e descartado sem desligar", () => {
  const diagnostics = [];
  const flow = readyLight({ security_light_lifecycle_v1: lifecycle({ pending_off_at: -1, pending_off_source: "resident_primary" }) });
  const output = run("light_reconcile", { payload: { kind: "light_physical", state: "on", updated_at: clock } }, flow, diagnostics);
  assert(output[0].every((message) => message.payload.deadline_type !== "pending_off"));
  assert.equal(flow.get("security_light_lifecycle_v1").pending_off_at, null);
});

scenario("08 deadline extremamente futuro remove ownership", () => {
  const flow = readyLight({ security_light_lifecycle_v1: lifecycle({ force_off_at: clock + 24 * 60 * 60_000 }) });
  assert.equal(run("light_reconcile", { payload: { kind: "light_physical", state: "on", updated_at: clock } }, flow), null);
  assert.equal(flow.get("security_light_lifecycle_v1").active_by_arrival, false);
});

scenario("09 mesmo timestamp aceita a interpretação derivada mais recente", () => {
  const first = { ready: true, updated_at: 200, in_use: true };
  const flow = memoryFlow({ vehicle_primary_context_v1: first });
  run("context_coordinator", { payload: { kind: "vehicle_primary_context", updated_at: 200, ready: true, context: { ready: true, updated_at: 200, in_use: false } } }, flow);
  assert.equal(flow.get("vehicle_primary_context_v1").in_use, false);
});

scenario("10 state de versao anterior e descartado conservadoramente", () => {
  const flow = memoryFlow({ security_vehicle_primary_recovery_v1: { version: 0, in_use: true, trip_active: true, last_confirmed_at: clock } });
  const context = run("vehicle_primary_normalize", vehicle_primaryInput(), flow)[0].payload.context;
  assert.equal(context.in_use, null);
  assert.equal(context.trip_active, false);
});

scenario("11 deadline recuperado bloqueado pode ser reagendado", () => {
  const deadline = clock - 1;
  const flow = readyLight({
    security_light_lifecycle_v1: lifecycle({ force_off_at: deadline }),
    security_light_physical_observed_at: clock - 3 * 60_000,
    security_light_recovery_scheduled: { backstop: deadline },
  });
  assert.equal(run("light_turn_off_if_active", { payload: { deadline_type: "backstop", recovered: true } }, flow), null);
  assert.equal(flow.get("security_light_recovery_scheduled").backstop, undefined);
  const recovered = run("light_reconcile", { payload: { kind: "light_physical", state: "on", updated_at: clock } }, flow);
  assert.equal(recovered[0][0].payload.deadline_type, "backstop");
  assert.equal(recovered[0][0].delay, 0);
});

scenario("12 dedupe do refletor so e gravado depois dos gates", () => {
  const flow = readyLight({
    security_light_physical_state: "off",
    security_light_lifecycle_v1: { version: 1, active_by_arrival: false, updated_at: clock },
  });
  const arrival = { payload: { kind: "arrival", source: "resident_primary", arrival_stage: "approach", event_at: clock } };
  const prepared = run("light_prepare_arrival", structuredClone(arrival), flow)[0];
  assert.equal(flow.get("security_light_lifecycle_v1").last_arrival_key, undefined);
  const action = run("light_mark_active", prepared, flow);
  assert(action);
  assert.equal(run("light_mark_active", structuredClone(prepared), flow), null);
});

scenario("13 snapshot mais novo ready false prevalece por seguranca", () => {
  const flow = memoryFlow({ people_context_v1: { ready: true, updated_at: 200, anyone_away: false } });
  run("context_coordinator", { payload: { kind: "people_context", updated_at: 210, ready: false, context: { ready: false, updated_at: 210, anyone_away: null } } }, flow);
  assert.equal(flow.get("people_context_v1").ready, false);
  assert.equal(flow.get("people_context_v1").anyone_away, null);
});

scenario("14 aviso da resident_secondary aguarda vehicle_primary e sai uma unica vez", () => {
  const flow = memoryFlow();
  const candidate = { payload: { kind: "resident_secondary_approach_notification", notification_key: "resident_secondary:chegando:200", event_at: 200 } };
  assert.equal(run("context_coordinator", structuredClone(candidate), flow), null);
  assert(flow.get("security_pending_resident_secondary_notification_v1"));
  const released = run("context_coordinator", { payload: { kind: "vehicle_primary_context", updated_at: 210, ready: true, context: { ready: true, updated_at: 210, arrival_armed: true, distance_home_m: 1_000 } } }, flow);
  assert.equal(released[2].payload.by_car, true);
  assert.equal(flow.get("security_pending_resident_secondary_notification_v1"), null);
  assert.equal(run("context_coordinator", { payload: { kind: "vehicle_primary_context", updated_at: 211, ready: true, context: { ready: true, updated_at: 211 } } }, flow), null);
});

scenario("15 backoff Bluelink segue 1 2 4 8 15 minutos", () => {
  const flow = memoryFlow({ vehicle_primary_context_v1: { away: true } });
  const expectedMinutes = [1, 2, 4, 8, 15];
  for (const minutes of expectedMinutes) {
    const output = run("vehicle_primary_refresh_decide", { payload: { kind: "refresh_command", anyone_away: true } }, flow);
    assert(output);
    const state = flow.get("security_vehicle_primary_refresh_v1");
    assert.equal(state.next_allowed_at - clock, minutes * 60_000);
    clock = state.next_allowed_at;
  }
  const state = flow.get("security_vehicle_primary_refresh_v1");
  assert.equal(state.attempts, 5);
});

scenario("16 side effects criticos estao ligados aos gates corretos", () => {
  assert.deepEqual(wireNames("light_mark_active"), ["Ligar refletor do portão", "Aguardar backstop de 15 min", "Avisar moradores: refletor ligado"]);
  assert.deepEqual(wireNames("light_turn_off_if_active"), ["Desligar refletor do portão"]);
  assert.deepEqual(wireNames("vehicle_primary_arrival_actions", 0), ["Forçar refresh do vehicle_primary"]);
  assert.deepEqual(wireNames("vehicle_primary_arrival_actions", 1), ["Atualizar viagens do dia após chegada"]);
  assert.deepEqual(wireNames("vehicle_primary_refresh_decide"), ["Forçar refresh do vehicle_primary", "Atualizar entidades do vehicle_primary"]);
  assert.deepEqual(wireNames("context_coordinator", 2), ["Avisar resident_primary: resident_secondary se aproxima"]);
});

scenario("17 store nomeado nao muda o default global", () => {
  const settings = fs.readFileSync(new URL("../settings.js", import.meta.url), "utf8");
  assert.match(settings, /default:\s*"memoryOnly"/);
  assert.match(settings, /persistent:\s*\{[\s\S]*module:\s*"localfilesystem"/);
  assert.match(settings, /dir:\s*__dirname/);
  assert.match(settings, /base:\s*"context"/);
  assert.match(settings, /flushInterval:\s*30/);
});

scenario("18 readiness parcial bloqueia ligar e desligar", () => {
  const pending = readyLight({ people_context_v1: { ready: false, updated_at: clock }, security_light_physical_state: "off" });
  const arrival = { payload: { kind: "arrival", source: "resident_primary", arrival_stage: "approach", event_at: clock, arrival_key: `resident_primary:approach:${clock}` } };
  assert.equal(run("light_mark_active", arrival, pending), null);
  const active = readyLight({
    people_context_v1: { ready: false, updated_at: clock },
    security_light_lifecycle_v1: lifecycle({ on_since: clock - 15 * 60_000, force_off_at: clock - 1 }),
  });
  assert.equal(run("light_turn_off_if_active", { payload: { deadline_type: "backstop" } }, active), null);
  assert.equal(run("light_evaluate_off", { payload: { event: "turn_off", vehicle_primary_ready: false, vehicle_primary_engine_on: false, vehicle_primary_unlocked: true } }, active), null);
});

scenario("19 conflito fisico no mesmo timestamp preserva primeira leitura", () => {
  const diagnostics = [];
  const flow = readyLight({ security_light_physical_state: "on", security_light_physical_updated_at: clock });
  assert.equal(run("light_reconcile", { payload: { kind: "light_physical", state: "off", updated_at: clock } }, flow, diagnostics), null);
  assert.equal(flow.get("security_light_physical_state"), "on");
  assert.equal(flow.get("light_reconciled"), false);
  assert(diagnostics.some(({ text }) => text.includes("mesmo timestamp")));
});

scenario("20 gerador legado nao remove recovery em execucao repetida", () => {
  const migration = fs.readFileSync(new URL("./refactor-security-context-flows.mjs", import.meta.url), "utf8");
  assert.match(migration, /recoveryAware/);
  assert.match(migration, /security_people_recovery_v1/);
  assert.match(migration, /process\.exit\(0\)/);
});

scenario("21 confirmacao com timestamp zero expira e limpa viagem", () => {
  const flow = memoryFlow({ security_vehicle_primary_recovery_v1: { version: 1, in_use: true, trip_active: true, trip_started_at: 1, last_confirmed_at: 0 } });
  const context = run("vehicle_primary_normalize", vehicle_primaryInput(), flow)[0].payload.context;
  assert.equal(context.in_use, null);
  assert.equal(context.trip_active, false);
  assert.equal(flow.get("security_vehicle_primary_recovery_v1").in_use, undefined);
});

scenario("22 aviso persistido incompleto expira sem notificacao", () => {
  const flow = memoryFlow({
    vehicle_primary_context_v1: { ready: true, updated_at: 210 },
    security_pending_resident_secondary_notification_v1: { version: 1, queued_at: clock, payload: { kind: "resident_secondary_approach_notification" } },
  });
  assert.equal(run("context_coordinator", { payload: { kind: "vehicle_primary_context", updated_at: 211, ready: true, context: { ready: true, updated_at: 211 } } }, flow), null);
  assert.equal(flow.get("security_pending_resident_secondary_notification_v1"), null);
});

scenario("23 snapshot rejeitado nao propaga transicao para side effect", () => {
  const flow = readyLight({ people_context_v1: { ready: true, updated_at: 200 } });
  const output = run("light_merge_context", { payload: { kind: "people_context", updated_at: 150, context: { ready: true, updated_at: 150 }, confirmed_home_transition: true, source: "resident_primary" } }, flow);
  assert.equal(output[0], null);
  assert.equal(output[1].payload.kind, "reconcile_signal");
});

Date.now = originalNow;
assert.equal(passed.length, 23);
console.log(`security recovery adversarial: ${passed.length} cenarios OK`);
for (const name of passed) console.log(name);
