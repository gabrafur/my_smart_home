import assert from 'node:assert/strict';
import fs from 'node:fs';
import jsonata from 'jsonata';

// Replay the generated decisions, functions and JSONata with synthetic HA
// facts. Residential effects are terminals, never imported or executed.
const flows = JSON.parse(fs.readFileSync(process.argv[2] ?? new URL('../flows.json', import.meta.url)));
const nodes = new Map(flows.map(n => [n.id, n]));
const policy = JSON.parse(nodes.get('daily_update_inventory_parameters').rules[0].to);
assert.equal(policy.device_firmware_auto, true);
assert.equal(nodes.get('daily_update_inventory_classify').checkall, 'false');
assert.equal(nodes.get('daily_update_firmware_install').data, '{"entity_id":payload.entity_id}',
  'omit version so HA installs its current latest, not an old queued target');
assert.equal(nodes.get('daily_update_firmware_dispatch_rbe').topi, 'firmware_dedupe_topic');
const get = (obj, key) => key.split('.').reduce((v, k) => v?.[k], obj);
const set = (obj, key, value) => {
  const parts = key.split('.'); const last = parts.pop(); let dest = obj;
  for (const p of parts) dest = dest[p] ??= {};
  dest[last] = value;
};
function fixture() {
  const store = new Map(), dedupe = new Map(), effects = [], dry = [], alerts = [], protectedRoutes = [];
  const flow = { get: key => store.get(key), set: (key, value) => store.set(key, structuredClone(value)) };
  const node = { status() {}, warn() {}, error(message) { throw Error(message); } };
  async function run(start, input) {
    const queue = [[start, structuredClone(input)]]; let steps = 0;
    while (queue.length) {
      assert.ok(++steps < 300, 'firmware replay must terminate');
      const [id, msg] = queue.shift(), n = nodes.get(id); assert.ok(n, id);
      const send = (i, value) => {
        if (value) for (const target of n.wires?.[i] ?? []) queue.push([target, structuredClone(value)]);
      };
      if (id === 'daily_update_firmware_install') { effects.push(msg); continue; }
      if (id === 'daily_update_dry_run_terminal') { dry.push(msg); continue; }
      if (id === 'operations_daily_firmware_automatic') {
        const event = JSON.parse(n.rules[0].to); assert.equal(event.active, false);
        assert.equal(event.reason, 'firmware_automatic_enabled'); alerts.push(event); continue;
      }
      if (id.startsWith('operations_daily_')) {
        assert.fail(`normal automatic firmware must not ask for approval: ${id}`);
      }
      if (id === 'daily_update_inventory_kia_out') { protectedRoutes.push(id); continue; }
      if (id === 'daily_update_inventory_record') continue;
      if (n.type === 'inject') {
        for (const p of n.props) {
          const value = p.vt === 'json' ? JSON.parse(p.v) : p.vt === 'bool' ? p.v === 'true' : p.v;
          set(msg, p.p, value);
        }
        send(0, msg);
      } else if (n.type === 'function') {
        const result = new Function('msg', 'node', 'flow', n.func)(msg, node, flow);
        if (Array.isArray(result)) result.forEach((out, i) => (Array.isArray(out) ? out : [out]).forEach(v => send(i, v)));
        else send(0, result);
      } else if (n.type === 'change') {
        for (const rule of n.rules) {
          assert.equal(rule.t, 'set');
          const value = rule.tot === 'json' ? JSON.parse(rule.to) : rule.tot === 'jsonata' ? await jsonata(rule.to).evaluate(msg) : rule.to;
          set(msg, rule.p, value);
        }
        send(0, msg);
      } else if (n.type === 'switch') {
        const value = n.propertyType === 'jsonata' ? await jsonata(n.property).evaluate(msg) : get(msg, n.property);
        let matched = false;
        for (const [i, rule] of n.rules.entries()) {
          const match = rule.t === 'true' ? value === true : rule.t === 'false' ? value === false : rule.t === 'else' ? !matched :
            rule.t === 'eq' ? value === rule.v : rule.t === 'regex' ? new RegExp(rule.v, rule.case === false ? 'i' : '').test(value) : false;
          if (match && (!matched || n.checkall === 'true')) { matched = true; send(i, msg); }
        }
      } else if (n.type === 'rbe') {
        assert.equal(n.func, 'rbe'); assert.equal(n.septopics, true);
        const key = n.id + ':' + get(msg, n.topi), value = get(msg, n.property);
        if (!dedupe.has(key) || dedupe.get(key) !== value) { dedupe.set(key, value); send(0, msg); }
      } else if (n.type === 'link out') for (const target of n.links) queue.push([target, structuredClone(msg)]);
      else if (n.type === 'link in') send(0, msg);
      else assert.fail(`unexpected real boundary: ${id} (${n.type})`);
    }
  }
  return { run, effects, dry, alerts, protectedRoutes };
}
const fact = (attrs = {}, entity_id = 'update.synthetic_controller') => ({
  entity_id, state: 'on', attributes: { device_class: 'firmware', friendly_name: 'Synthetic controller', installed_version: '1', latest_version: '2', in_progress: false, ...attrs },
});
const message = (entity, extra = {}) => ({ payload: [entity], update_policy: policy, ...extra });
const current = fixture();
await current.run('daily_update_inventory_normalize', message(fact()));
assert.equal(current.effects.length, 1, 'new firmware installs automatically without daily/manual authorization');
await current.run('daily_update_inventory_normalize', message(fact()));
assert.equal(current.effects.length, 1, 'same entity/version cannot dispatch twice');
await current.run('daily_update_inventory_normalize', message(fact({ latest_version: '3' })));
assert.equal(current.effects.length, 2, 'a newly offered version is eligible');
await current.run('daily_update_inventory_normalize', message(fact({}, 'update.synthetic_other')));
assert.equal(current.effects.length, 3, 'dedupe is per entity');
await current.run('daily_update_inventory_normalize', message(fact(), { _ha_updates_test: true }));
assert.equal(current.effects.length, 3, 'dry-run never dispatches an installation');
assert.equal(current.dry.length, 1, 'test and production have separate dedupe state');
assert.ok(current.alerts.length > 0);
for (const attrs of [{ in_progress: true }, { in_progress: 0 }, { latest_version: null }, { latest_version: '' }, { latest_version: 'unknown' }, { latest_version: 'unavailable' }, { latest_version: '1' }]) {
  const f = fixture(); await f.run('daily_update_inventory_normalize', message(fact(attrs)));
  assert.equal(f.effects.length, 0, JSON.stringify(attrs));
}
for (const age of [-10000, 41 * 60000]) {
  const f = fixture(); await f.run('daily_update_inventory_normalize', message(fact(), { update_observed_at: Date.now() - age }));
  assert.equal(f.effects.length, 0, 'future and stale snapshots cannot install');
}
const shared = fixture(); await shared.run('daily_update_firmware_test_auto', {});
assert.equal(shared.effects.length, 0); assert.equal(shared.dry.length, 1,
  'the manual test crosses the real policy, inventory, classification, freshness, dedupe and final gate');
const protectedCase = fixture();
await protectedCase.run('daily_update_inventory_normalize', message(fact({ friendly_name: 'Kia UVO firmware' }, 'update.synthetic_kia_uvo')));
assert.equal(protectedCase.effects.length, 0); assert.equal(protectedCase.protectedRoutes.length, 1,
  'versioned Bluelink cannot also reach generic firmware installation');
console.log('Firmware automatic latest: real generated decisions, freshness, in-progress, dedupe, protected integrations and full dry-run passed.');
