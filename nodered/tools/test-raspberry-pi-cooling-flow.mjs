import assert from "node:assert/strict";
import fs from "node:fs";

const flows = JSON.parse(fs.readFileSync(new URL("../flows.json", import.meta.url), "utf8"));
const packageYaml = fs.readFileSync(
  new URL("../../homeassistant/packages/raspberry_pi_system_health.yaml", import.meta.url),
  "utf8",
);
const byId = new Map(flows.map((item) => [item.id, item]));

assert.equal(byId.size, flows.length, "flows.json contem IDs duplicados");

function get(id, type) {
  const value = byId.get(id);
  assert(value, `node ausente: ${id}`);
  if (type) assert.equal(value.type, type, `${id} deveria ser ${type}`);
  return value;
}

function memoryFlow(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    get: (key) => values.get(key),
    set: (key, value) => values.set(key, value),
  };
}

function run(id, msg, flow = memoryFlow()) {
  const item = get(id, "function");
  const events = { warnings: [], statuses: [] };
  const runtimeNode = {
    warn: (value) => events.warnings.push(value),
    error: () => {},
    status: (value) => events.statuses.push(value),
  };
  const execute = new Function("msg", "flow", "node", item.func);
  return { result: execute(msg, flow, runtimeNode), flow, events };
}

function assertAction(id, action, entityId, data = undefined) {
  const value = get(id, "api-call-service");
  assert.equal(value.action, action);
  assert.deepEqual(value.entityId, entityId ? [entityId] : []);
  if (data !== undefined) {
    assert.equal(value.dataType, "json");
    assert.deepEqual(JSON.parse(value.data), data);
  }
}

function climate(state, temperature = 23, fanMode = "auto") {
  return { state, attributes: { temperature, fan_mode: fanMode } };
}

// Todo function node precisa compilar com a assinatura real do runtime.
for (const item of flows.filter((candidate) => candidate.type === "function")) {
  new Function("msg", "flow", "node", item.func);
}

// Todo wire aponta para um node existente; grupos enumeram exatamente nodes da aba.
for (const item of flows) {
  for (const output of item.wires ?? []) {
    for (const target of output) assert(byId.has(target), `${item.id} aponta para ${target} ausente`);
  }
}
for (const groupId of [
  "grp_rpi_cooling_triggers",
  "grp_rpi_cooling_start",
  "grp_rpi_cooling_stop",
  "grp_rpi_cooling_observability",
]) {
  const group = get(groupId, "group");
  for (const memberId of group.nodes) assert.equal(get(memberId).g, groupId);
  assert(group.w <= 2100, `${groupId} excede a largura organizada do canvas`);
}
for (const item of flows.filter(
  (candidate) => candidate.z === "raspberry_pi_cooling_tab" && candidate.type !== "group",
)) {
  assert(item.g, `${item.id} precisa pertencer a um grupo da aba`);
  assert(get(item.g, "group").nodes.includes(item.id), `${item.id} ausente do grupo ${item.g}`);
  for (const targetId of (item.wires ?? []).flat()) {
    const target = get(targetId);
    assert(target.x >= item.x - 30, `${item.id} possui fio de retorno para ${targetId}`);
    assert(
      Math.hypot(target.x - item.x, target.y - item.y) <= 500,
      `${item.id} possui fio longo para ${targetId}; use link nodes para manter o canvas legivel`,
    );
  }
}

assert.equal(get("raspberry_pi_cooling_tab", "tab").label, "resfriamento_raspberry_pi");
assert.deepEqual(get("rpi_cooling_start_gate").wires[0], ["rpi_cooling_acquire_out"]);
assert.deepEqual(get("rpi_cooling_acquire_out", "link out").links, ["rpi_cooling_acquire_in"]);
assert.deepEqual(get("rpi_cooling_acquire_in", "link in").wires[0], ["rpi_cooling_read_climate"]);
assert.deepEqual(get("rpi_cooling_stop_read_climate").wires[0], ["rpi_cooling_restore_path_out"]);
assert.deepEqual(get("rpi_cooling_restore_path_out", "link out").links, [
  "rpi_cooling_restore_path_in",
]);
assert.deepEqual(get("rpi_cooling_restore_path_in", "link in").wires[0], [
  "rpi_cooling_restore_decision",
]);

// Os thresholds e duracoes originais permanecem intactos.
const hot = get("rpi_cooling_hot", "server-state-changed");
assert.deepEqual(hot.entities.entity, ["sensor.raspberry_pi_cpu_temperature"]);
assert.equal(hot.ifStateOperator, "gt");
assert.equal(hot.ifState, "81.9");
assert.equal(hot.stateType, "str");
assert.equal(hot.ifStateType, "num");
assert.equal(hot.for, "2");
assert.equal(hot.forUnits, "minutes");

const normal = get("rpi_cooling_normal", "server-state-changed");
assert.equal(normal.ifStateOperator, "lt");
assert.equal(normal.stateType, "str");
assert.equal(normal.ifStateType, "num");
assert.equal(normal.ifState, "70");
assert.equal(normal.for, "10");
assert.equal(normal.forUnits, "minutes");
assert.equal(normal.ignoreCurrentStateUnknown, false);
assert.equal(normal.ignoreCurrentStateUnavailable, false);

// O estado bruto permanece string; somente o operando do comparador e numerico.
// Conversao via stateType/state_type=num e descontinuada no HA websocket 0.80.x.
for (const id of [
  "rpi_cooling_hot",
  "rpi_cooling_startup_snapshot",
  "rpi_cooling_retry_temperature_check",
  "rpi_cooling_normal",
  "rpi_cooling_retry_normal_check",
]) {
  const item = get(id);
  assert.equal(item.stateType ?? item.state_type, "str", `${id} nao deve usar state type numerico`);
}
assert.equal(get("rpi_cooling_retry_temperature_check").halt_if_type, "num");
assert.equal(get("rpi_cooling_retry_normal_check").halt_if_type, "num");

// Startup: quente inicia/reconcilia; frio com ownership retoma a janela; faixa intermediaria preserva.
for (const owner of ["off", "on"]) {
  const { result } = run("rpi_cooling_reconcile_startup", {
    cpu_temperature: 82.1,
    cooling_owner: owner,
  });
  assert(result[0]);
  assert.equal(result[0].operation, "start");
  assert.equal(result[0].start_source, "startup_reconciliation");
  assert.equal(result[1], null);
}
{
  const { result } = run("rpi_cooling_reconcile_startup", {
    cpu_temperature: 69.9,
    cooling_owner: "on",
  });
  assert.equal(result[0], null);
  assert(result[1]);
  assert.equal(result[1].operation, "stop");
}
for (const input of [
  { cpu_temperature: 75, cooling_owner: "on" },
  { cpu_temperature: 69, cooling_owner: "off" },
  { cpu_temperature: 75, cooling_owner: "off" },
]) {
  assert.equal(run("rpi_cooling_reconcile_startup", input).result, null);
}
{
  const pending = { state: "cool", temperature: 23, fan_mode: "auto" };
  const flow = memoryFlow();
  const { result } = run("rpi_cooling_reconcile_startup", {
    cpu_temperature: 69,
    cooling_owner: "off",
    stored_snapshot: JSON.stringify(pending),
  }, flow);
  assert.equal(result[0], null);
  assert.equal(result[1], null);
  assert.equal(result[2].operation, "rollback");
  assert.deepEqual(result[2].previous_climate, pending);
  assert.equal(flow.get("rpi_emergency_cooling_operation"), "rollback");
}
{
  const pending = { state: "off", temperature: 24, fan_mode: "auto" };
  const { result } = run("rpi_cooling_reconcile_startup", {
    cpu_temperature: 82,
    cooling_owner: "off",
    stored_snapshot: JSON.stringify(pending),
  });
  assert.deepEqual(result[0].previous_climate, pending);
}
const startupTimer = get("rpi_cooling_restart_recovery_timer", "trigger");
assert.equal(startupTimer.duration, "10");
assert.equal(startupTimer.units, "min");
assert.deepEqual(normal.wires[1], ["rpi_cooling_reset_timer_out"]);
assert.deepEqual(get("rpi_cooling_reset_timer_out", "link out").links, ["rpi_cooling_reset_timer_in"]);
assert.deepEqual(get("rpi_cooling_reset_timer_in", "link in").wires[0], [
  "rpi_cooling_reset_restart_timer",
]);
assert.deepEqual(startupTimer.wires[0], ["rpi_cooling_recovery_window_out"]);
assert.deepEqual(get("rpi_cooling_recovery_window_out", "link out").links, [
  "rpi_cooling_recovery_window_in",
]);
assert.deepEqual(get("rpi_cooling_recovery_window_in", "link in").wires[0], [
  "rpi_cooling_retry_normal_check",
]);

// Idempotencia: evento comum nao reaplica comandos quando ja existe ownership;
// startup pode reconciliar, e um lock impede duas sequencias concorrentes.
{
  const flow = memoryFlow();
  assert.equal(run("rpi_cooling_start_gate", {
    cooling_owner: "on",
    start_source: "temperature_threshold",
  }, flow).result, null);
  assert.equal(flow.get("rpi_emergency_cooling_operation"), undefined);
}
{
  const flow = memoryFlow();
  const first = run("rpi_cooling_start_gate", {
    cooling_owner: "on",
    start_source: "startup_reconciliation",
  }, flow).result;
  assert(first[0]);
  assert.equal(first[0].start_mode, "reconcile");
  assert.equal(flow.get("rpi_emergency_cooling_operation"), "start");
  assert.equal(run("rpi_cooling_start_gate", {
    cooling_owner: "on",
    start_source: "startup_reconciliation",
  }, flow).result, null);
}
{
  const { result } = run("rpi_cooling_start_gate", {
    cooling_owner: "unavailable",
    start_source: "startup_reconciliation",
  });
  assert.equal(result[0], null);
  assert.match(result[1].failure_reason, /ownership/);
}

// Climate indisponivel nunca avanca para comandos nem ownership.
{
  const { result } = run("rpi_cooling_validate_climate", {
    climate_state: "unavailable",
    climate_entity: climate("unavailable"),
    start_mode: "acquire",
  });
  assert.equal(result[0], null);
  assert.equal(result[1], null);
  assert.match(result[2].failure_reason, /indisponível/);
}

// Snapshot comportamental: desligado e ligado capturam os campos restauraveis.
for (const original of [
  climate("off", 24, "auto"),
  climate("cool", 23, "auto"),
]) {
  const { result } = run("rpi_cooling_validate_climate", {
    climate_state: original.state,
    climate_entity: original,
    start_mode: "acquire",
  });
  const prepared = result[0];
  assert(prepared);
  assert.equal(prepared.previous_climate.state, original.state);
  assert.equal(prepared.previous_climate.temperature, original.attributes.temperature);
  assert.equal(prepared.previous_climate.fan_mode, original.attributes.fan_mode);
  assert.equal(typeof prepared.previous_climate.captured_at, "string");
}
{
  const persisted = { state: "heat", temperature: 21, fan_mode: "low" };
  const { result } = run("rpi_cooling_validate_climate", {
    climate_state: "cool",
    climate_entity: climate("cool", 16, "high"),
    stored_snapshot: JSON.stringify(persisted),
    start_mode: "acquire",
  });
  assert.deepEqual(result[0].previous_climate, persisted);
}

// Ownership so aparece depois de persistir snapshot e concluir mode/temp/fan.
assert.deepEqual(get("rpi_cooling_persist_snapshot").wires[0], ["rpi_cooling_begin_control"]);
assert.deepEqual(get("rpi_cooling_begin_control").wires[0], ["rpi_cooling_set_mode"]);
assert.deepEqual(get("rpi_cooling_set_mode").wires[0], ["rpi_cooling_set_temperature"]);
assert.deepEqual(get("rpi_cooling_set_temperature").wires[0], ["rpi_cooling_set_fan"]);
assert.deepEqual(get("rpi_cooling_set_fan").wires[0], ["rpi_cooling_start_verify_out"]);
assert.deepEqual(get("rpi_cooling_start_verify_out", "link out").links, ["rpi_cooling_start_verify_in"]);
assert.deepEqual(get("rpi_cooling_start_verify_in", "link in").wires[0], ["rpi_cooling_verify_delay"]);
assert.deepEqual(get("rpi_cooling_verify_delay").wires[0], ["rpi_cooling_read_controlled_climate"]);
assert.deepEqual(get("rpi_cooling_read_controlled_climate").wires[0], ["rpi_cooling_verify_controlled_climate"]);
assert.deepEqual(get("rpi_cooling_verify_controlled_climate").wires[0], ["rpi_cooling_control_succeeded"]);
assert.deepEqual(get("rpi_cooling_control_succeeded").wires[0], ["rpi_cooling_mark_active"]);
assertAction(
  "rpi_cooling_mark_active",
  "input_boolean.turn_on",
  "input_boolean.raspberry_pi_emergency_cooling",
);
assertAction(
  "rpi_cooling_set_mode",
  "climate.set_hvac_mode",
  "climate.ar_condicionado_escritorio",
  { hvac_mode: "cool" },
);
assertAction(
  "rpi_cooling_set_temperature",
  "climate.set_temperature",
  "climate.ar_condicionado_escritorio",
  { temperature: 16, hvac_mode: "cool" },
);
assertAction(
  "rpi_cooling_set_fan",
  "climate.set_fan_mode",
  "climate.ar_condicionado_escritorio",
  { fan_mode: "high" },
);
{
  const confirmed = run("rpi_cooling_verify_controlled_climate", {
    controlled_climate_state: "cool",
    controlled_climate_entity: climate("cool", 16, "high"),
  }).result;
  assert(confirmed[0]);
  assert.equal(confirmed[1], null);
}
for (const invalid of [
  climate("unavailable", 16, "high"),
  climate("cool", 23, "high"),
  climate("cool", 16, "auto"),
]) {
  const failed = run("rpi_cooling_verify_controlled_climate", {
    controlled_climate_state: invalid.state,
    controlled_climate_entity: invalid,
  }).result;
  assert.equal(failed[0], null);
  assert.match(failed[1].failure_reason, /não confirmou/);
}

// Reconciliacao de um ownership existente nao marca de novo nem duplica a notificacao inicial.
{
  const flow = memoryFlow({ rpi_emergency_cooling_operation: "start" });
  const { result } = run("rpi_cooling_control_succeeded", { start_mode: "reconcile" }, flow);
  assert.equal(result[0], null);
  assert(result[1]);
  assert.equal(flow.get("rpi_emergency_cooling_operation"), null);
  assert.deepEqual(get("rpi_cooling_control_succeeded").wires[1], [
    "rpi_cooling_reconcile_notice_out",
    "rpi_cooling_reconcile_dismiss_failure_out",
  ]);
}

// Retry e limitado a tres tentativas; falha parcial gera rollback e nunca ownership falso.
{
  const flow = memoryFlow({ rpi_emergency_cooling_operation: "start" });
  const retry = run("rpi_cooling_start_failure", {
    operation: "start",
    attempt: 1,
    failure_reason: "climate unavailable",
  }, flow).result;
  assert.equal(retry[0].attempt, 2);
  assert.equal(retry.slice(1).filter(Boolean).length, 0);
  assert.equal(flow.get("rpi_emergency_cooling_operation"), null);
}
{
  const failed = run("rpi_cooling_start_failure", {
    operation: "start",
    start_mode: "acquire",
    attempt: 3,
    control_started: true,
    snapshot_persisted: true,
    previous_climate: { state: "cool", temperature: 23, fan_mode: "auto" },
    failure_reason: "set_fan_mode falhou",
  }).result;
  assert.equal(failed[0], null);
  assert.equal(failed[1], null);
  assert.equal(failed[2].operation, "rollback");
  assert.equal(failed[3], null);
  assert(failed[4]);
}
for (const retryId of ["rpi_cooling_start_retry_delay", "rpi_cooling_startup_retry_delay", "rpi_cooling_stop_retry_delay"]) {
  const retry = get(retryId, "delay");
  assert.equal(retry.timeout, "60");
  assert.equal(retry.timeoutUnits, "seconds");
}
assert.deepEqual(get("rpi_cooling_start_retry_delay").wires[0], ["rpi_cooling_retry_temperature_check"]);
assert.deepEqual(get("rpi_cooling_retry_temperature_check").wires[0], [
  "rpi_cooling_retry_owner_out",
]);

// Encerramento: helper off bloqueia o caminho destrutivo por wiring; lock evita concorrencia.
assert.deepEqual(get("rpi_cooling_active_check").wires, [["rpi_cooling_stop_gate"], []]);
{
  const flow = memoryFlow();
  assert(run("rpi_cooling_stop_gate", { attempt: 1 }, flow).result);
  assert.equal(flow.get("rpi_emergency_cooling_operation"), "stop");
  assert.equal(run("rpi_cooling_stop_gate", { attempt: 1 }, flow).result, null);
}

// Restauracao sobrevive a restart via input_text e cobre ar originalmente off/on.
{
  const { result } = run("rpi_cooling_restore_decision", {
    operation: "stop",
    climate_state: "cool",
    climate_entity: climate("cool", 16, "high"),
    stored_snapshot: JSON.stringify({ state: "off", temperature: 24, fan_mode: "auto" }),
  });
  assert(result[0]);
  assert.equal(result[0].restore.state, "off");
  assert.equal(result[1], null);
}
{
  const { result } = run("rpi_cooling_restore_decision", {
    operation: "stop",
    climate_state: "cool",
    climate_entity: climate("cool", 16, "high"),
    stored_snapshot: JSON.stringify({ state: "cool", temperature: 23, fan_mode: "auto" }),
  });
  assert.equal(result[0], null);
  assert.equal(result[1].restore.state, "cool");
  assert.equal(result[1].restore.temperature, 23);
  assert.equal(result[1].restore.fan_mode, "auto");
}
{
  const unavailable = run("rpi_cooling_restore_decision", {
    operation: "stop",
    climate_state: "unavailable",
  }).result;
  assert.equal(unavailable[0], null);
  assert.equal(unavailable[1], null);
  assert.match(unavailable[2].failure_reason, /indisponível/);
}
{
  const fallback = run("rpi_cooling_restore_decision", {
    operation: "stop",
    climate_state: "cool",
    climate_entity: climate("cool", 16, "high"),
    stored_snapshot: "",
  }).result[0];
  assert.equal(fallback.restore.state, "off");
  assert.equal(fallback.restore_fallback, true);
}
assert.deepEqual(run("rpi_cooling_restore_temperature_decision", {
  restore: { temperature: 23 },
}).result, [{ restore: { temperature: 23 } }, null]);
assert(run("rpi_cooling_restore_fan_decision", {
  restore: { fan_mode: "auto" },
}).result[0]);
assertAction("rpi_cooling_restore_off", "climate.turn_off", "climate.ar_condicionado_escritorio");
assert.equal(get("rpi_cooling_restore_mode").dataType, "jsonata");
assert.equal(get("rpi_cooling_restore_temperature").dataType, "jsonata");
assert.equal(get("rpi_cooling_restore_fan").dataType, "jsonata");
assert.deepEqual(get("rpi_cooling_restore_off").wires[0], ["rpi_cooling_restore_off_verify_out"]);
assert.deepEqual(get("rpi_cooling_restore_off_verify_out", "link out").links, [
  "rpi_cooling_restore_verify_in",
]);
assert.deepEqual(get("rpi_cooling_restore_fan").wires[0], ["rpi_cooling_restore_verify_out"]);
assert.deepEqual(get("rpi_cooling_restore_fan_decision").wires[1], ["rpi_cooling_restore_verify_out"]);
assert.deepEqual(get("rpi_cooling_restore_verify_out", "link out").links, [
  "rpi_cooling_restore_verify_in",
]);
assert.deepEqual(get("rpi_cooling_restore_verify_in", "link in").wires[0], [
  "rpi_cooling_restore_verify_delay",
]);
assert.equal(get("rpi_cooling_restore_verify_delay", "delay").timeout, "5");
assert.deepEqual(get("rpi_cooling_verify_restored_climate").wires, [
  ["rpi_cooling_restore_finished"],
  ["rpi_cooling_stop_failure_verify_out"],
]);
{
  const restoredOff = run("rpi_cooling_verify_restored_climate", {
    restore: { state: "off", temperature: 24, fan_mode: "auto" },
    restored_climate_state: "off",
    restored_climate_entity: climate("off", 16, "high"),
  }).result;
  assert(restoredOff[0]);
  assert.equal(restoredOff[1], null);
}
{
  const restoredOn = run("rpi_cooling_verify_restored_climate", {
    restore: { state: "cool", temperature: 23, fan_mode: "auto" },
    restored_climate_state: "cool",
    restored_climate_entity: climate("cool", 23, "auto"),
  }).result;
  assert(restoredOn[0]);
  assert.equal(restoredOn[1], null);
}
for (const restored of [
  { expectedState: "off", actualState: "cool", entity: climate("cool", 16, "high") },
  { expectedState: "cool", actualState: "cool", entity: climate("cool", 22, "auto") },
  { expectedState: "cool", actualState: "cool", entity: climate("cool", 23, "high") },
  { expectedState: "cool", actualState: "unavailable", entity: climate("unavailable") },
]) {
  const failed = run("rpi_cooling_verify_restored_climate", {
    restore: { state: restored.expectedState, temperature: 23, fan_mode: "auto" },
    restored_climate_state: restored.actualState,
    restored_climate_entity: restored.entity,
  }).result;
  assert.equal(failed[0], null);
  assert(failed[1]);
}
assert.deepEqual(get("rpi_cooling_restore_finished").wires[0], ["rpi_cooling_mark_inactive"]);
assert.deepEqual(get("rpi_cooling_restore_finished").wires[1], ["rpi_cooling_rollback_release_owner"]);
assertAction(
  "rpi_cooling_rollback_release_owner",
  "input_boolean.turn_off",
  "input_boolean.raspberry_pi_emergency_cooling",
);
assertAction(
  "rpi_cooling_mark_inactive",
  "input_boolean.turn_off",
  "input_boolean.raspberry_pi_emergency_cooling",
);

// Falha de saida mantem ownership, revalida temperatura e termina depois de tres tentativas.
{
  const retry = run("rpi_cooling_stop_failure", {
    operation: "stop",
    attempt: 1,
    failure_reason: "restore falhou",
  }).result;
  assert.equal(retry[0].attempt, 2);
  assert.equal(retry[1], null);
}
{
  const finalFailure = run("rpi_cooling_stop_failure", {
    operation: "stop",
    attempt: 3,
    failure_reason: "restore falhou",
  }).result;
  assert.equal(finalFailure[0], null);
  assert(finalFailure[1]);
}
assert.deepEqual(get("rpi_cooling_stop_retry_delay").wires[0], ["rpi_cooling_stop_retry_out"]);
assert.deepEqual(get("rpi_cooling_stop_retry_out", "link out").links, ["rpi_cooling_stop_retry_in"]);
assert.deepEqual(get("rpi_cooling_stop_retry_in", "link in").wires[0], [
  "rpi_cooling_retry_normal_check",
]);

// Observabilidade usa IDs estaveis, evitando acumulo; catches cobrem chamadas criticas.
assert.match(get("rpi_cooling_notify_started").data, /raspberry_pi_emergency_cooling/);
assert.match(get("rpi_cooling_notify_failure").data, /raspberry_pi_emergency_cooling_failure/);
assert.match(get("rpi_cooling_notify_recovered").data, /raspberry_pi_emergency_cooling_recovered/);
assert.match(get("rpi_cooling_dismiss_recovered").data, /raspberry_pi_emergency_cooling_recovered/);
assert.deepEqual(get("rpi_cooling_control_succeeded").wires[2], [
  "rpi_cooling_reconcile_dismiss_recovered_out",
]);
assert.deepEqual(get("rpi_cooling_start_finalized").wires[2], [
  "rpi_cooling_start_dismiss_recovered_out",
]);
const startCatch = new Set(get("rpi_cooling_start_catch", "catch").scope);
for (const id of [
  "rpi_cooling_read_climate",
  "rpi_cooling_persist_snapshot",
  "rpi_cooling_set_mode",
  "rpi_cooling_set_temperature",
  "rpi_cooling_set_fan",
  "rpi_cooling_read_controlled_climate",
  "rpi_cooling_mark_active",
]) assert(startCatch.has(id), `${id} precisa estar no catch de inicio`);
const stopCatch = new Set(get("rpi_cooling_stop_catch", "catch").scope);
for (const id of [
  "rpi_cooling_stop_read_climate",
  "rpi_cooling_restore_off",
  "rpi_cooling_restore_mode",
  "rpi_cooling_restore_temperature",
  "rpi_cooling_restore_fan",
  "rpi_cooling_read_restored_climate",
  "rpi_cooling_mark_inactive",
  "rpi_cooling_rollback_release_owner",
]) assert(stopCatch.has(id), `${id} precisa estar no catch de saida`);

// O pacote mantem ownership e snapshot persistentes, sem automacoes HA duplicadas.
assert.match(packageYaml, /raspberry_pi_emergency_cooling:/);
assert.match(packageYaml, /raspberry_pi_emergency_cooling_previous_climate:/);
assert.doesNotMatch(packageYaml, /id: raspberry_pi_emergency_cooling_(?:start|stop)/);
assert.doesNotMatch(packageYaml, /climate\.ar_condicionado_escritorio/);

console.log("Raspberry Pi emergency cooling behavior: OK");
