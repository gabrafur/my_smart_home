import assert from "node:assert/strict";
import fs from "node:fs";

const flows = JSON.parse(fs.readFileSync(new URL("../flows.json", import.meta.url), "utf8"));
const byId = new Map(flows.map((node) => [node.id, node]));
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

function peopleInput({
  event = "location_update", source = "gabriel", previous = "not_home", current = "chegando",
  gabriel = entity(source === "gabriel" ? current : "home", source === "gabriel" ? 1_400 : 20),
  gabrielIcloud = entity(source === "gabriel" ? current : "home", source === "gabriel" ? 1_400 : 20),
  valeria = entity(source === "valeria" ? current : "home", source === "valeria" ? 1_400 : 20),
  valeriaIcloud = entity(source === "valeria" ? current : "home", source === "valeria" ? 1_400 : 20),
  cycle,
} = {}) {
  return { payload: {
    event, source, trigger_state: current, trigger_prev_state: previous,
    gabriel, gabriel_icloud: gabrielIcloud, valeria, valeria_icloud: valeriaIcloud,
    refresh_cycle_id: cycle,
  } };
}

function cretaInput({
  event = "location_update", previous = "not_home", current = "chegando", distance = 1_400,
  engine = "off", lock = "locked", cycle, changed = new Date().toISOString(), accuracy = 10,
} = {}) {
  return { payload: {
    event, source: "creta", trigger_state: current, trigger_prev_state: previous,
    reason: event === "turn_off" ? "creta_engine_off" : undefined,
    creta: entity(current, distance, changed, accuracy),
    creta_engine: { state: engine }, creta_lock: { state: lock }, refresh_cycle_id: cycle,
  } };
}

function arrival(source = "gabriel", stage = "approach") {
  return { payload: {
    contract: "security.arrival.v1", kind: "arrival", source, arriving: [source],
    arrival_source_type: source === "creta" ? "creta" : "person", arrival_stage: stage,
  } };
}

for (const node of flows.filter((item) => item.type === "function")) {
  new Function("msg", "node", "context", "flow", "global", "env", "setTimeout", "clearTimeout", node.func);
}

for (const [tabId, forbidden] of [
  ["2fd40fd570e6f37a", /device_tracker\.|binary_sensor\.creta|lock\.creta|button\.creta|HOME_LAT|distanceMeters/],
  ["security_people_tab", /binary_sensor\.creta|lock\.creta|device_tracker\.creta|button\.creta/],
  ["security_creta_tab", /iphone_de_|iphonegabriel|request_location_update/],
]) {
  const serialized = JSON.stringify(flows.filter((node) => node.z === tabId));
  assert.doesNotMatch(serialized, forbidden, `fronteira de dominio violada em ${tabId}`);
}

scenario("01 Creta desligado e todos em casa", () => {
  const people = run("people_normalize", peopleInput({ event: "context_snapshot", gabriel: entity("home", 20), gabrielIcloud: entity("home", 20), valeria: entity("home", 20), valeriaIcloud: entity("home", 20) }), memoryFlow(), geoEnv)[0];
  const creta = run("creta_normalize", cretaInput({ event: "context_snapshot", current: "home", distance: 20 }), memoryFlow(), geoEnv)[0];
  assert.equal(people.payload.context.anyone_away, false);
  assert.equal(creta.payload.context.in_use, false);
  assert.equal(creta.payload.context.home, true);
});

scenario("02 Creta ligado e longe de casa", () => {
  const result = run("creta_normalize", cretaInput({ current: "not_home", distance: 5_000, engine: "on" }), memoryFlow(), geoEnv)[0];
  assert.equal(result.payload.context.in_use, true);
  assert.equal(result.payload.context.away, true);
});

scenario("03 Creta ligado e aproximando-se", () => {
  const [, detected] = run("creta_normalize", cretaInput({ engine: "on" }), memoryFlow(), geoEnv);
  assert.equal(detected.payload.arrival_stage, "approach");
  assert.equal(detected.payload.request_creta_wake, true);
});

scenario("04 entrada no anel de aproximadamente 1500 m", () => {
  const [, detected] = run("people_normalize", peopleInput(), memoryFlow(), geoEnv);
  assert.equal(detected.payload.arrival_stage, "approach");
});

scenario("05 Gabriel aproximando-se", () => {
  const [, detected] = run("people_normalize", peopleInput({ source: "gabriel" }), memoryFlow(), geoEnv);
  assert.deepEqual(detected.payload.arriving, ["gabriel"]);
});

scenario("06 Valeria aproximando-se", () => {
  const [, detected, notification] = run("people_normalize", peopleInput({ source: "valeria" }), memoryFlow(), geoEnv);
  assert.deepEqual(detected.payload.arriving, ["valeria"]);
  assert.equal(notification.payload.kind, "valeria_approach_notification");
});

scenario("07 Gabriel ja em casa", () => {
  const flow = memoryFlow({ people_arrival_armed: { gabriel: true } });
  run("people_normalize", peopleInput({ event: "context_snapshot", gabriel: entity("home", 20), gabrielIcloud: entity("home", 20) }), flow, geoEnv);
  assert.equal(flow.get("people_arrival_armed").gabriel, false);
});

scenario("08 Valeria ja em casa", () => {
  const flow = memoryFlow({ people_arrival_armed: { valeria: true } });
  run("people_normalize", peopleInput({ event: "context_snapshot", valeria: entity("home", 20), valeriaIcloud: entity("home", 20) }), flow, geoEnv);
  assert.equal(flow.get("people_arrival_armed").valeria, false);
});

scenario("09 Creta chegando encerra viagem e publica chegada", () => {
  const flow = memoryFlow({ creta_arrival_armed: true, creta_in_use: true });
  const [, detected] = run("creta_normalize", cretaInput({ previous: "chegando", current: "home", distance: 20 }), flow, geoEnv);
  assert.equal(detected.payload.arrival_source_type, "creta");
  const actions = run("creta_arrival_actions", detected, flow, geoEnv);
  assert.equal(actions[1], detected);
  assert.equal(byId.get("creta_trip_refresh").action, "button.press");
});

scenario("10 Creta desligado ao chegar", () => {
  const result = run("creta_normalize", cretaInput({ event: "turn_off", current: "home", distance: 20, engine: "off", lock: "unlocked" }), memoryFlow({ creta_in_use: true }), geoEnv)[0];
  assert.equal(result.payload.context.in_use, false);
});

scenario("11 Creta travado ao chegar nao apaga imediatamente", () => {
  const decision = run("light_evaluate_off", { payload: { active: true, event: "location_update", creta_engine_on: false, creta_unlocked: false } }, memoryFlow(), geoEnv);
  assert.equal(decision, null);
});

scenario("12 Creta destravado em casa apaga apos filtro do evento", () => {
  const eventNode = byId.get("creta_unlock_event");
  assert.equal(eventNode.for, "5");
  const decision = run("light_evaluate_off", { payload: { active: true, event: "turn_off", creta_engine_on: false, creta_unlocked: true } }, memoryFlow(), geoEnv);
  assert.equal(decision[0].payload.off_reason, "creta_desligado_e_destravado");
});

scenario("13 refletor ja ligado antes da chegada", () => {
  const inactive = byId.get("light_check_inactive");
  assert.equal(inactive.property, "payload.active");
  assert.equal(inactive.rules[0].t, "false");
});

scenario("14 ambiente ainda claro", () => {
  const flow = memoryFlow({ sun_below_horizon: false, creta_context_v1: { in_use: true } });
  const prepared = run("light_prepare_arrival", arrival(), flow, geoEnv);
  assert.equal(prepared.payload.sun_below_horizon, false);
});

scenario("15 ambiente escuro", () => {
  const flow = memoryFlow({ sun_below_horizon: true, creta_context_v1: { in_use: true, engine_on: true } });
  const prepared = run("light_prepare_arrival", arrival(), flow, geoEnv);
  assert.equal(prepared.payload.sun_below_horizon, true);
  assert(run("light_check_creta_in_use", prepared, flow, geoEnv));
});

scenario("16 timeout de 15 minutos", () => {
  const delay = byId.get("light_auto_off");
  assert.equal(delay.timeout, "15");
  assert.equal(delay.timeoutUnits, "minutes");
  assert.equal(byId.get("light_timeout").rules[0].to.includes("timeout_15min"), true);
});

scenario("17 desligamento respeita carencia de 90 segundos", () => {
  const flow = memoryFlow({ refletor_activated_at: Date.now() });
  const decision = run("light_evaluate_off", { payload: { active: true, confirmed_home_transition: true, source: "gabriel" } }, flow, geoEnv);
  assert(decision[1].delay > 89_000 && decision[1].delay <= 90_000);
  assert.equal(byId.get("light_off_grace").pauseType, "delayv");
});

scenario("18 cinco condicoes independentes de desligamento", () => {
  for (const source of ["gabriel", "valeria", "creta"]) {
    const decision = run("light_evaluate_off", { payload: { active: true, confirmed_home_transition: true, source } }, memoryFlow(), geoEnv);
    assert.equal(decision[1].payload.off_reason, `chegada_confirmada_${source}`);
  }
  assert.equal(byId.get("light_auto_off").timeout, "15");
});

scenario("19 localizacao de Gabriel unknown/unavailable", () => {
  const flow = memoryFlow({ people_arrival_armed: { gabriel: true } });
  const result = run("people_normalize", peopleInput({ event: "context_snapshot", gabriel: entity("unknown"), gabrielIcloud: entity("unavailable") }), flow, geoEnv)[0];
  assert.equal(result.payload.context.gabriel.state_valid, false);
  assert.equal(flow.get("people_arrival_armed").gabriel, true);
});

scenario("20 localizacao de Valeria unknown/unavailable", () => {
  const flow = memoryFlow({ people_arrival_armed: { valeria: true } });
  const result = run("people_normalize", peopleInput({ event: "context_snapshot", valeria: entity("unknown"), valeriaIcloud: entity("unavailable") }), flow, geoEnv)[0];
  assert.equal(result.payload.context.valeria.state_valid, false);
  assert.equal(flow.get("people_arrival_armed").valeria, true);
});

scenario("21 localizacao do Creta unknown/unavailable", () => {
  const flow = memoryFlow({ creta_arrival_armed: true });
  const result = run("creta_normalize", cretaInput({ event: "context_snapshot", current: "unknown", distance: null, accuracy: 999 }), flow, geoEnv)[0];
  assert.equal(result.payload.context.state_valid, false);
  assert.equal(flow.get("creta_arrival_armed"), true);
});

scenario("22 Home Assistant reiniciado: ciclo volta a pedir snapshots", () => {
  assert.equal(byId.get("context_tick").once, true);
  assert.equal(byId.get("context_tick").onceDelay, "30");
  assert.equal(byId.get("light_sun_event").outputInitially, true);
});

scenario("23 Node-RED reiniciado: gates falham de forma segura", () => {
  assert.equal(run("light_prepare_arrival", arrival(), memoryFlow(), geoEnv).payload.creta_in_use, false);
  assert.equal(run("light_check_creta_in_use", { payload: {} }, memoryFlow(), geoEnv), null);
});

scenario("24 restart durante viagem preserva risco conhecido", () => {
  const result = run("creta_normalize", cretaInput({ event: "context_snapshot", current: "not_home", distance: 5_000, engine: "off" }), memoryFlow(), geoEnv)[0];
  assert.equal(result.payload.context.in_use, false);
  assert.equal(result.payload.context.away, true);
});

scenario("25 restart com refletor ligado preserva risco conhecido", () => {
  const merged = run("light_merge_context", { payload: { kind: "sun_context", sun_below_horizon: true } }, memoryFlow(), geoEnv);
  assert.equal(merged.payload.active, false);
});

scenario("26 eventos fora de ordem atualizam caches sem emitir refresh", () => {
  const flow = memoryFlow();
  assert.equal(run("context_coordinator", { payload: { kind: "creta_context", context: { away: true } } }, flow, geoEnv), null);
  assert.equal(run("context_coordinator", { payload: { kind: "people_context", context: { anyone_away: false } } }, flow, geoEnv), null);
  assert.equal(flow.get("creta_context_v1").away, true);
});

scenario("27 dois eventos quase simultaneos geram um comando por ciclo", () => {
  const flow = memoryFlow();
  const request = run("context_coordinator", { payload: { kind: "refresh_tick" } }, flow, geoEnv)[0];
  const cycle = request.payload.refresh_cycle_id;
  assert.equal(run("context_coordinator", { payload: { kind: "people_context", context: { anyone_away: false }, refresh_cycle_id: cycle } }, flow, geoEnv), null);
  const completed = run("context_coordinator", { payload: { kind: "creta_context", context: { away: true }, refresh_cycle_id: cycle } }, flow, geoEnv);
  assert.equal(completed[1].payload.anyone_away, true);
  assert.equal(run("context_coordinator", { payload: { kind: "creta_context", context: { away: true }, refresh_cycle_id: cycle } }, flow, geoEnv), null);
});

scenario("28 refresh do Creta falhando permite retry", () => {
  const flow = memoryFlow({ creta_context_v1: { away: true } });
  const command = { payload: { kind: "refresh_command", anyone_away: true } };
  assert(run("creta_refresh_decide", structuredClone(command), flow, geoEnv));
  assert(run("creta_refresh_decide", structuredClone(command), flow, geoEnv));
  assert.equal(flow.get("creta_last_force_refresh_ts"), undefined);
});

scenario("29 refresh posterior do Creta com sucesso confirma cooldown", () => {
  const flow = memoryFlow({ creta_context_v1: { away: true } });
  run("creta_refresh_ack", { payload: {} }, flow, geoEnv);
  assert.equal(typeof flow.get("creta_last_force_refresh_ts"), "number");
  assert.equal(run("creta_refresh_decide", { payload: { kind: "refresh_command", anyone_away: true } }, flow, geoEnv), null);
});

scenario("30 tick de 30 segundos sem mudanca nao cria loop", () => {
  assert.equal(byId.get("context_tick").repeat, "30");
  const flow = memoryFlow({ people_context_v1: { nearest_distance_m: 5_000 }, people_last_refresh_ts: Date.now() });
  assert.equal(run("people_refresh_decide", { payload: { kind: "refresh_command", anyone_away: true } }, flow, geoEnv), null);
  const securityTabs = new Set(["security_people_tab", "security_creta_tab", "security_context_tab", "2fd40fd570e6f37a"]);
  for (const node of flows.filter((item) => securityTabs.has(item.z))) {
    for (const targetId of (node.wires ?? []).flat()) {
      assert.equal(byId.get(targetId).z, node.z, `wire entre tabs: ${node.id} -> ${targetId}`);
    }
  }
});

assert.equal(passed.length, 30);
console.log(`security context/light replay: ${passed.length} cenarios OK`);
for (const name of passed) console.log(name);
