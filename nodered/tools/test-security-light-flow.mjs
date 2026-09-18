import assert from "node:assert/strict";
import fs from "node:fs";
import {
  ensureArrivalContextPolicy,
  runArrivalContextVisual,
  runPeopleVisual,
  runSecurityArrivalVisual,
  runSecurityAvailabilityVisual,
  runSecurityContextVisual,
  runSecurityReconcileVisual,
  runVehicleRefreshVisual,
  runVehicleVisual,
} from "./visual-flow-test-harness.mjs";

const flows = JSON.parse(fs.readFileSync(new URL("../flows.json", import.meta.url), "utf8"));
const byId = new Map(flows.map((node) => [node.id, node]));
const aliasesByName = {
  people_refresh_decide: "Atualizar iPhones agora?",
  vehicle_primary_refresh_policy: "Escolher presença, chegada armada e motor",
  vehicle_primary_refresh_quiet_hours: "Pausar madrugada se ambos em casa",
  vehicle_primary_arrival_actions: "Acordar carro e fechar viagem",
  vehicle_primary_trip_refresh: "Atualizar viagens do dia após chegada",
  vehicle_primary_unlock_event: "Porta destravada por 5 s",
  vehicle_primary_engine_on_event: "Motor ligado por 5 s",
  vehicle_primary_engine_off_event: "Motor desligado por 5 s",
  vehicle_primary_location_event: "Localização ou telemetria do vehicle_primary mudou",
  context_tick: "POLÍTICA: reavaliar a cada 30 s",
  light_arrival_direction_gate: "Morador retornou via near_home ou salto direto para home?",
  light_check_vehicle_primary_in_use: "vehicle_primary está em uso?",
  light_mark_active: "Marcar refletor ativo por chegada",
  light_evaluate_off: "Desligar quando o carro confirmar OFF",
  light_turn_off_if_active: "Desativar somente se foi ligado por chegada",
  light_reconcile: "Emitir deadlines reconstruídos",
  light_auto_off: "Aguardar backstop de 15 min",
  light_check_inactive: "Rotear disponibilidade do refletor",
  light_sun_event: "Luminosidade mudou",
  light_timeout: "Solicitar desligamento por timeout",
};
for (const [alias, name] of Object.entries(aliasesByName)) {
  const node = flows.find((item) => item.name === name);
  assert(node, `node ausente pelo nome: ${name}`);
  byId.set(alias, node);
}
for (const [alias, id] of Object.entries({
  people_normalize: "554cb653b2fa4504",
  vehicle_primary_normalize: "092625f2eb5cc156",
  vehicle_primary_refresh_decide: "b33e117e55bdb5ed",
  context_coordinator: "arrival_context_refresh_build",
  light_merge_context: "48a5f40d806f6950",
  light_prepare_arrival: "62f77a1ad440639d",
})) byId.set(alias, byId.get(id));

function wireNames(alias, output = 0) {
  return (byId.get(alias).wires[output] ?? []).map((id) => byId.get(id)?.name ?? id);
}
const passed = [];
const LOCATION_POLICY = {
  version: 1, owner: "node_red", complete: true,
  near_home_radius_m: 700, location_fresh_minutes: 15,
  source_report_fresh_minutes: 75, recency_tie_seconds: 60,
  max_gps_accuracy_m: 100, vehicle_location_fresh_minutes: 30,
  movement_threshold_m: 250, home_radius_m: 100,
  arrival_recovery_minutes: 15, local_excursion_minutes: 90,
  near_home_refresh_minutes: 10,
  arrival_dedupe_minutes: 10, primary_home_grace_minutes: 10,
  external_cycle_confirm_seconds: 60,
  future_tolerance_seconds: 60, vehicle_signal_fresh_minutes: 5,
  vehicle_recovery_hours: 24,
};
const SECURITY_LIGHT_POLICY = {
  version: 1, owner: "node_red", complete: true,
  physical_fresh_seconds: 120, recovery_request_throttle_seconds: 30,
  off_grace_seconds: 90, backstop_minutes: 15, post_off_cooldown_minutes: 5,
  lifecycle_retention_hours: 24, deadline_slack_minutes: 1,
  unavailable_dedupe_seconds: 10, cooldown_max_minutes: 30,
};

function memoryGlobal() {
  const values = new Map([
    ["location_policy_v1", LOCATION_POLICY],
    ["security_light_policy_v1", SECURITY_LIGHT_POLICY],
  ]);
  return {
    get: (key) => values.get(key),
    set: (key, value) => values.set(key, value),
  };
}

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

function runDirect(id, msg, flow = memoryFlow(), env = environment()) {
  const node = byId.get(id);
  assert(node, `node ausente: ${id}`);
  assert.equal(node.type, "function", `${id} nao e function node`);
  const execute = new Function("msg", "node", "context", "flow", "global", "env", "setTimeout", "clearTimeout", node.func);
  return execute(msg, { warn() {}, error() {}, status() {} }, {}, flow, memoryGlobal(), env, setTimeout, clearTimeout);
}

function run(id, msg, flow = memoryFlow(), env = environment()) {
  const call = (nodeId, current) => runDirect(nodeId, current, flow, env);
  if (id === "people_normalize") return runPeopleVisual(call, msg);
  if (id === "vehicle_primary_normalize") return runVehicleVisual(call, msg);
  if (id === "vehicle_primary_refresh_decide") return runVehicleRefreshVisual(call, msg);
  if (id === "light_prepare_arrival") return runSecurityArrivalVisual(call, msg);
  if (id === "light_check_inactive") return runSecurityAvailabilityVisual(call, msg);
  if (id === "light_merge_context") return runSecurityContextVisual(call, msg);
  if (id === "light_reconcile") return runSecurityReconcileVisual(call, msg);
  if (id === "context_coordinator") {
    if (!flow.get("arrival_context_policy_v1")) ensureArrivalContextPolicy(call);
    return runArrivalContextVisual(call, msg);
  }
  return runDirect(id, msg, flow, env);
}

function runVehicleRefresh(msg, flow, env = environment()) {
  if (!flow.get("vehicle_primary_refresh_policy_config_v1")) {
    flow.set("vehicle_primary_refresh_policy_config_v1", {
      version: 1,
      complete: true,
      arrival_armed_interval_minutes: 1,
      approaching_interval_minutes: 5,
      away_interval_minutes: 15,
      home_interval_minutes: 30,
      quiet_start_hour: 0,
      quiet_end_hour: 6,
      in_flight_lease_seconds: 120,
      cache_probe_settle_seconds: 15,
      provider_backoff_max_hours: 6,
      semantic_evidence_window_minutes: 20,
      unknown_location_start_hour: 7,
      unknown_location_end_hour: 22,
    });
  }
  const branches = run(
    "vehicle_primary_refresh_policy",
    msg,
    flow,
    env,
  );
  const selected = branches.find(Boolean);
  if (!selected) return null;
  const bothHome = selected.payload.refresh_both_residents_home === true;
  const approaching = selected.payload.refresh_anyone_approaching === true;
  const arrivalRestartPending = selected.payload.refresh_arrival_restart_pending === true;
  selected.payload.refresh_interval_ms = arrivalRestartPending
    ? selected.payload.refresh_policy_config.arrival_armed_interval_ms
    : approaching
      ? selected.payload.refresh_policy_config.approaching_interval_ms
    : bothHome
      ? selected.payload.refresh_policy_config.home_interval_ms
      : selected.payload.refresh_policy_config.away_interval_ms;
  selected.payload.refresh_interval_policy = arrivalRestartPending
    ? "arrival_armed_engine_pending"
    : approaching
      ? "approaching"
    : bothHome
      ? "both_home"
      : "away";
  const allowed = run(
    "vehicle_primary_refresh_quiet_hours",
    selected,
    flow,
    env,
  );
  return allowed
    ? run("vehicle_primary_refresh_decide", allowed, flow, env)
    : null;
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
  return { state, last_changed: lastChanged, last_updated: lastChanged, attributes };
}

const geoEnv = environment({ HOME_LAT: "0", HOME_LON: "0", GATE_LAT: "0", GATE_LON: "0" });

function activeLightFlow(extra = {}) {
  const now = Date.now();
  return memoryFlow({
    people_context_v1: { ready: true, updated_at: now,
      resident_primary: { ready: true, stale: false, state: "home", current_home: true, updated_at: now },
      resident_secondary: { ready: true, stale: false, state: "home", current_home: true, updated_at: now } },
    vehicle_primary_context_v1: { ready: true, lighting_ready: true, engine_on: true, engine_state_valid: true, unlocked: false, updated_at: now, home: true, in_use: true },
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
  const now = Date.now();
  return memoryFlow({
    people_context_v1: {
      ready: true,
      updated_at: now,
      resident_primary: { ready: true, stale: false, state: "near_home", current_home: false, updated_at: now },
      resident_secondary: { ready: true, stale: false, state: "near_home", current_home: false, updated_at: now },
    },
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
  event = "location_update", source = "resident_primary", previous = "not_home", current = "near_home",
  resident_primary = entity(source === "resident_primary" ? current : "home", source === "resident_primary" ? 650 : 20),
  resident_primaryIcloud = entity(source === "resident_primary" ? current : "home", source === "resident_primary" ? 650 : 20),
  resident_secondary = entity(source === "resident_secondary" ? current : "home", source === "resident_secondary" ? 650 : 20),
  resident_secondaryIcloud = entity(source === "resident_secondary" ? current : "home", source === "resident_secondary" ? 650 : 20),
  cycle,
} = {}) {
  return { payload: {
    event, source, trigger_state: current, trigger_prev_state: previous,
    resident_primary, resident_primary_icloud: resident_primaryIcloud,
    resident_primary_selected: resident_primary,
    resident_secondary, resident_secondary_icloud: resident_secondaryIcloud,
    resident_secondary_selected: resident_secondary,
    refresh_cycle_id: cycle,
  } };
}

function vehicle_primaryInput({
  event = "location_update", previous = "not_home", current = "near_home", distance = 1_400,
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
    arrival_previous_state: stage === "approach" ? "not_home" : "near_home",
    arrival_direction: "returning", external_cycle_confirmed: true,
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
    assert.deepEqual(wireNames(node.name === "Motor ligado por 5 s" ? "vehicle_primary_engine_on_event" : "vehicle_primary_engine_off_event"), ["Eventos e snapshots → lifecycle"]);
  }
});

scenario("02b localização, telemetria e cache alimentam o contexto do veículo", () => {
  const locationEvent = byId.get("vehicle_primary_location_event");
  assert.deepEqual(locationEvent.entities.entity, [
    "device_tracker.vehicle_primary",
    "sensor.vehicle_primary_last_updated_at",
    "sensor.vehicle_primary_last_scanned_at",
  ]);
  assert.equal(locationEvent.outputOnlyOnStateChange, false);

  const home = run("vehicle_primary_normalize", vehicle_primaryInput({ event: "context_snapshot", current: "home", distance: null }), memoryFlow(), geoEnv)[0];
  const approaching = run("vehicle_primary_normalize", vehicle_primaryInput({ current: "near_home", distance: 650, engine: "on" }), memoryFlow(), geoEnv);
  const away = run("vehicle_primary_normalize", vehicle_primaryInput({ current: "not_home", distance: 5_000, engine: "on" }), memoryFlow(), geoEnv)[0];
  assert.equal(home.payload.context.home, true);
  assert.equal(home.payload.context.away, false);
  assert.equal(approaching[0].payload.context.location.state, "near_home");
  assert.equal(approaching[0].payload.context.location.state_valid, true);
  assert.equal(approaching[0].payload.context.home, false);
  assert.equal(approaching[0].payload.context.away, true);
  assert.equal(away.payload.context.location.state, "not_home");
  assert.equal(away.payload.context.home, false);
  assert.equal(away.payload.context.away, true);
});

scenario("03 vehicle_primary ligado e aproximando-se", () => {
  const [, detected] = run("vehicle_primary_normalize", vehicle_primaryInput({ engine: "on", distance: 650 }), memoryFlow({ vehicle_primary_arrival_armed: true }), geoEnv);
  assert.equal(detected.payload.arrival_stage, "approach");
  assert.equal(detected.payload.request_vehicle_primary_wake, true);
});

scenario("04 entrada no raio near_home de 700 m", () => {
  const flow = memoryFlow();
  const confirmedExternalAt = new Date(Date.now() - 61_000).toISOString();
  run("people_normalize", peopleInput({ event: "context_snapshot", current: "not_home",
    resident_primary: entity("not_home", 1_600, confirmedExternalAt),
    resident_primaryIcloud: entity("not_home", 1_600, confirmedExternalAt) }), flow, geoEnv);
  const [, detected] = run("people_normalize", peopleInput(), flow, geoEnv);
  assert.equal(detected.payload.arrival_stage, "approach");
  assert.equal(detected.payload.arrival_direction, "returning");
  assert.equal(detected.payload.external_cycle_confirmed, true);
});

scenario("04a saída e rebote near_home → home não viram chegada", () => {
  const flow = memoryFlow();
  const departure = run(
    "people_normalize",
    peopleInput({
      previous: "home",
      current: "near_home",
      resident_primary: entity("near_home", 215, undefined, 37),
      resident_primaryIcloud: entity("near_home", 215, undefined, 37),
    }),
    flow,
    geoEnv,
  );
  assert.equal(departure[1], null);
  assert.equal(departure[3].payload.direction_reason, "departure_from_home");
  assert.equal(flow.get("people_arrival_armed").resident_primary, false);

  const externalBounceFlow = memoryFlow();
  const duplicatedExternalAt = new Date().toISOString();
  const firstExternalSample = run(
    "people_normalize",
    peopleInput({ previous: "home", current: "not_home", resident_primary: entity("not_home", 1_600, duplicatedExternalAt), resident_primaryIcloud: entity("not_home", 1_600, duplicatedExternalAt) }),
    externalBounceFlow,
    geoEnv,
  );
  assert.equal(firstExternalSample[1], null);
  assert.equal(externalBounceFlow.get("people_arrival_armed").resident_primary, false);
  const pairedSnapshot = run(
    "people_normalize",
    peopleInput({ event: "context_snapshot", previous: undefined, current: "not_home", resident_primary: entity("not_home", 1_600, duplicatedExternalAt), resident_primaryIcloud: entity("not_home", 1_600, duplicatedExternalAt) }),
    externalBounceFlow,
    geoEnv,
  );
  assert.equal(pairedSnapshot[1], null);
  assert.equal(externalBounceFlow.get("people_arrival_armed").resident_primary, false,
    "snapshot duplicado da mesma observação não confirma saída");
  const immediateExternalBounce = run(
    "people_normalize",
    peopleInput({ previous: "not_home", current: "home", resident_primary: entity("home", 101), resident_primaryIcloud: entity("home", 101) }),
    externalBounceFlow,
    geoEnv,
  );
  assert.equal(immediateExternalBounce[1], null);
  assert.equal(immediateExternalBounce[3].payload.direction_reason, "external_cycle_not_confirmed");

  const confirmedExternalFlow = memoryFlow();
  const returnFlow = memoryFlow();
  const confirmedExternalAt = new Date(Date.now() - 61_000).toISOString();
  run(
    "people_normalize",
    peopleInput({ event: "context_snapshot", previous: undefined, current: "not_home", resident_primary: entity("not_home", 1_600, confirmedExternalAt), resident_primaryIcloud: entity("not_home", 1_600, confirmedExternalAt) }),
    confirmedExternalFlow,
    geoEnv,
  );
  const returningAfterConfirmedExternal = run(
    "people_normalize",
    peopleInput({ previous: "not_home", current: "home", resident_primary: entity("home", 101), resident_primaryIcloud: entity("home", 101) }),
    confirmedExternalFlow,
    geoEnv,
  );
  assert(returningAfterConfirmedExternal[1], "observação externa separada deve armar o retorno real");

  const bounce = run(
    "people_normalize",
    peopleInput({
      previous: "near_home",
      current: "home",
      resident_primary: entity("home", 99, undefined, 14),
      resident_primaryIcloud: entity("home", 99, undefined, 14),
    }),
    flow,
    geoEnv,
  );
  assert.equal(bounce[1], null);
  assert.equal(bounce[2], null);
  assert.equal(bounce[3].payload.direction_reason, "external_cycle_not_confirmed");
  assert.equal(
    run("people_arrival_departure_blocked_v1", bounce[3], flow, geoEnv),
    null,
  );
  assert.equal(flow.get("people_last_blocked_arrival_v1").dispatched, false);

  run(
    "people_normalize",
    peopleInput({
      event: "context_snapshot",
      previous: "near_home",
      current: "not_home",
      resident_primary: entity("not_home", 2_000, confirmedExternalAt),
      resident_primaryIcloud: entity("not_home", 2_000, confirmedExternalAt),
    }),
    returnFlow,
    geoEnv,
  );
  assert.equal(returnFlow.get("people_arrival_armed").resident_primary, false);
  const returning = run(
    "people_normalize",
    peopleInput(),
    returnFlow,
    geoEnv,
  );
  assert.equal(returning[1].payload.external_cycle_confirmed, true);
});

scenario("04b raio near_home configurável aceita 700 m", () => {
  const flow = memoryFlow({
    people_arrival_armed: { resident_primary: true },
  });
  const [, detected] = run(
    "people_normalize",
    peopleInput({ previous: "not_home", current: "near_home", resident_primary: entity("near_home", 650), resident_primaryIcloud: entity("near_home", 650) }),
    flow,
    geoEnv,
  );
  assert.equal(detected.payload.arrival_stage, "approach");
});

scenario("04c saída e rebote do veículo também ficam bloqueados", () => {
  const flow = memoryFlow();
  const departure = run(
    "vehicle_primary_normalize",
    vehicle_primaryInput({ previous: "home", current: "near_home", distance: 215, engine: "on" }),
    flow,
    geoEnv,
  );
  assert.equal(departure[1], null);
  assert.equal(departure[3].payload.direction_reason, "departure_from_home");
  assert.equal(flow.get("vehicle_primary_arrival_armed"), false);

  const externalBounceFlow = memoryFlow();
  const duplicatedVehicleExternalAt = new Date().toISOString();
  run(
    "vehicle_primary_normalize",
    vehicle_primaryInput({ previous: "home", current: "not_home", distance: 1_600, engine: "on", changed: duplicatedVehicleExternalAt }),
    externalBounceFlow,
    geoEnv,
  );
  run(
    "vehicle_primary_normalize",
    vehicle_primaryInput({ event: "context_snapshot", previous: "not_home", current: "not_home", distance: 1_600, engine: "on", changed: duplicatedVehicleExternalAt }),
    externalBounceFlow,
    geoEnv,
  );
  assert.equal(externalBounceFlow.get("vehicle_primary_arrival_armed"), false,
    "snapshot duplicado do veículo não confirma saída");
  const immediateExternalBounce = run(
    "vehicle_primary_normalize",
    vehicle_primaryInput({ previous: "not_home", current: "home", distance: 101, engine: "on" }),
    externalBounceFlow,
    geoEnv,
  );
  assert.equal(immediateExternalBounce[1], null);
  assert.equal(immediateExternalBounce[3].payload.direction_reason, "external_cycle_not_confirmed");

  const bounce = run(
    "vehicle_primary_normalize",
    vehicle_primaryInput({ previous: "near_home", current: "home", distance: 99, engine: "on" }),
    flow,
    geoEnv,
  );
  assert.equal(bounce[1], null);
  assert.equal(bounce[3].payload.direction_reason, "external_cycle_not_confirmed");
  assert.equal(
    run("vehicle_primary_arrival_departure_blocked_v1", bounce[3], flow, geoEnv),
    null,
  );
  assert.equal(
    flow.get("vehicle_primary_last_blocked_arrival_v1").dispatched,
    false,
  );

  const confirmedVehicleFlow = memoryFlow();
  const confirmedVehicleExternalAt = new Date(Date.now() - 61_000).toISOString();
  run(
    "vehicle_primary_normalize",
    vehicle_primaryInput({ event: "context_snapshot", previous: undefined, current: "not_home", distance: 1_600, engine: "on", changed: confirmedVehicleExternalAt }),
    confirmedVehicleFlow,
    geoEnv,
  );
  const confirmedVehicleReturn = run(
    "vehicle_primary_normalize",
    vehicle_primaryInput({ previous: "not_home", current: "near_home", distance: 650, engine: "on" }),
    confirmedVehicleFlow,
    geoEnv,
  );
  assert(confirmedVehicleReturn[1], "veículo realmente fora deve publicar retorno");
});

scenario("05 resident_primary aproximando-se", () => {
  const [, detected] = run("people_normalize", peopleInput({ source: "resident_primary" }),
    memoryFlow({ people_arrival_armed: { resident_primary: true } }), geoEnv);
  assert.deepEqual(detected.payload.arriving, ["resident_primary"]);
});

scenario("06 resident_secondary aproximando-se", () => {
  const [, detected] = run("people_normalize", peopleInput({ source: "resident_secondary" }),
    memoryFlow({ people_arrival_armed: { resident_secondary: true } }), geoEnv);
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

scenario("09 vehicle_primary near_home encerra viagem e publica chegada", () => {
  const flow = memoryFlow({ vehicle_primary_arrival_armed: true, vehicle_primary_in_use: true });
  const [, detected] = run("vehicle_primary_normalize", vehicle_primaryInput({ previous: "near_home", current: "home", distance: 20 }), flow, geoEnv);
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

scenario("09a republicação interna não recria a mesma chegada", () => {
  const flow = memoryFlow({
    vehicle_primary_arrival_armed: true,
    vehicle_primary_in_use: true,
  });
  const observedAt = new Date(Date.now() - 60_000).toISOString();
  const firstInput = vehicle_primaryInput({
    previous: "not_home",
    current: "near_home",
    distance: 200,
  });
  firstInput.payload.vehicle_primary.attributes.location_observed_at = observedAt;
  const [, firstArrival] = run(
    "vehicle_primary_normalize",
    firstInput,
    flow,
    geoEnv,
  );
  assert(firstArrival);

  const replayInput = vehicle_primaryInput({
    previous: "near_home",
    current: "near_home",
    distance: 200,
    changed: new Date(Date.now() + 1_000).toISOString(),
  });
  replayInput.payload.vehicle_primary.attributes.location_observed_at = observedAt;
  const [, duplicateArrival] = run(
    "vehicle_primary_normalize",
    replayInput,
    flow,
    geoEnv,
  );
  assert.equal(duplicateArrival, null);
});

scenario("10 vehicle_primary desligado ao chegar", () => {
  const result = run("vehicle_primary_normalize", vehicle_primaryInput({ event: "turn_off", current: "home", distance: 20, engine: "off", lock: "unlocked" }), memoryFlow({ vehicle_primary_in_use: true }), geoEnv)[0];
  assert.equal(result.payload.context.in_use, false);
});

scenario("11 motor OFF confiável apaga mesmo com vehicle_primary travado", () => {
  const flow = activeLightFlow({ vehicle_primary_context_v1: {
    ready: true, lighting_ready: true, engine_on: false, engine_state_valid: true,
    unlocked: false, updated_at: Date.now(), home: true, in_use: false,
  } });
  const decision = run("light_evaluate_off", {
    _light_context: { kind: "vehicle_primary_context", accepted: true },
    payload: { active: true, event: "turn_off", vehicle_primary_ready: true,
      vehicle_primary_engine_state_valid: true, vehicle_primary_engine_on: false,
      vehicle_primary_unlocked: false },
  }, flow, geoEnv);
  assert.equal(decision.payload.off_reason, "vehicle_primary_motor_off_confirmado");
});

scenario("12 contexto que não é do vehicle_primary não apaga com OFF antigo", () => {
  const eventNode = byId.get("vehicle_primary_unlock_event");
  assert.equal(eventNode.for, "5");
  const decision = run("light_evaluate_off", {
    _light_context: { kind: "people_context", accepted: true },
    payload: { active: true, event: "location_update", vehicle_primary_ready: true,
      vehicle_primary_engine_state_valid: true, vehicle_primary_engine_on: false,
      vehicle_primary_unlocked: true },
  }, activeLightFlow({ vehicle_primary_context_v1: {
    ready: true, engine_state_valid: true, engine_on: false, unlocked: true,
  } }), geoEnv);
  assert.equal(decision, null);
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

scenario("17 HOME não agenda atualização dentro do fluxo do refletor", () => {
  const flow = activeLightFlow();
  const lifecycle = flow.get("security_light_lifecycle_v1");
  lifecycle.on_since = Date.now() - 5 * 60_000;
  flow.set("security_light_lifecycle_v1", lifecycle);
  const decision = run("light_evaluate_off", { payload: { active: true, confirmed_home_transition: true, source: "resident_primary" } }, flow, geoEnv);
  assert.equal(decision, null);
  assert.equal(byId.has("71976ffe382e6d7d"), false);
  assert.equal(flows.some((node) => node.name === "Atualizar carro e aguardar motor OFF"), false);
});

scenario("18 somente motor OFF continua desligando imediatamente", () => {
  assert.equal(run("light_evaluate_off", {
    payload: { active: true, confirmed_home_transition: true, source: "vehicle_primary" },
  }, activeLightFlow(), geoEnv), null,
  "posição home do carro não pode iniciar a confirmação extraordinária");
  const immediateFlow = activeLightFlow({ vehicle_primary_context_v1: {
    ready: true, lighting_ready: true, engine_on: false, engine_state_valid: true,
    unlocked: false, updated_at: Date.now(), home: true, in_use: false,
  } });
  const immediate = run("light_evaluate_off", {
    _light_context: { kind: "vehicle_primary_context", accepted: true },
    payload: { event: "turn_off", vehicle_primary_ready: true,
      vehicle_primary_engine_state_valid: true, vehicle_primary_engine_on: false,
      vehicle_primary_unlocked: false },
  }, immediateFlow, geoEnv);
  assert.equal(immediate.payload.off_reason, "vehicle_primary_motor_off_confirmado");
  const command = run("light_turn_off_if_active", immediate, immediateFlow, geoEnv);
  assert(command, "motor OFF confiável deve alcançar o comando mesmo com o carro travado");
  assert.equal(immediateFlow.get("security_light_lifecycle_v1").active_by_arrival, false);
  assert.equal(byId.get("light_auto_off").timeout, "15");
});

scenario("18a dry-run de OFF não altera o lifecycle de produção", () => {
  const now = Date.now();
  const productionLifecycle = {
    version: 1, active_by_arrival: true, on_since: now,
    force_off_at: now + 15 * 60_000, updated_at: now,
  };
  const flow = activeLightFlow({
    security_light_lifecycle_v1: productionLifecycle,
    security_light_lifecycle_v1__test: structuredClone(productionLifecycle),
    vehicle_primary_context_v1__test: {
      ready: true, engine_state_valid: true, engine_on: false, unlocked: false,
    },
  });
  const command = run("light_turn_off_if_active", {
    _location_test: true,
    payload: { test_mode: true, deadline_type: "immediate" },
  }, flow, geoEnv);
  assert(command);
  assert.equal(flow.get("security_light_lifecycle_v1__test").active_by_arrival, false);
  assert.equal(flow.get("security_light_lifecycle_v1").active_by_arrival, true);
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

scenario("24 OFF conhecido permanece bloqueante mesmo antigo", () => {
  const input = vehicle_primaryInput({ event: "context_snapshot", current: "not_home", distance: 5_000, engine: "off" });
  input.payload.vehicle_primary_engine.last_updated = new Date(Date.now() - 10 * 60_000).toISOString();
  const result = run("vehicle_primary_normalize", input, memoryFlow(), geoEnv)[0];
  assert.equal(result.payload.context.in_use, false);
  assert.equal(result.payload.context.in_use_pending, false);
  assert.equal(result.payload.context.engine_stale, true);
  assert.equal(result.payload.context.lighting_ready, true);
  assert.equal(result.payload.context.away, true);
});

scenario("25 restart sem reconciliação não presume refletor ativo", () => {
  const merged = run("light_merge_context", { payload: { kind: "sun_context", sun_below_horizon: true } }, memoryFlow(), geoEnv)[0];
  assert.equal(merged.payload.active, false);
});

scenario("25a estado inicial do refletor aguarda o cache do Home Assistant", () => {
  assert.equal(byId.has("78753a34fe418682"), false,
    "o polling por relógio não deve competir com o carregamento do cache");
  assert.equal(byId.has("bfcddf998d4e3a53"), false,
    "api-current-state não deve consultar a entidade durante o startup");
  const physicalState = byId.get("eb9ffff62431e1c3");
  assert(physicalState, "o observador físico do refletor deve existir");
  assert.equal(physicalState.type, "server-state-changed");
  assert.equal(physicalState.outputInitially, true,
    "o estado inicial deve ser emitido após o Home Assistant ficar pronto");
  assert.equal(physicalState.outputOnlyOnStateChange, true);
  assert.deepEqual(physicalState.entities.entity, ["switch.refletor_portao_carros"]);
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
  assert(runVehicleRefresh(structuredClone(command), flow, geoEnv));
  assert.equal(runVehicleRefresh(structuredClone(command), flow, geoEnv), null);
  assert.equal(flow.get("security_vehicle_primary_refresh_v1").attempts, 1);
});

scenario("29 refresh posterior do vehicle_primary só confirma com evidência nova", () => {
  const flow = memoryFlow({ vehicle_primary_context_v1: { away: true } });
  runVehicleRefresh({ payload: { kind: "refresh_command", anyone_away: true } }, flow, geoEnv);
  run("vehicle_primary_normalize", vehicle_primaryInput({ locationOffset: 0, engineOffset: 0 }), flow, geoEnv);
  assert.equal(typeof flow.get("security_vehicle_primary_refresh_v1").last_success_at, "number");
  assert.equal(flow.get("security_vehicle_primary_refresh_v1").awaiting_evidence, false);
  assert.equal(runVehicleRefresh({ payload: { kind: "refresh_command", anyone_away: true } }, flow, geoEnv), null);
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

scenario("30a posição vencida em casa solicita GPS sem criar polling contínuo", () => {
  const oldLocation = new Date(Date.now() - 4 * 60 * 60_000).toISOString();
  const currentReport = new Date().toISOString();
  const stationary = () => {
    const value = entity("home", 20, oldLocation);
    value.attributes.location_observed_at = oldLocation;
    value.attributes.source_reported_at = currentReport;
    return value;
  };
  const normalized = run("people_normalize", peopleInput({
    event: "context_snapshot",
    resident_primary: stationary(),
    resident_primaryIcloud: stationary(),
    resident_secondary: stationary(),
    resident_secondaryIcloud: stationary(),
  }), memoryFlow(), geoEnv)[0].payload.context;
  assert.equal(normalized.ready, false);
  assert.equal(normalized.resident_primary.stationary_home, true);
  assert.equal(normalized.resident_secondary.stationary_home, true);

  const flow = memoryFlow({ people_context_v1: normalized });
  const command = {
    payload: { kind: "refresh_command", anyone_away: false, people_ready: false },
  };
  const requested = run("people_refresh_decide", structuredClone(command), flow, geoEnv);
  assert(requested[0]);
  assert(requested[1]);
  assert.equal(requested[0].payload.refresh_source, "resident_primary");
  assert.equal(requested[1].payload.refresh_source, "resident_secondary");
  assert.equal(requested[0].payload.refresh_routes.join(","), "companion,icloud");
  assert.equal(requested[1].payload.refresh_routes.join(","), "companion,icloud");
  assert.equal(
    run("people_refresh_decide", structuredClone(command), flow, geoEnv),
    null,
    "o tick seguinte precisa respeitar o cooldown de 30 minutos",
  );
});

scenario("30b recovery de localizacao respeita cooldown de 30 minutos", () => {
  const oldLocation = Date.now() - 60 * 60_000;
  const flow = memoryFlow({
    people_context_v1: {
      ready: false,
      resident_primary: { ready: false, stale: true, updated_at: oldLocation },
      resident_secondary: { ready: true, stale: false, updated_at: Date.now() },
    },
    security_people_location_refresh_v2: {
      version: 2,
      residents: {
        resident_primary: { last_request_at: Date.now() - 60_000 },
      },
    },
  });
  const command = {
    payload: { kind: "refresh_command", anyone_away: false, people_ready: false },
  };
  assert.equal(run("people_refresh_decide", structuredClone(command), flow, geoEnv), null);
  flow.get("security_people_location_refresh_v2").residents.resident_primary.last_request_at =
    Date.now() - 31 * 60_000;
  const requested = run("people_refresh_decide", structuredClone(command), flow, geoEnv);
  assert(requested[0]);
  assert.equal(requested[0].payload.refresh_source, "resident_primary");
  assert.equal(requested[1], null);
});

scenario("30b1 jitter do tick nao adia recovery por mais 30 segundos", () => {
  const command = {
    payload: { kind: "refresh_command", anyone_away: true, people_ready: false },
  };
  const early = memoryFlow({
    people_context_v1: {
      ready: false,
      resident_primary: { ready: false, stale: true, updated_at: Date.now() - 60 * 60_000 },
      resident_secondary: { ready: true, stale: false, updated_at: Date.now() },
    },
    security_people_location_refresh_v2: { version: 2, residents: {
      resident_primary: { last_request_at: Date.now() - (30 * 60_000 - 750) },
    } },
  });
  assert.equal(
    run("people_refresh_decide", structuredClone(command), early, geoEnv),
    null,
  );

  const schedulerJitter = memoryFlow({
    people_context_v1: {
      ready: false,
      resident_primary: { ready: false, stale: true, updated_at: Date.now() - 60 * 60_000 },
      resident_secondary: { ready: true, stale: false, updated_at: Date.now() },
    },
    security_people_location_refresh_v2: { version: 2, residents: {
      resident_primary: { last_request_at: Date.now() - (30 * 60_000 - 250) },
    } },
  });
  const requested = run(
    "people_refresh_decide",
    structuredClone(command),
    schedulerJitter,
    geoEnv,
  );
  assert(requested[0]);
  assert.equal(requested[1], null);
});

scenario("30b2 recovery solicita somente o morador com localização vencida", () => {
  const flow = memoryFlow({ people_context_v1: {
    ready: false,
    resident_primary: { ready: true, stale: false, updated_at: Date.now() },
    resident_secondary: {
      ready: false,
      stale: true,
      updated_at: Date.now() - 60 * 60_000,
    },
  } });
  const requested = run("people_refresh_decide", {
    payload: { kind: "refresh_command", people_ready: false },
  }, flow, geoEnv);
  assert.equal(requested[0], null);
  assert.equal(requested[1].payload.refresh_source, "resident_secondary");
  assert.deepEqual(requested[1].payload.refresh_routes, ["companion", "icloud"]);
});

scenario("30b3 observação posterior confirma semanticamente o refresh", () => {
  const before = Date.now() - 60 * 60_000;
  const state = {
    version: 2,
    residents: {
      resident_secondary: {
        last_request_at: Date.now() - 60_000,
        observed_at_before_request: before,
        awaiting_evidence: true,
        attempts: 1,
      },
    },
  };
  const flow = memoryFlow({
    people_context_v1: {
      ready: true,
      resident_primary: { ready: true, stale: false, updated_at: Date.now() },
      resident_secondary: { ready: true, stale: false, updated_at: before + 5 * 60_000 },
    },
    security_people_location_refresh_v2: state,
  });
  assert.equal(run("people_refresh_decide", {
    payload: { kind: "refresh_command", people_ready: true },
  }, flow, geoEnv), null);
  const confirmed = flow.get("security_people_location_refresh_v2").residents.resident_secondary;
  assert.equal(confirmed.awaiting_evidence, false);
  assert.equal(confirmed.attempts, 0);
  assert.equal(confirmed.last_success_at, before + 5 * 60_000);
});

scenario("30b3a falhas sem posição nova ampliam o backoff até quatro horas", () => {
  const oldLocation = Date.now() - 6 * 60 * 60_000;
  const command = {
    payload: { kind: "refresh_command", people_ready: false },
  };
  const flow = memoryFlow({
    people_context_v1: {
      ready: false,
      resident_primary: { ready: true, stale: false, updated_at: Date.now() },
      resident_secondary: { ready: false, stale: true, updated_at: oldLocation },
    },
    security_people_location_refresh_v2: {
      version: 2,
      residents: {
        resident_secondary: {
          last_request_at: Date.now() - 31 * 60_000,
          observed_at_before_request: oldLocation,
          awaiting_evidence: true,
          attempts: 2,
        },
      },
    },
  });
  assert.equal(
    run("people_refresh_decide", structuredClone(command), flow, geoEnv),
    null,
    "duas falhas devem elevar o cooldown para uma hora",
  );
  flow.get("security_people_location_refresh_v2").residents.resident_secondary.last_request_at =
    Date.now() - 61 * 60_000;
  const third = run("people_refresh_decide", structuredClone(command), flow, geoEnv);
  assert(third[1]);
  assert.equal(third[1].payload.refresh_attempt, 3);
  assert.equal(third[1].payload.refresh_cooldown_minutes, 60);

  const state = flow.get("security_people_location_refresh_v2");
  state.residents.resident_secondary.attempts = 5;
  state.residents.resident_secondary.last_request_at = Date.now() - 239 * 60_000;
  assert.equal(
    run("people_refresh_decide", structuredClone(command), flow, geoEnv),
    null,
    "o backoff máximo precisa segurar por quatro horas",
  );
  state.residents.resident_secondary.last_request_at = Date.now() - 241 * 60_000;
  const capped = run("people_refresh_decide", structuredClone(command), flow, geoEnv);
  assert(capped[1]);
  assert.equal(capped[1].payload.refresh_cooldown_minutes, 240);
});

scenario("30b4 TESTE percorre a decisão e termina antes do iCloud", () => {
  const flow = memoryFlow({ people_context_v1__test: {
    ready: false,
    resident_primary: { ready: false, stale: true, updated_at: Date.now() - 60 * 60_000 },
    resident_secondary: { ready: true, stale: false, updated_at: Date.now() },
  } });
  const requested = run("people_refresh_decide", {
    _location_test: true,
    payload: { kind: "refresh_command", people_ready: false, test_mode: true },
  }, flow, geoEnv);
  assert(requested[0]);
  const gated = runDirect("people_visual_primary_icloud_gate", requested[0], flow, geoEnv);
  assert.equal(gated[0], null);
  assert.equal(gated[1].payload.simulated, true);
  assert.equal(gated[1].payload.dispatched, false);
  assert(flow.get("security_people_location_refresh_v2__test"));
  assert.equal(flow.get("security_people_location_refresh_v2"), undefined);
});

scenario("30b5 posição atual fora não força polling silencioso", () => {
  const flow = memoryFlow({
    people_context_v1: {
      ready: true,
      anyone_away: true,
      nearest_distance_m: 5_000,
    },
    security_people_last_refresh_at: Date.now() - 60 * 60_000,
  });
  assert.equal(run("people_refresh_decide", {
    payload: { kind: "refresh_command", anyone_away: true, people_ready: true },
  }, flow, geoEnv), null);
});

scenario("30c vehicle_primary fora sozinho nao atualiza iPhones", () => {
  const flow = memoryFlow({
    people_context_v1: {
      ready: true,
      anyone_away: false,
      nearest_distance_m: 20,
    },
  });
  assert.equal(run("people_refresh_decide", {
    payload: { kind: "refresh_command", anyone_away: true, people_ready: true },
  }, flow, geoEnv), null);
  assert.equal(flow.get("security_people_last_refresh_at"), undefined);
});

scenario("31 desconexão transitória do HA é enfileirada e tratada", () => {
  const server = flows.find((item) => item.type === "server" && item.name === "Home Assistant");
  assert(server, "configuração do Home Assistant ausente");
  assert.equal(server.heartbeat, true);
  assert.equal(Number(server.heartbeatInterval), 30);

  const locationAdapters = ["564fdc36031eaef8", "e0b7c0ecf1d8ee28"].map((id) => byId.get(id));
  assert(locationAdapters.every((item) => item?.type === "change"));
  const contracts = locationAdapters.map((item) => item.rules.map((rule) => String(rule.to ?? "")).join("\n"));
  assert.match(contracts[0], /"recipients":\["resident_primary"\]/);
  assert.match(contracts[1], /"recipients":\["resident_secondary"\]/);
  const calls = locationAdapters.map((item) => byId.get(`${item.id}__hub_call`));
  assert(calls.every((item) => item?.type === "link call"));
  assert(calls.every((item) => item.links?.includes("notification_hub_mobile_in")));
  for (const id of ["notification_hub_mobile_primary_background", "notification_hub_mobile_secondary_background"]) {
    assert.equal(byId.get(id)?.queue, "first");
  }

  const catcher = byId.get("people_refresh_connection_catch");
  const handler = flows.find((item) => item.name === "Tratar desconexão transitória do HA");
  assert(catcher && handler, "tratamento de desconexão ausente");
  assert.deepEqual(new Set(catcher.scope), new Set([
    ...calls.map((item) => item.id),
    "people_visual_primary_icloud_update",
    "people_visual_secondary_icloud_update",
  ]));
  assert.equal(catcher.wires[0][0], handler.id);
  assert.match(handler.func, /connection lost/);
  assert.match(handler.func, /noconnectionerror/);
  assert.match(handler.func, /timedout\|timeout\|timed out/);
  assert.match(handler.func, /Falha inesperada/);
  assert.doesNotMatch(handler.func, /node\.error/);

  const execute = new Function("msg", "node", handler.func);
  const events = { errors: [], warnings: [], statuses: [] };
  const runtimeNode = {
    error: (value) => events.errors.push(value),
    warn: (value) => events.warnings.push(value),
    status: (value) => events.statuses.push(value),
  };
  assert.equal(execute({ error: { message: "Call-service error. timeout" } }, runtimeNode), null);
  assert.equal(events.errors.length, 0);
  assert.equal(events.warnings.length, 0);
  assert.match(events.statuses.at(-1).text, /refresh será reavaliado/);

  assert.equal(execute({ error: { message: "falha de domínio" } }, runtimeNode), null);
  assert.equal(events.errors.length, 0);
  assert.equal(events.warnings.length, 1);
  assert.match(events.warnings[0], /falha de domínio/);
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
  assert.equal(context.payload.context.in_use, false);
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
  assert.equal(pending.retention, "while_approaching");
  assert.equal(pending.expires_at, pending.queued_at + 90 * 60_000);

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
  assert(flow.get(pendingKey), "replay não consome a intenção antes do despacho");

  const preparedOn = run("light_prepare_arrival", engineOn[2], flow, geoEnv)[0];
  assert(run("light_check_vehicle_primary_in_use", preparedOn, flow, geoEnv));
});

scenario("33a motor ON reavalia morador armado que permanece em near_home", () => {
  const now = Date.now();
  const people = {
    ready: true,
    updated_at: now,
    arrival_armed: { resident_primary: false, resident_secondary: true },
    resident_primary: {
      ready: true, stale: false, state: "home", current_home: true,
      distance_m: 20, updated_at: now,
    },
    resident_secondary: {
      ready: true, stale: false, state: "near_home", current_home: false,
      distance_m: 650, updated_at: now,
    },
  };
  const vehicleOff = {
    ready: true, lighting_ready: true, in_use: false,
    engine_on: false, engine_state_valid: true, updated_at: now,
  };
  const vehicleOn = {
    ...vehicleOff,
    in_use: true,
    engine_on: true,
    updated_at: now + 1,
  };
  const flow = readyLightFlow({
    people_context_v1: people,
    vehicle_primary_context_v1: vehicleOff,
  });
  const engineOn = run("light_merge_context", {
    payload: {
      kind: "vehicle_primary_context",
      event: "turn_on",
      updated_at: now + 1,
      context: vehicleOn,
    },
  }, flow, geoEnv);
  assert(engineOn[2], "motor ON deve gerar reavaliação imediata da chegada armada");
  assert.equal(engineOn[2].payload.source, "resident_secondary");
  assert.equal(engineOn[2].payload.arrival_stage, "approach");
  assert.equal(engineOn[2].payload.arrival_replayed_after_engine_authorization, true);
  assert.equal(engineOn[2].payload.arrival_replayed_after_engine_on, true);
  const prepared = run("light_prepare_arrival", engineOn[2], flow, geoEnv)[0];
  assert(prepared, "reavaliação deve atravessar a decisão normal de chegada");
  assert(run("light_check_vehicle_primary_in_use", prepared, flow, geoEnv));

  const unarmed = readyLightFlow({
    people_context_v1: {
      ...people,
      arrival_armed: { resident_primary: false, resident_secondary: false },
    },
    vehicle_primary_context_v1: vehicleOff,
  });
  assert.equal(run("light_merge_context", {
    payload: {
      kind: "vehicle_primary_context",
      event: "turn_on",
      updated_at: now + 1,
      context: vehicleOn,
    },
  }, unarmed, geoEnv)[2], null, "near_home sem ciclo externo armado não pode acender");

  const repeated = readyLightFlow({
    people_context_v1: people,
    vehicle_primary_context_v1: vehicleOff,
  });
  assert.equal(run("light_merge_context", {
    payload: {
      kind: "vehicle_primary_context",
      event: "context_update",
      updated_at: now + 1,
      context: vehicleOn,
    },
  }, repeated, geoEnv)[2], null, "snapshot com motor já ON não pode recriar chegada");

  const bypassFlow = readyLightFlow({
    people_context_v1: people,
    vehicle_primary_context_v1: {
      ...vehicleOff,
      ready: false,
      lighting_ready: false,
      engine_communication_failed: true,
    },
    security_light_engine_bypass_enabled: true,
  });
  const bypassReplay = run("light_merge_context", {
    payload: {
      kind: "engine_bypass_context",
      enabled: true,
      communication_failed: true,
      updated_at: now + 2,
    },
  }, bypassFlow, geoEnv);
  assert(bypassReplay[2],
    "bypass que se torna válido deve reavaliar o morador armado mesmo sem intenção pendente");
  assert.equal(bypassReplay[2].payload.arrival_replayed_after_engine_bypass, true);
  const bypassPrepared = run("light_prepare_arrival", bypassReplay[2], bypassFlow, geoEnv)[0];
  assert.equal(bypassPrepared.payload.engine_bypass_allowed, true);
  assert(run("light_check_vehicle_primary_in_use", bypassPrepared, bypassFlow, geoEnv));
});

scenario("33e retorno local exige OFF e novo ON antes de acender", () => {
  const peopleFlow = memoryFlow();
  const departure = run(
    "people_normalize",
    peopleInput({
      source: "resident_secondary",
      previous: "home",
      current: "near_home",
    }),
    peopleFlow,
    geoEnv,
  )[0].payload.context;
  const excursion = departure.local_excursions.resident_secondary;
  assert(excursion, "home → near_home deve abrir um ciclo local sem virar chegada");

  const initialVehicle = {
    ready: true, lighting_ready: true, in_use: false,
    engine_on: false, engine_state_valid: true,
    engine_updated_at: excursion.started_at - 1,
    updated_at: excursion.started_at - 1,
  };
  const lightFlow = readyLightFlow({
    people_context_v1: departure,
    vehicle_primary_context_v1: initialVehicle,
  });
  run("light_merge_context", {
    payload: {
      kind: "people_context",
      source: "resident_secondary",
      updated_at: departure.updated_at,
      context: departure,
    },
  }, lightFlow, geoEnv);

  const firstOnAt = excursion.started_at + 1_000;
  const firstOn = run("light_merge_context", {
    payload: {
      kind: "vehicle_primary_context",
      event: "turn_on",
      updated_at: firstOnAt,
      context: {
        ...initialVehicle,
        in_use: true,
        engine_on: true,
        engine_updated_at: firstOnAt,
        updated_at: firstOnAt,
      },
    },
  }, lightFlow, geoEnv);
  assert.equal(firstOn[2], null, "o ON da saída não pode ser confundido com retorno");

  const offAt = firstOnAt + 1_000;
  run("light_merge_context", {
    payload: {
      kind: "vehicle_primary_context",
      event: "turn_off",
      updated_at: offAt,
      context: {
        ...initialVehicle,
        engine_updated_at: offAt,
        updated_at: offAt,
      },
    },
  }, lightFlow, geoEnv);

  const returnOnAt = offAt + 1_000;
  const returnOn = run("light_merge_context", {
    payload: {
      kind: "vehicle_primary_context",
      event: "turn_on",
      updated_at: returnOnAt,
      context: {
        ...initialVehicle,
        in_use: true,
        engine_on: true,
        engine_updated_at: returnOnAt,
        updated_at: returnOnAt,
      },
    },
  }, lightFlow, geoEnv)[2];
  assert(returnOn, "novo ON após a parada deve reconhecer a volta do passeio local");
  assert.equal(returnOn.payload.arrival_stage, "local_return");
  assert.equal(returnOn.payload.local_excursion_return, true);
  const prepared = run("light_prepare_arrival", returnOn, lightFlow, geoEnv)[0];
  assert(prepared, "retorno local deve atravessar a decisão de iluminação");
  assert(run("light_check_vehicle_primary_in_use", prepared, lightFlow, geoEnv));
});

scenario("33f OFF antes do primeiro ON não transforma saída em retorno", () => {
  const now = Date.now();
  const startedAt = now - 2_000;
  const people = {
    ready: true,
    updated_at: now,
    local_excursions: {
      resident_primary: { started_at: startedAt, expires_at: now + 90 * 60_000 },
    },
    resident_primary: {
      ready: true, stale: false, state: "near_home", current_home: false,
      updated_at: now,
    },
    resident_secondary: {
      ready: true, stale: false, state: "home", current_home: true,
      updated_at: now,
    },
  };
  const flow = readyLightFlow({ people_context_v1: people });
  const offAt = startedAt + 500;
  run("light_merge_context", {
    payload: { kind: "people_context", updated_at: now, context: people },
  }, flow, geoEnv);
  run("light_merge_context", {
    payload: { kind: "vehicle_primary_context", event: "context_update",
      updated_at: offAt, context: { ready: true, lighting_ready: true,
        in_use: false, engine_on: false, engine_state_valid: true,
        engine_updated_at: offAt, updated_at: offAt } },
  }, flow, geoEnv);
  const firstOnAt = now + 1_000;
  const firstOn = run("light_merge_context", {
    payload: { kind: "vehicle_primary_context", event: "turn_on",
      updated_at: firstOnAt, context: { ready: true, lighting_ready: true,
        in_use: true, engine_on: true, engine_state_valid: true,
        engine_updated_at: firstOnAt, updated_at: firstOnAt } },
  }, flow, geoEnv);
  assert.equal(firstOn[2], null,
    "o primeiro ON após sair com o carro inicialmente OFF ainda é a partida");
  const state = flow.get("security_light_local_excursion_v1");
  assert.equal(state.residents.resident_primary.engine_off_seen_at, null);
  assert.equal(state.residents.resident_primary.departure_engine_on_seen_at, firstOnAt);
});

scenario("33g evento de chegada leva a posição atual contra corrida de contexto", () => {
  const now = Date.now();
  const staleContext = {
    ready: true,
    updated_at: now - 1_000,
    resident_primary: {
      ready: true, stale: false, state: "not_home", current_home: false,
      updated_at: now - 1_000,
    },
    resident_secondary: {
      ready: true, stale: false, state: "home", current_home: true,
      updated_at: now,
    },
  };
  const flow = readyLightFlow({ people_context_v1: staleContext });
  const event = arrival("resident_primary", "approach");
  event.payload.event_at = now;
  event.payload.arrival_resident_snapshot = {
    ready: true, stale: false, state: "near_home", current_home: false,
    updated_at: now,
  };
  const prepared = run("light_prepare_arrival", event, flow, geoEnv)[0];
  assert(prepared,
    "evidência do próprio evento deve vencer o contexto interno imediatamente anterior");
  assert(run("light_check_vehicle_primary_in_use", prepared, flow, geoEnv));
});

scenario("34 pessoa near_home aciona com motor ON sem o carro estar near_home", () => {
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

scenario("34a posição antiga do carro não bloqueia chegada de morador", () => {
  for (const source of ["resident_primary", "resident_secondary"]) {
    const staleVehicle = {
      ready: false,
      lighting_ready: false,
      stale: true,
      in_use: true,
      engine_on: true,
      engine_state_valid: true,
      engine_stale: true,
      engine_communication_failed: false,
      location: { state: "not_home", stale: true, ready: false },
      updated_at: Date.now(),
    };
    const flow = readyLightFlow({
      vehicle_primary_context_v1: staleVehicle,
    });
    const decision = run(
      "light_prepare_arrival",
      arrival(source, "approach"),
      flow,
      geoEnv,
    );
    assert(decision[0], `${source}: motor ON confiável deve liberar a decisão`);
    assert.equal(decision[2], null, `${source}: posição antiga não deve pedir wake`);
    assert.equal(decision[0].payload.vehicle_primary_lighting_ready, true);
    assert.equal(decision[0].payload.vehicle_primary_engine_stale, true);
    assert(run("light_check_vehicle_primary_in_use", decision[0], flow, geoEnv));

    const vehicleDecision = run(
      "light_prepare_arrival",
      arrival("vehicle_primary", "approach"),
      readyLightFlow({ vehicle_primary_context_v1: staleVehicle }),
      geoEnv,
    );
    assert.equal(vehicleDecision[0], null, "chegada do carro não pode acender o refletor");
    assert.equal(vehicleDecision[2], null, "posição do carro não deve solicitar recovery para acender");
    assert.equal(vehicleDecision[1].payload.kind, "arrival_blocked");
  }
});

scenario("34b OFF conhecido bloqueia morador mesmo com posição antiga", () => {
  const flow = readyLightFlow({
    vehicle_primary_context_v1: {
      ready: false,
      lighting_ready: false,
      stale: true,
      in_use: false,
      engine_on: false,
      engine_state_valid: true,
      engine_stale: true,
      engine_communication_failed: false,
      location: { state: "not_home", stale: true, ready: false },
      updated_at: Date.now(),
    },
  });
  const decision = run(
    "light_prepare_arrival",
    arrival("resident_primary", "approach"),
    flow,
    geoEnv,
  );
  assert(decision[0], "OFF conhecido deve chegar ao gate bloqueante");
  assert.equal(decision[2], null, "OFF conhecido não precisa de recovery");
  assert.equal(
    run("light_check_vehicle_primary_in_use", decision[0], flow, geoEnv),
    null,
  );
});

scenario("34c falha de comunicação invalida OFF antigo e libera fallback", () => {
  const flow = readyLightFlow({
    security_light_engine_bypass_enabled: true,
    security_light_engine_bypass_automatic: true,
    vehicle_primary_context_v1: {
      ready: false,
      lighting_ready: false,
      stale: true,
      in_use: false,
      engine_on: false,
      engine_state_valid: true,
      engine_stale: true,
      engine_communication_failed: true,
      location: { state: "home", stale: true, ready: false },
      updated_at: Date.now(),
    },
  });
  const decision = run(
    "light_prepare_arrival",
    arrival("resident_primary", "approach"),
    flow,
    geoEnv,
  );
  assert(decision[0], "falha da API deve manter a chegada avaliável");
  assert.equal(decision[0].payload.engine_bypass_allowed, true);
  assert(
    run("light_check_vehicle_primary_in_use", decision[0], flow, geoEnv),
    "bypass automático deve superar um OFF antigo não confiável",
  );
});

scenario("35 near_home exige ciclo externo e recovery fica só na iluminação", () => {
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
      const blockedWithoutAwayCycle = run(
        "people_normalize",
        peopleInput({ source, previous, current: "near_home" }),
        memoryFlow(),
        geoEnv,
      );
      assert.equal(blockedWithoutAwayCycle[1], null, `${previous} não pode virar chegada geral`);
      assert.equal(blockedWithoutAwayCycle[2], null, `${previous} sem ciclo externo não pode ir à iluminação`);
      assert.equal(
        blockedWithoutAwayCycle[3].payload.direction_reason,
        "external_cycle_not_confirmed",
      );

      const recoveredAwayCycle = run(
        "people_normalize",
        peopleInput({ source, previous, current: "near_home" }),
        memoryFlow({ people_arrival_armed: { [source]: true } }),
        geoEnv,
      );
      assert(recoveredAwayCycle[2], `${previous} → near_home deve recuperar ciclo externo persistido`);
      assert.equal(recoveredAwayCycle[2].payload.illumination_only, true);
      assert.equal(recoveredAwayCycle[2].payload.arrival_previous_state, previous);
      assert.equal(recoveredAwayCycle[2].payload.external_cycle_confirmed, true);
      assert(run("light_prepare_arrival", recoveredAwayCycle[2], readyLightFlow(), geoEnv)[0],
        `${previous} → near_home armado e atual deve atravessar o gate final`);
    }

    const armedFlow = memoryFlow({
      people_arrival_armed: { [source]: true },
    });
    const fromAway = run(
      "people_normalize",
      peopleInput({ source, previous: "not_home", current: "near_home" }),
      armedFlow,
      geoEnv,
    );
    assert(fromAway[1], "not_home → near_home deve continuar como chegada geral");
    assert.equal(fromAway[2], null);

    for (const previous of ["home", "near_home"]) {
      const blocked = run(
        "people_normalize",
        peopleInput({ source, previous, current: "near_home" }),
        memoryFlow({ people_arrival_armed: { [source]: true } }),
        geoEnv,
      );
      assert.equal(blocked[1], null, `${previous} → near_home não pode ser chegada geral`);
      assert.equal(blocked[2], null, `${previous} → near_home não pode acionar iluminação`);
    }
    const namedExternal = run(
      "people_normalize",
      peopleInput({ source, previous: "work", current: "near_home" }),
      memoryFlow({ people_arrival_armed: { [source]: true } }),
      geoEnv,
    );
    assert(namedExternal[1], "zona externa canônica deve equivaler a not_home");
    assert.equal(namedExternal[1].payload.arrival_stage, "approach");
    assert(run("light_prepare_arrival", namedExternal[1], readyLightFlow(), geoEnv)[0],
      "zona externa nomeada deve atravessar o gate final como away");
  }

  assert.deepEqual(
    wireNames("people_normalize", 3),
    ["BLOQUEADO: saída/rebote (sem efeitos)"],
  );
  assert.deepEqual(
    wireNames("vehicle_primary_normalize", 3),
    ["BLOQUEADO: saída/rebote do veículo"],
  );
});

scenario("35a gate final recupera away → home e rejeita direção inválida", () => {
  assert.equal(byId.get("light_arrival_direction_gate").type, "switch");
  assert.equal(
    byId.get("light_arrival_direction_gate").property,
    "_light_arrival.direction_and_arrival_valid",
  );
  const blockedFlow = memoryFlow();
  let blockedMsg = runDirect("security_visual_arrival_facts",
    { payload: { kind: "arrival", source: "resident_primary", arrival_stage: "home" } },
    blockedFlow, geoEnv);
  assert.equal(blockedMsg._light_arrival.direction_valid, false);
  assert.equal(blockedMsg._light_arrival.direction_and_arrival_valid, false);
  blockedMsg = runDirect("security_light_arrival_direction_blocked_v1", blockedMsg, blockedFlow, geoEnv);
  const blocked = runDirect("62f77a1ad440639d", blockedMsg, blockedFlow, geoEnv);
  assert.equal(blocked[0], null);
  assert.equal(blocked[1].payload.kind, "arrival_blocked");
  assert.equal(blocked[1].payload.dispatched, false);

  const accepted = runDirect("security_visual_arrival_facts", arrival("resident_primary", "approach"),
    readyLightFlow(), geoEnv);
  assert.equal(accepted._light_arrival.direction_valid, true,
    "retorno com ciclo externo confirmado deve prosseguir");
  assert.equal(accepted._light_arrival.resident_arrival_valid, true,
    "somente morador atual em near_home vindo de away deve prosseguir");
  assert.equal(accepted._light_arrival.direction_and_arrival_valid, true,
    "o gate visual deve receber um booleano combinado válido");

  const homeBlocked = runDirect("security_visual_arrival_facts",
    arrival("resident_primary", "home"), readyLightFlow(), geoEnv);
  assert.equal(homeBlocked._light_arrival.resident_arrival_valid, false,
    "near_home → home não pode iniciar um novo acendimento");

  const now = Date.now();
  const homePeople = {
    ready: true,
    updated_at: now,
    resident_primary: {
      ready: true, stale: false, state: "home", current_home: true, updated_at: now,
    },
    resident_secondary: {
      ready: true, stale: false, state: "home", current_home: true, updated_at: now,
    },
  };
  const directHome = arrival("resident_primary", "home");
  directHome.payload.arrival_previous_state = "not_home";
  directHome.payload.event_at = now;
  directHome.payload.arrival_resident_snapshot = {
    ...homePeople.resident_primary,
  };
  const directHomeFlow = readyLightFlow({ people_context_v1: homePeople });
  const directHomeAccepted = runDirect(
    "security_visual_arrival_facts",
    directHome,
    directHomeFlow,
    geoEnv,
  );
  assert.equal(directHomeAccepted._light_arrival.direct_home_recovery, true);
  assert.equal(directHomeAccepted._light_arrival.arrival_path, "direct_home_recovery");
  assert.equal(directHomeAccepted._light_arrival.resident_arrival_valid, true,
    "not_home → home atual e confirmado deve recuperar a chegada perdida");
  assert.equal(directHomeAccepted._light_arrival.direction_and_arrival_valid, true);
  assert(run("light_prepare_arrival", directHome, directHomeFlow, geoEnv)[0],
    "salto direto confirmado deve chegar aos gates finais do refletor");

  const vehicleBlocked = runDirect("security_visual_arrival_facts",
    arrival("vehicle_primary", "approach"), readyLightFlow(), geoEnv);
  assert.equal(vehicleBlocked._light_arrival.resident_arrival_valid, false,
    "localização do carro não pode iniciar o acendimento");
  assert.deepEqual(byId.get("cf9bc321e0ec89f9").wires,
    [["security_visual_arrival_route_out"]]);
  assert(
    byId.get("light_merge_context").wires[2].includes(
      "light_arrival_replay_route_out_v1",
    ),
    "replay persistido também deve atravessar o gate visual de direção",
  );
});

scenario("35b backtest preserva near_home longo e recupera home com OFF vencido", () => {
  const now = Date.now();
  const homePeople = {
    ready: true,
    updated_at: now,
    arrival_armed: { resident_primary: false, resident_secondary: true },
    resident_primary: {
      ready: true, stale: false, state: "home", current_home: true, updated_at: now,
    },
    resident_secondary: {
      ready: true, stale: false, state: "home", current_home: true, updated_at: now,
    },
  };
  const staleOffAt = now - 50 * 60_000;
  const flow = readyLightFlow({
    people_context_v1: homePeople,
    vehicle_primary_context_v1: {
      ready: true,
      lighting_ready: false,
      in_use: false,
      engine_on: false,
      engine_state_valid: true,
      engine_stale: true,
      engine_updated_at: staleOffAt,
      updated_at: now,
    },
  });
  const finalHome = arrival("resident_secondary", "home");
  finalHome.payload.arrival_previous_state = "unavailable";
  finalHome.payload.event_at = now;
  finalHome.payload.arrival_resident_snapshot = {
    ...homePeople.resident_secondary,
  };
  const prepared = run("light_prepare_arrival", finalHome, flow, geoEnv);
  assert(prepared[0],
    "chegada home confirmada após perda temporária do GPS deve ser recuperada");
  assert.equal(prepared[0].payload.stale_engine_home_fallback, true);
  assert.equal(prepared[0].payload.engine_data_unreliable, true);
  const gated = run("light_check_vehicle_primary_in_use", prepared[0], flow, geoEnv);
  assert(gated, "OFF de 50 min não pode vetar o último trecho confirmado");
  assert.equal(gated.payload.vehicle_primary_gate,
    "confirmed_home_arrival_with_stale_engine_fallback");
  const available = run("light_check_inactive", gated, flow, geoEnv);
  assert(available[0], "refletor OFF deve aceitar a contingência confirmada");
  const dispatched = run("light_mark_active", available[0], flow, geoEnv);
  assert(dispatched[0], "contingência deve alcançar o comando real de turn_on");
  assert.equal(dispatched[0].payload.reason,
    "confirmed_home_arrival_with_stale_engine_fallback");
  assert.equal(flow.get("security_light_lifecycle_v1").active_by_arrival, true);

  const unconfirmed = structuredClone(finalHome);
  unconfirmed.payload.external_cycle_confirmed = false;
  assert.equal(run("light_prepare_arrival", unconfirmed, flow, geoEnv)[0], null,
    "GPS unavailable sem ciclo externo confirmado não pode ligar");

  const nearToHome = structuredClone(finalHome);
  nearToHome.payload.arrival_previous_state = "near_home";
  assert.equal(run("light_prepare_arrival", nearToHome, flow, geoEnv)[0], null,
    "near_home → home comum não pode criar um segundo acendimento");

  const freshOffFlow = readyLightFlow({
    people_context_v1: homePeople,
    vehicle_primary_context_v1: {
      ready: true, lighting_ready: true, in_use: false, engine_on: false,
      engine_state_valid: true, engine_stale: false, updated_at: now,
    },
  });
  const freshOff = run("light_prepare_arrival", finalHome, freshOffFlow, geoEnv)[0];
  assert(freshOff, "OFF atual deve alcançar o gate explícito");
  assert.equal(freshOff.payload.stale_engine_home_fallback, false);
  assert.equal(run("light_check_vehicle_primary_in_use", freshOff, freshOffFlow, geoEnv), null,
    "OFF atual continua sendo bloqueio forte");
});

scenario("35c aproximação sobrevive a GPS stale sem autorizar replay", () => {
  const now = Date.now();
  const flow = readyLightFlow({
    vehicle_primary_context_v1: {
      ready: true, lighting_ready: true, in_use: false, engine_on: false,
      engine_state_valid: true, engine_stale: false, updated_at: now,
    },
  });
  const queued = arrival("resident_secondary", "approach");
  queued.payload.event_at = now - 30 * 60_000;
  queued.payload.arrival_originally_queued_at = now - 30 * 60_000;
  assert(run("light_prepare_arrival", queued, flow, geoEnv)[0],
    "OFF atual deve guardar a aproximação mesmo sem passar pelo gate do motor");
  const key = "security_light_pending_arrival_v1";
  const pending = flow.get(key);
  assert(pending, "aproximação de 30 min deve continuar persistida");
  assert.equal(pending.expires_at, pending.queued_at + 90 * 60_000);

  const stalePeople = structuredClone(flow.get("people_context_v1"));
  stalePeople.updated_at = now + 1;
  stalePeople.resident_secondary = {
    ready: false, stale: true, state: "unavailable", current_home: false,
    updated_at: now - 20 * 60_000,
  };
  const staleUpdate = run("light_merge_context", {
    payload: { kind: "people_context", updated_at: now + 1, context: stalePeople },
  }, flow, geoEnv);
  assert.equal(staleUpdate[2], null,
    "localização stale não pode autorizar replay mesmo no escuro");
  assert(flow.get(key), "perda temporária do GPS não pode apagar a aproximação");

  const freshPeople = structuredClone(stalePeople);
  freshPeople.updated_at = now + 2;
  freshPeople.resident_secondary = {
    ready: true, stale: false, state: "near_home", current_home: false,
    updated_at: now + 2,
  };
  const engineOn = {
    ready: true, lighting_ready: true, in_use: true, engine_on: true,
    engine_state_valid: true, engine_stale: false, updated_at: now + 2,
  };
  flow.set("vehicle_primary_context_v1", engineOn);
  const refreshed = run("light_merge_context", {
    payload: { kind: "people_context", updated_at: now + 2, context: freshPeople },
  }, flow, geoEnv);
  assert(refreshed[2], "GPS atual em near_home com motor ON deve reprocessar a aproximação");
});

scenario("35d matriz de chegada home mantém fallback estritamente delimitado", () => {
  const previousStates = ["not_home", "work", "unknown", "unavailable", "near_home", "home"];
  const engineCases = [
    { name: "on", engine_on: true, in_use: true, engine_stale: false },
    { name: "off_fresh", engine_on: false, in_use: false, engine_stale: false },
    { name: "off_stale", engine_on: false, in_use: false, engine_stale: true },
  ];
  for (const previous of previousStates) {
    for (const confirmed of [false, true]) {
      for (const engine of engineCases) {
        const now = Date.now();
        const people = {
          ready: true, updated_at: now,
          resident_primary: {
            ready: true, stale: false, state: "home", current_home: true,
            updated_at: now,
          },
          resident_secondary: {
            ready: true, stale: false, state: "home", current_home: true,
            updated_at: now,
          },
        };
        const flow = readyLightFlow({
          people_context_v1: people,
          vehicle_primary_context_v1: {
            ready: true,
            lighting_ready: !engine.engine_stale,
            engine_state_valid: true,
            engine_updated_at: engine.engine_stale ? now - 50 * 60_000 : now,
            updated_at: now,
            ...engine,
          },
        });
        const event = arrival("resident_primary", "home");
        event.payload.arrival_previous_state = previous;
        event.payload.external_cycle_confirmed = confirmed;
        event.payload.event_at = now;
        event.payload.arrival_resident_snapshot = { ...people.resident_primary };
        const decision = run("light_prepare_arrival", event, flow, geoEnv);
        const directional = confirmed &&
          !["near_home", "home"].includes(previous);
        assert.equal(Boolean(decision[0]), directional,
          `${previous}/${confirmed}/${engine.name}: decisão direcional inesperada`);
        if (!directional) continue;
        const gated = run("light_check_vehicle_primary_in_use", decision[0], flow, geoEnv);
        const shouldPass = engine.name === "on" || engine.name === "off_stale";
        assert.equal(Boolean(gated), shouldPass,
          `${previous}/${confirmed}/${engine.name}: resultado do motor inesperado`);
        if (engine.name === "off_stale") {
          assert.equal(gated.payload.vehicle_primary_gate,
            "confirmed_home_arrival_with_stale_engine_fallback");
        }
      }
    }
  }
});

scenario("35e fallback de home tenta ligar mesmo com refletor unavailable", () => {
  const now = Date.now();
  const people = {
    ready: true, updated_at: now,
    resident_primary: {
      ready: true, stale: false, state: "home", current_home: true, updated_at: now,
    },
    resident_secondary: {
      ready: true, stale: false, state: "home", current_home: true, updated_at: now,
    },
  };
  const flow = readyLightFlow({
    people_context_v1: people,
    vehicle_primary_context_v1: {
      ready: true, lighting_ready: false, in_use: false, engine_on: false,
      engine_state_valid: true, engine_stale: true,
      engine_updated_at: now - 50 * 60_000, updated_at: now,
    },
    security_light_physical_state: "unavailable",
    light_reconciled: false,
  });
  const event = arrival("resident_primary", "home");
  event.payload.arrival_previous_state = "unavailable";
  event.payload.event_at = now;
  event.payload.arrival_resident_snapshot = { ...people.resident_primary };
  const prepared = run("light_prepare_arrival", event, flow, geoEnv)[0];
  const gated = run("light_check_vehicle_primary_in_use", prepared, flow, geoEnv);
  const available = run("light_check_inactive", gated, flow, geoEnv)[0];
  assert(available, "unavailable deve permitir a tentativa após todos os gates");
  const dispatched = run("light_mark_active", available, flow, geoEnv);
  assert(dispatched[0], "o comando real deve ser despachado");
  assert.equal(dispatched[0].payload.actuator_confirmation_pending, true);
  assert.equal(dispatched[0]._security_light_decision_state,
    "turn_on_attempted_while_unavailable");
});

scenario("35f falha de comunicação ainda exige bypass explicitamente ligado", () => {
  const now = Date.now();
  const people = {
    ready: true, updated_at: now,
    resident_primary: {
      ready: true, stale: false, state: "home", current_home: true, updated_at: now,
    },
    resident_secondary: {
      ready: true, stale: false, state: "home", current_home: true, updated_at: now,
    },
  };
  const vehicle = {
    ready: false, lighting_ready: false, in_use: false, engine_on: false,
    engine_state_valid: true, engine_stale: true,
    engine_communication_failed: true,
    engine_updated_at: now - 50 * 60_000, updated_at: now,
  };
  const event = arrival("resident_primary", "home");
  event.payload.arrival_previous_state = "unavailable";
  event.payload.event_at = now;
  event.payload.arrival_resident_snapshot = { ...people.resident_primary };

  const blockedFlow = readyLightFlow({
    people_context_v1: people,
    vehicle_primary_context_v1: vehicle,
    security_light_engine_bypass_enabled: false,
  });
  const blocked = run("light_prepare_arrival", structuredClone(event), blockedFlow, geoEnv);
  assert.equal(blocked[0], null,
    "falha de comunicação não pode usar automaticamente o fallback de OFF stale");

  const bypassFlow = readyLightFlow({
    people_context_v1: people,
    vehicle_primary_context_v1: vehicle,
    security_light_engine_bypass_enabled: true,
  });
  const prepared = run("light_prepare_arrival", structuredClone(event), bypassFlow, geoEnv)[0];
  assert(prepared, "bypass explicitamente ligado deve manter a contingência existente");
  const gated = run("light_check_vehicle_primary_in_use", prepared, bypassFlow, geoEnv);
  assert(gated);
  assert.equal(gated.payload.vehicle_primary_gate, "manual_bypass_for_unreliable_engine");
});

scenario("36 unavailable tenta ligar uma vez e aguarda reconciliação física", () => {
  const unavailableFlow = readyLightFlow({
    security_light_physical_state: "unavailable",
    light_reconciled: false,
  });
  const candidate = {
    payload: {
      arrival_key: "resident_secondary:approach:1",
      source: "resident_secondary",
      vehicle_primary_gate: "known_engine_on",
    },
  };

  const first = run(
    "light_check_inactive",
    structuredClone(candidate),
    unavailableFlow,
    geoEnv,
  );
  assert(first[0], "unavailable deve seguir para uma tentativa real de acendimento");
  assert.equal(first[0].payload.actuator_available, false);
  assert.equal(first[0].payload.actuator_confirmation_pending, true);
  assert.equal(first[0].payload.reflector_state_before_attempt, "unavailable");
  assert.equal(first[1], null);
  assert.equal(first[2], null);
  const dispatched = run(
    "light_mark_active",
    first[0],
    unavailableFlow,
    geoEnv,
  );
  assert(dispatched[0], "produção deve despachar turn_on mesmo com unavailable");
  assert.equal(dispatched[0].payload.actuator_confirmation_pending, true);
  assert.equal(dispatched[0]._security_light_decision_state,
    "turn_on_attempted_while_unavailable");
  assert.equal(
    unavailableFlow.get("security_light_turn_on_notification_latch_v1").reason,
    "turn_on_dispatched_while_unavailable",
  );

  assert.deepEqual(
    run(
      "light_check_inactive",
      { payload: { arrival_key: "resident_primary:approach:2" } },
      unavailableFlow,
      geoEnv,
    ),
    [null, null, null],
    "o lifecycle ativo deve impedir tentativas repetidas durante unavailable",
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
  assert(run("light_check_inactive", structuredClone(candidate), unavailableFlow, geoEnv)[0],
    "OFF físico deve liberar um novo ciclo de acendimento");

  const testFlow = readyLightFlow({
    security_light_physical_state: "unavailable",
    light_reconciled: false,
    people_context_v1__test: {
      ready: true,
      resident_secondary: {
        ready: true, stale: false, state: "near_home", current_home: false,
        updated_at: Date.now(),
      },
    },
    security_light_lifecycle_v1__test: {
      version: 1, active_by_arrival: false, updated_at: Date.now(),
    },
  });
  const testResult = run("light_check_inactive", {
    _location_test: true,
    payload: {
      test_mode: true,
      arrival_key: "test:resident_secondary:approach",
    },
  }, testFlow, geoEnv);
  assert(testResult[0], "TESTE deve atravessar a mesma autorização de unavailable");
  assert.equal(testResult[1], null);
  assert.equal(testResult[2], null);
  testResult[0].payload.source = "resident_secondary";
  testResult[0].payload.vehicle_primary_gate = "known_engine_on";
  const simulated = run("light_mark_active", testResult[0], testFlow, geoEnv);
  assert.equal(simulated[0], null, "TESTE não pode usar o ramo de produção");
  assert(simulated[1], "TESTE deve chegar ao terminal dry-run após todos os gates");

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
  const afterOutage = run("light_check_inactive", structuredClone(candidate), onFlow, geoEnv);
  assert(afterOutage[0],
    "unavailable após estado ON também deve permitir nova tentativa de ligar");
  assert.equal(afterOutage[0].payload.actuator_confirmation_pending, true);
});

scenario("37 tracker stale da outra pessoa não bloqueia chegada válida", () => {
  const flow = readyLightFlow({
    people_context_v1: {
      ready: false,
      resident_primary: { ready: true, stale: false, state: "near_home", updated_at: Date.now() },
      resident_secondary: { ready: false, stale: true, state: "not_home" },
    },
  });
  const result = run("light_mark_active", {
    payload: {
      source: "resident_primary",
      arrival_key: "resident_primary:approach:isolated-stale-peer",
      vehicle_primary_gate: "known_engine_on",
    },
  }, flow, geoEnv);
  assert(result[0], "a chegada da fonte pronta deve criar o lifecycle");
  assert.equal(flow.get("security_light_lifecycle_v1").active_by_arrival, true);
});

scenario("38 chegada pendente persiste somente contrato reexecutável", () => {
  const flow = readyLightFlow();
  let msg = runDirect(
    "security_visual_arrival_facts",
    arrival("resident_primary", "approach"),
    flow,
    geoEnv,
  );
  msg = runDirect("security_visual_arrival_pending", msg, flow, geoEnv);
  const pending = flow.get("security_light_pending_arrival_v1");
  assert.doesNotThrow(() => structuredClone(pending));
  assert.equal(pending.version, 2);
  assert.equal(pending.message._light_arrival, undefined);
  assert.equal(msg._light_arrival.diagnostic.payload.diagnostic, "arrival_trigger_received");
});

scenario("39 HOME não inicia acendimento; near_home não arma o refresh de 90 s", () => {
  const home = run("light_prepare_arrival",
    arrival("resident_primary", "home"), readyLightFlow(), geoEnv);
  assert.equal(home[0], null, "a chegada HOME não deve iniciar o acendimento");
  assert.equal(home[1].payload.kind, "arrival_blocked");
  const approach = run("light_mark_active", {
    payload: { ...arrival("resident_primary", "approach").payload,
      arrival_key: "resident_primary:approach:real", vehicle_primary_gate: "known_engine_on" },
  }, readyLightFlow(), geoEnv);
  assert.equal(approach.length, 2);
  assert.equal(approach[0]?.payload.deadline_type, "backstop");
});

scenario("40 confirmação HOME pertence ao fluxo contexto_chegadas", () => {
  assert(byId.has("arrival_context_home_refresh_build"));
  assert.equal(byId.get("arrival_context_home_refresh_build").z, "62bb822e033d1623");
  assert.equal(byId.get("arrival_context_home_refresh_build").func.includes("require_lighting_ready: false"), true);
});

scenario("41 backtest: chegada antes do anoitecer renova GPS antes de vencer", () => {
  const now = Date.now();
  const observedAt = now - 10 * 60_000 - 1_000;
  const flow = readyLightFlow({
    sun_below_horizon: false,
    people_context_v1: {
      ready: true, updated_at: observedAt,
      arrival_armed: { resident_primary: true, resident_secondary: false },
      resident_primary: { ready: true, stale: false, state: "near_home",
        current_home: false, distance_m: 344, updated_at: observedAt },
      resident_secondary: { ready: true, stale: false, state: "home",
        current_home: true, distance_m: 20, updated_at: now },
    },
    security_light_arrival_watch_v1: { version: 1, residents: {
      resident_primary: { source: "resident_primary", event_at: observedAt,
        created_at: observedAt, attempts: 0, last_refresh_at: null,
        waiting_for_callback: false },
    } },
  });
  const output = run("light_merge_context", {
    payload: { kind: "sun_context", sun_below_horizon: false, updated_at: now },
  }, flow, geoEnv);
  assert(output[3], "a vigília deve pedir atualização antes dos 15 min");
  assert.equal(output[3].payload.source, "resident_primary");
  assert.equal(output[3].payload.attempt, 1);
  assert.equal(output[3].payload.reason, "near_home_refresh_before_stale");

  const oneMinuteLater = run("light_merge_context", {
    payload: { kind: "sun_context", sun_below_horizon: false,
      updated_at: now + 60_001 },
  }, flow, geoEnv);
  assert.equal(oneMinuteLater[3], null,
    "a segunda tentativa deve ficar reservada para motor ou bypass");
  assert.equal(flow.get("security_light_arrival_watch_v1").residents.resident_primary.attempts, 1);
});

scenario("42 backtest: motor ON com GPS vencido pede fonte certa e não acende", () => {
  const now = Date.now();
  const oldAt = now - 21 * 60_000;
  const people = {
    ready: true, updated_at: oldAt,
    arrival_armed: { resident_primary: false, resident_secondary: true },
    resident_primary: { ready: true, stale: false, state: "home",
      current_home: true, updated_at: now },
    resident_secondary: { ready: true, stale: false, state: "near_home",
      current_home: false, distance_m: 650, updated_at: oldAt },
  };
  const vehicleOff = { ready: true, lighting_ready: true, in_use: false,
    engine_on: false, engine_state_valid: true, updated_at: now - 1 };
  const flow = readyLightFlow({
    people_context_v1: people, vehicle_primary_context_v1: vehicleOff,
    security_light_arrival_watch_v1: { version: 1, residents: {
      resident_secondary: { source: "resident_secondary", event_at: oldAt,
        created_at: oldAt, attempts: 1, last_refresh_at: now - 11 * 60_000,
        waiting_for_callback: true },
    } },
  });
  const output = run("light_merge_context", { payload: {
    kind: "vehicle_primary_context", event: "turn_on", updated_at: now,
    context: { ...vehicleOff, in_use: true, engine_on: true, updated_at: now },
  } }, flow, geoEnv);
  assert.equal(output[2], null, "posição vencida nunca pode produzir replay");
  assert.equal(output[3].payload.source, "resident_secondary");
  assert.equal(output[3].payload.reason, "engine_authorized_location_stale");
  assert.equal(output[3].payload.attempt, 2,
    "motor ON deve consumir a tentativa reservada, não uma repetição periódica");
});

scenario("43 callback atual em near_home conclui o replay; callback home cancela", () => {
  const now = Date.now();
  const makeFlow = () => readyLightFlow({
    people_context_v1: {
      ready: false, updated_at: now - 16 * 60_000,
      arrival_armed: { resident_primary: true, resident_secondary: false },
      resident_primary: { ready: false, stale: true, state: "near_home",
        current_home: null, updated_at: now - 16 * 60_000 },
      resident_secondary: { ready: true, stale: false, state: "home",
        current_home: true, updated_at: now },
    },
    security_light_arrival_watch_v1: { version: 1, residents: {
      resident_primary: { source: "resident_primary", event_at: now - 16 * 60_000,
        created_at: now - 16 * 60_000, attempts: 1, last_refresh_at: now - 5_000,
        waiting_for_callback: true },
    } },
  });
  const nearFlow = makeFlow();
  const nearContext = structuredClone(nearFlow.get("people_context_v1"));
  nearContext.ready = true; nearContext.updated_at = now;
  Object.assign(nearContext.resident_primary, {
    ready: true, stale: false, state: "near_home", current_home: false,
    distance_m: 466, updated_at: now,
  });
  const replay = run("light_merge_context", { payload: {
    kind: "people_context", source: "resident_primary", updated_at: now,
    context: nearContext,
  } }, nearFlow, geoEnv)[2];
  assert(replay);
  assert.equal(replay.payload.arrival_replayed_after_location_refresh, true);

  const homeFlow = makeFlow();
  const homeContext = structuredClone(homeFlow.get("people_context_v1"));
  homeContext.ready = true; homeContext.updated_at = now;
  Object.assign(homeContext.resident_primary, {
    ready: true, stale: false, state: "home", current_home: true,
    distance_m: 20, updated_at: now,
  });
  const homeOutput = run("light_merge_context", { payload: {
    kind: "people_context", source: "resident_primary", updated_at: now,
    context: homeContext,
  } }, homeFlow, geoEnv);
  assert.equal(homeOutput[2], null);
  assert.equal(homeFlow.get("security_light_arrival_watch_v1").residents.resident_primary,
    undefined, "home deve encerrar a vigília sem acender");
});

scenario("44 flags antigas não burlam o timestamp real da localização", () => {
  const oldAt = Date.now() - 16 * 60_000;
  const flow = readyLightFlow({ people_context_v1: {
    ready: true,
    resident_primary: { ready: true, stale: false, state: "near_home",
      current_home: false, updated_at: oldAt },
    resident_secondary: { ready: true, stale: false, state: "home",
      current_home: true, updated_at: Date.now() },
  } });
  const result = run("light_mark_active", { payload: {
    source: "resident_primary", arrival_key: "stale-flag-regression",
    vehicle_primary_gate: "known_engine_on",
  } }, flow, geoEnv);
  assert.equal(result, null);
});

scenario("45 refresh extraordinário é por morador e ignora cooldown genérico", () => {
  const primary = runDirect("people_visual_arrival_refresh_dispatch", {
    payload: { kind: "arrival_location_refresh", source: "resident_primary" },
  });
  assert(primary[0]); assert.equal(primary[1], null);
  const secondary = runDirect("people_visual_arrival_refresh_dispatch", {
    payload: { kind: "arrival_location_refresh", source: "resident_secondary" },
  });
  assert.equal(secondary[0], null); assert(secondary[1]);
  assert.deepEqual(byId.get("people_visual_arrival_refresh_dispatch").wires,
    [
      ["564fdc36031eaef8", "people_visual_primary_icloud_out"],
      ["e0b7c0ecf1d8ee28", "people_visual_secondary_icloud_out"],
    ]);
  assert.equal(byId.get("people_visual_primary_icloud_update").action,
    "public_bindings.call");
  assert.equal(byId.get("people_visual_secondary_icloud_update").action,
    "public_bindings.call");
});

scenario("46 política alinha retenção e refresh preventivo ao frescor", () => {
  assert.equal(LOCATION_POLICY.arrival_recovery_minutes, 15);
  assert.equal(LOCATION_POLICY.local_excursion_minutes, 90);
  assert.equal(LOCATION_POLICY.near_home_refresh_minutes, 10);
  assert(LOCATION_POLICY.near_home_refresh_minutes < LOCATION_POLICY.location_fresh_minutes);
});

scenario("47 decisão canônica publica estado e atributos para o Recorder", () => {
  const flow = memoryFlow();
  const discovery = runDirect("security_visual_decision_publish", {
    topic: "security_light_decision_discovery", payload: "",
  }, flow, geoEnv)[0][0];
  assert.equal(discovery.topic,
    "homeassistant/sensor/security_light_last_decision/config");
  const published = runDirect("security_visual_decision_publish", {
    _security_light_decision_state: "waiting_location_refresh",
    payload: { source: "resident_secondary", reason: "engine_authorized_location_stale", attempt: 1 },
  }, flow, geoEnv)[0];
  assert.equal(published[0].payload, "waiting_location_refresh");
  assert.equal(JSON.parse(published[1].payload).source, "resident_secondary");
  assert.equal(flow.get("security_light_last_decision_v1").decision,
    "waiting_location_refresh");
});

assert.equal(passed.length, 77);
console.log(`security context/light replay: ${passed.length} cenarios OK`);
for (const name of passed) console.log(name);
