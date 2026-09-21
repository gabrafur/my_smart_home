#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";

const flowsPath = process.argv[2] ?? new URL("../flows.json", import.meta.url);
const flows = JSON.parse(fs.readFileSync(flowsPath, "utf8"));
const byId = new Map(flows.map((node) => [node.id, node]));
const TAB = "62bb822e033d1623";
const tabNodes = flows.filter((node) => node.z === TAB);
const getFunction = (id) => {
  const node = byId.get(id);
  assert.equal(node?.type, "function", `function ausente: ${id}`);
  return new Function("msg", "flow", "node", "global", node.func);
};
function context(initial = {}) {
  const stores = {
    default: new Map(Object.entries(initial.default ?? {})),
    persistent: new Map(Object.entries(initial.persistent ?? {})),
    memoryOnly: new Map(Object.entries(initial.memoryOnly ?? {})),
  };
  return {
    stores,
    get(key, store = "default") { return stores[store].get(key); },
    set(key, value, store = "default") { stores[store].set(key, structuredClone(value)); },
  };
}
const nodeMock = { status() {}, warn() {}, error(error) { throw new Error(String(error)); } };
const globalMock = { get() { return undefined; } };
const call = (fn, msg, flow) => fn(msg, flow, nodeMock, globalMock);

assert.equal(byId.get(TAB)?.label, "contexto_chegadas");
assert.ok(tabNodes.length >= 100);
assert.deepEqual(
  byId.get("vehicle_primary_manual_refresh_button_v1")?.entities?.entity,
  ["input_button.vehicle_primary_force_refresh_now"],
  "o botão manual deve observar a entidade canônica existente no Home Assistant",
);
for (const id of [
  "arrival_context_policy_switch", "arrival_context_cycle_policy_available", "arrival_context_kind_switch",
  "arrival_context_reset_test_gate", "arrival_context_inflight_switch", "arrival_context_inflight_force",
  "arrival_context_snapshot_policy_available", "arrival_context_snapshot_valid", "arrival_context_snapshot_future",
  "arrival_context_snapshot_out_of_order", "arrival_context_snapshot_newer", "arrival_context_snapshot_missing_time",
  "arrival_context_snapshot_same_changed", "arrival_context_departure_domain", "arrival_context_departure_accepted",
  "arrival_context_departure_source", "arrival_context_departure_previous", "arrival_context_departure_state",
  "arrival_context_departure_ready", "arrival_context_departure_away", "arrival_context_departure_duplicate",
  "arrival_context_cycle_match", "arrival_context_both_received", "arrival_context_pending_emitted",
  "arrival_context_departure_precedence", "arrival_context_requested_reason", "arrival_context_recovery_reason",
  "arrival_context_people_reason",
  "arrival_context_home_domain", "arrival_context_home_accepted", "arrival_context_home_source",
  "arrival_context_home_transition", "arrival_context_home_current", "arrival_context_home_duplicate",
  "arrival_context_home_pending", "arrival_context_home_ack", "arrival_context_home_expired",
  "arrival_context_home_away", "arrival_context_home_engine_off", "arrival_context_home_due",
  "arrival_context_home_engine_allows", "arrival_context_home_retry_due",
]) assert.equal(byId.get(id)?.type, "switch", `decisão visual ausente: ${id}`);

const policyValidate = getFunction("arrival_context_policy_validate");
const policyStore = getFunction("arrival_context_policy_store");
const policyLoad = getFunction("arrival_context_cycle_policy_load");
const cycleRead = getFunction("arrival_context_cycle_read");
const cycleStart = getFunction("arrival_context_cycle_start");
const cyclePromote = getFunction("arrival_context_cycle_promote");
const testReset = getFunction("arrival_context_test_reset");
const snapshotRead = getFunction("arrival_context_snapshot_read");
const cacheMutate = getFunction("arrival_context_cache_mutate");
const departureRead = getFunction("arrival_context_departure_read");
const departureBuild = getFunction("arrival_context_departure_build");
const pendingRead = getFunction("arrival_context_pending_read");
const pendingUpdate = getFunction("arrival_context_pending_update");
const markEmitted = getFunction("arrival_context_mark_emitted");
const refreshBuild = getFunction("arrival_context_refresh_build");
const homeRefreshRead = getFunction("arrival_context_home_refresh_read");
const homeRefreshStore = getFunction("arrival_context_home_refresh_store");
const homeRefreshDueLoad = getFunction("arrival_context_home_due_read");
const homeRefreshDueSelect = getFunction("arrival_context_home_due_select");
const homeRefreshDueRead = (msg, flowArg, nodeArg, globalArg) =>
  homeRefreshDueSelect(
    homeRefreshDueLoad(msg, flowArg, nodeArg, globalArg),
    flowArg,
    nodeArg,
    globalArg,
  );
const homeRefreshBuild = getFunction("arrival_context_home_refresh_build");
const homeRefreshClear = getFunction("arrival_context_home_clear");
const defaults = { inflight_timeout_s: 10, future_tolerance_s: 60,
  home_confirmation_delay_s: 90, home_confirmation_retry_s: 30,
  home_confirmation_expiry_min: 15 };
const flow = context();
let msg = call(policyValidate, { payload: defaults }, flow);
assert.equal(msg.policy_valid, true);
call(policyStore, msg, flow);
assert.deepEqual(call(policyLoad, {}, flow).policy, { version: 1, ...defaults });
for (const payload of [
  { ...defaults, inflight_timeout_s: 0 }, { ...defaults, inflight_timeout_s: 61 },
  { ...defaults, future_tolerance_s: -1 }, { ...defaults, future_tolerance_s: 301 },
  { ...defaults, inflight_timeout_s: 1.5 },
  { ...defaults, home_confirmation_delay_s: 29 }, { ...defaults, home_confirmation_retry_s: 9 },
  { ...defaults, home_confirmation_expiry_min: 61 },
]) assert.equal(call(policyValidate, { payload }, flow).policy_valid, false);
assert.equal(call(policyValidate, { payload: { ...defaults, inflight_timeout_s: 1, future_tolerance_s: 0 } }, flow).policy_valid, true);
assert.equal(call(policyValidate, { payload: { ...defaults, inflight_timeout_s: 60, future_tolerance_s: 300 } }, flow).policy_valid, true);
assert.deepEqual(call(policyLoad, {}, flow).policy, { version: 1, ...defaults });

const now = Date.UTC(2026, 0, 1, 12, 0, 0);
function begin(targetFlow, at, extra = {}) {
  let current = call(policyLoad, { monitor_now: at, payload: { kind: "refresh_tick", ...extra } }, targetFlow);
  current = call(cycleRead, current, targetFlow);
  return { read: current, started: current.context_cycle_inflight ? null : call(cycleStart, current, targetFlow) };
}
let started = begin(flow, now, { reason: "startup_or_periodic_reconciliation" });
assert.equal(started.read.context_cycle_inflight, false);
assert.equal(started.started.payload.contract, "security.snapshot-request.v1");
const firstCycle = started.started.payload.refresh_cycle_id;
let inFlight = begin(flow, now + 9999, { reason: "periodic" });
assert.equal(inFlight.read.context_cycle_inflight, true);
assert.equal(inFlight.started, null);
inFlight.read.context_force_recovery = true;
inFlight.read.context_require_lighting = true;
inFlight.read.context_request_reason = "lighting_recovery";
call(cyclePromote, inFlight.read, flow);
assert.equal(flow.get("refresh_pending").cycle, firstCycle);
assert.equal(flow.get("refresh_pending").force_recovery, true);
started = begin(flow, now + 10000, { reason: "new_after_timeout" });
assert.equal(started.read.context_cycle_inflight, false, "limite exato de 10 s abre novo ciclo");
assert.notEqual(started.started.payload.refresh_cycle_id, firstCycle);

function acceptance(current) {
  if (current.context_is_future) return ["reject", "future_timestamp"];
  if (current.context_is_out_of_order) return ["reject", "out_of_order"];
  if (current.context_is_newer) return ["accept", ""];
  if (current.context_missing_timestamp) return ["reject", "missing_timestamp"];
  if (current.context_same_changed) return ["accept", ""];
  return ["reject", "duplicate"];
}
function processSnapshot(targetFlow, input) {
  let current = call(policyLoad, input, targetFlow);
  current = call(snapshotRead, current, targetFlow);
  assert.equal(current.context_snapshot_valid, true);
  [current.context_snapshot_action, current.context_rejected_reason] = acceptance(current);
  current = call(cacheMutate, current, targetFlow);
  current = call(departureRead, current, targetFlow);
  const departure = current.context_domain === "people" && current.context_snapshot_accepted &&
    ["resident_primary", "resident_secondary"].includes(current.departure_source) &&
    current.payload.trigger_prev_state === "home" && ["near_home", "not_home"].includes(current.payload.trigger_state) &&
    current.departure_position?.ready === true && current.payload.context.best_location_away === true &&
    current.departure_previous_signature !== current.departure_signature;
  let command = null;
  if (departure) {
    const outputs = call(departureBuild, current, targetFlow);
    command = outputs[0];
    current = outputs[1];
  }
  current = call(pendingRead, current, targetFlow);
  let paired = null;
  if (current.context_cycle_match) {
    current = call(pendingUpdate, current, targetFlow);
    if (current.context_both_received && !current.context_already_emitted) {
      current = call(markEmitted, current, targetFlow);
      if (!current.context_departure_selected) {
        current.context_people_recovery_needed = current.context_pending.people_ready !== true;
        current.context_contexts_ready = current.context_pending.people_ready === true && current.context_pending.vehicle_primary_ready === true;
        current.context_recovery_needed = current.context_pending.vehicle_primary_ready !== true || current.context_pending.force_recovery === true;
        current.context_recovery_reason = current.context_pending.request_reason ||
          (current.context_recovery_needed ? "vehicle_readiness_recovery_needed" :
            current.context_people_recovery_needed ? "people_location_recovery_only" : "paired_ready_snapshots");
        paired = call(refreshBuild, current, targetFlow);
      }
    }
  }
  return { current, command, paired };
}

const missingFirst = context({ persistent: { arrival_context_policy_v1: { version: 1, ...defaults } } });
let processed = processSnapshot(missingFirst, { monitor_now: now, payload: { kind: "people_context", context: { ready: true }, ready: true } });
assert.equal(processed.current.context_snapshot_accepted, true, "primeiro snapshot sem timestamp preserva compatibilidade");
processed = processSnapshot(missingFirst, { monitor_now: now + 1, payload: { kind: "people_context", context: { ready: false }, ready: false } });
assert.equal(processed.current.context_rejected_reason, "missing_timestamp");

const pairFlow = context({ persistent: { arrival_context_policy_v1: { version: 1, ...defaults } } });
started = begin(pairFlow, now, { reason: "paired" });
const cycle = started.started.payload.refresh_cycle_id;
const peopleContext = { updated_at: now, ready: true, anyone_away: true, best_location_away: true,
  arrival_armed: { resident_primary: true, resident_secondary: false },
  local_excursions: {
    resident_secondary: { started_at: now - 60_000, expires_at: now + 60_000 },
  },
  resident_primary: { state: "not_home", ready: true, best_location_away: true, updated_at: now },
  resident_secondary: { state: "home", ready: true, updated_at: now } };
processed = processSnapshot(pairFlow, { monitor_now: now, payload: { kind: "people_context", refresh_cycle_id: cycle, updated_at: now, context: peopleContext, ready: true } });
assert.equal(processed.paired, null);
processed = processSnapshot(pairFlow, { monitor_now: now + 1, payload: { kind: "vehicle_primary_context", refresh_cycle_id: cycle, updated_at: now + 1, context: { updated_at: now + 1, ready: true, away: false }, ready: true } });
assert.equal(processed.paired.payload.contexts_ready, true);
assert.equal(processed.paired.payload.recovery_needed, false);
assert.equal(processed.paired.payload.anyone_away, true);
assert.equal(processed.paired.payload.resident_primary_updated_at,
  peopleContext.resident_primary.updated_at);
assert.equal(processed.paired.payload.resident_secondary_updated_at,
  peopleContext.resident_secondary.updated_at,
  "cadência de retorno pendente deve receber a idade real da posição");
assert.deepEqual(processed.paired.payload.people_arrival_armed,
  peopleContext.arrival_armed,
  "contrato entre tabs deve transportar a chegada armada");
assert.deepEqual(processed.paired.payload.people_local_excursions,
  peopleContext.local_excursions,
  "contrato entre tabs deve transportar a parada curta");
processed = processSnapshot(pairFlow, { monitor_now: now + 2, payload: { kind: "vehicle_primary_context", refresh_cycle_id: cycle, updated_at: now + 2, context: { updated_at: now + 2, ready: true }, ready: true } });
assert.equal(processed.paired, null, "ciclo concluído não duplica política");

processed = processSnapshot(pairFlow, { monitor_now: now + 61000, payload: { kind: "people_context", updated_at: now + 61000, context: { ...peopleContext, updated_at: now + 61000 }, ready: true } });
assert.equal(processed.current.context_snapshot_accepted, true);
processed = processSnapshot(pairFlow, { monitor_now: now + 62000, payload: { kind: "people_context", updated_at: now + 61000, context: { ...peopleContext, ready: false, updated_at: now + 61000 }, ready: false } });
assert.equal(processed.current.context_snapshot_accepted, true, "mudança derivada no mesmo timestamp é aceita");
processed = processSnapshot(pairFlow, { monitor_now: now + 63000, payload: { kind: "people_context", updated_at: now - 1, context: { ...peopleContext, updated_at: now - 1 }, ready: true } });
assert.equal(processed.current.context_rejected_reason, "out_of_order");
processed = processSnapshot(pairFlow, { monitor_now: now + 64000, payload: { kind: "people_context", updated_at: now + 400000, context: { ...peopleContext, updated_at: now + 400000 }, ready: true } });
assert.equal(processed.current.context_rejected_reason, "future_timestamp");

const departureFlow = context({ persistent: { arrival_context_policy_v1: { version: 1, ...defaults } } });
started = begin(departureFlow, now, { reason: "paired" });
const departureCycle = started.started.payload.refresh_cycle_id;
processSnapshot(departureFlow, { monitor_now: now, payload: { kind: "vehicle_primary_context", refresh_cycle_id: departureCycle, updated_at: now, context: { updated_at: now, ready: true }, ready: true } });
const departurePeople = { ...peopleContext, updated_at: now + 1,
  resident_primary: { state: "near_home", ready: true, best_location_away: true, updated_at: now + 1 } };
processed = processSnapshot(departureFlow, { monitor_now: now + 1, payload: {
  kind: "people_context", refresh_cycle_id: departureCycle, updated_at: now + 1, context: departurePeople, ready: true,
  source: "resident_primary", trigger_prev_state: "home", trigger_state: "near_home",
} });
assert.equal(processed.command.payload.reason, "resident_departure");
assert.equal(processed.paired, null, "saída prevalece sobre política conjunta no mesmo snapshot");
assert.equal(departureFlow.get("refresh_pending").emitted, true);

const testFlow = context({ persistent: { arrival_context_policy_v1: { version: 1, ...defaults } } });
msg = call(testReset, { _location_test: true, payload: { kind: "test_reset", test_mode: true } }, testFlow);
msg = call(cycleRead, { ...msg, policy: { version: 1, ...defaults }, monitor_now: now }, testFlow);
msg = call(cycleStart, msg, testFlow);
assert.equal(msg.payload.test_mode, true);
assert.equal(testFlow.get("refresh_pending"), undefined, "teste não contamina ciclo de produção");
assert.ok(testFlow.get("refresh_pending__test"));

const homeFlow = context({
  persistent: { arrival_context_policy_v1: { version: 1, ...defaults } },
  default: { vehicle_primary_context_v1: { updated_at: now - 10_000, ready: true,
    engine_state_valid: true, engine_on: true, refresh: { last_request_at: null } } },
});
let homeMsg = {
  policy: { version: 1, ...defaults }, context_domain: "people", context_snapshot_accepted: true,
  context_incoming_at: now, context_now: now,
  payload: { kind: "people_context", source: "resident_secondary",
    trigger_prev_state: "unavailable", trigger_state: "home", ready: true,
    context: { updated_at: now, ready: true,
      resident_secondary: { state: "home", ready: true, stale: false,
        current_home: true, updated_at: now } } },
};
homeFlow.set("people_context_v1", homeMsg.payload.context);
homeMsg = call(homeRefreshRead, homeMsg, homeFlow);
assert.equal(homeMsg.home_refresh.transition_valid, true,
  "unavailable → home precisa ser uma chegada válida para o refresh extraordinário");
assert.equal(homeMsg.home_refresh.engine_on_at_arrival, true);
call(homeRefreshStore, homeMsg, homeFlow);
let homePendingState = homeFlow.get("resident_home_refresh_v2", "persistent");
let homePending = homePendingState.residents.resident_secondary;
assert.equal(homePending.due_at, now + 90_000);
assert.equal(homePending.engine_on_at_arrival, true);

let dueMsg = call(homeRefreshDueRead, {
  policy: { version: 1, ...defaults }, monitor_now: now + 90_001,
  payload: { kind: "home_confirmation_tick" },
}, homeFlow);
assert.equal(dueMsg.home_refresh_due.due, true);
assert.equal(dueMsg.home_refresh_due.engine_allows, true);
dueMsg.policy = { version: 1, ...defaults };
const extraordinary = call(homeRefreshBuild, dueMsg, homeFlow);
assert.equal(extraordinary.payload.reason, "resident_arrival_confirmation");
assert.equal(extraordinary.payload.resident_arrival_force, true);
assert.equal(extraordinary.payload.require_lighting_ready, false,
  "refresh de HOME não pode depender do lifecycle do refletor");
homePendingState = homeFlow.get("resident_home_refresh_v2", "persistent");
homePending = homePendingState.residents.resident_secondary;
assert.equal(homePending.attempts, 1);

homeFlow.set("vehicle_primary_context_v1", { updated_at: now + 95_000, ready: true,
  engine_state_valid: true, engine_on: true,
  refresh: { last_request_at: homePending.issued_at + 1 } });
dueMsg = call(homeRefreshDueRead, { payload: { kind: "home_confirmation_tick" } }, homeFlow);
assert.equal(dueMsg.home_refresh_due.request_observed, true);
call(homeRefreshClear, dueMsg, homeFlow);
assert.equal(homeFlow.get("resident_home_refresh_v2", "persistent"), undefined);

const offFlow = context({
  persistent: { arrival_context_policy_v1: { version: 1, ...defaults },
    resident_home_refresh_v2: { version: 2, residents: {
      resident_primary: { version: 1, source: "resident_primary",
        arrival_observed_at: now, due_at: now + 90_000, expires_at: now + 990_000,
        engine_on_at_arrival: true, next_emit_at: now + 90_000 }
    } } },
  default: {
    people_context_v1: { resident_primary: { ready: true, stale: false, current_home: true } },
    vehicle_primary_context_v1: { updated_at: now + 30_000, engine_state_valid: true,
      engine_on: false, refresh: {} },
  },
});
dueMsg = call(homeRefreshDueRead, { payload: { kind: "home_confirmation_tick" } }, offFlow);
assert.equal(dueMsg.home_refresh_due.explicit_engine_off, true,
  "OFF confirmado após HOME cancela a consulta desnecessária");

const independentFlow = context({
  persistent: { arrival_context_policy_v1: { version: 1, ...defaults } },
  default: { vehicle_primary_context_v1: { updated_at: now - 10_000, ready: true,
    engine_state_valid: true, engine_on: true, refresh: { last_request_at: null } } },
});
for (const [source, offset] of [["resident_primary", 0], ["resident_secondary", 20_000]]) {
  const eventAt = now + offset;
  const people = {
    updated_at: eventAt, ready: true,
    resident_primary: { state: "home", ready: true, stale: false,
      current_home: true, updated_at: eventAt },
    resident_secondary: { state: "home", ready: true, stale: false,
      current_home: true, updated_at: eventAt },
  };
  independentFlow.set("people_context_v1", people);
  let residentMsg = {
    policy: { version: 1, ...defaults }, context_domain: "people",
    context_snapshot_accepted: true, context_incoming_at: eventAt, context_now: eventAt,
    payload: { kind: "people_context", source, trigger_prev_state: "near_home",
      trigger_state: "home", ready: true, context: people },
  };
  residentMsg = call(homeRefreshRead, residentMsg, independentFlow);
  call(homeRefreshStore, residentMsg, independentFlow);
}
let independentState = independentFlow.get("resident_home_refresh_v2", "persistent");
assert.deepEqual(Object.keys(independentState.residents).sort(),
  ["resident_primary", "resident_secondary"],
  "cada morador precisa manter seu próprio deadline HOME");
independentFlow.set("people_context_v1", {
  resident_primary: { ready: true, stale: false, current_home: true, state: "home" },
  resident_secondary: { ready: true, stale: false, current_home: false, state: "near_home" },
});
dueMsg = call(homeRefreshDueRead, {
  policy: { version: 1, ...defaults }, monitor_now: now + 30_000, payload: {},
}, independentFlow);
assert.equal(dueMsg.home_refresh_due.pending.source, "resident_secondary");
assert.equal(dueMsg.home_refresh_due.explicit_away, true);
call(homeRefreshClear, dueMsg, independentFlow);
independentState = independentFlow.get("resident_home_refresh_v2", "persistent");
assert.ok(independentState.residents.resident_primary,
  "oscilação do segundo morador não pode cancelar o refresh do primeiro");

const arrivalFlagFlow = context({ persistent: { arrival_context_policy_v1: { version: 1, ...defaults } } });
started = begin(arrivalFlagFlow, now, { reason: "resident_arrival_confirmation",
  force_recovery: true, resident_arrival_force: true,
  arrival_source: "resident_secondary", arrival_stage: "home" });
assert.equal(arrivalFlagFlow.get("refresh_pending").resident_arrival_force, true,
  "o bypass extraordinário não pode se perder no ciclo coordenado");

for (const id of ["3514854bb1279cbb", "45cb8ce559f5a522", "9f9a1fe3c4afc387", "1ba5ecf650ac79b8", "6473697c19342f07", "9f109b7076619124"]) {
  assert.ok(byId.has(id), `contrato preservado: ${id}`);
}
const maxFunctionSize = Math.max(...tabNodes.filter((node) => node.type === "function").map((node) => node.func.length));
assert.ok(maxFunctionSize < 2000, `JavaScript residual grande: ${maxFunctionSize}`);

console.log("Arrival context visual flow tests passed.");
