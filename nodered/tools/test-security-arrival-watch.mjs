import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(new URL("functions/security-light-arrival-watch.js", import.meta.url), "utf8");
const execute = new Function("msg", "flow", "node", source);
const start = Date.parse("2026-09-01T20:00:00Z");
const values = new Map();
const flow = { get: (key) => values.get(key), set: (key, value) => values.set(key, structuredClone(value)) };
const production = { version: 1, residents: { protected: true } };
flow.set("security_light_arrival_watch_v1", production);
flow.set("security_light_arrival_watch_v1__test", { version: 1, residents: {
  resident_secondary: { event_at: start, created_at: start, attempts: 0, waiting_for_callback: false },
} });
function tick(minutes, observedMinutes = 0, extra = {}) {
  const age = minutes - observedMinutes;
  const data = { test_mode: true, now: start + minutes * 60000, future_ms: 60000,
    location_policy: { location_fresh_minutes: 15, near_home_refresh_minutes: 10 },
    lifecycle: {}, people: { arrival_armed: { resident_secondary: true },
      resident_secondary: { state: "near_home", current_home: false,
        ready: age <= 15, stale: age > 15, updated_at: start + observedMinutes * 60000 } },
    engine_allowed: false, bypass_allowed: false, sun_ready: true, dark: true, ...extra };
  return execute({ _light_context: data }, flow, { warn() {} })._light_context;
}
assert.equal(tick(9).phone_refresh_request, null);
assert.equal(tick(10).phone_refresh_request.payload.attempt, 1, "refresh before the location expires");
assert.equal(tick(10.5).phone_refresh_request, null, "respect retry spacing");
assert.equal(tick(11).phone_refresh_request.payload.attempt, 2, "retry even while the engine remains off");
assert.equal(tick(12).phone_refresh_request, null, "do not flood the provider");
assert.equal(tick(12, 12).engine_on_arrival, undefined, "a fresh callback with engine off does not illuminate");
assert.equal(tick(21, 12).phone_refresh_request, null);
assert.equal(tick(22, 12).phone_refresh_request.payload.attempt, 1, "new position starts a new refresh cycle");
assert.equal(tick(23, 12).phone_refresh_request.payload.attempt, 2);
const failed = tick(28, 12).phone_refresh_request;
assert.equal(failed.payload.kind, "arrival_location_refresh_failed");
assert.equal(failed._security_light_decision_state, "location_refresh_failed");
assert.equal(tick(29, 12).phone_refresh_request, null, "diagnostic emitted once per failed observation");
assert.equal(tick(30, 30).engine_on_arrival, undefined);
assert.equal(tick(40, 30).phone_refresh_request.payload.attempt, 1, "continue monitoring a long nearby stop");
const unchanged = tick(40.5, 30, { engine_allowed: true });
assert.equal(unchanged.engine_on_arrival, undefined, "old current data is not a new callback");
const refreshed = tick(41, 41, { engine_allowed: true });
assert.equal(refreshed.engine_on_arrival.payload.arrival_replayed_after_location_refresh, true);
assert.equal(refreshed.engine_on_arrival.payload.test_mode, true);
assert.deepEqual(flow.get("security_light_arrival_watch_v1"), production, "test never overwrites production");
tick(42, 42, { people: { arrival_armed: { resident_secondary: false },
  resident_secondary: { state: "home", ready: true, stale: false, current_home: true, updated_at: start + 42 * 60000 } } });
assert.deepEqual(flow.get("security_light_arrival_watch_v1__test").residents, {});
console.log("Arrival location watch: proactive renewal, bounded retry, fresh evidence and isolation passed.");
