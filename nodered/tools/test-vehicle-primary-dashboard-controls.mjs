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
const now = Date.parse("2026-08-17T03:00:00Z");

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
  assert.match(second.result[2].notification.message, /nova consulta não foi enviada/i);
  assert.match(second.result[2].notification.message, /59 s/);
  assert.ok(second.logs.some((line) => line.includes("VEHICLE_PRIMARY_REFRESH_SUPPRESSED")));
  assert.equal(second.store.get("security_vehicle_primary_refresh_v1").attempts, 1);
  assert.equal(second.store.get("security_vehicle_primary_refresh_v1").state, "backoff");
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
    msg: { payload: { kind: "refresh_command", anyone_away: false } },
  });
  assert.equal(result, null);
  assert.equal(store.get("security_vehicle_primary_refresh_v1").state, "waiting");
  assert.equal(
    store.get("security_vehicle_primary_refresh_v1").reason,
    "waiting_for_movement",
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
        last_attempt_at: now - 120_000,
        next_allowed_at: now - 1,
      },
    },
    msg: { payload: { kind: "refresh_command", anyone_away: true } },
  });
  const state = store.get("security_vehicle_primary_refresh_v1");
  assert.equal(state.attempts, 3);
  assert.equal(state.state, "refreshing");
  assert.equal(state.next_retry_at, now + 240_000);
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
}

const ids = flows.map((node) => node.id);
for (const expected of [
  "vehicle_primary_manual_refresh_button_v1",
  "vehicle_primary_manual_refresh_request_v1",
  "vehicle_primary_refresh_telemetry_tick_v1",
  "vehicle_primary_refresh_telemetry_v1",
  "vehicle_primary_refresh_mqtt_v1",
  "vehicle_primary_manual_refresh_blocked_notification_v1",
]) {
  assert.equal(ids.filter((id) => id === expected).length, 1, expected);
}

const normalizer = flows.find((node) => node.id === "092625f2eb5cc156");
assert.match(normalizer.func, /refresh_state_contract_v1/);
assert.match(normalizer.func, /vehicleContext\.refresh/);

const refreshDecision = flows.find((node) => node.id === "b33e117e55bdb5ed");
assert.equal(refreshDecision.outputs, 3);
assert.deepEqual(refreshDecision.wires[0], ["8907830bb7f6c40c"]);
assert.deepEqual(
  refreshDecision.wires[2],
  ["vehicle_primary_manual_refresh_blocked_notification_v1"],
);

const blockedNotification = flows.find(
  (node) => node.id === "vehicle_primary_manual_refresh_blocked_notification_v1",
);
assert.equal(blockedNotification.action, "persistent_notification.create");
assert.equal(blockedNotification.dataType, "jsonata");

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

console.log("vehicle_primary dashboard controls: 7 cenários aprovados.");
