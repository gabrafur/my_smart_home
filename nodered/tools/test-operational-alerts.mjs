import assert from 'node:assert/strict';
import fs from 'node:fs';
import jsonata from 'jsonata';
import { installOperationalAlerts } from './install-operational-alerts.mjs';

const flows = JSON.parse(fs.readFileSync(new URL('../flows.json', import.meta.url)));
const byId = new Map(flows.map(n => [n.id, n]));
const stores = { memory: new Map(), memoryOnly: new Map(), persistent: new Map() };
const flow = { get: (k, s = 'memory') => stores[s].get(k), set: (k, v, s = 'memory') => stores[s].set(k, structuredClone(v)) };
const observed = [];
const node = { status() {}, warn() {}, log() {}, error(message) { throw Error(message); } };
const invoke = (id, msg, ctx = flow, mock = node) => new Function('msg', 'flow', 'node', 'global', byId.get(id).func)(msg, ctx, mock, { get() {} });
const get = (obj, key) => key.split('.').reduce((v, k) => v?.[k], obj);
const set = (obj, key, value) => { const keys = key.split('.'); const last = keys.pop(); let p = obj; for (const k of keys) p = p[k] ??= {}; p[last] = value; };

// Replay actual decision nodes and both existing/new branches to the final
// shared dry-run boundary. Any residential service/exec is an immediate failure.
async function replay(start, input) {
  const queue = [[start, input]];
  let steps = 0;
  while (queue.length) {
    assert.ok(++steps < 500, 'replay must terminate');
    const [id, msg] = queue.shift(); const n = byId.get(id); assert.ok(n, id);
    const send = (output, value) => { if (value) for (const target of n.wires?.[output] ?? []) queue.push([target, structuredClone(value)]); };
    if (id === 'global_observer_dry_run_terminal') {
      invoke(id, msg); observed.push(flow.get('global_flow_observer_last_dry_run_v1')); continue;
    }
    if (n.type === 'function') {
      const result = invoke(id, msg);
      if (Array.isArray(result)) result.forEach((output, i) => (Array.isArray(output) ? output : [output]).forEach(v => send(i, v)));
      else send(0, result);
    } else if (n.type === 'change') {
      for (const rule of n.rules) {
        assert.equal(rule.t, 'set');
        const value = rule.tot === 'json' ? JSON.parse(rule.to) : rule.tot === 'jsonata' ? await jsonata(rule.to).evaluate(msg) : rule.tot === 'msg' ? get(msg, rule.to) : rule.tot === 'num' ? Number(rule.to) : rule.tot === 'bool' ? rule.to === 'true' : rule.to;
        set(msg, rule.p, value);
      }
      send(0, msg);
    } else if (n.type === 'switch') {
      const value = get(msg, n.property); let matched = false;
      n.rules.forEach((rule, i) => {
        const match = rule.t === 'true' ? value === true : rule.t === 'false' ? value === false : rule.t === 'eq' ? value === (rule.vt === 'num' ? Number(rule.v) : rule.v) : rule.t === 'else' ? !matched : false;
        if (match && (!matched || n.checkall === 'true')) { matched = true; send(i, msg); }
      });
    } else if (n.type === 'link out') {
      for (const target of n.links) queue.push([target, structuredClone(msg)]);
    } else if (n.type === 'link in') send(0, msg);
    else throw Error(`Unexpected effect in dry-run: ${id} (${n.type})`);
  }
}

for (const [start, input] of [
  ['daily_update_hacs_state', { _ha_updates_test: true, payload: { entity_id: 'update.synthetic_hacs', state_class: 'pending', latest_version: '2', test_mode: true } }],
  ['daily_update_inventory_unknown_out', { _ha_updates_test: true, payload: { entity_id: 'update.synthetic_unknown', latest_version: '2', test_mode: true } }],
  ['daily_update_firmware_auto', { _ha_updates_test: true, update_policy: { device_firmware_auto: false }, payload: { entity_id: 'update.synthetic_firmware', latest_version: '2', test_mode: true } }],
  ['daily_update_dependency_blocked_from_fix', { _repository_dependency_test: true, payload: { package: 'synthetic-package', version: '1', test_mode: true } }],
]) {
  const before = observed.length;
  await replay(start, structuredClone(input));
  assert.equal(observed.length, before + 1, start);
  await replay(start, structuredClone(input));
  assert.equal(observed.length, before + 1, `${start}: duplicate suppressed`);
}
const pressure = { _host_memory_guardian_test: true, payload: { status: 'pressure_no_safe_candidate', request_id: 'synthetic-pressure', checked_at: '2026-01-01T00:00:00Z', test_mode: true } };
const beforePressure = observed.length;
await replay('host_memory_guardian_result_in', structuredClone(pressure));
assert.equal(observed.length, beforePressure + 1);
await replay('host_memory_guardian_result_in', { ...structuredClone(pressure), payload: { ...pressure.payload, request_id: 'next-poll' } });
assert.equal(observed.length, beforePressure + 1, 'new poll is still the same pressure incident');
await replay('host_memory_guardian_result_in', { ...pressure, payload: { ...pressure.payload, status: 'healthy', request_id: 'recovered' } });
assert.equal(observed.length, beforePressure + 2, 'recovery reaches shared dry-run');
assert.ok(observed.every(result => result?.simulated === true && result.dispatched === false && result.notification_sent === false));
assert.equal(stores.persistent.size, 0, 'full dry-run never changes production state');
assert.equal(stores.memoryOnly.get('global_observer_diagnostic_last_test').simulated, true);
assert.equal(stores.memoryOnly.get('global_observer_diagnostic_last_test').dispatched, false);

// Production lifecycle persists across a fresh context wrapper (restart),
// updates for a new version, silently dismisses and rearms after recovery.
const event = { source: 'atualizacoes_diarias', subject: 'update.synthetic', active: true, reason: 'firmware_approval_required', version: '2', title: 'Ação', message: 'Revisar' };
const alert = invoke('operations_daily_lifecycle', { operational_alert: event });
assert.ok(alert);
assert.equal(invoke('operations_daily_lifecycle', { operational_alert: event }, { ...flow }), null);
const dispatch = invoke('global_observer_dispatch_guard', alert);
assert.ok(dispatch[0] && dispatch[1]); assert.equal(dispatch[2], null);
const resolved = invoke('operations_daily_lifecycle', { operational_alert: { ...event, active: false } });
const resolution = invoke('global_observer_dispatch_guard', resolved);
assert.equal(resolution[0], null); assert.equal(resolution[1].payload.persistent_notification_operation, 'dismiss');
assert.ok(invoke('operations_daily_lifecycle', { operational_alert: event }));
assert.ok(invoke('operations_daily_lifecycle', { operational_alert: { ...event, version: '3' } }));

const weeklyContext = { values: new Map(), get(k) { return this.values.get(k); }, set(k, v) { this.values.set(k, v); } };
const weekly = state => invoke('weekly_docs_review_track_status', { payload: state, _weekly_docs_test: true }, weeklyContext);
assert.ok(weekly('unavailable'));
assert.equal(weekly('unknown'), null, 'unknown must not clear a confirmed failure');
assert.equal(weekly('unavailable'), null);
const recovered = weekly('aguardando');
assert.equal(recovered[0][0].payload.mobile_notification, false);
assert.ok(weekly('parado'));
assert.equal(weekly('parado'), null);

const errors = [];
invoke('daily_update_request_complete', { payload: { code: 1 } }, flow, { ...node, error: (e, context) => errors.push([e, context]) });
invoke('weekly_docs_review_complete_failed', { payload: { code: 1 } }, flow, { ...node, error: (e, context) => errors.push([e, context]) });
assert.equal(errors.length, 2, 'nonzero helper exits must reach catch');
assert.ok(errors.every(([, context]) => context && !Object.hasOwn(context, 'payload')));

const first = installOperationalAlerts(structuredClone(flows));
assert.deepEqual(installOperationalAlerts(structuredClone(first)), first, 'additive generator is idempotent');
for (const current of flows.filter(n => !n.id.startsWith('operations_'))) {
  const next = first.find(n => n.id === current.id); assert.ok(next, current.id);
  for (const field of ['x', 'y', 'w', 'h']) assert.equal(next[field], current[field], `${current.id}.${field}`);
}
console.log('Operational alerts: decisions, shared dry-run, both channels, dedupe, restart, recovery and silence passed.');
