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

function assertVirtualRoute(sourceId, outputIndex, outputId, inputId, targetId) {
  assert.deepEqual(get(sourceId).wires[outputIndex], [outputId]);
  assert.deepEqual(get(outputId, "link out").links, [inputId]);
  assert(get(inputId, "link in").links.includes(outputId));
  assert.deepEqual(get(inputId).wires[0], [targetId]);
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
  "c8f8e5b532232a4f",
  "5ae977feca8f9b01",
  "4afb66a093b1940d",
  "f79ed8df25162bcf",
]) {
  const group = get(groupId, "group");
  for (const memberId of group.nodes) assert.equal(get(memberId).g, groupId);
  assert(group.w <= 4600, `${groupId} excede a largura organizada do canvas`);
}
for (const item of flows.filter(
  (candidate) => candidate.z === "456b32bd5d59b0d6" && candidate.type !== "group",
)) {
  assert(item.g, `${item.id} precisa pertencer a um grupo da aba`);
  assert(get(item.g, "group").nodes.includes(item.id), `${item.id} ausente do grupo ${item.g}`);
}

assert.equal(get("456b32bd5d59b0d6", "tab").label, "resfriamento_raspberry_pi");
assert.deepEqual(get("482e20c891bc1dd8").wires[0], ["54b8e92dac5342a4"]);
assert.deepEqual(get("0547960da622f030").wires[0], ["3fbbfda5d4519a8a"]);

// Os thresholds e duracoes originais permanecem intactos.
const hot = get("9b0dbe523189f263", "server-state-changed");
assert.deepEqual(hot.entities.entity, ["sensor.raspberry_pi_cpu_temperature"]);
assert.equal(hot.ifStateOperator, "gt");
assert.equal(hot.ifState, "81.9");
assert.equal(hot.stateType, "str");
assert.equal(hot.ifStateType, "num");
assert.equal(hot.for, "2");
assert.equal(hot.forUnits, "minutes");

const normal = get("213e93913539d640", "server-state-changed");
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
  "9b0dbe523189f263",
  "338e309762aa7a99",
  "426ce86b78602275",
  "213e93913539d640",
  "c1b98e075390aee0",
]) {
  const item = get(id);
  assert.equal(item.stateType ?? item.state_type, "str", `${id} nao deve usar state type numerico`);
}
assert.equal(get("426ce86b78602275").halt_if_type, "num");
assert.equal(get("c1b98e075390aee0").halt_if_type, "num");

// Startup: quente inicia/reconcilia; frio com ownership retoma a janela; faixa intermediaria preserva.
for (const owner of ["off", "on"]) {
  const { result } = run("566d191a914b687b", {
    cpu_temperature: 82.1,
    cooling_owner: owner,
  });
  assert(result[0]);
  assert.equal(result[0].operation, "start");
  assert.equal(result[0].start_source, "startup_reconciliation");
  assert.equal(result[1], null);
}
{
  const { result } = run("566d191a914b687b", {
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
  assert.equal(run("566d191a914b687b", input).result, null);
}
for (const stored_snapshot of ["", "unknown", "unavailable", "none", "null"]) {
  const { result, events } = run("566d191a914b687b", {
    cpu_temperature: 69,
    cooling_owner: "off",
    stored_snapshot,
  });
  assert.equal(result, null);
  assert.deepEqual(events.warnings, [], `${stored_snapshot || "empty"} is a transient HA state, not corrupt JSON`);
}
{
  const { result, events } = run("566d191a914b687b", {
    cpu_temperature: 69,
    cooling_owner: "off",
    stored_snapshot: "{malformed",
  });
  assert.equal(result, null);
  assert.equal(events.warnings.length, 1, "real malformed snapshots must remain observable");
  assert.match(events.warnings[0], /Snapshot pendente inválido/);
}
{
  const pending = { state: "cool", temperature: 23, fan_mode: "auto" };
  const flow = memoryFlow();
  const { result } = run("566d191a914b687b", {
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
  const { result } = run("566d191a914b687b", {
    cpu_temperature: 82,
    cooling_owner: "off",
    stored_snapshot: JSON.stringify(pending),
  });
  assert.deepEqual(result[0].previous_climate, pending);
}
const startupTimer = get("a35f9d7d54ac6026", "trigger");
assert.equal(startupTimer.duration, "10");
assert.equal(startupTimer.units, "min");
assertVirtualRoute(
  normal.id,
  1,
  "rpi_layout_cancel_timer_out",
  "rpi_layout_cancel_timer_in",
  "29b85bea56c558c5",
);
assertVirtualRoute(
  startupTimer.id,
  0,
  "rpi_layout_startup_timer_out",
  "rpi_layout_startup_timer_in",
  "c1b98e075390aee0",
);

// Idempotencia: evento comum nao reaplica comandos quando ja existe ownership;
// startup pode reconciliar, e um lock impede duas sequencias concorrentes.
{
  const flow = memoryFlow();
  assert.equal(run("482e20c891bc1dd8", {
    cooling_owner: "on",
    start_source: "temperature_threshold",
  }, flow).result, null);
  assert.equal(flow.get("rpi_emergency_cooling_operation"), undefined);
}
{
  const flow = memoryFlow();
  const first = run("482e20c891bc1dd8", {
    cooling_owner: "on",
    start_source: "startup_reconciliation",
  }, flow).result;
  assert(first[0]);
  assert.equal(first[0].start_mode, "reconcile");
  assert.equal(flow.get("rpi_emergency_cooling_operation"), "start");
  assert.equal(run("482e20c891bc1dd8", {
    cooling_owner: "on",
    start_source: "startup_reconciliation",
  }, flow).result, null);
}
{
  const { result } = run("482e20c891bc1dd8", {
    cooling_owner: "unavailable",
    start_source: "startup_reconciliation",
  });
  assert.equal(result[0], null);
  assert.match(result[1].failure_reason, /ownership/);
}

// Climate indisponivel nunca avanca para comandos nem ownership.
{
  const { result } = run("b8c032f35ca26623", {
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
  const { result } = run("b8c032f35ca26623", {
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
  const { result } = run("b8c032f35ca26623", {
    climate_state: "cool",
    climate_entity: climate("cool", 16, "high"),
    stored_snapshot: JSON.stringify(persisted),
    start_mode: "acquire",
  });
  assert.deepEqual(result[0].previous_climate, persisted);
}

// Ownership so aparece depois de persistir snapshot e concluir mode/temp/fan.
assert.deepEqual(get("26d9d7195ce14910").wires[0], ["8c3d9e9163059731"]);
assert.deepEqual(get("8c3d9e9163059731").wires[0], ["2e77d30f5abbb9e8"]);
assert.deepEqual(get("2e77d30f5abbb9e8").wires[0], ["cc598d0965e30fe5"]);
assert.deepEqual(get("cc598d0965e30fe5").wires[0], ["a32c4cc997cdaee0"]);
assert.deepEqual(get("a32c4cc997cdaee0").wires[0], ["47cae39680ac8969"]);
assert.deepEqual(get("47cae39680ac8969").wires[0], ["c57195edaf731fea"]);
assert.deepEqual(get("c57195edaf731fea").wires[0], ["303ec8403542617c"]);
assert.deepEqual(get("303ec8403542617c").wires[0], ["bed05acc4339b69c"]);
assert.deepEqual(get("bed05acc4339b69c").wires[0], ["a6f0fa154aac7b84"]);
assertAction(
  "a6f0fa154aac7b84",
  "input_boolean.turn_on",
  "input_boolean.raspberry_pi_emergency_cooling",
);
assertAction(
  "2e77d30f5abbb9e8",
  "climate.set_hvac_mode",
  "climate.ar_condicionado_escritorio",
  { hvac_mode: "cool" },
);
assertAction(
  "cc598d0965e30fe5",
  "climate.set_temperature",
  "climate.ar_condicionado_escritorio",
  { temperature: 16, hvac_mode: "cool" },
);
assertAction(
  "a32c4cc997cdaee0",
  "climate.set_fan_mode",
  "climate.ar_condicionado_escritorio",
  { fan_mode: "high" },
);
{
  const confirmed = run("303ec8403542617c", {
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
  const failed = run("303ec8403542617c", {
    controlled_climate_state: invalid.state,
    controlled_climate_entity: invalid,
  }).result;
  assert.equal(failed[0], null);
  assert.match(failed[1].failure_reason, /não confirmou/);
}

// Reconciliacao de um ownership existente nao marca de novo nem duplica a notificacao inicial.
{
  const flow = memoryFlow({ rpi_emergency_cooling_operation: "start" });
  const { result } = run("bed05acc4339b69c", { start_mode: "reconcile" }, flow);
  assert.equal(result[0], null);
  assert(result[1]);
  assert.equal(flow.get("rpi_emergency_cooling_operation"), null);
  assert.equal(get("bed05acc4339b69c").wires[1].length, 2);
  for (const target of get("bed05acc4339b69c").wires[1]) get(target, "link out");
}

// Retry e limitado a tres tentativas; falha parcial gera rollback e nunca ownership falso.
{
  const flow = memoryFlow({ rpi_emergency_cooling_operation: "start" });
  const retry = run("065453aa19652afe", {
    operation: "start",
    attempt: 1,
    failure_reason: "climate unavailable",
  }, flow).result;
  assert.equal(retry[0].attempt, 2);
  assert.equal(retry.slice(1).filter(Boolean).length, 0);
  assert.equal(flow.get("rpi_emergency_cooling_operation"), null);
}
{
  const failed = run("065453aa19652afe", {
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
for (const retryId of ["2715a6cbdf6f5683", "7a46b455ab19f6f1", "b69a6887788d1c54"]) {
  const retry = get(retryId, "delay");
  assert.equal(retry.timeout, "60");
  assert.equal(retry.timeoutUnits, "seconds");
}
assert.deepEqual(get("2715a6cbdf6f5683").wires[0], ["426ce86b78602275"]);
assertVirtualRoute(
  "426ce86b78602275",
  0,
  "rpi_layout_hot_retry_out",
  "rpi_layout_hot_retry_in",
  "4a38415ec9862e2e",
);

// Encerramento: helper off bloqueia o caminho destrutivo por wiring; lock evita concorrencia.
assert.deepEqual(get("8a59f82d6ce4aadf").wires, [["6162b449cc4a318b"], []]);
{
  const flow = memoryFlow();
  assert(run("6162b449cc4a318b", { attempt: 1 }, flow).result);
  assert.equal(flow.get("rpi_emergency_cooling_operation"), "stop");
  assert.equal(run("6162b449cc4a318b", { attempt: 1 }, flow).result, null);
}

// Restauracao sobrevive a restart via input_text e cobre ar originalmente off/on.
{
  const { result } = run("3fbbfda5d4519a8a", {
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
  const { result } = run("3fbbfda5d4519a8a", {
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
  const unavailable = run("3fbbfda5d4519a8a", {
    operation: "stop",
    climate_state: "unavailable",
  }).result;
  assert.equal(unavailable[0], null);
  assert.equal(unavailable[1], null);
  assert.match(unavailable[2].failure_reason, /indisponível/);
}
{
  const fallback = run("3fbbfda5d4519a8a", {
    operation: "stop",
    climate_state: "cool",
    climate_entity: climate("cool", 16, "high"),
    stored_snapshot: "",
  }).result[0];
  assert.equal(fallback.restore.state, "off");
  assert.equal(fallback.restore_fallback, true);
}
assert.deepEqual(run("2d4e5f16992b02a3", {
  restore: { temperature: 23 },
}).result, [{ restore: { temperature: 23 } }, null]);
assert(run("9db243616c0d9256", {
  restore: { fan_mode: "auto" },
}).result[0]);
assertAction("58fc2938de8879ce", "climate.turn_off", "climate.ar_condicionado_escritorio");
assert.equal(get("54e8149a2939446d").dataType, "jsonata");
assert.equal(get("abef0869bb9f8954").dataType, "jsonata");
assert.equal(get("94cf8f23337b9e97").dataType, "jsonata");
assertVirtualRoute(
  "58fc2938de8879ce",
  0,
  "rpi_layout_restore_off_wait_out",
  "rpi_layout_restore_wait_in",
  "d4a1580cc965ba33",
);
assert.deepEqual(get("94cf8f23337b9e97").wires[0], ["d4a1580cc965ba33"]);
assertVirtualRoute(
  "9db243616c0d9256",
  1,
  "rpi_layout_restore_fan_wait_out",
  "rpi_layout_restore_wait_in",
  "d4a1580cc965ba33",
);
assert.equal(get("d4a1580cc965ba33", "delay").timeout, "5");
assert.deepEqual(get("ff9a68d5d76c1aab").wires, [
  ["6e624c181ac580f8"],
  ["rpi_layout_restore_validation_failure_out"],
]);
assertVirtualRoute(
  "ff9a68d5d76c1aab",
  1,
  "rpi_layout_restore_validation_failure_out",
  "rpi_layout_restore_failure_in",
  "3653df579248c807",
);
{
  const restoredOff = run("ff9a68d5d76c1aab", {
    restore: { state: "off", temperature: 24, fan_mode: "auto" },
    restored_climate_state: "off",
    restored_climate_entity: climate("off", 16, "high"),
  }).result;
  assert(restoredOff[0]);
  assert.equal(restoredOff[1], null);
}
{
  const restoredOn = run("ff9a68d5d76c1aab", {
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
  const failed = run("ff9a68d5d76c1aab", {
    restore: { state: restored.expectedState, temperature: 23, fan_mode: "auto" },
    restored_climate_state: restored.actualState,
    restored_climate_entity: restored.entity,
  }).result;
  assert.equal(failed[0], null);
  assert(failed[1]);
}
assert.deepEqual(get("6e624c181ac580f8").wires[0], ["b9a3beb0d37aad9a"]);
assert.deepEqual(get("6e624c181ac580f8").wires[1], ["9b036ac57fe732eb"]);
assertAction(
  "9b036ac57fe732eb",
  "input_boolean.turn_off",
  "input_boolean.raspberry_pi_emergency_cooling",
);
assertAction(
  "b9a3beb0d37aad9a",
  "input_boolean.turn_off",
  "input_boolean.raspberry_pi_emergency_cooling",
);

// Falha de saida mantem ownership, revalida temperatura e termina depois de tres tentativas.
{
  const retry = run("3653df579248c807", {
    operation: "stop",
    attempt: 1,
    failure_reason: "restore falhou",
  }).result;
  assert.equal(retry[0].attempt, 2);
  assert.equal(retry[1], null);
}
{
  const finalFailure = run("3653df579248c807", {
    operation: "stop",
    attempt: 3,
    failure_reason: "restore falhou",
  }).result;
  assert.equal(finalFailure[0], null);
  assert(finalFailure[1]);
}
assert.deepEqual(get("b69a6887788d1c54").wires[0], ["c1b98e075390aee0"]);

// Observabilidade usa IDs estaveis, evitando acumulo; catches cobrem chamadas criticas.
assert.match(get("349bc099633fee5d").data, /raspberry_pi_emergency_cooling/);
assert.match(get("ab4f85af1ed94f86").data, /raspberry_pi_emergency_cooling_failure/);
assert.match(get("a240a1bb42481943").data, /raspberry_pi_emergency_cooling_recovered/);
assert.match(get("4b48bc3c0c58d87c").data, /raspberry_pi_emergency_cooling_recovered/);
assert.deepEqual(get("bed05acc4339b69c").wires[2], ["048e2325e2e65944"]);
assert.deepEqual(get("0cca7636547bd45c").wires[2], ["048e2325e2e65944"]);
const startCatch = new Set(get("4e460c1a9e688d48", "catch").scope);
for (const id of [
  "54b8e92dac5342a4",
  "26d9d7195ce14910",
  "2e77d30f5abbb9e8",
  "cc598d0965e30fe5",
  "a32c4cc997cdaee0",
  "c57195edaf731fea",
  "a6f0fa154aac7b84",
]) assert(startCatch.has(id), `${id} precisa estar no catch de inicio`);
const stopCatch = new Set(get("ff69bc148fd602ce", "catch").scope);
for (const id of [
  "0547960da622f030",
  "58fc2938de8879ce",
  "54e8149a2939446d",
  "abef0869bb9f8954",
  "94cf8f23337b9e97",
  "feff1e28b5cf244b",
  "b9a3beb0d37aad9a",
  "9b036ac57fe732eb",
]) assert(stopCatch.has(id), `${id} precisa estar no catch de saida`);

// O pacote mantem ownership e snapshot persistentes, sem automacoes HA duplicadas.
assert.match(packageYaml, /raspberry_pi_emergency_cooling:/);
assert.match(packageYaml, /raspberry_pi_emergency_cooling_previous_climate:/);
assert.doesNotMatch(packageYaml, /id: raspberry_pi_emergency_cooling_(?:start|stop)/);
assert.doesNotMatch(packageYaml, /climate\.ar_condicionado_escritorio/);

console.log("Raspberry Pi emergency cooling behavior: OK");
