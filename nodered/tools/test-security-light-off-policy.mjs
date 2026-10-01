import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const nodes = new Map(JSON.parse(fs.readFileSync(new URL('../flows.json', import.meta.url))).map(n => [n.id, n]));
let now = 1_800_000_000_000;
const policy = { version: 1, complete: true, physical_fresh_seconds: 120, off_grace_seconds: 90,
  backstop_minutes: 15, post_off_cooldown_minutes: 5, lifecycle_retention_hours: 24,
  deadline_slack_minutes: 1, cooldown_max_minutes: 30, approach_radius_m: 150 };
const location = { version: 1, complete: true, future_tolerance_seconds: 60, vehicle_signal_fresh_minutes: 5 };
const global = { get: k => k === 'location_policy_v1' ? location : policy };
const store = values => ({ get: k => values[k], set: (k,v) => { values[k] = v; }, values });
let checks = 0;
function fixture(extra = {}) {
  return store({ security_light_lifecycle_v1: { version: 1, active_by_arrival: true,
      on_since: now - 60_000, force_off_at: now + 840_000, updated_at: now },
    vehicle_primary_context_v1: { ready: true, engine_state_valid: true, engine_on: false,
      engine_updated_at: now, telemetry_updated_at: now, ...extra },
    security_light_physical_state: 'on', security_light_physical_observed_at: now,
    light_reconciled: true, sun_ready: true });
}
function run(id, msg, flow) {
  const node = nodes.get(id); assert(node);
  return vm.runInNewContext('(function(msg){' + node.func + '\n})', {
    flow, global, node: { log() {}, warn() {}, status() {}, error(e) { throw Error(e); } },
    Date: class extends Date { static now() { return now; } }
  })(msg);
}
const schedule = flow => run('374d4e39be0a30ac', {
  _light_context: { kind: 'vehicle_primary_context', accepted: true }, payload: {}
}, flow);
for (const extra of [
  { ready: false, location: { ready: false, stale: true }, in_use: null },
  { ready: false, location: { ready: true }, in_use: null }
]) {
  const flow = fixture(extra); const msg = schedule(flow);
  assert.equal(msg.delay, 90_000, 'fresh OFF must not depend on GPS or inferred usage');
  now += 90_000;
  const command = run('84d450933e67b8c1', msg, flow);
  assert(command, 'final gate must also accept fresh OFF without aggregate readiness');
  assert.equal(flow.get('security_light_lifecycle_v1').active_by_arrival, false);
  checks++;
}
for (const extra of [
  { telemetry_updated_at: now - 600_000 },
  { telemetry_updated_at: now - 61_000 },
  { telemetry_updated_at: now + 61_000 },
  { telemetry_updated_at: null, engine_updated_at: null },
  { engine_communication_failed: true }, { engine_on: true }, { engine_state_valid: false }
]) {
  for (const ready of [true, false]) {
    assert.equal(schedule(fixture({ ...extra, ready })), null); checks++;
  }
}
{
  const flow = fixture(); const msg = schedule(flow);
  assert.equal(msg.delay, 90_000); assert.equal(schedule(flow), null);
  assert.equal(run('84d450933e67b8c1', msg, flow), null);
  now += 90_000;
  const result = run('84d450933e67b8c1', msg, flow);
  assert.equal(result.payload.off_diagnostic.engine_age_ms, 90_000);
  assert.equal(flow.get('security_light_lifecycle_v1').active_by_arrival, false);
  assert.equal(run('84d450933e67b8c1', msg, flow), null); checks++;
}
for (const changed of [{ engine_on: true }, { engine_communication_failed: true },
  { telemetry_updated_at: now - 600_000 }]) {
  const flow = fixture(); const msg = schedule(flow); now += 90_000;
  Object.assign(flow.get('vehicle_primary_context_v1'), changed);
  assert.equal(run('84d450933e67b8c1', msg, flow), null); checks++;
}
{
  const flow = fixture(); const old = schedule(flow);
  flow.get('vehicle_primary_context_v1').engine_on = true; schedule(flow);
  assert.equal(flow.get('security_light_lifecycle_v1').pending_off_at, null);
  now += 30_000; Object.assign(flow.get('vehicle_primary_context_v1'), { engine_on: false, telemetry_updated_at: now });
  const latest = schedule(flow); now += 90_000;
  flow.set('security_light_physical_observed_at', now);
  assert.equal(run('84d450933e67b8c1', old, flow), null);
  assert(run('84d450933e67b8c1', latest, flow)); checks++;
}
{
  const flow = fixture(); schedule(flow);
  const restored = run('security_visual_lifecycle_load', { payload: { kind: 'reconcile_signal' } }, flow);
  assert.equal(restored._light_reconcile.lifecycle.pending_off_at, now + 90_000);
  const facts = run('security_visual_recovery_facts', restored, flow);
  const built = run('security_visual_recovery_build', facts, flow);
  const recovered = built._light_reconcile.messages.find(m => m.payload.deadline_type === 'confirmed_off');
  assert(recovered); now += 90_000;
  assert(run('84d450933e67b8c1', recovered, flow)); checks++;
}
{
  const flow = fixture({ engine_on: true, engine_communication_failed: true });
  flow.get('security_light_lifecycle_v1').force_off_at = now - 1;
  flow.set('light_reconciled', false);
  assert(run('84d450933e67b8c1', { payload: { deadline_type: 'backstop' } }, flow)); checks++;
}
{
  const flow = fixture(); const original = JSON.stringify(flow.values);
  run('security_visual_off_test_prepare', { topic: 'reset' }, flow);
  const input = run('security_visual_off_test_prepare', { topic: 'new_off' }, flow);
  flow.set('vehicle_primary_context_v1__test', input.payload.context);
  input._light_context = { kind: 'vehicle_primary_context', accepted: true };
  const scheduled = run('374d4e39be0a30ac', input, flow); assert(scheduled);
  now += 90_000;
  const command = run('84d450933e67b8c1', scheduled, flow); assert(command);
  assert.equal(command.payload.test_mode, true);
  assert.deepEqual(nodes.get('security_visual_off_test_gate').wires[0], ['security_visual_off_dry_run']);
  run('security_visual_off_dry_run', command, flow);
  assert.equal(flow.get('security_light_last_off_dry_run_v1__test').dispatched, false);
  assert.equal(JSON.stringify(Object.fromEntries(Object.entries(flow.values).filter(([k]) => !k.endsWith('__test')))), original);
  checks++;
}
console.log(`Security OFF policy: ${checks} regressions passed (no devices).`);
