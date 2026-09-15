import assert from "node:assert/strict";
import fs from "node:fs";
import {
  ensureArrivalContextPolicy, runArrivalContextVisual, runPeopleVisual,
  runSecurityArrivalVisual, runSecurityContextVisual, runSecurityReconcileVisual,
  runVehicleRefreshVisual, runVehicleVisual,
} from "./visual-flow-test-harness.mjs";

const flows = JSON.parse(fs.readFileSync(new URL("../flows.json", import.meta.url), "utf8"));
const byId = new Map(flows.map((item) => [item.id, item]));
const aliasesByName = {
  vehicle_primary_refresh_policy: "Escolher presença, chegada armada e motor",
  vehicle_primary_refresh_quiet_hours: "Pausar madrugada se ambos em casa",
  light_check_vehicle_primary_in_use: "vehicle_primary está em uso?",
  light_turn_off_if_active: "Desativar somente se foi ligado por chegada",
  light_reconcile: "Emitir deadlines reconstruídos",
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
const NOW = Date.parse("2026-08-13T12:00:00.000Z");
const originalNow = Date.now;
Date.now = () => NOW;
const LOCATION_POLICY = {
  version: 1, owner: "node_red", complete: true,
  near_home_radius_m: 700, location_fresh_minutes: 15,
  source_report_fresh_minutes: 75, recency_tie_seconds: 60,
  max_gps_accuracy_m: 100, vehicle_location_fresh_minutes: 30,
  movement_threshold_m: 250, home_radius_m: 100,
  arrival_recovery_minutes: 15, near_home_refresh_minutes: 10,
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
  const values = new Map([["location_policy_v1", LOCATION_POLICY],
    ["security_light_policy_v1", SECURITY_LIGHT_POLICY]]);
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

function runDirect(id, msg, flow = memoryFlow(), warnings = []) {
  const target = byId.get(id);
  assert(target, `node ausente: ${id}`);
  const execute = new Function("msg", "node", "context", "flow", "global", "env", "setTimeout", "clearTimeout", target.func);
  const env = { get: (key) => ({ HOME_LAT: "0", HOME_LON: "0", GATE_LAT: "0", GATE_LON: "0" })[key] };
  return execute(msg, { warn: (text) => warnings.push(text), error() {}, log() {}, status() {} }, {}, flow, memoryGlobal(), env, setTimeout, clearTimeout);
}

function run(id, msg, flow = memoryFlow(), warnings = []) {
  const call = (nodeId, current) => runDirect(nodeId, current, flow, warnings);
  if (id === "people_normalize") return runPeopleVisual(call, msg);
  if (id === "vehicle_primary_normalize") return runVehicleVisual(call, msg);
  if (id === "vehicle_primary_refresh_decide") return runVehicleRefreshVisual(call, msg);
  if (id === "light_prepare_arrival") return runSecurityArrivalVisual(call, msg);
  if (id === "light_merge_context") return runSecurityContextVisual(call, msg);
  if (id === "light_reconcile") return runSecurityReconcileVisual(call, msg);
  if (id === "context_coordinator") {
    if (!flow.get("arrival_context_policy_v1")) ensureArrivalContextPolicy(call);
    return runArrivalContextVisual(call, msg);
  }
  return runDirect(id, msg, flow, warnings);
}

function runPeoplePipeline(msg, flow = memoryFlow()) {
  return run("people_normalize", msg, flow);
}

function runVehicleRefresh(msg, flow) {
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
  const branches = run("vehicle_primary_refresh_policy", msg, flow);
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
  const allowed = run("vehicle_primary_refresh_quiet_hours", selected, flow);
  return allowed
    ? run("vehicle_primary_refresh_decide", allowed, flow)
    : null;
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
    resident_primary_selected: source === "resident_primary" ? selected : home,
    resident_secondary: source === "resident_secondary" ? selected : home,
    resident_secondary_icloud: source === "resident_secondary" ? selected : home,
    resident_secondary_selected: source === "resident_secondary" ? selected : home,
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
  return { payload: { contract: "security.arrival.v1", kind: "arrival", source, arriving: [source], arrival_source_type: source === "vehicle_primary" ? "vehicle_primary" : "person", arrival_stage: stage, arrival_previous_state: stage === "approach" ? "not_home" : "near_home", arrival_direction: "returning", external_cycle_confirmed: true, event_at: eventAt } };
}

function lifecycle(overrides = {}) {
  return { version: 1, active_by_arrival: true, on_since: NOW - 60_000, force_off_at: NOW + 14 * 60_000, updated_at: NOW - 60_000, ...overrides };
}

function readyFlow(extra = {}) {
  return memoryFlow({
    people_context_v1: { ready: true, updated_at: NOW,
      resident_primary: { ready: true, stale: false, state: "home", current_home: true, primary_home: true, updated_at: NOW },
      resident_secondary: { ready: true, stale: false, state: "home", current_home: true, primary_home: true, updated_at: NOW } },
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
  const result = run("vehicle_primary_normalize", vehicle_primaryInput({ state: "not_home", distance: 5_000, engine: "on", engineAge: 10 * 60_000 }), flow)[0].payload.context;
  assert.equal(result.in_use, true);
  assert.equal(result.trip_active, true);
});

scenario("03 restart durante aproximação", () => {
  const flow = memoryFlow({ security_people_recovery_v1: { version: 1, arrival_armed: { resident_primary: true } } });
  const result = run("people_normalize", peopleInput({ event: "location_update", state: "near_home", distance: 650 }), flow);
  assert.equal(result[1].payload.arrival_stage, "approach");
});

scenario("04 restart dentro do raio near_home", () => {
  const result = run("vehicle_primary_normalize", vehicle_primaryInput({ event: "location_update", state: "near_home", distance: 650, engine: "on" }), memoryFlow({ vehicle_primary_arrival_armed: true }));
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

scenario("07 restart remove deadline legado de refresh do refletor", () => {
  const flow = readyFlow({ security_light_lifecycle_v1: lifecycle({ vehicle_refresh_at: NOW + 30_000, vehicle_refresh_source: "resident_primary" }) });
  const recovered = run("light_reconcile", { payload: { kind: "light_physical", state: "on" } }, flow)[0];
  assert.equal(recovered.some((msg) => msg.payload.deadline_type === "vehicle_refresh"), false);
  assert.equal(flow.get("security_light_lifecycle_v1").vehicle_refresh_at, null);
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
  const output = run("vehicle_primary_normalize", vehicle_primaryInput({ event: "location_update", state: "near_home", distance: 1_400, locationAge: 31 * 60_000, engine: "unknown", engineAge: 10 * 60_000 }), memoryFlow());
  assert.equal(output[0].payload.context.ready, false);
  assert.equal(output[0].payload.context.in_use, null);
  assert.equal(output[1], null);
});

scenario("13 restart com iPhone resident_primary stale", () => {
  const output = run("people_normalize", peopleInput({ source: "resident_primary", event: "location_update", state: "near_home", distance: 1_400, age: 16 * 60_000 }), memoryFlow());
  assert.equal(output[0].payload.context.resident_primary.stale, true);
  assert.equal(output[0].payload.context.ready, false);
  assert.equal(output[1], null);
});

scenario("14 restart com iPhone resident_secondary stale", () => {
  const output = run("people_normalize", peopleInput({ source: "resident_secondary", event: "location_update", state: "near_home", distance: 1_400, age: 16 * 60_000 }), memoryFlow());
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

scenario("18 snapshots near_home fora de ordem", () => {
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
  const result = run("vehicle_primary_normalize", vehicle_primaryInput({ state: "not_home", distance: 5_000, locationAge: 31 * 60_000, engine: "unknown", engineAge: 10 * 60_000 }), flow)[0].payload.context;
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
  assert.equal(runVehicleRefresh({ payload: { kind: "refresh_command", anyone_away: true } }, flow), null);
});

scenario("23 recovery preserva somente o backstop", () => {
  const flow = readyFlow({ security_light_lifecycle_v1: lifecycle({ vehicle_refresh_at: NOW + 45_000, vehicle_refresh_source: "resident_primary" }) });
  const messages = run("light_reconcile", { payload: { kind: "light_physical", state: "on" } }, flow)[0];
  assert.equal(messages.some((msg) => msg.payload.deadline_type === "vehicle_refresh"), false);
  assert(messages.some((msg) => msg.payload.deadline_type === "backstop"));
});

scenario("24 recovery descarta refresh legado já vencido", () => {
  const flow = readyFlow({ security_light_lifecycle_v1: lifecycle({ vehicle_refresh_at: NOW - 1_000, vehicle_refresh_source: "resident_primary" }) });
  const messages = run("light_reconcile", { payload: { kind: "light_physical", state: "on" } }, flow)[0];
  assert.equal(messages.some((msg) => msg.payload.deadline_type === "vehicle_refresh"), false);
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
    memoryFlow({ people_context_v1: {
      ready: false,
      resident_primary: { ready: true, stale: false, state: "near_home", current_home: false, updated_at: NOW },
    } }),
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
      resident_secondary: { state: "near_home" },
    },
  } }, flow);
  const first = run("context_coordinator", { payload: { kind: "vehicle_primary_context", ready: true, refresh_cycle_id: cycle, context: { ready: true } } }, flow);
  const duplicate = run("context_coordinator", { payload: { kind: "vehicle_primary_context", ready: true, refresh_cycle_id: cycle, context: { ready: true } } }, flow);
  assert(first[1]);
  assert.equal(first[1].payload.resident_primary_state, "home");
  assert.equal(first[1].payload.resident_secondary_state, "near_home");
  assert.equal(duplicate, null);
});

scenario("31 snapshot antigo near_home após snapshot novo", () => {
  const flow = memoryFlow();
  run("light_merge_context", { payload: { kind: "vehicle_primary_context", updated_at: NOW, context: { updated_at: NOW, ready: true, in_use: true } } }, flow);
  run("light_merge_context", { payload: { kind: "vehicle_primary_context", updated_at: NOW - 1, context: { updated_at: NOW - 1, ready: true, in_use: false } } }, flow);
  assert.equal(flow.get("vehicle_primary_context_v1").in_use, true);
});

scenario("32 retry repetido de Bluelink", () => {
  const flow = memoryFlow({ vehicle_primary_context_v1: { away: true } });
  runVehicleRefresh({ payload: { kind: "refresh_command", anyone_away: true } }, flow);
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
      semantic_evidence_window_ms: 20 * 60_000,
      baseline_observed_at: {
        telemetry: NOW - 2_000,
      },
    },
  });
  run("vehicle_primary_normalize", vehicle_primaryInput(), flow);
  assert.equal(flow.get("security_vehicle_primary_refresh_v1").attempts, 0);
  assert.equal(flow.get("security_vehicle_primary_refresh_v1").awaiting_evidence, false);
});

scenario("34 OFF conhecido encerra viagem mesmo antigo", () => {
  const flow = memoryFlow({ security_vehicle_primary_recovery_v1: { version: 1, in_use: true, trip_active: true, last_confirmed_at: NOW - 60_000 } });
  const result = run("vehicle_primary_normalize", vehicle_primaryInput({ state: "not_home", distance: 10_000, engine: "off", engineAge: 10 * 60_000 }), flow)[0].payload.context;
  assert.equal(result.in_use, false);
  assert.equal(result.in_use_reason, "known_engine_off");
  assert.equal(result.engine_stale, true);
});

scenario("35 viagem terminando durante restart", () => {
  const flow = memoryFlow({ security_vehicle_primary_recovery_v1: { version: 1, in_use: true, trip_active: true, last_confirmed_at: NOW - 60_000 } });
  const result = run("vehicle_primary_normalize", vehicle_primaryInput({ state: "home", distance: 20, engine: "off", lock: "unlocked" }), flow)[0].payload.context;
  assert.equal(result.in_use, false);
  assert.equal(result.trip_active, false);
});

scenario("36 evento de chegada duplicado após restart", () => {
  const flow = memoryFlow({ security_people_recovery_v1: { version: 1, arrival_armed: { resident_primary: true } } });
  const input = peopleInput({ event: "location_update", state: "near_home", distance: 650 });
  assert(run("people_normalize", structuredClone(input), flow)[1]);
  assert.equal(run("people_normalize", structuredClone(input), flow)[1], null);
});

scenario("37 normalizador de pessoas não envia notificações laterais", () => {
  const flow = memoryFlow({ security_people_recovery_v1: { version: 1, arrival_armed: { resident_secondary: true } } });
  const input = peopleInput({ source: "resident_secondary", event: "location_update", state: "near_home", distance: 650 });
  const result = run("people_normalize", structuredClone(input), flow);
  assert.equal(result.length, 4);
  assert(result[1]);
  assert.equal(result[2], null);
  assert.equal(result[3], null);
});

scenario("38 lifecycle legado perde somente o refresh movido", () => {
  const flow = readyFlow({
    people_context_v1: { ready: true, resident_primary: { current_home: false } },
    security_light_lifecycle_v1: lifecycle({ vehicle_refresh_at: NOW - 1, vehicle_refresh_source: "resident_primary" }),
  });
  run("light_reconcile", { payload: { kind: "light_physical", state: "on" } }, flow);
  assert.equal(flow.get("security_light_lifecycle_v1").vehicle_refresh_at, null);
  assert.equal(flow.get("security_light_lifecycle_v1").active_by_arrival, true);
});

scenario("39 timeout expirou enquanto Node-RED estava offline", () => {
  const flow = readyFlow({
    people_context_v1: { ready: false },
    vehicle_primary_context_v1: { ready: false },
    sun_ready: false,
    light_reconciled: false,
    security_light_physical_observed_at: NOW - 60 * 60_000,
    security_light_lifecycle_v1: lifecycle({ force_off_at: NOW - 1 }),
  });
  const command = run("light_turn_off_if_active", { payload: { deadline_type: "backstop" } }, flow);
  assert(command, "backstop não pode depender de contextos de localização");
  assert.equal(command.payload.backstop_forced, true);
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
  const mobile = entity("near_home", 231, 3 * 24 * 60 * 60_000, 10);
  mobile.entity_id = "device_tracker.mobile_primary_source_1";
  const icloud = entity("home", 25, 0, 4);
  icloud.entity_id = "device_tracker.mobile_primary_source_2";
  const input = peopleInput({ event: "context_snapshot" });
  input.payload.resident_primary = mobile;
  input.payload.resident_primary_icloud = icloud;

  const context = runPeoplePipeline(input, memoryFlow())[0].payload.context;
  assert.equal(context.resident_primary.entity_id, icloud.entity_id);
  assert.equal(context.resident_primary.state, "home");
  assert.equal(context.resident_primary.distance_m, 25);
});

scenario("42 trackers quase simultâneos usam a melhor precisão", () => {
  const mobile = entity("near_home", 231, 5_000, 10);
  mobile.entity_id = "device_tracker.mobile_secondary_source_1";
  const icloud = entity("home", 25, 0, 4);
  icloud.entity_id = "device_tracker.mobile_secondary_source_2";
  const input = peopleInput({ event: "context_snapshot" });
  input.payload.resident_secondary = mobile;
  input.payload.resident_secondary_icloud = icloud;

  const context = runPeoplePipeline(input, memoryFlow())[0].payload.context;
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

  const context = runPeoplePipeline(input, memoryFlow())[0].payload.context;
  assert.equal(context.resident_primary.entity_id, mobile.entity_id);
  assert.equal(context.resident_primary.state, "not_home");
});

scenario("44 coordenadas confiáveis vencem tracker impreciso", () => {
  const mobile = entity("near_home", 1_400, 0, 999);
  mobile.entity_id = "device_tracker.mobile_primary_source_1";
  const icloud = entity("home", 25, 0, 10);
  icloud.entity_id = "device_tracker.mobile_primary_source_2";
  const input = peopleInput({ event: "context_snapshot" });
  input.payload.resident_primary = mobile;
  input.payload.resident_primary_icloud = icloud;

  const context = runPeoplePipeline(input, memoryFlow())[0].payload.context;
  assert.equal(context.resident_primary.entity_id, icloud.entity_id);
  assert.equal(context.resident_primary.location_reliable, true);
});

scenario("45 tracker não selecionado não influencia decisões canônicas", () => {
  const mobile = entity("not_home", 2_000, 30 * 60_000, 40);
  mobile.entity_id = "device_tracker.mobile_secondary_source_1";
  const icloud = entity("home", 25, 0, 5);
  icloud.entity_id = "device_tracker.mobile_secondary_source_2";
  const input = peopleInput({ event: "context_snapshot" });
  input.payload.resident_secondary = mobile;
  input.payload.resident_secondary_icloud = icloud;

  const context = runPeoplePipeline(input, memoryFlow())[0].payload.context;
  assert.equal(context.resident_secondary.entity_id, icloud.entity_id);
  assert.equal(context.resident_secondary.state, "home");
  assert.equal(context.resident_secondary.best_location_away, false);
  assert.equal(context.resident_secondary.any_tracker_away, false);
  assert.equal(context.best_location_away, false);
  assert.equal(context.any_tracker_away, false);
});

scenario("46 bateria do iCloud não renova localização congelada", () => {
  const mobile = entity("not_home", 2_000, 60 * 60_000, 40);
  mobile.entity_id = "device_tracker.mobile_secondary_source_1";
  mobile.attributes.location_observed_at = iso(-60 * 60_000);

  const icloud = entity("home", 25, 0, 5);
  icloud.entity_id = "device_tracker.mobile_secondary_source_2";
  icloud.last_changed = iso(-4 * 60 * 60_000);
  icloud.last_updated = iso(0);
  icloud.attributes.location_observed_at = iso(-4 * 60 * 60_000);
  icloud.attributes.battery = 62;

  const input = peopleInput({ event: "context_snapshot" });
  input.payload.resident_secondary = mobile;
  input.payload.resident_secondary_icloud = icloud;

  const context = runPeoplePipeline(input, memoryFlow())[0].payload.context;
  assert.equal(context.resident_secondary.entity_id, mobile.entity_id);
  assert.equal(context.resident_secondary.state, "not_home");
  assert.equal(context.resident_secondary.updated_at, NOW - 60 * 60_000);
});

scenario("47 near_home recente e preciso vence fallback antigo em home", () => {
  const mobile = entity("near_home", 650, 0, 25);
  mobile.entity_id = "device_tracker.mobile_secondary_source_1";
  const icloud = entity("home", 25, 25 * 60_000, 5);
  icloud.entity_id = "device_tracker.mobile_secondary_source_2";
  const input = peopleInput({
    source: "resident_secondary",
    state: "near_home",
    previous: "not_home",
    event: "location_update",
  });
  input.payload.resident_secondary = mobile;
  input.payload.resident_secondary_icloud = icloud;
  input.payload.trigger_entity = mobile.entity_id;

  const result = runPeoplePipeline(
    input,
    memoryFlow({ people_arrival_armed: { resident_secondary: true } }),
  );
  assert.equal(
    result[0].payload.context.resident_secondary.entity_id,
    mobile.entity_id,
  );
  assert.equal(result[1].payload.arrival_stage, "approach");
});

scenario("48 posição recente sem precisão aceitável não vence posição precisa", () => {
  const mobile = entity("near_home", 1_400, 0, 999);
  mobile.entity_id = "device_tracker.mobile_primary_source_1";
  const icloud = entity("home", 25, 5 * 60_000, 10);
  icloud.entity_id = "device_tracker.mobile_primary_source_2";
  const input = peopleInput({ event: "context_snapshot" });
  input.payload.resident_primary = mobile;
  input.payload.resident_primary_icloud = icloud;

  const context = runPeoplePipeline(input, memoryFlow())[0].payload.context;
  assert.equal(context.resident_primary.entity_id, icloud.entity_id);
  assert.equal(context.resident_primary.state, "home");
});

Date.now = originalNow;
assert.equal(passed.length, 48);
console.log(`security recovery replay: ${passed.length} cenarios OK`);
for (const name of passed) console.log(name);
