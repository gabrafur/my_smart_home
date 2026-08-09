import assert from "node:assert/strict";
import fs from "node:fs";

const flows = JSON.parse(fs.readFileSync(new URL("../flows.json", import.meta.url), "utf8"));
const byId = new Map(flows.map((node) => [node.id, node]));

function memoryFlow(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    get: (key) => values.get(key),
    set: (key, value) => values.set(key, value),
  };
}

function environment(values = {}) {
  return { get: (key) => values[key] };
}

function run(id, msg, flow = memoryFlow(), env = environment()) {
  const node = byId.get(id);
  assert(node, `node ausente: ${id}`);
  assert.equal(node.type, "function", `${id} nao e function node`);
  const execute = new Function("msg", "flow", "node", "env", node.func);
  return execute(msg, flow, { warn() {}, error() {} }, env);
}

function entity(state, distanceM, lastChanged = new Date().toISOString()) {
  // No equador, 1 grau de latitude corresponde a aproximadamente 111,2 km.
  return {
    state,
    last_changed: lastChanged,
    attributes: {
      latitude: distanceM / 111_200,
      longitude: 0,
      gps_accuracy: 10,
    },
  };
}

function input({
  source = "gabriel",
  previous = "not_home",
  current = "chegando",
  gabriel = entity(current, 1_000),
  gabrielIcloud = entity("not_home", 1_000),
  valeria = entity("home", 20),
  valeriaIcloud = entity("home", 20),
  creta = entity("not_home", 1_000),
  engine = "off",
  lock = "locked",
  event = "location_update",
} = {}) {
  return {
    payload: {
      event,
      source,
      trigger_state: current,
      trigger_prev_state: previous,
      sun: { state: "below_horizon" },
      gabriel,
      gabriel_icloud: gabrielIcloud,
      valeria,
      valeria_icloud: valeriaIcloud,
      creta,
      creta_engine: { state: engine },
      creta_lock: { state: lock },
    },
  };
}

const geoEnv = environment({ HOME_LAT: "0", HOME_LON: "0", GATE_LAT: "0", GATE_LON: "0" });

// Todo function node precisa ao menos compilar com a assinatura real do runtime.
for (const node of flows.filter((item) => item.type === "function")) {
  new Function("msg", "flow", "node", "env", node.func);
}

// O inject manual precisa reproduzir o contrato do node de notificacao.
// Um timestamp em payload faz o JSONata omitir `message` e o HA rejeitar a chamada.
{
  const manualMessage = byId.get("249963a6cd6c247a");
  assert.equal(manualMessage?.payloadType, "json");
  assert.equal(typeof JSON.parse(manualMessage.payload).message, "string");
  assert.notEqual(JSON.parse(manualMessage.payload).message.trim(), "");
}

// O tick de 30 s continua servindo aos iPhones; wakes Kia respeitam o piso BR.
assert.equal(byId.get("sec_refresh_every_10min")?.repeat, "30");
const refreshFunc = byId.get("sec_refresh_anyone_away")?.func ?? "";
for (const constant of ["KIA_REFRESH_INTERVAL_MS", "KIA_NEAR_REFRESH_INTERVAL_MS", "KIA_BASELINE_INTERVAL_MS"]) {
  assert.match(refreshFunc, new RegExp(`const ${constant} = 15 \\* 60 \\* 1000`));
}

// Sem coordenadas no ambiente, o fluxo degrada para os estados de zona.
{
  const prepared = run("sec_prepare_arrival_context", input(), memoryFlow(), environment())[2];
  assert(prepared);
  assert.equal(prepared.payload.gabriel.distance_m, null);
  assert.equal(prepared.payload.gabriel.state, "chegando");
}

// Pessoa chegando sem Creta em uso nunca passa pelo gate obrigatorio.
{
  const flow = memoryFlow({ refletor_portao_carros_arrival_armed_entities: { gabriel: true } });
  const prepared = run("sec_prepare_arrival_context", input(), flow, geoEnv)[2];
  const arrival = run("sec_detect_arriving_source", prepared, flow, geoEnv);
  assert(arrival);
  assert.equal(run("sec_check_engine_on", arrival, flow, geoEnv), null);
}

// Dado de motor velho nao derruba a trava de uma viagem ainda em andamento.
{
  const flow = memoryFlow({
    creta_in_use: true,
    refletor_portao_carros_arrival_armed_entities: { gabriel: true, creta: true },
  });
  const prepared = run("sec_prepare_arrival_context", input(), flow, geoEnv)[2];
  const arrival = run("sec_detect_arriving_source", prepared, flow, geoEnv);
  const gated = run("sec_check_engine_on", arrival, flow, geoEnv);
  assert.equal(gated.payload.creta_gate, "creta_in_use_latched");
}

// A localizacao do proprio Creta tambem e uma fonte valida de chegada.
{
  const flow = memoryFlow({
    creta_in_use: true,
    refletor_portao_carros_arrival_armed_entities: { creta: true },
  });
  const prepared = run("sec_prepare_arrival_context", input({ source: "creta" }), flow, geoEnv)[2];
  const arrival = run("sec_detect_arriving_source", prepared, flow, geoEnv);
  assert.equal(arrival.payload.arrival_source_type, "creta");
  assert.equal(arrival.payload.arrival_stage, "approach");
}

// Motor desligado + porta destravada e suficiente para desligar imediatamente.
{
  const flow = memoryFlow({ refletor_portao_carros_active_by_arrival: true });
  const prepared = run("sec_prepare_arrival_context", input({ event: "turn_off", lock: "unlocked" }), flow, geoEnv)[0];
  const decision = run("sec_evaluate_turn_off", prepared, flow, geoEnv);
  assert.equal(decision[0].payload.off_reason, "creta_desligado_e_destravado");
}

// Qualquer desligamento arma cinco minutos de anti-religamento.
{
  const flow = memoryFlow({ refletor_portao_carros_active_by_arrival: true, creta_in_use: true });
  assert(run("sec_turn_off_if_active", { payload: { active: true } }, flow, geoEnv));
  assert.equal(run("sec_check_engine_on", { payload: { creta_in_use: true } }, flow, geoEnv), null);
}

// Tracker primario congelado fora + iCloud em casa nao vira aproximacao,
// independentemente de o Creta estar ou nao em uso.
for (const cretaInUse of [false, true]) {
  const flow = memoryFlow({
    creta_in_use: cretaInUse,
    refletor_portao_carros_arrival_armed_entities: { gabriel: true },
  });
  const msg = input({ gabriel: entity("chegando", 644), gabrielIcloud: entity("home", 20) });
  const prepared = run("sec_prepare_arrival_context", msg, flow, geoEnv)[2];
  assert.equal(run("sec_detect_arriving_source", prepared, flow, geoEnv), null);
}

// O falso not_home -> chegando de uma coordenada congelada continua sem push
// quando o outro tracker confirma que a Valeria esta em casa.
{
  const flow = memoryFlow({
    refletor_portao_carros_arrival_armed_entities: { valeria: true },
  });
  const prepared = run("sec_prepare_arrival_context", input({
    source: "valeria",
    valeria: entity("chegando", 644),
    valeriaIcloud: entity("home", 20),
  }), flow, geoEnv)[2];
  const [, notification] = run("sec_update_arming_location", prepared, flow, geoEnv);
  assert.equal(notification, null);
}

// Se o fluxo viu a saida completa, um iCloud congelado em home nao pode
// engolir a volta real. O push fica antes do gate de escuridao e funciona de
// dia tambem.
{
  const flow = memoryFlow({
    refletor_portao_carros_arrival_armed_entities: { valeria: true },
  });

  const away = run("sec_prepare_arrival_context", input({
    source: "valeria",
    previous: "chegando",
    current: "not_home",
    valeria: entity("not_home", 2_000),
    valeriaIcloud: entity("home", 20),
  }), flow, geoEnv)[2];
  run("sec_update_arming_location", away, flow, geoEnv);

  const returningInput = input({
    source: "valeria",
    previous: "not_home",
    current: "chegando",
    valeria: entity("chegando", 1_400),
    valeriaIcloud: entity("home", 20),
  });
  returningInput.payload.sun.state = "above_horizon";
  const returning = run("sec_prepare_arrival_context", returningInput, flow, geoEnv)[2];
  const [, notification] = run("sec_update_arming_location", returning, flow, geoEnv);
  assert.equal(notification.payload.message, "Valéria está chegando de carro.");
}

// A travessia home -> chegando e saida, nunca chegada.
{
  const flow = memoryFlow({
    creta_in_use: true,
    refletor_portao_carros_arrival_armed_entities: { gabriel: true },
  });
  const prepared = run("sec_prepare_arrival_context", input({ previous: "home" }), flow, geoEnv)[2];
  assert.equal(run("sec_detect_arriving_source", prepared, flow, geoEnv), null);
}

console.log("security-light replay: 10 cenarios e sintaxe de todos os function nodes OK");
