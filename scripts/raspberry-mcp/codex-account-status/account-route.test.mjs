import assert from 'node:assert/strict';
import {makeAccountRoute, accountDescriptor} from './account-route.mjs';
import fs from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
// The broker loads ws from the path installed on the Raspberry; CI has no such file.
// Load the source with a stand-in that refuses any connection, so only pure code runs.
const hostRequire = createRequire(import.meta.url);
const stubRequire = name => name === '/usr/local/lib/raspberry-ha-notices/vendor/ws'
  ? class NoNetwork { constructor() { throw Error('network forbidden in tests'); } } : hostRequire(name);
const loaded = {exports: {}};
// Same realm as the route, so plain objects keep their prototypes.
vm.runInThisContext('(function (module, exports, require) {' +
  fs.readFileSync(new URL('./broker.cjs', import.meta.url), 'utf8') + '\n})')(loaded, loaded.exports, stubRequire);
const {classify, METHODS, APP} = loaded.exports;
// The control socket follows the host_operator HOME set by systemd (User= is rendered at install).
const loadWith = env => {
  const saved = {...process.env}; Object.assign(process.env, env);
  if (!('CODEX_APP_SERVER_CONTROL_SOCKET' in env)) delete process.env.CODEX_APP_SERVER_CONTROL_SOCKET;
  try {
    const m = {exports: {}};
    vm.runInThisContext('(function (module, exports, require) {' +
      fs.readFileSync(new URL('./broker.cjs', import.meta.url), 'utf8') + '\n})')(m, m.exports, stubRequire);
    return m.exports.APP;
  } finally { for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); }
};
assert.equal(typeof APP, 'string');
assert.equal(loadWith({HOME: '/home/example_operator'}), '/home/example_operator/.codex/app-server-control/app-server-control.sock');
assert.equal(loadWith({HOME: '/home/example_operator', CODEX_APP_SERVER_CONTROL_SOCKET: '/run/example.sock'}), '/run/example.sock');
assert.ok(!fs.readFileSync(new URL('./raspberry-codex-account-status@.service', import.meta.url), 'utf8').match(/^(User|Group)=(?!@HOST_OPERATOR_)/m));
const limited = classify({account: {type: 'chatgpt', planType: 'prolite'}},
  {ordinaryUsageAllowed: false, rateLimits: {rateLimitReachedType: 'rate_limit_reached', credits: {hasCredits: false, unlimited: false}, primary: {usedPercent: 100, resetsAt: 1795262780}}});
assert.equal(limited.reason, 'codex_usage_limit_reached');
assert.equal(limited.resets_at, '2026-11-21T12:06:20.000Z');
assert.equal(classify({account: {type: 'chatgpt', planType: 'pro'}}, {ordinaryUsageAllowed: true, rateLimits: {}}).reason, 'codex_usage_available');
assert.equal(classify({account: {type: 'apiKey'}}, {ordinaryUsageAllowed: true}).reason, 'codex_subscription_not_personal');
assert.deepEqual([...METHODS].sort(), ['account/rateLimits/read', 'account/read', 'initialize']);
const prior = async q => q.method === 'tools/list' ? {jsonrpc: '2.0', id: q.id, result: {tools: [{name: 'x'}]}}
  : q.params.name === 'codex_task_create' ? {jsonrpc: '2.0', id: q.id, result: {content: [{type: 'text', text: 'task_rpc_unconfirmed'}], isError: true}}
  : {jsonrpc: '2.0', id: q.id, result: {content: [{type: 'text', text: '{}'}], isError: false}};
const route = makeAccountRoute(prior, async () => limited);
const list = await route({jsonrpc: '2.0', id: 1, method: 'tools/list'});
assert.deepEqual(list.result.tools.map(t => t.name), ['x', 'codex_account_status']);
assert.equal(accountDescriptor.annotations.readOnlyHint, true);
const read = await route({jsonrpc: '2.0', id: 2, method: 'tools/call', params: {name: 'codex_account_status', arguments: {host: 'raspberry'}}});
assert.equal(read.result.structuredContent.reason, 'codex_usage_limit_reached');
const bad = await route({jsonrpc: '2.0', id: 3, method: 'tools/call', params: {name: 'codex_account_status', arguments: {host: 'raspberry', x: 1}}});
assert.equal(bad.error.message, 'codex_account_parameters_refused');
const created = await route({jsonrpc: '2.0', id: 4, method: 'tools/call', params: {name: 'codex_task_create', arguments: {}}});
assert.equal(created.result.content[0].text, 'task_rpc_unconfirmed');
assert.equal(JSON.parse(created.result.content[1].text).likely_reason, 'codex_usage_limit_reached');
const other = await route({jsonrpc: '2.0', id: 5, method: 'tools/call', params: {name: 'codex_task_status', arguments: {}}});
assert.equal(other.result.content.length, 1);
const down = makeAccountRoute(prior, async () => { throw Error('x'); });
const d = await down({jsonrpc: '2.0', id: 6, method: 'tools/call', params: {name: 'codex_account_status', arguments: {host: 'raspberry'}}});
assert.equal(d.result.structuredContent.collection_error, 'account_route_unavailable');
const scoped = makeAccountRoute(async q => ({jsonrpc: '2.0', id: q.id, result: {content: [{type: 'text', text: 'task_scope_refused'}], isError: true}}), async () => limited);
const s2 = await scoped({jsonrpc: '2.0', id: 7, method: 'tools/call', params: {name: 'codex_task_create', arguments: {}}});
assert.equal(JSON.parse(s2.result.content[1].text).likely_reason, null);
for (const name of ['codex_thread_send', 'codex_repair_submit']) {
  const r = await makeAccountRoute(async q => ({jsonrpc: '2.0', id: q.id, result: {content: [{type: 'text', text: 'task_rpc_unconfirmed'}], isError: true}}), async () => limited)(
    {jsonrpc: '2.0', id: 8, method: 'tools/call', params: {name, arguments: {}}});
  assert.equal(JSON.parse(r.result.content[1].text).likely_reason, 'codex_usage_limit_reached', name);
}
console.log('codex account route: 14 checks passed');
