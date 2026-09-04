import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const toolsDir = path.dirname(fileURLToPath(import.meta.url));
const functionDir = path.join(toolsDir, "functions");
const flows = JSON.parse(
  fs.readFileSync(path.resolve(toolsDir, "../flows.json"), "utf8"),
);

function source(name) {
  return fs.readFileSync(path.join(functionDir, name), "utf8");
}

function runtime(code, { msg, values = {}, now }) {
  const store = new Map(Object.entries(values));
  const logs = [];
  const RealDate = Date;
  class FixedDate extends RealDate {
    constructor(value) {
      super(value === undefined ? now : value);
    }
    static now() {
      return now;
    }
  }
  const sandbox = {
    msg,
    Date: FixedDate,
    flow: {
      get(key) {
        return store.get(key);
      },
      set(key, value) {
        store.set(key, value);
      },
    },
    node: {
      log(value) { logs.push(String(value)); },
      warn(value) { logs.push(String(value)); },
      error(value) { logs.push(String(value)); },
      status() {},
    },
    console,
  };
  const result = vm.runInNewContext(`(function () {\n${code}\n})()`, sandbox);
  return { result, store, logs };
}

const coordinator = source("vehicle-primary-refresh-coordinator.js");
const manual = source("vehicle-primary-manual-refresh.js");
const telemetry = source("vehicle-primary-refresh-telemetry.js");
const providerBackoffSync = source("vehicle-primary-provider-backoff-sync.js");
const remoteCommandMonitor = source("vehicle-primary-remote-command-monitor.js");
const remoteCommandGuard = source("vehicle-primary-remote-command-dispatch-guard.js");
const now = Date.parse("2026-08-17T03:00:00Z");

{
  const failureMessage = {
    payload: {
      test_mode: true,
      state: "failed",
      attributes: {
        command: "lock",
        failure_stage: "confirmation",
        reason: "falha simulada após o aceite",
        updated_at: "test-failure",
      },
      preconditions: {
        front_left_door: { state: "off" },
        front_right_door: { state: "off" },
        back_left_door: { state: "on" },
        back_right_door: { state: "off" },
        trunk: { state: "off" },
        engine: { state: "off" },
        lock: { state: "unlocked" },
        telemetry: { state: "2026-08-17T02:45:00Z" },
      },
    },
    _vehicle_primary_remote_command_test: true,
  };
  const failure = runtime(remoteCommandMonitor, {
    now,
    msg: structuredClone(failureMessage),
  });
  assert.equal(failure.result.alert.title, "TESTE — falha no comando do Creta");
  assert.match(failure.result.alert.message, /travar as portas/);
  assert.match(failure.result.alert.message, /porta traseira esquerda aberta/);
  assert.match(failure.result.alert.message, /15 min/);
  assert.doesNotMatch(failure.result.alert.message, /Motivo informado/);
  assert.equal(failure.result.notification.id, "vehicle_primary_remote_command_failed");

  const duplicate = runtime(remoteCommandMonitor, {
    now: now + 1_000,
    values: Object.fromEntries(failure.store),
    msg: structuredClone(failureMessage),
  });
  assert.equal(duplicate.result, null);

  const guarded = runtime(remoteCommandGuard, {
    now,
    msg: failure.result,
  });
  assert.equal(guarded.result[0], null);
  assert.equal(guarded.result[1], null);
  assert.equal(guarded.result[2].payload.simulated, true);
  assert.equal(guarded.result[2].payload.dispatched, false);
  assert.equal(guarded.result[2].payload.notification_sent, false);
  assert.equal(guarded.result[2].payload.persistent_notification_created, false);
}

{
  const success = runtime(remoteCommandMonitor, {
    now,
    msg: {
      payload: {
        test_mode: true,
        state: "accepted",
        attributes: { command: "unlock", updated_at: "test-success" },
      },
      _vehicle_primary_remote_command_test: true,
    },
  });
  assert.equal(success.result, null);
}

{
  const { result } = runtime(manual, {
    now,
    msg: { payload: { event_type: "manual_refresh" } },
  });
  assert.equal(result.payload.kind, "refresh_tick");
  assert.equal(result.payload.reason, "manual_force");
  assert.equal(result.payload.force_recovery, true);
}

{
  const state = {
    attempts: 0,
    last_success_at: now - 60_000,
    last_request_at: now - 60_000,
    next_allowed_at: now + 600_000,
    awaiting_evidence: false,
  };
  const first = runtime(coordinator, {
    now,
    values: {
      vehicle_primary_context_v1: { ready: true, location: {}, engine_updated_at: 1, lock_updated_at: 1 },
      security_vehicle_primary_refresh_v1: state,
    },
    msg: {
      payload: {
        kind: "refresh_command",
        reason: "manual_force",
        force_recovery: true,
      },
    },
  });
  assert.ok(Array.isArray(first.result));
  assert.ok(first.result[0]);
  assert.ok(first.result[1]);
  assert.equal(first.result[2], null);
  const stored = first.store.get("security_vehicle_primary_refresh_v1");
  assert.equal(stored.state, "refreshing");
  assert.equal(stored.attempts, 1);
  assert.equal(stored.manual_force, true);

  const second = runtime(coordinator, {
    now: now + 1_000,
    values: {
      vehicle_primary_context_v1: { ready: true },
      security_vehicle_primary_refresh_v1: stored,
    },
    msg: {
      payload: {
        kind: "refresh_command",
        reason: "manual_force",
        force_recovery: true,
      },
    },
  });
  assert.ok(Array.isArray(second.result));
  assert.equal(second.result[0], null);
  assert.equal(second.result[1], null);
  assert.equal(second.result[2].notification.id, "vehicle_primary_refresh_blocked");
  assert.match(second.result[2].notification.message, /nenhuma nova consulta foi enviada/i);
  assert.match(second.result[2].notification.message, /119 s/);
  assert.ok(second.logs.some((line) => line.includes("VEHICLE_PRIMARY_REFRESH_SUPPRESSED")));
  assert.equal(second.store.get("security_vehicle_primary_refresh_v1").attempts, 1);
  assert.equal(second.store.get("security_vehicle_primary_refresh_v1").state, "in_flight");
}

{
  const { result, store } = runtime(coordinator, {
    now,
    values: {
      vehicle_primary_context_v1: { ready: true },
      security_vehicle_primary_refresh_v1: {
        attempts: 0,
        awaiting_evidence: false,
        last_success_at: 0,
        next_allowed_at: 0,
      },
    },
    msg: { payload: {
      kind: "refresh_command",
      anyone_away: false,
      resident_primary_state: "home",
      resident_secondary_state: "home",
    } },
  });
  assert.equal(result, null);
  assert.equal(store.get("security_vehicle_primary_refresh_v1").state, "waiting");
  assert.equal(
    store.get("security_vehicle_primary_refresh_v1").reason,
    "quiet_hours_both_home",
  );
}

{
  const { store } = runtime(coordinator, {
    now,
    values: {
      vehicle_primary_context_v1: { ready: true },
      security_vehicle_primary_refresh_v1: {
        attempts: 2,
        awaiting_evidence: true,
        recovery_reason: "movement_recovery",
        last_attempt_at: now - 16 * 60_000,
        next_allowed_at: now - 1,
      },
    },
    msg: { payload: { kind: "refresh_command", anyone_away: true } },
  });
  const state = store.get("security_vehicle_primary_refresh_v1");
  assert.equal(state.attempts, 2);
  assert.equal(state.state, "probing_cache");
  assert.equal(state.interval_policy, "recovery_15m");
  assert.equal(state.next_retry_at, now - 1);
}

{
  const { result } = runtime(telemetry, {
    now,
    values: {
      security_vehicle_primary_refresh_v1: {
        state: "backoff",
        reason: "api_error",
        attempts: 3,
        awaiting_evidence: true,
        last_attempt_at: now - 40_000,
        next_allowed_at: now + 58_000,
        last_success_reason: "fresh_telemetry_engine_state_known",
        lighting_ready_after_wake: true,
        engine_communication_failed: false,
        last_evidence_domains: ["telemetry"],
      },
    },
    msg: {},
  });
  assert.equal(result[0].length, 4);
  assert.equal(result[0][0].topic, "homeassistant/sensor/creta_refresh_coordinator/config");
  assert.equal(result[0][0].payload, "");
  assert.equal(result[0][0].retain, true);
  assert.equal(
    result[0][1].topic,
    "homeassistant/sensor/vehicle_primary_refresh_coordinator_source/config",
  );
  assert.equal(result[0][1].payload, "");
  const discovery = JSON.parse(result[0][2].payload);
  assert.equal(discovery.name, "Refresh Coordinator");
  assert.equal(discovery.object_id, "vehicle_primary_refresh_coordinator");
  assert.equal(discovery.unique_id, "vehicle_primary_refresh_coordinator");
  assert.equal(
    result[0][2].topic,
    "homeassistant/sensor/vehicle_primary_refresh_coordinator/config",
  );
  const payload = JSON.parse(result[0][3].payload);
  assert.equal(payload.state, "backoff");
  assert.equal(payload.attempt, 3);
  assert.equal(payload.remaining_seconds, 58);
  assert.equal(payload.failure_endpoint, null);
  assert.equal(payload.failure_stage, null);
  assert.equal(payload.last_success_reason, "fresh_telemetry_engine_state_known");
  assert.equal(payload.lighting_ready_after_wake, true);
  assert.equal(payload.engine_communication_failed, false);
  assert.deepEqual(payload.last_evidence_domains, ["telemetry"]);
}

const ids = flows.map((node) => node.id);
for (const expected of [
  "vehicle_primary_manual_refresh_button_v1",
  "vehicle_primary_manual_refresh_request_v1",
  "vehicle_primary_refresh_telemetry_tick_v1",
  "vehicle_primary_refresh_telemetry_v1",
  "vehicle_primary_refresh_mqtt_v1",
  "vehicle_primary_manual_refresh_blocked_notification_v1",
  "vehicle_primary_refresh_notification_requested_out_v1",
  "vehicle_primary_refresh_error_notification_out_v1",
  "vehicle_primary_refresh_notification_in_v1",
  "vehicle_primary_refresh_notification_guard_v1",
  "vehicle_primary_refresh_notify_primary_v1",
  "vehicle_primary_refresh_notify_persistent_v1",
  "vehicle_primary_refresh_dismiss_persistent_v1",
  "vehicle_primary_refresh_notification_dry_run_out_v1",
  "vehicle_primary_cache_probe_dispatch_guard_v1",
  "vehicle_primary_cache_probe_call_v1",
  "vehicle_primary_cache_probe_accepted_v1",
  "vehicle_primary_remote_command_event_v1",
  "vehicle_primary_remote_command_monitor_v1",
  "vehicle_primary_remote_command_guard_v1",
  "vehicle_primary_remote_command_notify_primary_v1",
  "vehicle_primary_remote_command_notify_persistent_v1",
  "vehicle_primary_remote_command_dry_run_out_v1",
  "vehicle_primary_remote_command_test_reset_v1",
  "vehicle_primary_remote_command_test_success_v1",
  "vehicle_primary_remote_command_test_failure_v1",
]) {
  assert.equal(ids.filter((id) => id === expected).length, 1, expected);
}

const normalizer = flows.find((node) => node.id === "092625f2eb5cc156");
assert.match(normalizer.func, /refresh_state_contract_v1/);
assert.match(normalizer.func, /vehicleContext\.refresh/);
assert.match(
  normalizer.func,
  /semantic_wake_confirmation_independent_of_derived_readiness_v2/,
);
assert.match(normalizer.func, /if \(evidenceObserved\)/);
assert.doesNotMatch(normalizer.func, /else if \(evidenceObserved\)/);
assert.match(normalizer.func, /lighting_ready_after_wake/);
assert.match(normalizer.func, /engine_state_trust_by_api_health_v1/);
assert.match(normalizer.func, /engine_communication_failed/);
assert.doesNotMatch(normalizer.func, /fresh_telemetry_engine_unreliable/);

const refreshDecision = flows.find((node) => node.id === "b33e117e55bdb5ed");
assert.equal(refreshDecision.outputs, 5);
assert.deepEqual(refreshDecision.wires[0], ["vehicle_primary_refresh_dispatch_guard_v1"]);
assert.deepEqual(
  refreshDecision.wires[2],
  ["vehicle_primary_manual_refresh_blocked_notification_v1"],
);
assert.deepEqual(
  refreshDecision.wires[3],
  ["vehicle_primary_refresh_notification_requested_out_v1"],
);
assert.deepEqual(
  refreshDecision.wires[4],
  ["vehicle_primary_cache_probe_dispatch_guard_v1"],
);

const blockedNotification = flows.find(
  (node) => node.id === "vehicle_primary_manual_refresh_blocked_notification_v1",
);
assert.equal(blockedNotification.action, "persistent_notification.create");
assert.equal(blockedNotification.dataType, "jsonata");

const dispatchGuard = flows.find(
  (node) => node.id === "vehicle_primary_refresh_dispatch_guard_v1",
);
assert.deepEqual(dispatchGuard.wires, [
  ["8907830bb7f6c40c"],
  ["vehicle_primary_refresh_dry_run_out_v1"],
]);
assert.match(dispatchGuard.func, /simulated:\s*true/);
assert.match(dispatchGuard.func, /dispatched:\s*false/);

const forceRefresh = flows.find((node) => node.id === "8907830bb7f6c40c");
assert.deepEqual(forceRefresh.wires, [["vehicle_primary_refresh_accepted_v1"]]);
const cacheProbeGuard = flows.find(
  (node) => node.id === "vehicle_primary_cache_probe_dispatch_guard_v1",
);
assert.deepEqual(cacheProbeGuard.wires, [
  ["vehicle_primary_cache_probe_call_v1"],
  ["vehicle_primary_refresh_dry_run_out_v1"],
]);
assert.match(cacheProbeGuard.func, /vehicle_primary\.cache_probe/);
const cacheProbe = flows.find(
  (node) => node.id === "vehicle_primary_cache_probe_call_v1",
);
assert.equal(cacheProbe.action, "kia_uvo.update");
assert.equal(cacheProbe.queue, "all");
assert.deepEqual(cacheProbe.wires, [["vehicle_primary_cache_probe_accepted_v1"]]);
const cacheProbeAccepted = flows.find(
  (node) => node.id === "vehicle_primary_cache_probe_accepted_v1",
);
assert.match(cacheProbeAccepted.func, /cache_probe_settle_until/);
const semanticTelemetryEvent = flows.find(
  (node) => node.id === "46c2142f93cfc3e1",
);
assert.ok(
  semanticTelemetryEvent.entities.entity.includes(
    "sensor.vehicle_primary_last_updated_at",
  ),
  "o timestamp semântico precisa disparar a confirmação do wake",
);
const accepted = flows.find(
  (node) => node.id === "vehicle_primary_refresh_accepted_v1",
);
assert.match(accepted.func, /aceite HTTP 200\/202/);
assert.match(accepted.func, /awaiting_evidence = false/);
assert.match(accepted.func, /last_success_reason = "api_accepted_200_or_202"/);

const providerBackoffState = flows.find(
  (node) => node.id === "vehicle_primary_provider_backoff_state_v1",
);
assert.deepEqual(providerBackoffState.entities.entity, [
  "sensor.vehicle_primary_api_retry_at",
]);
assert.equal(providerBackoffState.outputInitially, true);
assert.equal(providerBackoffState.outputProperties[0].valueType, "jsonata");
assert.match(providerBackoffState.outputProperties[0].value, /attributes\.status/);
assert.deepEqual(providerBackoffState.wires, [[
  "vehicle_primary_provider_backoff_sync_v1",
]]);
const providerBackoffNode = flows.find(
  (node) => node.id === "vehicle_primary_provider_backoff_sync_v1",
);
assert.equal(providerBackoffNode.func, providerBackoffSync.trimEnd());
assert.deepEqual(providerBackoffNode.wires, [[
  "vehicle_primary_provider_bypass_command_v1",
]]);
const providerBypassCommand = flows.find(
  (node) => node.id === "vehicle_primary_provider_bypass_command_v1",
);
assert.equal(providerBypassCommand.type, "mqtt out");
assert.equal(providerBypassCommand.broker, "721c47f31046b8bc");

const refreshErrorCatch = flows.find(
  (node) => node.id === "vehicle_primary_api_error_catch_v1",
);
assert(refreshErrorCatch.scope.includes("16396e34ff530ac7"));
const refreshErrorLogger = flows.find(
  (node) => node.id === "vehicle_primary_api_error_log_v1",
);
assert.equal(refreshErrorLogger.outputs, 2);
assert.deepEqual(refreshErrorLogger.wires[1], [
  "vehicle_primary_api_error_bypass_out_v1",
]);
const refreshErrorBypassOut = flows.find(
  (node) => node.id === "vehicle_primary_api_error_bypass_out_v1",
);
const refreshErrorBypassIn = flows.find(
  (node) => node.id === "vehicle_primary_api_error_bypass_in_v1",
);
assert.deepEqual(refreshErrorBypassOut.links, [
  "vehicle_primary_api_error_bypass_in_v1",
]);
assert.deepEqual(refreshErrorBypassIn.wires, [[
  "vehicle_primary_provider_bypass_command_v1",
]]);
const refreshTelemetry = flows.find(
  (node) => node.id === "vehicle_primary_refresh_telemetry_v1",
);
assert.equal(refreshTelemetry.outputs, 3);
assert.deepEqual(refreshTelemetry.wires[2], [
  "vehicle_primary_provider_bypass_command_v1",
]);

const refreshNotification = flows.find(
  (node) => node.id === "vehicle_primary_refresh_notify_primary_v1",
);
assert.equal(refreshNotification.action, "public_bindings.call");
assert.match(refreshNotification.data, /"role":"mobile_primary"/);
assert.match(refreshNotification.data, /"action":"notify_3"/);
assert.match(refreshNotification.data, /"title":alert\.title/);
assert.match(refreshNotification.data, /"message":alert\.message/);
assert.equal(refreshNotification.queue, "all");

const refreshPersistent = flows.find(
  (node) => node.id === "vehicle_primary_refresh_notify_persistent_v1",
);
assert.equal(refreshPersistent.action, "persistent_notification.create");
assert.match(refreshPersistent.data, /notification_id/);
assert.equal(refreshPersistent.queue, "all");

const refreshDismiss = flows.find(
  (node) => node.id === "vehicle_primary_refresh_dismiss_persistent_v1",
);
assert.equal(refreshDismiss.action, "persistent_notification.dismiss");
assert.equal(refreshDismiss.queue, "all");
const refreshNotificationGuard = flows.find(
  (node) => node.id === "vehicle_primary_refresh_notification_guard_v1",
);
assert.equal(refreshNotificationGuard.outputs, 4);
assert.deepEqual(refreshNotificationGuard.wires[3], [
  "vehicle_primary_refresh_dismiss_persistent_v1",
]);

const remoteEvent = flows.find(
  (node) => node.id === "vehicle_primary_remote_command_event_v1",
);
assert.deepEqual(remoteEvent.entities.entity, [
  "sensor.garagem_vehicle_primary_remote_command_status",
]);
assert.equal(remoteEvent.ifState, "failed");
const remoteGuard = flows.find(
  (node) => node.id === "vehicle_primary_remote_command_guard_v1",
);
assert.deepEqual(remoteGuard.wires, [
  ["vehicle_primary_remote_command_notify_primary_v1"],
  ["vehicle_primary_remote_command_notify_persistent_v1"],
  ["vehicle_primary_remote_command_dry_run_out_v1"],
]);
const remoteMobile = flows.find(
  (node) => node.id === "vehicle_primary_remote_command_notify_primary_v1",
);
assert.equal(remoteMobile.action, "public_bindings.call");
assert.equal(remoteMobile.queue, "all");
const remotePersistent = flows.find(
  (node) => node.id === "vehicle_primary_remote_command_notify_persistent_v1",
);
assert.equal(remotePersistent.action, "persistent_notification.create");
assert.match(remotePersistent.data, /notification_id/);
assert.equal(remotePersistent.queue, "all");

for (const [id, action] of [
  ["8907830bb7f6c40c", "force_refresh"],
  ["16396e34ff530ac7", "refresh_trip_info"],
]) {
  const node = flows.find((item) => item.id === id);
  assert.equal(node.action, "public_bindings.call");
  assert.deepEqual(JSON.parse(node.data), { role: "vehicle_primary", action });
  assert.deepEqual(node.entityId, []);
}
assert.equal(flows.some((node) => node.id === "77cf2dfe4ff36964"), false);
assert.equal(flows.some((node) => node.id === "684feca0f1585885"), false);
assert.doesNotMatch(JSON.stringify(flows), /77cf2dfe4ff36964|684feca0f1585885/);

const exampleBindings = JSON.parse(
  fs.readFileSync(new URL("../../bindings/private-bindings.example.json", import.meta.url)),
);
const vehicleServices = exampleBindings.roles.vehicle_primary.services;
assert.deepEqual(vehicleServices.force_refresh, {
  target_service: "button.press",
  target_public_entity_id: "button.vehicle_primary_force_refresh",
});
assert.deepEqual(vehicleServices.refresh_trip_info, {
  target_service: "button.press",
  target_public_entity_id: "button.garagem_vehicle_primary_refresh_trip_info",
});
assert.deepEqual(vehicleServices.unlock, {
  target_service: "lock.unlock",
  target_public_entity_id: "lock.vehicle_primary_door_lock",
});
assert.ok(
  exampleBindings.roles.vehicle_primary.entities[
    "sensor.garagem_vehicle_primary_remote_command_status"
  ].attributes.includes("failure_stage"),
);

for (const node of flows.filter((item) => item.type === "api-call-service")) {
  const serialized = JSON.stringify(node);
  if (node.action === "button.press" || node.action === "homeassistant.update_entity") {
    assert.doesNotMatch(
      serialized,
      /button\.vehicle_primary|button\.garagem_vehicle_primary|device_tracker\.vehicle_primary|binary_sensor\.vehicle_primary|lock\.vehicle_primary/,
      `ação direta em alias sintético: ${node.name}`,
    );
  }
}

console.log("vehicle_primary dashboard controls: 10 cenários aprovados.");
