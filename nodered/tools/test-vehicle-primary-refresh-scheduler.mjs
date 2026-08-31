#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

process.env.TZ = "America/Sao_Paulo";

const toolsDir = path.dirname(fileURLToPath(import.meta.url));
const functionDir = path.join(toolsDir, "functions");
const flows = JSON.parse(
  fs.readFileSync(path.resolve(toolsDir, "../flows.json"), "utf8"),
);

function source(name) {
  return fs.readFileSync(path.join(functionDir, name), "utf8");
}

const code = {
  coordinator: source("vehicle-primary-refresh-coordinator.js"),
  accepted: source("vehicle-primary-refresh-accepted.js"),
  error: source("vehicle-primary-refresh-error.js"),
  dispatchGuard: source("vehicle-primary-refresh-dispatch-guard.js"),
  tripGuard: source("vehicle-primary-trip-dispatch-guard.js"),
  dryRun: source("vehicle-primary-dry-run-terminal.js"),
  notificationGuard: source("vehicle-primary-notification-dispatch-guard.js"),
  arrival: source("vehicle-primary-arrival-actions.js"),
  normalizer: flows.find((node) => node.id === "092625f2eb5cc156")?.func,
};

for (const [name, body] of Object.entries(code)) {
  assert.equal(typeof body, "string", `fonte ausente: ${name}`);
  new Function(
    "msg", "node", "context", "flow", "global", "env",
    "setTimeout", "clearTimeout", body,
  );
}

function memory(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    get(key) { return values.get(key); },
    set(key, value) { values.set(key, value); },
    values,
  };
}

function execute(body, { msg, store, now, logs = [] }) {
  const RealDate = Date;
  class FixedDate extends RealDate {
    constructor(value) { super(value === undefined ? now : value); }
    static now() { return now; }
  }
  const globals = memory();
  const sandbox = {
    msg,
    Date: FixedDate,
    structuredClone,
    flow: store,
    global: globals,
    context: memory(),
    env: {
      get(key) {
        return ({ HOME_LAT: "0", HOME_LON: "0", GATE_LAT: "0", GATE_LON: "0" })[key];
      },
    },
    node: {
      log(value) { logs.push(String(value)); },
      warn(value) { logs.push(String(value)); },
      error(value) { logs.push(String(value)); },
      status() {},
    },
    setTimeout,
    clearTimeout,
  };
  return vm.runInNewContext(`(function () {\n${body}\n})()`, sandbox);
}

const DAY = Date.parse("2026-08-30T15:00:00Z"); // 12:00 America/Sao_Paulo
const NIGHT = Date.parse("2026-08-30T03:00:00Z"); // 00:00 America/Sao_Paulo
const KEY = "security_vehicle_primary_refresh_v1";

function readyContext(at) {
  return {
    ready: true,
    lighting_ready: true,
    location: { updated_at: at },
    engine_updated_at: at,
    lock_updated_at: at,
  };
}

function command(overrides = {}) {
  return {
    payload: {
      kind: "refresh_command",
      anyone_away: false,
      vehicle_primary_ready: true,
      ...overrides,
    },
  };
}

function coordinator(store, now, overrides = {}) {
  return execute(code.coordinator, {
    msg: command(overrides), store, now,
  });
}

function entity(state, updatedAt, attributes = {}) {
  const timestamp = new Date(updatedAt).toISOString();
  return {
    state,
    last_changed: timestamp,
    last_updated: timestamp,
    attributes,
  };
}

function normalize(store, now, observedAt, telemetryAt = observedAt) {
  return execute(code.normalizer, {
    now,
    store,
    msg: {
      payload: {
        event: "context_snapshot",
        source: "refresh",
        trigger_state: "home",
        trigger_prev_state: "home",
        vehicle_primary: entity("home", observedAt, {
          latitude: 0,
          longitude: 0,
          gps_accuracy: 10,
        }),
        vehicle_primary_engine: entity("off", observedAt),
        vehicle_primary_lock: entity("locked", observedAt),
        vehicle_primary_last_updated: entity(
          new Date(telemetryAt).toISOString(),
          observedAt,
        ),
      },
    },
  });
}

const passed = [];
function scenario(name, callback) {
  callback();
  passed.push(name);
}

scenario("01 intervalo normal de 15 minutos", () => {
  const store = memory({
    vehicle_primary_context_v1: readyContext(DAY - 1_000),
    [KEY]: {
      attempts: 0,
      awaiting_evidence: false,
      last_success_at: DAY - 1_000,
      next_allowed_at: DAY + 15 * 60_000,
    },
  });
  assert.equal(coordinator(store, DAY + 14 * 60_000), null);
  assert(coordinator(store, DAY + 15 * 60_000));
});

scenario("02 todos em casa durante o dia", () => {
  const store = memory({ vehicle_primary_context_v1: readyContext(DAY) });
  assert(coordinator(store, DAY, { anyone_away: false }));
});

scenario("03 todos em casa durante a noite", () => {
  const store = memory({ vehicle_primary_context_v1: readyContext(NIGHT) });
  assert.equal(coordinator(store, NIGHT, { anyone_away: false }), null);
  assert.equal(store.get(KEY).reason, "waiting_for_day_or_away");
});

scenario("04 alguém fora de casa", () => {
  const store = memory({ vehicle_primary_context_v1: readyContext(NIGHT) });
  assert(coordinator(store, NIGHT, { anyone_away: true }));
});

scenario("05 refresh manual ignora cooldown e permanece serializado", () => {
  const store = memory({
    vehicle_primary_context_v1: readyContext(DAY),
    [KEY]: {
      attempts: 0,
      awaiting_evidence: false,
      last_success_at: DAY,
      last_request_at: DAY,
      next_allowed_at: DAY + 15 * 60_000,
    },
  });
  const first = coordinator(store, DAY + 1_000, {
    reason: "manual_force",
    force_recovery: true,
  });
  assert(first[0]);
  assert(first[1]);
  assert.equal(first[2], null);
  assert.equal(store.get(KEY).last_request_at, DAY + 1_000);

  const second = coordinator(store, DAY + 2_000, {
    reason: "manual_force",
    force_recovery: true,
  });
  assert.equal(second[0], null);
  assert.equal(second[2].notification.id, "vehicle_primary_refresh_blocked");
});

scenario("06 chegada e movimento entram no coordenador", () => {
  const store = memory({ vehicle_primary_context_v1: readyContext(DAY) });
  const arrival = execute(code.arrival, {
    now: DAY,
    store,
    msg: {
      payload: {
        kind: "arrival",
        source: "vehicle_primary",
        arrival_source_type: "vehicle_primary",
        arrival_stage: "approach",
        event_at: DAY,
        request_vehicle_primary_wake: true,
      },
    },
  });
  assert.equal(arrival[0].payload.kind, "refresh_command");
  assert.equal(arrival[0].payload.reason, "vehicle_primary_arrival");
  assert(coordinator(store, DAY, arrival[0].payload));

  const movementStore = memory({ vehicle_primary_context_v1: readyContext(DAY) });
  assert(coordinator(movementStore, DAY, {
    reason: "vehicle_primary_location_changed",
    force_recovery: true,
  }));
});

scenario("07 recovery com entidade stale", () => {
  const store = memory({ vehicle_primary_context_v1: { ready: false, stale: true } });
  assert(coordinator(store, NIGHT, {
    vehicle_primary_ready: false,
    recovery_needed: true,
    reason: "stale_recovery",
  }));
});

for (const [number, state] of [["08", "unknown"], ["09", "unavailable"]]) {
  scenario(`${number} entidade ${state} falha de maneira segura`, () => {
    const store = memory({ vehicle_primary_context_v1: { ready: false, state } });
    const result = coordinator(store, NIGHT, {
      vehicle_primary_ready: false,
      recovery_needed: true,
      reason: `${state}_recovery`,
    });
    assert(result[0]);
    assert.equal(store.get(KEY).request_in_flight, true);
  });
}

for (const [number, message, expected] of [
  ["10", "401 Unauthorized", "authentication"],
  ["11", "ReadTimeout while contacting Bluelink", "timeout"],
]) {
  scenario(`${number} ${message}`, () => {
    const store = memory({
      [KEY]: {
        attempts: 1,
        awaiting_evidence: true,
        request_in_flight: true,
        next_allowed_at: DAY + 60_000,
      },
    });
    execute(code.error, {
      now: DAY,
      store,
      msg: { error: { source: { name: "Forçar refresh" }, message } },
    });
    const state = store.get(KEY);
    assert.equal(state.last_failure_class, expected);
    assert.equal(state.request_in_flight, false);
    assert.equal(coordinator(store, DAY + 1_000, { anyone_away: true }), null);
  });
}

scenario("12 restart durante cooldown", () => {
  const store = memory({
    vehicle_primary_context_v1: readyContext(DAY),
    [KEY]: {
      attempts: 0,
      awaiting_evidence: false,
      last_success_at: DAY - 60_000,
      next_allowed_at: DAY + 10 * 60_000,
    },
  });
  assert.equal(coordinator(store, DAY, { anyone_away: true }), null);
  assert.equal(store.get(KEY).state, "cooldown");
});

scenario("13 restart durante backoff", () => {
  const store = memory({
    vehicle_primary_context_v1: readyContext(DAY),
    [KEY]: {
      attempts: 4,
      awaiting_evidence: true,
      request_in_flight: false,
      last_attempt_at: DAY - 1_000,
      next_allowed_at: DAY + 8 * 60_000,
    },
  });
  assert.equal(coordinator(store, DAY, { anyone_away: true }), null);
  assert.equal(store.get(KEY).attempts, 4);
  assert.equal(store.get(KEY).state, "backoff");
});

scenario("14 duas solicitações simultâneas", () => {
  const store = memory({ vehicle_primary_context_v1: readyContext(DAY) });
  assert(coordinator(store, DAY, { anyone_away: true })[0]);
  assert.equal(coordinator(store, DAY + 1, { anyone_away: true }), null);
  assert.equal(store.get(KEY).attempts, 1);
});

scenario("15 evidência nova confirma sucesso", () => {
  const baseline = DAY - 30_000;
  const store = memory({
    vehicle_primary_context_v1: readyContext(baseline),
    [KEY]: {
      attempts: 2,
      awaiting_evidence: true,
      request_in_flight: false,
      last_attempt_at: DAY - 15_000,
      last_request_at: DAY - 15_000,
      next_allowed_at: DAY + 105_000,
      baseline_observed_at: {
        telemetry: baseline,
      },
    },
  });
  normalize(store, DAY, DAY);
  const state = store.get(KEY);
  assert.equal(state.awaiting_evidence, false);
  assert.equal(state.attempts, 0);
  assert.deepEqual([...state.last_evidence_domains], ["telemetry"]);
  assert.equal(state.next_allowed_at, DAY - 15_000 + 15 * 60_000);
});

scenario("16 serviço aceito sem evidência nova não é sucesso", () => {
  const baseline = DAY - 30_000;
  const store = memory({
    vehicle_primary_context_v1: readyContext(baseline),
    [KEY]: {
      attempts: 1,
      awaiting_evidence: true,
      request_in_flight: true,
      last_attempt_at: DAY - 10_000,
      last_request_at: DAY - 10_000,
      next_allowed_at: DAY + 50_000,
      baseline_observed_at: {
        telemetry: baseline,
      },
    },
  });
  execute(code.accepted, { now: DAY, store, msg: command() });
  assert.equal(store.get(KEY).next_allowed_at, DAY + 15 * 60_000);
  normalize(store, DAY + 15_000, baseline);
  const state = store.get(KEY);
  assert.equal(state.awaiting_evidence, true);
  assert.equal(state.last_success_at ?? 0, 0);
  assert.equal(state.state, "awaiting_evidence");
  assert.equal(state.next_allowed_at, DAY + 15 * 60_000);
});

scenario("22 aceite tardio ancora e evidência não encurta o piso", () => {
  const baseline = DAY - 30_000;
  const dispatchAt = DAY;
  const acceptedAt = DAY + 26_000;
  const store = memory({
    vehicle_primary_context_v1: readyContext(baseline),
    [KEY]: {
      attempts: 1,
      awaiting_evidence: true,
      request_in_flight: true,
      last_attempt_at: dispatchAt,
      last_request_at: dispatchAt,
      next_allowed_at: dispatchAt + 15 * 60_000,
      baseline_observed_at: {
        telemetry: baseline,
      },
    },
  });
  execute(code.accepted, { now: acceptedAt, store, msg: command() });
  const acceptedDeadline = acceptedAt + 15 * 60_000;
  assert.equal(store.get(KEY).next_allowed_at, acceptedDeadline);

  normalize(store, acceptedAt + 4_000, acceptedAt + 4_000);
  const state = store.get(KEY);
  assert.equal(state.awaiting_evidence, false);
  assert.equal(state.next_allowed_at, acceptedDeadline);
  assert.equal(state.cooldown_until, acceptedDeadline);
});

scenario("23 republicação de cache não confirma dado novo", () => {
  const semanticTimestamp = DAY - 30_000;
  const store = memory({
    vehicle_primary_context_v1: readyContext(semanticTimestamp),
    [KEY]: {
      attempts: 2,
      awaiting_evidence: true,
      request_in_flight: false,
      last_attempt_at: DAY - 15_000,
      last_request_at: DAY - 15_000,
      next_allowed_at: DAY + 15 * 60_000,
      baseline_observed_at: {
        telemetry: semanticTimestamp,
      },
    },
  });

  normalize(store, DAY, DAY, semanticTimestamp);
  const state = store.get(KEY);
  assert.equal(state.awaiting_evidence, true);
  assert.equal(state.attempts, 2);
  assert.equal(state.last_success_at ?? 0, 0);
});

scenario("24 cache atrasado posterior ao baseline não confirma wake", () => {
  const baseline = DAY - 30 * 60_000;
  const delayedCache = DAY - 10 * 60_000;
  const requestAt = DAY - 15_000;
  const store = memory({
    vehicle_primary_context_v1: readyContext(baseline),
    [KEY]: {
      attempts: 1,
      awaiting_evidence: true,
      request_in_flight: false,
      last_attempt_at: requestAt,
      last_request_at: requestAt,
      next_allowed_at: requestAt + 15 * 60_000,
      baseline_observed_at: { telemetry: baseline },
    },
  });

  normalize(store, DAY, DAY, delayedCache);
  const state = store.get(KEY);
  assert.equal(state.awaiting_evidence, true);
  assert.equal(state.attempts, 1);
  assert.equal(state.last_success_at ?? 0, 0);
});

scenario("17 recuperação posterior da integração", () => {
  const baseline = DAY - 17 * 60_000;
  const store = memory({
    vehicle_primary_context_v1: readyContext(baseline),
    [KEY]: {
      attempts: 1,
      awaiting_evidence: true,
      request_in_flight: false,
      last_attempt_at: DAY - 16 * 60_000,
      last_request_at: DAY - 16 * 60_000,
      next_allowed_at: DAY,
      last_failure_class: "authentication",
      baseline_observed_at: {
        telemetry: baseline,
      },
    },
  });
  assert(coordinator(store, DAY, {
    anyone_away: true,
    reason: "authentication_recovery",
  })[0]);
  execute(code.accepted, { now: DAY + 10_000, store, msg: command() });
  normalize(store, DAY + 15_000, DAY + 15_000);
  assert.equal(store.get(KEY).awaiting_evidence, false);
  assert.equal(store.get(KEY).attempts, 0);
});

scenario("18 toda retentativa respeita o piso Bluelink de 15 minutos", () => {
  let now = DAY;
  const store = memory({ vehicle_primary_context_v1: readyContext(DAY) });
  const observed = [];
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const coordinated = coordinator(store, now, { anyone_away: true });
    assert(coordinated[0]);
    if (attempt === 1) assert.equal(coordinated[3], null);
    if (attempt === 2) {
      assert.match(coordinated[3].alert.title, /Falha ao atualizar veículo/);
      const guarded = execute(code.notificationGuard, {
        now,
        store,
        msg: coordinated[3],
      });
      assert(guarded[0]);
      assert.equal(guarded[1], null);
    }
    if (attempt > 2) assert.equal(coordinated[3], null);
    const state = store.get(KEY);
    observed.push((state.next_allowed_at - now) / 60_000);
    execute(code.error, {
      now,
      store,
      msg: { error: { source: { name: "force_refresh" }, message: "timeout" } },
    });
    now = state.next_allowed_at;
  }
  assert.deepEqual(observed, [15, 15, 15, 15, 15]);
  const saturated = store.get(KEY);
  assert.equal(saturated.attempts, 5);
  assert.equal(coordinator(store, now - 1, { anyone_away: true }), null);
});

scenario("21 stale de segurança não quebra cooldown do último wake", () => {
  const store = memory({
    vehicle_primary_context_v1: {
      ready: false,
      stale: true,
      engine_stale: true,
    },
    [KEY]: {
      attempts: 0,
      awaiting_evidence: false,
      last_success_at: DAY,
      last_request_at: DAY,
      next_allowed_at: DAY + 15 * 60_000,
    },
  });
  assert.equal(coordinator(store, DAY + 5 * 60_000, {
    vehicle_primary_ready: false,
    recovery_needed: true,
    reason: "startup_or_periodic_reconciliation",
  }), null);
  assert.equal(store.get(KEY).state, "cooldown");
  assert(coordinator(store, DAY + 15 * 60_000, {
    vehicle_primary_ready: false,
    recovery_needed: true,
    reason: "startup_or_periodic_reconciliation",
  })[0]);
});

scenario("19 dry-run percorre a fronteira final sem chamada externa", () => {
  const store = memory({
    vehicle_primary_context_v1__test: readyContext(DAY),
  });
  const coordinated = execute(code.coordinator, {
    now: DAY,
    store,
    msg: command({ test_mode: true, test_now: DAY, anyone_away: true }),
  });
  const guarded = execute(code.dispatchGuard, {
    now: DAY,
    store,
    msg: coordinated[0],
  });
  assert.equal(guarded[0], null);
  assert.equal(guarded[1].payload.dispatched, false);
  execute(code.dryRun, { now: DAY, store, msg: guarded[1] });
  assert.equal(store.get("vehicle_primary_last_dry_run_v1").external_call_sent, false);

  const trip = execute(code.tripGuard, {
    now: DAY,
    store,
    msg: { payload: { test_mode: true } },
  });
  assert.equal(trip[0], null);
  assert.equal(trip[1].payload.dispatched, false);
});

scenario("20 alerta sintético chega somente ao terminal dry-run", () => {
  const store = memory({
    vehicle_primary_context_v1__test: readyContext(DAY),
    [`${KEY}__test`]: {
      attempts: 1,
      awaiting_evidence: true,
      next_allowed_at: DAY,
    },
  });
  const coordinated = execute(code.coordinator, {
    now: DAY,
    store,
    msg: command({ test_mode: true, test_now: DAY, anyone_away: true }),
  });
  assert(coordinated[3]);
  const guarded = execute(code.notificationGuard, {
    now: DAY,
    store,
    msg: coordinated[3],
  });
  assert.equal(guarded[0], null);
  assert.equal(guarded[1].payload.notification_sent, false);
  execute(code.dryRun, { now: DAY, store, msg: guarded[1] });
  assert.equal(store.get("vehicle_primary_last_dry_run_v1").dispatched, false);
});

console.log(
  `vehicle_primary refresh scheduler: ${passed.length} cenários aprovados.`,
);
