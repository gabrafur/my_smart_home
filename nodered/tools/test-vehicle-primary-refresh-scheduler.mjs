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
const contextCoordinator = flows.find(
  (node) => node.name === "Coordenar snapshot e refresh",
);
assert.match(
  contextCoordinator?.func ?? "",
  /any_resident_away:\s*people\?\.any_tracker_away === true/,
);
assert.doesNotMatch(
  contextCoordinator?.func ?? "",
  /any_fresh_tracker_away/,
);

function source(name) {
  return fs.readFileSync(path.join(functionDir, name), "utf8");
}

const code = {
  coordinator: source("vehicle-primary-refresh-coordinator.js"),
  accepted: source("vehicle-primary-refresh-accepted.js"),
  cacheProbeAccepted: source("vehicle-primary-cache-probe-accepted.js"),
  error: source("vehicle-primary-refresh-error.js"),
  providerBackoffSync: source("vehicle-primary-provider-backoff-sync.js"),
  telemetry: source("vehicle-primary-refresh-telemetry.js"),
  dispatchGuard: source("vehicle-primary-refresh-dispatch-guard.js"),
  cacheProbeGuard: source("vehicle-primary-cache-probe-dispatch-guard.js"),
  tripGuard: source("vehicle-primary-trip-dispatch-guard.js"),
  dryRun: source("vehicle-primary-dry-run-terminal.js"),
  notificationGuard: source("vehicle-primary-notification-dispatch-guard.js"),
  arrival: source("vehicle-primary-arrival-actions.js"),
  contextCoordinator: contextCoordinator?.func,
  peopleRefresh: flows.find(
    (node) => node.name === "Atualizar iPhones agora?",
  )?.func,
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

function execute(body, { msg, store, now, logs = [], warnings = [], errors = [] }) {
  const RealDate = Date;
  class FixedDate extends RealDate {
    constructor(value) { super(value === undefined ? now : value); }
    static now() { return now; }
  }
  const globals = memory();
  const sandbox = {
    msg,
    Date: FixedDate,
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
      warn(value) { warnings.push(String(value)); logs.push(String(value)); },
      error(value) { errors.push(String(value)); logs.push(String(value)); },
      status() {},
    },
    setTimeout,
    clearTimeout,
  };
  return vm.runInNewContext(`(function () {\n${body}\n})()`, sandbox);
}

const DAY = Date.parse("2026-08-30T15:00:00Z"); // 12:00 America/Sao_Paulo
const NIGHT = Date.parse("2026-08-30T03:00:00Z"); // 00:00 America/Sao_Paulo
const BEFORE_SIX = Date.parse("2026-08-30T08:59:00Z"); // 05:59 America/Sao_Paulo
const SIX = Date.parse("2026-08-30T09:00:00Z"); // 06:00 America/Sao_Paulo
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

function normalize(
  store,
  now,
  observedAt,
  telemetryAt = observedAt,
  { engineAt = observedAt, lockAt = observedAt } = {},
) {
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
        vehicle_primary_engine: entity("off", engineAt),
        vehicle_primary_lock: entity("locked", lockAt),
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

scenario("01 intervalo de 15 minutos com alguém fora", () => {
  const store = memory({
    vehicle_primary_context_v1: readyContext(DAY - 1_000),
    [KEY]: {
      attempts: 0,
      awaiting_evidence: false,
      last_success_at: DAY - 1_000,
      next_allowed_at: DAY + 15 * 60_000,
    },
  });
  const residentStates = {
    resident_primary_state: "not_home",
    resident_secondary_state: "home",
  };
  assert.equal(coordinator(store, DAY + 14 * 60_000, residentStates), null);
  assert(coordinator(store, DAY + 15 * 60_000, residentStates));
});

scenario("02 ambos em casa usam intervalo de 30 minutos", () => {
  const store = memory({ vehicle_primary_context_v1: readyContext(DAY) });
  assert(coordinator(store, DAY, {
    anyone_away: true,
    resident_primary_state: "home",
    resident_secondary_state: "home",
  }));
  const state = store.get(KEY);
  assert.equal(state.interval_ms, 30 * 60_000);
  assert.equal(state.interval_policy, "both_home_30m");
  assert.equal(state.next_allowed_at, DAY + 30 * 60_000);
});

scenario("02a evidência recente fora reduz conflito de presença para 15 minutos", () => {
  const acceptedAt = DAY;
  const store = memory({
    vehicle_primary_context_v1: readyContext(acceptedAt),
    [KEY]: {
      attempts: 0,
      awaiting_evidence: false,
      last_success_at: acceptedAt,
      last_request_at: acceptedAt,
      service_accepted_at: acceptedAt,
      next_allowed_at: acceptedAt + 30 * 60_000,
      interval_ms: 30 * 60_000,
    },
  });

  const result = coordinator(store, acceptedAt + 15 * 60_000, {
    resident_primary_state: "home",
    resident_secondary_state: "home",
    any_resident_away: true,
  });

  assert(result[0]);
  assert.equal(store.get(KEY).interval_ms, 15 * 60_000);
  assert.equal(store.get(KEY).interval_policy, "away_or_approaching_15m");
});

scenario("03 ambos em casa ficam pausados entre 00h e 06h", () => {
  const store = memory({ vehicle_primary_context_v1: readyContext(NIGHT) });
  assert.equal(coordinator(store, NIGHT, {
    anyone_away: true,
    resident_primary_state: "home",
    resident_secondary_state: "home",
  }), null);
  assert.equal(store.get(KEY).reason, "quiet_hours_both_home");
});

scenario("04 not_home mantém intervalo de 15 minutos durante a madrugada", () => {
  const store = memory({ vehicle_primary_context_v1: readyContext(NIGHT) });
  assert(coordinator(store, NIGHT, {
    resident_primary_state: "not_home",
    resident_secondary_state: "home",
  }));
  assert.equal(store.get(KEY).interval_ms, 15 * 60_000);
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
    resident_primary_state: "home",
    resident_secondary_state: "home",
  });
  assert(first[0]);
  assert(first[1]);
  assert.equal(first[2], null);
  assert.equal(store.get(KEY).last_request_at, DAY + 1_000);

  const second = coordinator(store, DAY + 2_000, {
    reason: "manual_force",
    force_recovery: true,
    resident_primary_state: "home",
    resident_secondary_state: "home",
  });
  assert.equal(second[0], null);
  assert.equal(second[2].notification.id, "vehicle_primary_refresh_blocked");
});

scenario("26 refresh manual ignora a pausa da madrugada", () => {
  const store = memory({ vehicle_primary_context_v1: readyContext(NIGHT) });
  const result = coordinator(store, NIGHT, {
    reason: "manual_force",
    force_recovery: true,
    resident_primary_state: "home",
    resident_secondary_state: "home",
  });
  assert(result[0]);
  assert.equal(store.get(KEY).interval_ms, 30 * 60_000);
});

scenario("27 política diurna começa exatamente às 06h", () => {
  const beforeStore = memory({
    vehicle_primary_context_v1: readyContext(BEFORE_SIX),
  });
  const states = {
    resident_primary_state: "home",
    resident_secondary_state: "home",
  };
  assert.equal(coordinator(beforeStore, BEFORE_SIX, states), null);

  const sixStore = memory({ vehicle_primary_context_v1: readyContext(SIX) });
  assert(coordinator(sixStore, SIX, states));
  assert.equal(sixStore.get(KEY).next_allowed_at, SIX + 30 * 60_000);
});

scenario("28 estado chegando mantém intervalo de 15 minutos", () => {
  const store = memory({ vehicle_primary_context_v1: readyContext(NIGHT) });
  assert(coordinator(store, NIGHT, {
    resident_primary_state: "home",
    resident_secondary_state: "chegando",
  }));
  assert.equal(store.get(KEY).interval_policy, "away_or_approaching_15m");
});

scenario("29 saída reduz cooldown persistido de 30 para 15 minutos", () => {
  const acceptedAt = DAY + 10_000;
  const store = memory({
    vehicle_primary_context_v1: readyContext(DAY),
    [KEY]: {
      attempts: 0,
      awaiting_evidence: false,
      last_request_at: DAY,
      service_accepted_at: acceptedAt,
      next_allowed_at: acceptedAt + 30 * 60_000,
      interval_ms: 30 * 60_000,
    },
  });
  const result = coordinator(store, acceptedAt + 15 * 60_000, {
    resident_primary_state: "not_home",
    resident_secondary_state: "home",
  });
  assert(result[0]);
  assert.equal(store.get(KEY).interval_ms, 15 * 60_000);
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

scenario("06a republicação da mesma chegada não repete side effects", () => {
  const store = memory();
  const first = execute(code.arrival, {
    now: DAY,
    store,
    msg: {
      payload: {
        kind: "arrival",
        source: "vehicle_primary",
        arrival_source_type: "vehicle_primary",
        arrival_stage: "home",
        event_at: DAY,
      },
    },
  });
  assert(first?.[1]);

  const duplicate = execute(code.arrival, {
    now: DAY + 1_000,
    store,
    msg: {
      payload: {
        kind: "arrival",
        source: "vehicle_primary",
        arrival_source_type: "vehicle_primary",
        arrival_stage: "home",
        event_at: DAY + 1_000,
      },
    },
  });
  assert.equal(duplicate, null);
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
  ["35", "HomeAssistantError: Service kia_uvo.update not found.", "integration_unavailable"],
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

scenario("25 telemetria do wake processada após seis minutos confirma sucesso", () => {
  const baseline = DAY - 10 * 60_000;
  const requestAt = DAY - 6 * 60_000;
  const delayedTelemetry = requestAt + 2 * 60_000;
  const store = memory({
    vehicle_primary_context_v1: readyContext(baseline),
    [KEY]: {
      attempts: 2,
      awaiting_evidence: true,
      request_in_flight: false,
      last_attempt_at: requestAt,
      last_request_at: requestAt,
      next_allowed_at: requestAt + 15 * 60_000,
      baseline_observed_at: { telemetry: baseline },
    },
  });

  normalize(store, DAY, DAY, delayedTelemetry);
  const state = store.get(KEY);
  assert.equal(state.awaiting_evidence, false);
  assert.equal(state.attempts, 0);
  assert.equal(state.last_success_at, DAY);
});

scenario("30 telemetria nova confirma wake comum com motor sem mudança", () => {
  const baseline = DAY - 10 * 60_000;
  const requestAt = DAY - 5 * 60_000;
  const staleSignalAt = DAY - 20 * 60_000;
  const store = memory({
    vehicle_primary_context_v1: readyContext(baseline),
    [KEY]: {
      attempts: 5,
      awaiting_evidence: true,
      request_in_flight: false,
      last_attempt_at: requestAt,
      last_request_at: requestAt,
      next_allowed_at: requestAt + 30 * 60_000,
      interval_ms: 30 * 60_000,
      require_lighting_ready: false,
      baseline_observed_at: { telemetry: baseline },
    },
  });

  normalize(store, DAY, DAY, requestAt + 4 * 60_000, {
    engineAt: staleSignalAt,
    lockAt: staleSignalAt,
  });
  const state = store.get(KEY);
  assert.equal(state.awaiting_evidence, false);
  assert.equal(state.attempts, 0);
  assert.equal(state.state, "cooldown");
  assert.deepEqual([...state.last_evidence_domains], ["telemetry"]);
  assert.equal(state.lighting_ready_after_wake, false);
  assert.equal(state.last_success_reason, "fresh_telemetry_engine_unreliable");
});

scenario("31 wake da iluminação confirma telemetria sem mascarar motor stale", () => {
  const baseline = DAY - 10 * 60_000;
  const requestAt = DAY - 5 * 60_000;
  const staleSignalAt = DAY - 20 * 60_000;
  const store = memory({
    vehicle_primary_context_v1: readyContext(baseline),
    [KEY]: {
      attempts: 1,
      awaiting_evidence: true,
      request_in_flight: false,
      last_attempt_at: requestAt,
      last_request_at: requestAt,
      next_allowed_at: requestAt + 15 * 60_000,
      require_lighting_ready: true,
      baseline_observed_at: { telemetry: baseline },
    },
  });

  normalize(store, DAY, DAY, requestAt + 4 * 60_000, {
    engineAt: staleSignalAt,
    lockAt: staleSignalAt,
  });
  const state = store.get(KEY);
  assert.equal(state.awaiting_evidence, false);
  assert.equal(state.attempts, 0);
  assert.equal(state.state, "cooldown");
  assert.equal(state.last_failure_class, null);
  assert.equal(state.lighting_ready_after_wake, false);
  assert.equal(state.last_success_reason, "fresh_telemetry_engine_unreliable");
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
  const probe = coordinator(store, DAY, {
    anyone_away: true,
    reason: "authentication_recovery",
  });
  assert.equal(probe[0], null);
  assert(probe[4]);
  const guarded = execute(code.cacheProbeGuard, {
    now: DAY,
    store,
    msg: probe[4],
  });
  assert(guarded[0]);
  assert.equal(guarded[1], null);
  execute(code.cacheProbeAccepted, {
    now: DAY,
    store,
    msg: guarded[0],
  });
  normalize(store, DAY + 15_000, DAY + 15_000);
  assert.equal(store.get(KEY).awaiting_evidence, false);
  assert.equal(store.get(KEY).attempts, 0);
});

scenario("18 toda retentativa respeita o piso Bluelink de 15 minutos", () => {
  let now = DAY;
  const store = memory({ vehicle_primary_context_v1: readyContext(DAY) });
  const observed = [];
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    let coordinated = coordinator(store, now, { anyone_away: true });
    if (attempt > 1) {
      assert.equal(coordinated[0], null);
      assert(coordinated[4]);
      execute(code.cacheProbeAccepted, {
        now,
        store,
        msg: coordinated[4],
      });
      assert.equal(
        coordinator(store, now + 1_000, { anyone_away: true }),
        null,
      );
      now += 15_000;
      coordinated = coordinator(store, now, { anyone_away: true });
    }
    assert(coordinated[0]);
    assert.equal(coordinated[3], null);
    const state = store.get(KEY);
    observed.push((state.next_allowed_at - now) / 60_000);
    const serviceFailure = execute(code.error, {
      now,
      store,
      msg: { error: { source: { name: "force_refresh" }, message: "timeout" } },
    });
    if (attempt === 1) {
      assert.match(serviceFailure.alert.title, /Erro ao atualizar veículo/);
      const guarded = execute(code.notificationGuard, {
        now,
        store,
        msg: serviceFailure,
      });
      assert(guarded[0]);
      assert(guarded[1]);
      assert.equal(guarded[2], null);
    }
    if (attempt > 1) assert.equal(serviceFailure, null);
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
  const previousRequestAt = DAY - 20 * 60_000;
  const store = memory({
    vehicle_primary_context_v1__test: readyContext(DAY),
    [`${KEY}__test`]: {
      attempts: 1,
      awaiting_evidence: true,
      last_attempt_at: previousRequestAt,
      last_request_at: previousRequestAt,
      next_allowed_at: DAY,
      cache_probe_completed_for_request_at: previousRequestAt,
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
  assert.equal(guarded[1], null);
  assert.equal(guarded[2].payload.notification_sent, false);
  assert.equal(guarded[2].payload.persistent_notification_created, false);
  execute(code.dryRun, { now: DAY, store, msg: guarded[2] });
  assert.equal(store.get("vehicle_primary_last_dry_run_v1").dispatched, false);
});

scenario("32 cache novo evita wake redundante no vencimento do retry", () => {
  const baseline = DAY - 20 * 60_000;
  const previousRequestAt = DAY - 16 * 60_000;
  const store = memory({
    vehicle_primary_context_v1: readyContext(baseline),
    [KEY]: {
      attempts: 1,
      awaiting_evidence: true,
      request_in_flight: false,
      last_attempt_at: previousRequestAt,
      last_request_at: previousRequestAt,
      next_allowed_at: DAY,
      baseline_observed_at: { telemetry: baseline },
    },
  });

  const probe = coordinator(store, DAY, { anyone_away: true });
  assert.equal(probe[0], null);
  assert(probe[4]);
  execute(code.cacheProbeAccepted, {
    now: DAY,
    store,
    msg: probe[4],
  });
  normalize(store, DAY + 15_000, DAY + 15_000);
  const state = store.get(KEY);
  assert.equal(state.awaiting_evidence, false);
  assert.equal(state.attempts, 0);
  assert.equal(state.cache_probe_completed_for_request_at, null);
  assert.equal(
    coordinator(store, DAY + 15_001, { anyone_away: true }),
    null,
  );
});

scenario("32a dado passivo tardio não confirma wake antigo", () => {
  const baseline = DAY - 13 * 60 * 60_000;
  const previousRequestAt = DAY - 12 * 60 * 60_000;
  const store = memory({
    vehicle_primary_context_v1: readyContext(baseline),
    [KEY]: {
      version: 10,
      attempts: 1,
      awaiting_evidence: true,
      request_in_flight: false,
      last_attempt_at: previousRequestAt,
      last_request_at: previousRequestAt,
      next_allowed_at: DAY,
      baseline_observed_at: { telemetry: baseline },
    },
  });

  const probe = coordinator(store, DAY, { anyone_away: true });
  assert(probe[4]);
  execute(code.cacheProbeAccepted, {
    now: DAY,
    store,
    msg: probe[4],
  });
  normalize(store, DAY + 15_000, DAY + 15_000, DAY - 60_000);
  const afterPassiveData = store.get(KEY);
  assert.equal(afterPassiveData.awaiting_evidence, true);
  assert.equal(afterPassiveData.last_success_at ?? 0, 0);

  const wake = coordinator(store, DAY + 15_000, { anyone_away: true });
  assert(wake[0]);
  assert.equal(wake[4], null);
  assert.equal(store.get(KEY).last_request_at, DAY + 15_000);
});

scenario("33 cache antigo libera um único wake após a propagação", () => {
  const baseline = DAY - 20 * 60_000;
  const previousRequestAt = DAY - 15 * 60_000;
  const store = memory({
    vehicle_primary_context_v1: readyContext(baseline),
    [KEY]: {
      attempts: 1,
      awaiting_evidence: true,
      request_in_flight: false,
      last_attempt_at: previousRequestAt,
      last_request_at: previousRequestAt,
      next_allowed_at: DAY,
      baseline_observed_at: { telemetry: baseline },
    },
  });

  const probe = coordinator(store, DAY, { anyone_away: true });
  execute(code.cacheProbeAccepted, {
    now: DAY,
    store,
    msg: probe[4],
  });
  normalize(store, DAY + 15_000, DAY + 15_000, baseline);
  const wake = coordinator(store, DAY + 15_000, { anyone_away: true });
  assert(wake[0]);
  assert.equal(wake[4], null);
  assert.equal(store.get(KEY).attempts, 2);
  assert.equal(
    coordinator(store, DAY + 15_001, { anyone_away: true }),
    null,
  );
});

scenario("34 erro ao reler cache adia a sondagem sem enviar wake", () => {
  const previousRequestAt = DAY - 15 * 60_000;
  const store = memory({
    vehicle_primary_context_v1: readyContext(DAY - 20 * 60_000),
    [KEY]: {
      attempts: 1,
      awaiting_evidence: true,
      last_attempt_at: previousRequestAt,
      last_request_at: previousRequestAt,
      next_allowed_at: DAY,
      interval_ms: 15 * 60_000,
    },
  });
  const probe = coordinator(store, DAY, { anyone_away: true });
  assert(probe[4]);
  execute(code.error, {
    now: DAY,
    store,
    msg: {
      error: {
        source: { name: "Reler cache do vehicle_primary" },
        message: "service unavailable",
      },
    },
  });
  assert.equal(store.get(KEY).next_allowed_at, DAY + 15 * 60_000);
  assert.equal(
    coordinator(store, DAY + 1_000, { anyone_away: true }),
    null,
  );
});

scenario("36 falso legado sem endpoint é reavaliado pelo cache", () => {
  const previousRequestAt = DAY - 15 * 60_000;
  const store = memory({
    vehicle_primary_context_v1: { ready: false, state: "unavailable" },
    [KEY]: {
      attempts: 1,
      awaiting_evidence: true,
      last_attempt_at: previousRequestAt,
      last_request_at: previousRequestAt,
      next_allowed_at: DAY + 10 * 60_000,
      interval_ms: 15 * 60_000,
      last_failure_class: "integration_unavailable",
    },
  });

  const result = coordinator(store, DAY, {
    vehicle_primary_ready: false,
    recovery_needed: true,
    anyone_away: true,
  });
  assert.equal(result[0], null);
  assert.equal(result[3], null);
  assert(result[4]);
  const state = store.get(KEY);
  assert.equal(state.state, "probing_cache");
  assert.equal(state.reason, "pre_wake_cache_probe");
  assert.equal(state.last_failure_class ?? null, null);
  assert.equal(state.attempts, 1);
});

scenario("37 endpoint ausente informa serviço e etapa no alerta", () => {
  const store = memory({
    [KEY]: {
      attempts: 1,
      awaiting_evidence: true,
      request_in_flight: true,
      failure_notified_at: 0,
      next_allowed_at: DAY + 15 * 60_000,
      interval_ms: 15 * 60_000,
    },
  });

  const result = execute(code.error, {
    now: DAY,
    store,
    msg: {
      error: {
        source: { name: "Reler cache do vehicle_primary" },
        message: "HomeAssistantError: Service kia_uvo.update not found.",
      },
    },
  });
  assert.equal(store.get(KEY).last_failure_class, "integration_unavailable");
  assert.match(result.alert.title, /Endpoint Bluelink indisponível/);
  assert.match(result.alert.message, /kia_uvo\.update/);
  assert.match(result.alert.message, /Reler cache do vehicle_primary/);
  assert.equal(result.notification.id, "vehicle_primary_refresh_failed");
});

scenario("37a deadline do provedor bloqueia chamadas automáticas após restart", () => {
  const store = memory({
    vehicle_primary_context_v1: readyContext(DAY),
    [KEY]: { attempts: 2 },
  });
  const retryAt = DAY + 2 * 60 * 60_000;
  const bypassCommand = execute(code.providerBackoffSync, {
    now: DAY,
    store,
    msg: {
      payload: {
        state: new Date(retryAt).toISOString(),
        attributes: { status: "rate_limited" },
      },
    },
  });

  const state = store.get(KEY);
  assert.equal(state.provider_retry_at, retryAt);
  assert.equal(state.next_allowed_at, retryAt);
  assert.equal(state.last_failure_class, "provider_backoff");
  assert.equal(coordinator(store, DAY + 1_000, { anyone_away: true }), null);
  assert.equal(store.get(KEY).state, "backoff");
  assert.equal(bypassCommand.topic, "homeassistant/vehicle_primary/engine_bypass/set");
  assert.deepEqual(JSON.parse(bypassCommand.payload), {
    requested_state: "ON",
    source: "provider_backoff",
  });
});

scenario("37b backoff esperado não reabre falha global do canvas", () => {
  const store = memory({ [KEY]: { interval_ms: 15 * 60_000 } });
  const warnings = [];
  const errors = [];
  execute(code.error, {
    now: DAY,
    store,
    warnings,
    errors,
    msg: {
      error: {
        source: { name: "Atualizar viagens do dia após chegada" },
        message: "HomeAssistantError: Bluelink rate limit backoff is active",
      },
    },
  });
  assert.equal(errors.length, 0);
  assert.equal(warnings.length, 1);
  assert.equal(store.get(KEY).last_failure_class, "provider_backoff");
  assert.equal(
    store.get(KEY).failure_endpoint,
    "public_bindings.call (viagens do dia)",
  );
});

scenario("38 sucesso semântico mantém 30 minutos com ambos em casa", () => {
  const requestAt = DAY - 5 * 60_000;
  const baseline = DAY - 20 * 60_000;
  const staleSignalAt = DAY - 20 * 60_000;
  const store = memory({
    vehicle_primary_context_v1: readyContext(baseline),
    [KEY]: {
      attempts: 1,
      awaiting_evidence: true,
      last_attempt_at: requestAt,
      last_request_at: requestAt,
      next_allowed_at: requestAt + 15 * 60_000,
      interval_ms: 15 * 60_000,
      baseline_observed_at: { telemetry: baseline },
    },
  });

  normalize(store, DAY, DAY, DAY - 60_000, {
    engineAt: staleSignalAt,
    lockAt: staleSignalAt,
  });
  assert.equal(store.get("vehicle_primary_context_v1").ready, false);

  assert.equal(coordinator(store, DAY + 30_000, {
    resident_primary_state: "home",
    resident_secondary_state: "home",
    vehicle_primary_ready: false,
    recovery_needed: true,
  }), null);
  const state = store.get(KEY);
  assert.equal(state.interval_ms, 30 * 60_000);
  assert.equal(state.interval_policy, "both_home_30m");
  assert.equal(state.next_allowed_at, DAY + 30 * 60_000);
});

scenario("39 sucesso semântico antigo não mascara recuperação", () => {
  const lastSuccessAt = DAY - 32 * 60_000;
  const store = memory({
    vehicle_primary_context_v1: { ready: false },
    [KEY]: {
      attempts: 0,
      awaiting_evidence: false,
      last_success_at: lastSuccessAt,
      last_request_at: lastSuccessAt,
      next_allowed_at: DAY - 60_000,
      interval_ms: 30 * 60_000,
      last_evidence_domains: ["telemetry"],
    },
  });

  const result = coordinator(store, DAY, {
    resident_primary_state: "home",
    resident_secondary_state: "home",
    vehicle_primary_ready: false,
    recovery_needed: true,
  });
  assert(result[0]);
  assert.equal(store.get(KEY).interval_ms, 15 * 60_000);
  assert.equal(store.get(KEY).interval_policy, "recovery_15m");
});

scenario("40 versão 9 reabre sucesso correlacionado muitas horas depois", () => {
  const oldRequestAt = DAY - 12 * 60 * 60_000;
  const passiveTelemetryAt = DAY - 60_000;
  const store = memory({
    vehicle_primary_context_v1: {
      ...readyContext(DAY),
      telemetry_updated_at: passiveTelemetryAt,
    },
    [KEY]: {
      version: 9,
      attempts: 0,
      awaiting_evidence: false,
      last_request_at: oldRequestAt,
      last_attempt_at: oldRequestAt,
      last_success_at: DAY,
      next_allowed_at: DAY + 30 * 60_000,
      interval_ms: 30 * 60_000,
      last_evidence_domains: ["telemetry"],
    },
  });

  const result = coordinator(store, DAY, {
    resident_primary_state: "home",
    resident_secondary_state: "home",
  });
  assert.equal(result[0], null);
  assert(result[4]);
  const state = store.get(KEY);
  assert.equal(state.version, 12);
  assert.equal(state.awaiting_evidence, true);
  assert.equal(state.last_success_at, 0);
  assert.equal(state.last_failure_class, "no_fresh_data");
  assert.match(state.failure_endpoint, /public_bindings\.call/);
  assert.equal(state.reason, "pre_wake_cache_probe");
});

scenario("41 mudança real de classe de falha gera novo alerta", () => {
  const store = memory({
    [KEY]: {
      attempts: 2,
      awaiting_evidence: true,
      failure_notified_at: DAY - 60_000,
      failure_notification_key:
        "no_fresh_data|public_bindings.call (wake do veículo)",
      last_failure_class: "no_fresh_data",
      next_allowed_at: DAY + 15 * 60_000,
      interval_ms: 15 * 60_000,
    },
  });

  const notification = execute(code.error, {
    now: DAY,
    store,
    msg: {
      error: {
        source: { name: "Acionar wake do vehicle_primary" },
        message: "request timed out",
      },
    },
  });
  assert(notification);
  assert.equal(store.get(KEY).last_failure_class, "timeout");
  assert.match(notification.alert.message, /tempo esgotado/);

  const duplicate = execute(code.error, {
    now: DAY + 1_000,
    store,
    msg: {
      error: {
        source: { name: "Acionar wake do vehicle_primary" },
        message: "request timed out",
      },
    },
  });
  assert.equal(duplicate, null);
});

scenario("41a HTTP 403 é identificado como backoff do provedor", () => {
  const store = memory({
    [KEY]: {
      attempts: 1,
      awaiting_evidence: true,
      next_allowed_at: DAY + 15 * 60_000,
      interval_ms: 15 * 60_000,
    },
  });
  const notification = execute(code.error, {
    now: DAY,
    store,
    msg: {
      error: {
        source: { name: "Forçar refresh do vehicle_primary" },
        message:
          "HomeAssistantError: Bluelink provider denied vehicle refresh; " +
          "403 Client Error: Forbidden",
      },
    },
  });
  assert(notification);
  assert.equal(store.get(KEY).last_failure_class, "provider_backoff");
  assert.match(notification.alert.message, /temporariamente recusado/);
  assert.match(notification.alert.message, /Forçar refresh/);
});

scenario("42 recuperação limpa detalhes e fecha alerta persistente", () => {
  const baseline = DAY - 10 * 60_000;
  const requestAt = DAY - 5 * 60_000;
  const store = memory({
    vehicle_primary_context_v1: readyContext(baseline),
    [KEY]: {
      version: 10,
      attempts: 2,
      awaiting_evidence: true,
      last_attempt_at: requestAt,
      last_request_at: requestAt,
      next_allowed_at: DAY + 10 * 60_000,
      baseline_observed_at: { telemetry: baseline },
      failure_notified_at: requestAt,
      failure_notification_key:
        "no_fresh_data|public_bindings.call (wake do veículo)",
      last_failure_class: "no_fresh_data",
      failure_endpoint: "public_bindings.call (wake do veículo)",
      failure_stage: "confirmação semântica em até 20 min",
    },
  });

  normalize(store, DAY, DAY, DAY - 60_000);
  const recovered = store.get(KEY);
  assert.equal(recovered.last_failure_class, null);
  assert.equal(recovered.failure_endpoint, null);
  assert.equal(recovered.failure_stage, null);
  assert.equal(recovered.recovery_notification_pending, true);

  const telemetry = execute(code.telemetry, {
    now: DAY + 1_000,
    store,
    msg: { payload: {} },
  });
  assert.equal(telemetry[1].notification.id, "vehicle_primary_refresh_failed");
  assert.equal(telemetry[1].notification.dismiss_only, true);
  const dismiss = execute(code.notificationGuard, {
    now: DAY + 1_000,
    store,
    msg: telemetry[1],
  });
  assert.equal(dismiss[0], null);
  assert.equal(dismiss[1], null);
  assert.equal(dismiss[2], null);
  assert.equal(dismiss[3].notification.id, "vehicle_primary_refresh_failed");
  assert.equal(store.get(KEY).recovery_notification_pending, false);
});

scenario("43 saída de morador emite refresh prioritário do veículo", () => {
  const previousAt = DAY - 60_000;
  const previousPeople = {
    resident_primary: { state: "home", ready: true, updated_at: previousAt },
    resident_secondary: { state: "home", ready: true, updated_at: previousAt },
    any_tracker_away: false,
    updated_at: previousAt,
    ready: true,
  };
  const currentPeople = {
    ...previousPeople,
    resident_primary: { state: "not_home", ready: true, updated_at: DAY },
    any_tracker_away: true,
    updated_at: DAY,
  };
  const store = memory({
    people_context_v1: previousPeople,
    vehicle_primary_context_v1: readyContext(previousAt),
  });
  const departureMessage = {
    payload: {
      kind: "people_context",
      source: "resident_primary",
      trigger_prev_state: "home",
      trigger_state: "not_home",
      context: currentPeople,
      updated_at: DAY,
      ready: true,
    },
  };

  const result = execute(code.contextCoordinator, {
    now: DAY,
    store,
    msg: departureMessage,
  });
  assert(result[1]);
  assert.equal(result[1].payload.reason, "resident_departure");
  assert.equal(result[1].payload.resident_departure_force, true);
  assert.equal(result[1].payload.departure_event_at, DAY);

  const duplicate = execute(code.contextCoordinator, {
    now: DAY + 1_000,
    store,
    msg: departureMessage,
  });
  assert.equal(duplicate, null);
});

scenario("44 saída ignora deadline, mas não duplica o mesmo wake", () => {
  const departureAt = DAY;
  const store = memory({
    vehicle_primary_context_v1: readyContext(DAY),
    [KEY]: {
      attempts: 0,
      awaiting_evidence: false,
      last_request_at: DAY - 60_000,
      last_success_at: DAY - 60_000,
      next_allowed_at: DAY + 29 * 60_000,
      interval_ms: 30 * 60_000,
    },
  });
  const departure = {
    reason: "resident_departure",
    recovery_reason: "resident_departure",
    resident_departure_force: true,
    departure_event_at: departureAt,
    force_recovery: true,
    resident_primary_state: "not_home",
    resident_secondary_state: "home",
  };

  const first = coordinator(store, DAY + 1_000, departure);
  assert(first[0]);
  assert.equal(store.get(KEY).resident_departure_force, true);
  assert.equal(store.get(KEY).last_request_at, DAY + 1_000);

  const duplicate = coordinator(store, DAY + 2_000, departure);
  assert.equal(duplicate, null);
  assert.equal(store.get(KEY).last_request_at, DAY + 1_000);

  const phoneStore = memory({ people_context_v1: {} });
  const phoneResult = execute(code.peopleRefresh, {
    now: DAY + 1_000,
    store: phoneStore,
    msg: command(departure),
  });
  assert.equal(phoneResult, null);
  assert.equal(phoneStore.get("security_people_last_refresh_at"), undefined);
});

scenario("45 segunda saída não antecipa alerta semântico de 20 minutos", () => {
  const firstDepartureAt = DAY;
  const store = memory({
    vehicle_primary_context_v1: readyContext(DAY - 60_000),
  });
  const first = coordinator(store, firstDepartureAt, {
    reason: "resident_departure",
    recovery_reason: "resident_departure",
    resident_departure_force: true,
    departure_event_at: firstDepartureAt,
    force_recovery: true,
    resident_primary_state: "not_home",
    resident_secondary_state: "home",
  });
  assert(first[0]);
  assert.equal(first[3], null);

  execute(code.accepted, {
    now: DAY + 10_000,
    store,
    msg: { payload: {} },
  });

  const second = coordinator(store, DAY + 90_000, {
    reason: "resident_departure",
    recovery_reason: "resident_departure",
    resident_departure_force: true,
    departure_event_at: DAY + 89_000,
    force_recovery: true,
    resident_primary_state: "not_home",
    resident_secondary_state: "not_home",
  });
  assert(second[0]);
  assert.equal(second[3], null);
  assert.equal(store.get(KEY).evidence_wait_started_at, firstDepartureAt);
  assert.equal(store.get(KEY).last_failure_class ?? null, null);
});

scenario("46 alerta semântico nasce somente após 20 minutos reais", () => {
  const store = memory({
    vehicle_primary_context_v1: readyContext(DAY - 60_000),
    [KEY]: {
      version: 11,
      attempts: 2,
      awaiting_evidence: true,
      evidence_wait_started_at: DAY,
      last_attempt_at: DAY + 90_000,
      last_request_at: DAY + 90_000,
      next_allowed_at: DAY + 30 * 60_000,
      interval_ms: 15 * 60_000,
    },
  });
  const before = coordinator(store, DAY + 20 * 60_000 - 1, {
    resident_primary_state: "not_home",
    resident_secondary_state: "not_home",
  });
  assert.equal(before, null);
  assert.equal(store.get(KEY).last_failure_class ?? null, null);

  const due = coordinator(store, DAY + 20 * 60_000, {
    resident_primary_state: "not_home",
    resident_secondary_state: "not_home",
  });
  assert.equal(due[0], null);
  assert(due[3]);
  assert.match(due[3].alert.message, /dentro de 20 min/);
  assert.equal(store.get(KEY).last_failure_class, "no_fresh_data");
  assert.equal(store.get(KEY).failure_at, DAY + 20 * 60_000);
});

scenario("47 sucesso limpa o início da espera semântica", () => {
  const baseline = DAY - 10 * 60_000;
  const requestAt = DAY - 5 * 60_000;
  const store = memory({
    vehicle_primary_context_v1: readyContext(baseline),
    [KEY]: {
      version: 11,
      attempts: 1,
      awaiting_evidence: true,
      evidence_wait_started_at: requestAt,
      last_attempt_at: requestAt,
      last_request_at: requestAt,
      next_allowed_at: DAY + 10 * 60_000,
      baseline_observed_at: { telemetry: baseline },
    },
  });

  normalize(store, DAY, DAY, DAY - 60_000);
  assert.equal(store.get(KEY).awaiting_evidence, false);
  assert.equal(store.get(KEY).evidence_wait_started_at, null);
});

console.log(
  `vehicle_primary refresh scheduler: ${passed.length} cenários aprovados.`,
);
