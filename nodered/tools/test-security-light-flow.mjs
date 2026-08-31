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
  vehicle_primary_engine_on_event: "Motor ligado por 5 s",
  vehicle_primary_engine_off_event: "Motor desligado por 5 s",
  vehicle_primary_location_event: "Localização ou telemetria do vehicle_primary mudou",
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
const passed = [];

function memoryFlow(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    get: (key) => values.get(key),
    set: (key, value) => values.set(key, value),
    values,
  };
}

function environment(values = {}) {
  return { get: (key) => values[key] };
}

function run(id, msg, flow = memoryFlow(), env = environment()) {
  const node = byId.get(id);
  assert(node, `node ausente: ${id}`);
  assert.equal(node.type, "function", `${id} nao e function node`);
  const execute = new Function("msg", "node", "context", "flow", "global", "env", "setTimeout", "clearTimeout", node.func);
  return execute(msg, { warn() {}, error() {}, status() {} }, {}, flow, {}, env, setTimeout, clearTimeout);
}

function scenario(name, callback) {
  callback();
  passed.push(name);
}

function entity(state, distanceM = null, lastChanged = new Date().toISOString(), accuracy = 10) {
  const attributes = { gps_accuracy: accuracy };
  if (distanceM !== null) {
    attributes.latitude = distanceM / 111_200;
    attributes.longitude = 0;
  }
  return { state, last_changed: lastChanged, attributes };
}

const geoEnv = environment({ HOME_LAT: "0", HOME_LON: "0", GATE_LAT: "0", GATE_LON: "0" });

function activeLightFlow(extra = {}) {
  const now = Date.now();
  return memoryFlow({
    people_context_v1: { ready: true, updated_at: now, resident_primary: { current_home: true }, resident_secondary: { current_home: true } },
    vehicle_primary_context_v1: { ready: true, lighting_ready: true, engine_on: true, engine_state_valid: true, updated_at: now, home: true, in_use: true },
    sun_ready: true,
    security_light_physical_state: "on",
    security_light_lifecycle_v1: {
      version: 1,
      active_by_arrival: true,
      on_since: now,
      force_off_at: now + 15 * 60 * 1000,
      updated_at: now,
    },
    light_reconciled: true,
    security_light_ready: true,
    ...extra,
    security_light_physical_observed_at: Date.now(),
  });
}

function readyLightFlow(extra = {}) {
  return memoryFlow({
    people_context_v1: { ready: true, updated_at: Date.now() },
    vehicle_primary_context_v1: { ready: true, lighting_ready: true, in_use: true, engine_on: true, engine_state_valid: true, updated_at: Date.now() },
    sun_ready: true,
    sun_below_horizon: true,
    light_reconciled: true,
    security_light_ready: true,
    security_light_physical_observed_at: Date.now(),
    security_light_physical_state: "off",
    security_light_lifecycle_v1: { version: 1, active_by_arrival: false, updated_at: Date.now() },
    ...extra,
  });
}

function peopleInput({
  event = "location_update", source = "resident_primary", previous = "not_home", current = "chegando",
  resident_primary = entity(source === "resident_primary" ? current : "home", source === "resident_primary" ? 1_400 : 20),
  resident_primaryIcloud = entity(source === "resident_primary" ? current : "home", source === "resident_primary" ? 1_400 : 20),
  resident_secondary = entity(source === "resident_secondary" ? current : "home", source === "resident_secondary" ? 1_400 : 20),
  resident_secondaryIcloud = entity(source === "resident_secondary" ? current : "home", source === "resident_secondary" ? 1_400 : 20),
  cycle,
} = {}) {
  return { payload: {
    event, source, trigger_state: current, trigger_prev_state: previous,
    resident_primary, resident_primary_icloud: resident_primaryIcloud, resident_secondary, resident_secondary_icloud: resident_secondaryIcloud,
    refresh_cycle_id: cycle,
  } };
}

function vehicle_primaryInput({
  event = "location_update", previous = "not_home", current = "chegando", distance = 1_400,
  engine = "off", lock = "locked", cycle, changed = new Date().toISOString(), accuracy = 10,
} = {}) {
  return { payload: {
    event, source: "vehicle_primary", trigger_state: current, trigger_prev_state: previous,
    reason: event === "turn_off" ? "vehicle_primary_engine_off" : undefined,
    vehicle_primary: entity(current, distance, changed, accuracy),
    vehicle_primary_engine: { state: engine, last_updated: changed },
    vehicle_primary_lock: { state: lock, last_updated: changed },
    vehicle_primary_last_updated: { state: changed, last_updated: changed },
    refresh_cycle_id: cycle,
  } };
}

function arrival(source = "resident_primary", stage = "approach") {
  return { payload: {
    contract: "security.arrival.v1", kind: "arrival", source, arriving: [source],
    arrival_source_type: source === "vehicle_primary" ? "vehicle_primary" : "person", arrival_stage: stage,
  } };
}

for (const node of flows.filter((item) => item.type === "function")) {
  new Function("msg", "node", "context", "flow", "global", "env", "setTimeout", "clearTimeout", node.func);
}

for (const [tabId, forbidden] of [
  ["2fd40fd570e6f37a", /device_tracker\.|binary_sensor\.vehicle_primary|lock\.vehicle_primary|button\.vehicle_primary|HOME_LAT|distanceMeters/],
  ["security_people_tab", /binary_sensor\.vehicle_primary|lock\.vehicle_primary|device_tracker\.vehicle_primary|button\.vehicle_primary/],
  ["security_vehicle_primary_tab", /iphone_de_|iphoneresident_primary|request_location_update/],
]) {
  const serialized = JSON.stringify(flows.filter((node) => node.z === tabId));
  assert.doesNotMatch(serialized, forbidden, `fronteira de dominio violada em ${tabId}`);
}

scenario("01 vehicle_primary desligado e todos em casa", () => {
  const people = run("people_normalize", peopleInput({ event: "context_snapshot", resident_primary: entity("home", 20), resident_primaryIcloud: entity("home", 20), resident_secondary: entity("home", 20), resident_secondaryIcloud: entity("home", 20) }), memoryFlow(), geoEnv)[0];
  const vehicle_primary = run("vehicle_primary_normalize", vehicle_primaryInput({ event: "context_snapshot", current: "home", distance: 20 }), memoryFlow(), geoEnv)[0];
  assert.equal(people.payload.context.anyone_away, false);
  assert.equal(vehicle_primary.payload.context.in_use, false);
  assert.equal(vehicle_primary.payload.context.home, true);
});

scenario("02 vehicle_primary ligado e longe de casa", () => {
  const result = run("vehicle_primary_normalize", vehicle_primaryInput({ current: "not_home", distance: 5_000, engine: "on" }), memoryFlow(), geoEnv)[0];
  assert.equal(result.payload.context.in_use, true);
  assert.equal(result.payload.context.away, true);
});

scenario("02a eventos de motor ON e OFF são simétricos com filtro de 5 s", () => {
  const engineOn = byId.get("vehicle_primary_engine_on_event");
  const engineOff = byId.get("vehicle_primary_engine_off_event");
  for (const [node, state, event] of [
    [engineOn, "on", "turn_on"],
    [engineOff, "off", "turn_off"],
  ]) {
    assert.deepEqual(node.entities.entity, ["binary_sensor.vehicle_primary_engine"]);
    assert.equal(node.ifState, state);
    assert.equal(node.for, "5");
    assert.equal(node.forUnits, "seconds");
    assert.match(node.outputProperties[0].value, new RegExp(`\\"event\\":\\"${event}\\"`));
    assert.deepEqual(wireNames(node.name === "Motor ligado por 5 s" ? "vehicle_primary_engine_on_event" : "vehicle_primary_engine_off_event"), ["Normalizar vehicle_primary e detectar transições"]);
  }
});

scenario("02b localização e telemetria alimentam o contexto do veículo", () => {
  const locationEvent = byId.get("vehicle_primary_location_event");
  assert.deepEqual(locationEvent.entities.entity, [
    "device_tracker.vehicle_primary",
    "sensor.vehicle_primary_last_updated_at",
  ]);
  assert.equal(locationEvent.outputOnlyOnStateChange, false);

  const home = run("vehicle_primary_normalize", vehicle_primaryInput({ event: "context_snapshot", current: "home", distance: null }), memoryFlow(), geoEnv)[0];
  const approaching = run("vehicle_primary_normalize", vehicle_primaryInput({ current: "chegando", distance: null, engine: "on" }), memoryFlow(), geoEnv);
  const away = run("vehicle_primary_normalize", vehicle_primaryInput({ current: "not_home", distance: null, engine: "on" }), memoryFlow(), geoEnv)[0];
  assert.equal(home.payload.context.home, true);
  assert.equal(home.payload.context.away, false);
  assert.equal(approaching[0].payload.context.location.state, "chegando");
  assert.equal(approaching[0].payload.context.location.state_valid, true);
  assert.equal(approaching[0].payload.context.home, false);
  assert.equal(approaching[0].payload.context.away, false);
  assert.equal(away.payload.context.location.state, "not_home");
  assert.equal(away.payload.context.home, false);
  assert.equal(away.payload.context.away, true);
});

scenario("03 vehicle_primary ligado e aproximando-se", () => {
  const [, detected] = run("vehicle_primary_normalize", vehicle_primaryInput({ engine: "on" }), memoryFlow(), geoEnv);
  assert.equal(detected.payload.arrival_stage, "approach");
  assert.equal(detected.payload.request_vehicle_primary_wake, true);
});

scenario("04 entrada no anel de aproximadamente 1500 m", () => {
  const [, detected] = run("people_normalize", peopleInput(), memoryFlow(), geoEnv);
  assert.equal(detected.payload.arrival_stage, "approach");
});

scenario("05 resident_primary aproximando-se", () => {
  const [, detected] = run("people_normalize", peopleInput({ source: "resident_primary" }), memoryFlow(), geoEnv);
  assert.deepEqual(detected.payload.arriving, ["resident_primary"]);
});

scenario("06 resident_secondary aproximando-se", () => {
  const [, detected] = run("people_normalize", peopleInput({ source: "resident_secondary" }), memoryFlow(), geoEnv);
  assert.deepEqual(detected.payload.arriving, ["resident_secondary"]);
});

scenario("07 resident_primary ja em casa", () => {
  const flow = memoryFlow({ people_arrival_armed: { resident_primary: true } });
  run("people_normalize", peopleInput({ event: "context_snapshot", resident_primary: entity("home", 20), resident_primaryIcloud: entity("home", 20) }), flow, geoEnv);
  assert.equal(flow.get("people_arrival_armed").resident_primary, false);
});

scenario("08 resident_secondary ja em casa", () => {
  const flow = memoryFlow({ people_arrival_armed: { resident_secondary: true } });
  run("people_normalize", peopleInput({ event: "context_snapshot", resident_secondary: entity("home", 20), resident_secondaryIcloud: entity("home", 20) }), flow, geoEnv);
  assert.equal(flow.get("people_arrival_armed").resident_secondary, false);
});

scenario("09 vehicle_primary chegando encerra viagem e publica chegada", () => {
  const flow = memoryFlow({ vehicle_primary_arrival_armed: true, vehicle_primary_in_use: true });
  const [, detected] = run("vehicle_primary_normalize", vehicle_primaryInput({ previous: "chegando", current: "home", distance: 20 }), flow, geoEnv);
  assert.equal(detected.payload.arrival_source_type, "vehicle_primary");
  const actions = run("vehicle_primary_arrival_actions", detected, flow, geoEnv);
  assert.equal(actions[0], null);
  assert.equal(actions[1].payload.side_effect, "vehicle_primary.refresh_trip_info");
  assert.equal(actions[1].payload.test_mode, false);
  assert.equal(byId.get("vehicle_primary_trip_refresh").action, "public_bindings.call");
  assert.deepEqual(JSON.parse(byId.get("vehicle_primary_trip_refresh").data), {
    role: "vehicle_primary",
    action: "refresh_trip_info",
  });
  assert.deepEqual(
    wireNames("vehicle_primary_arrival_actions", 1),
    ["Separar viagens reais e dry-run"],
  );
});

scenario("10 vehicle_primary desligado ao chegar", () => {
  const result = run("vehicle_primary_normalize", vehicle_primaryInput({ event: "turn_off", current: "home", distance: 20, engine: "off", lock: "unlocked" }), memoryFlow({ vehicle_primary_in_use: true }), geoEnv)[0];
  assert.equal(result.payload.context.in_use, false);
});

scenario("11 vehicle_primary travado ao chegar nao apaga imediatamente", () => {
  const decision = run("light_evaluate_off", { payload: { active: true, event: "location_update", vehicle_primary_engine_on: false, vehicle_primary_unlocked: false } }, activeLightFlow(), geoEnv);
  assert.equal(decision, null);
});

scenario("12 vehicle_primary destravado em casa apaga apos filtro do evento", () => {
  const eventNode = byId.get("vehicle_primary_unlock_event");
  assert.equal(eventNode.for, "5");
  const decision = run("light_evaluate_off", { payload: { active: true, event: "turn_off", vehicle_primary_ready: true, vehicle_primary_engine_on: false, vehicle_primary_unlocked: true } }, activeLightFlow(), geoEnv);
  assert.equal(decision[0].payload.off_reason, "vehicle_primary_desligado_e_destravado");
});

scenario("13 refletor ja ligado antes da chegada", () => {
  const output = run("light_check_inactive", { payload: {} }, activeLightFlow(), geoEnv);
  assert.deepEqual(output, [null, null, null]);
});

scenario("14 ambiente ainda claro", () => {
  const flow = readyLightFlow({ sun_below_horizon: false });
  const prepared = run("light_prepare_arrival", arrival(), flow, geoEnv)[0];
  assert.equal(prepared.payload.sun_below_horizon, false);
});

scenario("15 ambiente escuro", () => {
  const flow = readyLightFlow();
  const prepared = run("light_prepare_arrival", arrival(), flow, geoEnv)[0];
  assert.equal(prepared.payload.sun_below_horizon, true);
  assert(run("light_check_vehicle_primary_in_use", prepared, flow, geoEnv));
});

scenario("16 timeout de 15 minutos", () => {
  const delay = byId.get("light_auto_off");
  assert.equal(delay.timeout, "15");
  assert.equal(delay.timeoutUnits, "minutes");
  assert.equal(byId.get("light_timeout").rules.some((rule) => rule.to === "timeout_15min"), true);
});

scenario("17 desligamento respeita carencia de 90 segundos", () => {
  const flow = activeLightFlow();
  const decision = run("light_evaluate_off", { payload: { active: true, confirmed_home_transition: true, source: "resident_primary" } }, flow, geoEnv);
  assert(decision[1].delay > 89_000 && decision[1].delay <= 90_000);
  assert.equal(byId.get("light_off_grace").pauseType, "delayv");
});

scenario("18 cinco condicoes independentes de desligamento", () => {
  for (const source of ["resident_primary", "resident_secondary", "vehicle_primary"]) {
    const decision = run("light_evaluate_off", { payload: { active: true, confirmed_home_transition: true, source } }, activeLightFlow(), geoEnv);
    assert.equal(decision[1].payload.off_reason, `chegada_confirmada_${source}`);
  }
  assert.equal(byId.get("light_auto_off").timeout, "15");
});

scenario("19 localizacao de resident_primary unknown/unavailable", () => {
  const flow = memoryFlow({ people_arrival_armed: { resident_primary: true } });
  const result = run("people_normalize", peopleInput({ event: "context_snapshot", resident_primary: entity("unknown"), resident_primaryIcloud: entity("unavailable") }), flow, geoEnv)[0];
  assert.equal(result.payload.context.resident_primary.state_valid, false);
  assert.equal(flow.get("people_arrival_armed").resident_primary, true);
});

scenario("20 localizacao de resident_secondary unknown/unavailable", () => {
  const flow = memoryFlow({ people_arrival_armed: { resident_secondary: true } });
  const result = run("people_normalize", peopleInput({ event: "context_snapshot", resident_secondary: entity("unknown"), resident_secondaryIcloud: entity("unavailable") }), flow, geoEnv)[0];
  assert.equal(result.payload.context.resident_secondary.state_valid, false);
  assert.equal(flow.get("people_arrival_armed").resident_secondary, true);
});

scenario("21 localizacao do vehicle_primary unknown/unavailable", () => {
  const flow = memoryFlow({ vehicle_primary_arrival_armed: true });
  const result = run("vehicle_primary_normalize", vehicle_primaryInput({ event: "context_snapshot", current: "unknown", distance: null, accuracy: 999 }), flow, geoEnv)[0];
  assert.equal(result.payload.context.state_valid, false);
  assert.equal(flow.get("vehicle_primary_arrival_armed"), true);
});

scenario("22 Home Assistant reiniciado: ciclo volta a pedir snapshots", () => {
  assert.equal(byId.get("context_tick").once, true);
  assert.equal(byId.get("context_tick").onceDelay, "2");
  assert.equal(byId.get("light_sun_event").outputInitially, true);
});

scenario("23 Node-RED reiniciado: gates falham de forma segura", () => {
  const decision = run("light_prepare_arrival", arrival(), memoryFlow(), geoEnv);
  assert.equal(decision[0], null);
  assert(decision[1]);
  assert.equal(run("light_check_vehicle_primary_in_use", { payload: {} }, memoryFlow(), geoEnv), null);
});

scenario("24 restart durante viagem fica pendente sem evidência persistida", () => {
  const input = vehicle_primaryInput({ event: "context_snapshot", current: "not_home", distance: 5_000, engine: "off" });
  input.payload.vehicle_primary_engine.last_updated = new Date(Date.now() - 10 * 60_000).toISOString();
  const result = run("vehicle_primary_normalize", input, memoryFlow(), geoEnv)[0];
  assert.equal(result.payload.context.in_use, null);
  assert.equal(result.payload.context.in_use_pending, true);
  assert.equal(result.payload.context.away, true);
});

scenario("25 restart sem reconciliação não presume refletor ativo", () => {
  const merged = run("light_merge_context", { payload: { kind: "sun_context", sun_below_horizon: true } }, memoryFlow(), geoEnv)[0];
  assert.equal(merged.payload.active, false);
});

scenario("26 eventos fora de ordem atualizam caches sem emitir refresh", () => {
  const flow = memoryFlow();
  assert.equal(run("context_coordinator", { payload: { kind: "vehicle_primary_context", context: { away: true } } }, flow, geoEnv), null);
  assert.equal(run("context_coordinator", { payload: { kind: "people_context", context: { anyone_away: false } } }, flow, geoEnv), null);
  assert.equal(flow.get("vehicle_primary_context_v1").away, true);
});

scenario("27 dois eventos quase simultaneos geram um comando por ciclo", () => {
  const flow = memoryFlow();
  const request = run("context_coordinator", { payload: { kind: "refresh_tick" } }, flow, geoEnv)[0];
  const cycle = request.payload.refresh_cycle_id;
  assert.equal(run("context_coordinator", { payload: { kind: "people_context", context: { anyone_away: false }, ready: true, refresh_cycle_id: cycle } }, flow, geoEnv), null);
  const completed = run("context_coordinator", { payload: { kind: "vehicle_primary_context", context: { away: true }, ready: true, refresh_cycle_id: cycle } }, flow, geoEnv);
  assert.equal(completed[1].payload.anyone_away, true);
  assert.equal(run("context_coordinator", { payload: { kind: "vehicle_primary_context", context: { away: true }, ready: true, refresh_cycle_id: cycle } }, flow, geoEnv), null);
});

scenario("28 refresh do vehicle_primary falhando permite retry", () => {
  const flow = memoryFlow({ vehicle_primary_context_v1: { away: true } });
  const command = { payload: { kind: "refresh_command", anyone_away: true } };
  assert(run("vehicle_primary_refresh_decide", structuredClone(command), flow, geoEnv));
  assert.equal(run("vehicle_primary_refresh_decide", structuredClone(command), flow, geoEnv), null);
  assert.equal(flow.get("security_vehicle_primary_refresh_v1").attempts, 1);
});

scenario("29 refresh posterior do vehicle_primary só confirma com evidência nova", () => {
  const flow = memoryFlow({ vehicle_primary_context_v1: { away: true } });
  run("vehicle_primary_refresh_decide", { payload: { kind: "refresh_command", anyone_away: true } }, flow, geoEnv);
  run("vehicle_primary_normalize", vehicle_primaryInput({ locationOffset: 0, engineOffset: 0 }), flow, geoEnv);
  assert.equal(typeof flow.get("security_vehicle_primary_refresh_v1").last_success_at, "number");
  assert.equal(flow.get("security_vehicle_primary_refresh_v1").awaiting_evidence, false);
  assert.equal(run("vehicle_primary_refresh_decide", { payload: { kind: "refresh_command", anyone_away: true } }, flow, geoEnv), null);
});

scenario("30 tick de 30 segundos sem mudanca nao cria loop", () => {
  assert.equal(byId.get("context_tick").repeat, "30");
  const flow = memoryFlow({ people_context_v1: { nearest_distance_m: 5_000 }, security_people_last_refresh_at: Date.now() });
  assert.equal(run("people_refresh_decide", { payload: { kind: "refresh_command", anyone_away: true } }, flow, geoEnv), null);
  const labels = new Set(["localizacao_pessoas", "contexto_vehicle_primary", "contexto_chegadas", "iluminacao_seguranca"]);
  const securityTabs = new Set(flows.filter((item) => item.type === "tab" && labels.has(item.label)).map((item) => item.id));
  for (const node of flows.filter((item) => securityTabs.has(item.z))) {
    for (const targetId of (node.wires ?? []).flat()) {
      assert.equal(byId.get(targetId).z, node.z, `wire entre tabs: ${node.id} -> ${targetId}`);
    }
  }
});

scenario("31 desconexão transitória do HA é enfileirada e tratada", () => {
  const server = flows.find((item) => item.type === "server" && item.name === "Home Assistant");
  assert(server, "configuração do Home Assistant ausente");
  assert.equal(server.heartbeat, true);
  assert.equal(Number(server.heartbeatInterval), 30);

  const calls = flows.filter((item) =>
    item.type === "api-call-service" &&
    item.name?.startsWith("Solicitar localização do iPhone ")
  );
  assert.equal(calls.length, 2);
  assert(calls.every((item) => item.queue === "first"));

  const catcher = flows.find((item) => item.name === "Capturar desconexão transitória dos iPhones");
  const handler = flows.find((item) => item.name === "Tratar desconexão transitória do HA");
  assert(catcher && handler, "tratamento de desconexão ausente");
  assert.deepEqual(new Set(catcher.scope), new Set(calls.map((item) => item.id)));
  assert.equal(catcher.wires[0][0], handler.id);
  assert.match(handler.func, /Connection lost/);
  assert.match(handler.func, /NoConnectionError/);
  assert.match(handler.func, /Falha inesperada/);
});

scenario("32 movimento na mesma zona solicita refresh sem autorizar iluminação", () => {
  assert.equal(byId.get("46c2142f93cfc3e1").outputOnlyOnStateChange, false);
  const flow = memoryFlow();
  const staleAt = new Date(Date.now() - 10 * 60_000).toISOString();
  const first = vehicle_primaryInput({
    previous: "not_home", current: "not_home", distance: 5_000,
    engine: "off", changed: staleAt,
  });
  first.payload.vehicle_primary_engine.last_updated = staleAt;
  assert.equal(run("vehicle_primary_normalize", first, flow, geoEnv)[2], null);

  const second = vehicle_primaryInput({
    previous: "not_home", current: "not_home", distance: 5_400,
    engine: "off", changed: new Date().toISOString(),
  });
  second.payload.vehicle_primary_engine.last_updated = staleAt;
  const [context, arrivalEvent, refresh] = run("vehicle_primary_normalize", second, flow, geoEnv);
  assert.equal(arrivalEvent, null);
  assert.equal(context.payload.context.in_use, null);
  assert.equal(refresh.payload.reason, "vehicle_primary_location_changed_engine_stale");
  assert.equal(refresh.payload.force_recovery, true);
  assert.equal(refresh.payload.require_lighting_ready, true);
});

scenario("33 chegada real é reprocessada quando motor muda de OFF para ON", () => {
  const now = Date.now();
  const vehicleOff = {
    ready: true,
    lighting_ready: true,
    in_use: false,
    engine_on: false,
    engine_state_valid: true,
    engine_stale: false,
    updated_at: now,
  };
  const flow = readyLightFlow({ vehicle_primary_context_v1: vehicleOff });

  const preparedOff = run(
    "light_prepare_arrival",
    arrival("resident_primary", "approach"),
    flow,
    geoEnv,
  )[0];
  assert(preparedOff, "motor OFF atual é contexto válido para decidir");
  assert.equal(run("light_check_vehicle_primary_in_use", preparedOff, flow, geoEnv), null);

  const pendingKey = "security_light_pending_arrival_v1";
  const pending = flow.get(pendingKey);
  assert(pending, "chegada real deve ser preservada enquanto o motor está OFF");
  assert.equal(pending.wait_reason, "vehicle_engine_on_after_arrival");

  const stillOffAt = now + 1;
  const stillOff = run("light_merge_context", {
    payload: {
      kind: "vehicle_primary_context",
      updated_at: stillOffAt,
      context: { ...vehicleOff, updated_at: stillOffAt },
    },
  }, flow, geoEnv);
  assert.equal(stillOff[2], null);
  assert(flow.get(pendingKey), "contexto ainda OFF não pode consumir a chegada");

  const engineOnAt = now + 2;
  const engineOn = run("light_merge_context", {
    payload: {
      kind: "vehicle_primary_context",
      updated_at: engineOnAt,
      context: {
        ...vehicleOff,
        in_use: true,
        engine_on: true,
        updated_at: engineOnAt,
      },
    },
  }, flow, geoEnv);
  assert(engineOn[2], "contexto real ON deve reprocessar a chegada preservada");
  assert.equal(engineOn[2].payload.arrival_replayed_after_context_recovery, true);
  assert.equal(flow.get(pendingKey), null);

  const preparedOn = run("light_prepare_arrival", engineOn[2], flow, geoEnv)[0];
  assert(run("light_check_vehicle_primary_in_use", preparedOn, flow, geoEnv));
});

scenario("34 pessoa chegando aciona com motor ON sem o carro estar chegando", () => {
  for (const source of ["resident_primary", "resident_secondary"]) {
    const flow = readyLightFlow({
      vehicle_primary_context_v1: {
        ready: true,
        lighting_ready: true,
        in_use: true,
        engine_on: true,
        engine_state_valid: true,
        engine_stale: false,
        location: { state: "not_home" },
        home: false,
        away: true,
        approaching_home: false,
        updated_at: Date.now(),
      },
    });
    const prepared = run(
      "light_prepare_arrival",
      arrival(source, "approach"),
      flow,
      geoEnv,
    )[0];
    assert(prepared, `${source} deve entrar na decisão de acendimento`);
    assert.equal(prepared.payload.vehicle_primary_engine_on, true);
    assert.equal(prepared.payload.vehicle_primary_in_use, true);
    assert(run("light_check_vehicle_primary_in_use", prepared, flow, geoEnv));
  }
});

scenario("35 chegando exige predecessor permitido e recovery fica só na iluminação", () => {
  assert.deepEqual(
    byId.get("people_lighting_tracker_recovery_arrival_out").links,
    ["cf9bc321e0ec89f9"],
  );
  assert.equal(
    byId.get("people_lighting_tracker_recovery_arrival_out").links.includes(
      "6481cb991b3732f5",
    ),
    false,
    "recovery unknown/unavailable não pode alcançar o alarme",
  );
  const peopleTestCoordinator = byId.get("131d1f73e8230b27");
  for (const testCase of [
    "resident_primary_unknown_approach",
    "resident_secondary_unknown_approach",
    "resident_primary_unavailable_approach",
    "resident_secondary_invalid_approach",
  ]) {
    assert.match(peopleTestCoordinator.func, new RegExp(testCase));
  }

  for (const source of ["resident_primary", "resident_secondary"]) {
    for (const previous of ["unknown", "unavailable"]) {
      const result = run(
        "people_normalize",
        peopleInput({ source, previous, current: "chegando" }),
        memoryFlow(),
        geoEnv,
      );
      assert.equal(result[1], null, `${previous} não pode virar chegada geral`);
      assert(result[2], `${previous} → chegando deve ir à iluminação`);
      assert.equal(result[2].payload.illumination_only, true);
      assert.equal(result[2].payload.arrival_previous_state, previous);
    }

    const armedFlow = memoryFlow({
      people_arrival_armed: { [source]: true },
    });
    const fromAway = run(
      "people_normalize",
      peopleInput({ source, previous: "not_home", current: "chegando" }),
      armedFlow,
      geoEnv,
    );
    assert(fromAway[1], "not_home → chegando deve continuar como chegada geral");
    assert.equal(fromAway[2], null);

    for (const previous of ["home", "chegando", "work"]) {
      const blocked = run(
        "people_normalize",
        peopleInput({ source, previous, current: "chegando" }),
        memoryFlow({ people_arrival_armed: { [source]: true } }),
        geoEnv,
      );
      assert.equal(blocked[1], null, `${previous} → chegando não pode ser chegada geral`);
      assert.equal(blocked[2], null, `${previous} → chegando não pode acionar iluminação`);
    }
  }
});

scenario("36 aviso de turn on fica travado até confirmação física de OFF", () => {
  const unavailableFlow = readyLightFlow({
    security_light_physical_state: "unavailable",
    light_reconciled: false,
  });
  const candidate = {
    payload: {
      arrival_key: "resident_secondary:approach:1",
      source: "resident_secondary",
    },
  };

  const first = run(
    "light_check_inactive",
    structuredClone(candidate),
    unavailableFlow,
    geoEnv,
  );
  assert(first[1], "primeira falha deve emitir um único aviso de indisponibilidade");
  assert.equal(first[0], null);
  assert.equal(first[2], null);
  assert.equal(
    unavailableFlow.get("security_light_turn_on_notification_latch_v1").latched,
    true,
  );

  assert.deepEqual(
    run(
      "light_check_inactive",
      { payload: { arrival_key: "resident_primary:approach:2" } },
      unavailableFlow,
      geoEnv,
    ),
    [null, null, null],
    "novas chegadas não podem repetir aviso enquanto o latch estiver ativo",
  );

  run("light_reconcile", {
    payload: {
      kind: "light_physical",
      state: "off",
      updated_at: Date.now(),
    },
  }, unavailableFlow, geoEnv);
  assert.equal(
    unavailableFlow.get("security_light_turn_on_notification_latch_v1"),
    null,
  );
  assert(
    run("light_check_inactive", structuredClone(candidate), unavailableFlow, geoEnv)[0],
    "OFF físico deve liberar um novo ciclo de acendimento",
  );

  const testFlow = readyLightFlow({
    security_light_physical_state: "unavailable",
    light_reconciled: false,
  });
  const testResult = run("light_check_inactive", {
    _location_test: true,
    payload: {
      test_mode: true,
      arrival_key: "test:resident_secondary:approach",
    },
  }, testFlow, geoEnv);
  assert.equal(testResult[1], null, "TESTE não pode usar o ramo de produção");
  assert(testResult[2], "TESTE indisponível deve solicitar somente os pushes TESTE");

  const onFlow = readyLightFlow({
    security_light_physical_state: "on",
    security_light_lifecycle_v1: {
      version: 1,
      active_by_arrival: false,
      updated_at: Date.now(),
    },
  });
  run("light_reconcile", {
    payload: {
      kind: "light_physical",
      state: "on",
      updated_at: Date.now(),
    },
  }, onFlow, geoEnv);
  assert.equal(
    onFlow.get("security_light_turn_on_notification_latch_v1").reason,
    "physical_on",
  );
  onFlow.set("security_light_physical_state", "unavailable");
  onFlow.set("light_reconciled", false);
  assert.deepEqual(
    run("light_check_inactive", structuredClone(candidate), onFlow, geoEnv),
    [null, null, null],
    "estado ON observado deve continuar suprimindo após indisponibilidade",
  );
});

assert.equal(passed.length, 38);
console.log(`security context/light replay: ${passed.length} cenarios OK`);
for (const name of passed) console.log(name);
