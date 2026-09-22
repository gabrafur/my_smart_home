import assert from 'node:assert/strict';
import fs from 'node:fs';
import jsonata from 'jsonata';
import { runSecurityArrivalVisual, runSecurityContextVisual, runSecurityAvailabilityVisual } from './visual-flow-test-harness.mjs';

const flows = JSON.parse(fs.readFileSync(new URL('../flows.json', import.meta.url)));
const nodes = new Map(flows.map(n => [n.id, n]));
const epoch = Date.UTC(2026, 0, 1, 20);
let now = epoch;
class Clock extends Date {
  constructor(...args) { super(...(args.length ? args : [now])); }
  static now() { return now; }
}
const location = { version: 1, complete: true, future_tolerance_seconds: 60,
  location_fresh_minutes: 15, source_report_fresh_minutes: 75,
  vehicle_signal_fresh_minutes: 5, local_excursion_minutes: 90,
  arrival_recovery_minutes: 15, arrival_dedupe_minutes: 10,
  primary_home_grace_minutes: 10, home_radius_m: 100, near_home_radius_m: 700,
  external_cycle_confirm_seconds: 60, near_home_refresh_minutes: 5 };
const light = { version: 1, complete: true, physical_fresh_seconds: 120,
  recovery_request_throttle_seconds: 30, backstop_minutes: 15, post_off_cooldown_minutes: 5,
  unavailable_dedupe_seconds: 10, off_grace_seconds: 90, lifecycle_retention_hours: 24,
  deadline_slack_minutes: 1, cooldown_max_minutes: 30 };
const global = { get: key => key === 'location_policy_v1' ? location : light };
function store(initial = {}) {
  const values = new Map(Object.entries(initial));
  return { get: k => values.get(k), set: (k, v) => values.set(k, v), values };
}
const compiled = new Map();
function call(flow, id, msg) {
  if (!compiled.has(id)) compiled.set(id, new Function('msg', 'flow', 'global', 'node', 'Date', nodes.get(id).func));
  return compiled.get(id)(msg, flow, global, {
    status() {}, warn() {}, log() {}, error(text) { throw Error(text); }
  }, Clock);
}
const resident = (state = 'near_home', at = now) => ({ state, ready: true, stale: false,
  current_home: state === 'home', updated_at: at });
const cycle = () => ({ started_at: now - 20 * 60000, expires_at: now + 70 * 60000 });
function fixture(role) {
  const excursion = cycle();
  const state = { version: 1, residents: { [role]: { ...excursion,
    departure_engine_on_seen_at: excursion.started_at + 1000,
    engine_off_seen_at: excursion.started_at + 5 * 60000, consumed_at: null } } };
  const people = { ready: true, updated_at: now, local_excursions: { [role]: excursion },
    resident_primary: resident('home'), resident_secondary: resident('home') };
  people[role] = resident();
  const flow = store({ security_light_local_excursion_v1__test: state,
    sun_ready: false, sun_below_horizon: false, light_reconciled: true,
    security_light_physical_state: 'off', security_light_physical_observed_at: now,
    security_light_local_excursion_v1: { production: 'untouched' } });
  return { flow, people, excursion };
}
function context(flow, kind, payload = {}) {
  if (kind === 'sun_context') flow.set('sun_ready', true);
  return runSecurityContextVisual((id, msg) => call(flow, id, msg), {
    _location_test: true, payload: { kind, ...payload, test_mode: true }
  });
}
function engine(flow, on = true, at = now, failed = false) {
  return context(flow, 'vehicle_primary_context', { event: on ? 'turn_on' : 'turn_off', updated_at: now,
    context: { ready: true, updated_at: now, engine_updated_at: at,
      in_use: on, engine_on: on, engine_state_valid: true, engine_stale: false,
      engine_communication_failed: failed } });
}
function finish(flow, message) {
  const run = (id, msg) => call(flow, id, msg);
  const prepared = runSecurityArrivalVisual(run, message)?.[0];
  assert(prepared, 'arrival must cross the canonical arrival gates');
  const gate = flows.find(n => n.name === 'vehicle_primary está em uso?').id;
  const gated = run(gate, prepared);
  assert(gated, 'engine gate');
  const available = runSecurityAvailabilityVisual(run, gated)?.[0];
  assert(available, 'availability gate');
  const outputs = run('354c9839bfca592f', available);
  assert.equal(outputs?.[0], null, 'no production output');
  assert(outputs?.[1], 'must reach final dry-run');
  run('light_full_dry_run_terminal_v1', outputs[1]);
  const result = flow.get('security_light_last_dry_run_v1__test');
  assert.equal(result.simulated, true);
  assert.equal(result.dispatched, false);
  assert.deepEqual(flow.get('security_light_local_excursion_v1'), { production: 'untouched' });
}

let count = 0;
for (const role of ['resident_primary', 'resident_secondary']) {
  for (const order of ['svp', 'spv', 'vsp', 'vps', 'psv', 'pvs']) {
    now = epoch;
    const { flow, people } = fixture(role);
    let arrival;
    for (const step of order) {
      const outputs = step === 's' ? context(flow, 'sun_context', { sun_below_horizon: true })
        : step === 'v' ? engine(flow)
        : context(flow, 'people_context', { updated_at: now, context: people });
      if (outputs?.[2]) arrival = outputs[2];
      assert(flow.get('security_light_local_excursion_v1__test').residents[role],
        'partial startup must retain persisted departure and stop evidence');
    }
    assert(arrival, `startup order ${order}: return must survive hydration`);
    assert.equal(flow.get('security_light_local_excursion_v1__test').residents[role].consumed_at, null,
      'preparing a candidate does not consume it');
    finish(flow, arrival);
    assert.equal(flow.get('security_light_local_excursion_v1__test').residents[role].consumed_at, now);
    assert.equal(engine(flow)?.[2], null, 'completed local cycle must not repeat');
    count++;
  }
}

for (const mode of ['expired', 'future', 'excessive_ttl', 'missing_stop', 'failed_off', 'old_departure', 'future_stop']) {
  now = epoch;
  const { flow, people } = fixture('resident_secondary');
  const state = flow.get('security_light_local_excursion_v1__test').residents.resident_secondary;
  if (mode === 'old_departure') state.departure_engine_on_seen_at = now - 86400000;
  if (mode === 'future_stop') state.engine_off_seen_at = now + 120000;
  if (mode === 'expired') state.expires_at = now - 1;
  if (mode === 'future') state.started_at = now + 120000;
  if (mode === 'excessive_ttl') state.expires_at = now + 24 * 3600000;
  if (mode === 'missing_stop' || mode === 'failed_off') state.engine_off_seen_at = null;
  if (mode === 'failed_off') engine(flow, false, now - 1000, true);
  context(flow, 'sun_context', { sun_below_horizon: true });
  context(flow, 'people_context', { updated_at: now, context: people });
  assert.equal(engine(flow)?.[2], null, `invalid evidence ${mode} cannot authorize`);
  count++;
}

now = epoch;
{
  const { flow, people } = fixture('resident_secondary');
  context(flow, 'people_context', { updated_at: now, context: people });
  context(flow, 'sun_context', { sun_below_horizon: false });
  assert.equal(engine(flow)?.[2], null, 'daylight blocks dispatch');
  assert.equal(flow.get('security_light_local_excursion_v1__test').residents.resident_secondary.consumed_at, null);
  const sunset = context(flow, 'sun_context', { sun_below_horizon: true });
  finish(flow, sunset[2]);
  count++;
}

async function peopleMessage(flow, role, state, previous, { snapshot = false, observed = now, homeFor = 0 } = {}) {
  const entity = value => ({ state: value, attributes: { location_observed_at: new Clock(observed).toISOString(),
    canonical_distance_home_m: value === 'home' ? 20 : value === 'near_home' ? 500 : 2000 },
    last_changed: new Clock(now - homeFor).toISOString(), last_updated: new Clock(observed).toISOString() });
  let msg = { _location_test: true, payload: { event: snapshot ? 'context_snapshot' : 'location_update',
    source: role, trigger_state: state, trigger_prev_state: previous,
    resident_primary_selected: entity(role === 'resident_primary' ? state : 'home'),
    resident_secondary_selected: entity(role === 'resident_secondary' ? state : 'home') } };
  for (const id of ['people_visual_normalize', 'people_visual_state_load', 'people_visual_facts']) msg = call(flow, id, msg);
  if (await jsonata(nodes.get('people_visual_decision').property).evaluate(msg)) {
    msg = call(flow, 'people_visual_arrival_gate', msg);
    msg = call(flow, 'people_visual_arrival_dedupe', msg);
  } else if (await jsonata(nodes.get('people_visual_recovery_gate').property).evaluate(msg)) {
    msg = call(flow, 'people_visual_recovery_build', msg);
    msg = call(flow, 'people_visual_recovery_dedupe', msg);
  }
  return call(flow, '554cb653b2fa4504', msg);
}

for (const role of ['resident_primary', 'resident_secondary']) {
  for (const previous of ['not_home', 'unavailable']) {
    now = epoch;
    const flow = store({ people_arrival_armed__test: { [role]: true } });
    const snapshot = await peopleMessage(flow, role, 'home', previous, { snapshot: true });
    assert.equal(snapshot[1], null); assert.equal(snapshot[2], null, 'snapshot alone cannot create an arrival');
    assert.equal(flow.get('people_arrival_armed__test')[role], false);
    // Restart after snapshot, before the paired location event.
    flow.values.delete('people_arrival_armed__test');
    const event = await peopleMessage(flow, role, 'home', previous);
    assert(event[previous === 'not_home' ? 1 : 2], 'paired event must retain the confirmed external cycle');
    const duplicate = await peopleMessage(flow, role, 'home', previous);
    assert.equal(duplicate[1], null); assert.equal(duplicate[2], null);
    count++;
  }
  for (const invalid of ['unarmed', 'expired', 'different_observation', 'same_home']) {
    now = epoch;
    const flow = store({ people_arrival_armed__test: { [role]: invalid !== 'unarmed' } });
    await peopleMessage(flow, role, 'home', 'not_home', { snapshot: true });
    if (invalid === 'expired') now += 16 * 60000;
    const result = await peopleMessage(flow, role, 'home', invalid === 'same_home' ? 'home' : 'not_home',
      { observed: invalid === 'different_observation' ? now + 1000 : now });
    assert.equal(result[1], null, invalid); assert.equal(result[2], null, invalid);
    count++;
  }
  now = epoch;
  const flow = store();
  await peopleMessage(flow, role, 'near_home', 'home');
  assert(flow.get('security_people_recovery_v1__test').local_excursions[role]);
  now += 12 * 60000;
  await peopleMessage(flow, role, 'home', 'home', { snapshot: true, homeFor: 11 * 60000 });
  assert.equal(flow.get('security_people_recovery_v1__test').local_excursions[role], undefined,
    'settled HOME must close the previous local cycle before another person starts the vehicle');
  count++;
}
for (const closure of ['closed', 'new_cycle', 'expired']) {
  now = epoch;
  const { flow, people } = fixture('resident_secondary');
  context(flow, 'people_context', { updated_at: now, context: people });
  context(flow, 'sun_context', { sun_below_horizon: true });
  const arrival = engine(flow)[2];
  assert(arrival);
  if (closure === 'closed') delete people.local_excursions.resident_secondary;
  if (closure === 'new_cycle') people.local_excursions.resident_secondary.started_at += 1000;
  if (closure === 'expired') now += 91 * 60000;
  const outputs = runSecurityArrivalVisual((id, msg) => call(flow, id, msg), arrival);
  assert.equal(outputs?.[0], null, 'queued local return cannot outlive its canonical cycle');
  count++;
}

// A stale pending arrival for one resident must not starve a fresh local return.
now = epoch;
{
  const { flow, people } = fixture('resident_secondary');
  people.resident_primary = { ...resident('near_home', now - 3600000), stale: true, ready: false };
  flow.set('security_light_pending_arrival_v1__test', { version: 2, retention: 'while_approaching',
    source: 'resident_primary', queued_at: now - 60000, expires_at: now + 60000,
    message: { payload: { kind: 'arrival', source: 'resident_primary' } } });
  context(flow, 'people_context', { updated_at: now, context: people });
  context(flow, 'sun_context', { sun_below_horizon: true });
  const result = engine(flow)[2];
  assert.equal(result?.payload.source, 'resident_secondary');
  finish(flow, result);
  count++;
}

// Build the external proof from actual observations, then return hours later.
for (const role of ['resident_primary', 'resident_secondary']) {
  for (const motor of ['on', 'fresh_off', 'stale_off', 'failed_off', 'unknown']) {
    now = epoch - 3 * 3600000;
    const peopleFlow = store();
    await peopleMessage(peopleFlow, role, 'not_home', 'home');
    now += 2 * 60000;
    await peopleMessage(peopleFlow, role, 'not_home', 'not_home', { snapshot: true });
    assert.equal(peopleFlow.get('security_people_recovery_v1__test').arrival_armed[role], true);
    now = epoch;
    peopleFlow.values.delete('people_arrival_armed__test');
    const snapshot = await peopleMessage(peopleFlow, role, 'home', 'unavailable', { snapshot: true });
    const arrival = (await peopleMessage(peopleFlow, role, 'home', 'unavailable'))[2];
    assert(arrival, 'long absence preserves confirmed departure across restart and reordered snapshot');
    const { flow } = fixture(role);
    context(flow, 'people_context', { updated_at: now, context: snapshot[0].payload.context });
    const vehicle = { ready: true, updated_at: now, engine_updated_at: now,
      in_use: motor === 'on', engine_on: motor === 'on', engine_state_valid: motor !== 'unknown',
      engine_stale: motor === 'stale_off', engine_communication_failed: motor === 'failed_off' };
    context(flow, 'vehicle_primary_context', { updated_at: now, context: vehicle });
    const waiting = runSecurityArrivalVisual((id, msg) => call(flow, id, msg), arrival);
    assert.equal(waiting[0], null, 'missing sun context waits without dispatch');
    const replay = context(flow, 'sun_context', { sun_below_horizon: true })[2];
    assert(replay, 'context recovery must re-evaluate canonical motor policy');
    if (['on', 'stale_off'].includes(motor)) finish(flow, replay);
    else {
      const prepared = runSecurityArrivalVisual((id, msg) => call(flow, id, msg), replay)?.[0];
      if (prepared) assert.equal(call(flow, flows.find(n => n.name === 'vehicle_primary está em uso?').id, prepared), null);
      assert.equal(flow.get('security_light_lifecycle_v1__test')?.active_by_arrival, undefined);
    }
    count++;
  }
}
console.log(`Security return recovery: ${count} restart, local, long-return and dry-run scenarios passed.`);
