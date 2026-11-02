import test from 'node:test';
import assert from 'node:assert/strict';
import {makeBindingRoute, valid, actions, tools} from '../frontend/binding-route.mjs';

const legacyActions = ['nodered_plan_reader_binding', 'nodered_apply_reader_binding',
  'nodered_plan_restore_reader_binding', 'nodered_restore_reader_binding'];
const revoke = 'nodered_revoke_reader_binding';
const legacyTools = ['admin_action_apply', 'admin_action_status', 'admin_action_reconcile'];
const args = action => ({host: 'raspberry', action, idempotency_key: 'nodered-peer-' + 'a'.repeat(32)});
const call = (name, arguments_) => ({jsonrpc: '2.0', id: 42, method: 'tools/call', params: {name, arguments: arguments_, _meta: {fixture: true}}});

test('revoke pairs exclusively with revoke tool and all original action pairs remain valid', () => {
  assert.deepEqual(actions, [...legacyActions, revoke]);
  assert.deepEqual(tools, [...legacyTools, 'admin_action_revoke']);
  for (const name of legacyTools) {
    for (const action of legacyActions) assert.equal(valid(name, args(action)), true);
    assert.equal(valid(name, args(revoke)), false);
  }
  assert.equal(valid('admin_action_revoke', args(revoke)), true);
  for (const action of legacyActions) assert.equal(valid('admin_action_revoke', args(action)), false);
  for (const extra of [{path: '/fixture'}, {host: 'other'}, {idempotency_key: 'nodered-peer-' + 'A'.repeat(32)}])
    assert.equal(valid('admin_action_revoke', {...args(revoke), ...extra}), false);
  assert.equal(valid('admin_action_revoke', []), false);
  assert.equal(valid('other', args(revoke)), false);
});

test('valid binding requests dispatch once and preserve original name and audit identity', async () => {
  const pairs = [...legacyTools.flatMap(tool => legacyActions.map(action => [tool, action])), ['admin_action_revoke', revoke]];
  for (const [name, action] of pairs) {
    const request = call(name, args(action));
    const initial = structuredClone(request);
    const auditRows = []; let invoked = 0, dispatched = 0;
    const route = makeBindingRoute(() => {throw Error('unexpected prior');},
      async params => { invoked++; assert.deepEqual(params, request.params); return {state: 'fixture'}; },
      async (forwarded, second, audit, run) => {
        dispatched++; assert.equal(forwarded.params.name, 'project_files');
        assert.deepEqual(forwarded.params.arguments, request.params.arguments);
        assert.deepEqual(forwarded.params._meta, request.params._meta);
        assert.equal(second, undefined);
        audit({tool: 'project_files', outcome: 'fixture'}); return run();
      }, row => auditRows.push(row));
    assert.deepEqual(await route(request), {state: 'fixture'});
    assert.equal(invoked, 1); assert.equal(dispatched, 1);
    assert.deepEqual(auditRows, [{tool: name, outcome: 'fixture'}]);
    assert.deepEqual(request, initial);
  }
});

test('invalid binding and mismatched revocation pairs are rejected before any dispatch', async () => {
  const blocked = () => {throw Error('unexpected call');};
  const route = makeBindingRoute(blocked, blocked, blocked, blocked);
  const cases = [call('admin_action_apply', args(revoke)),
    ...legacyActions.map(action => call('admin_action_revoke', args(action))),
    call('admin_action_revoke', {...args(revoke), path: '/fixture'}),
    call('admin_action_revoke', {...args(revoke), host: 'other'}),
    call('admin_action_revoke', args('nodered_unrecognized'))];
  for (const request of cases) {
    const result = await route(request);
    assert.equal(result.id, request.id);
    assert.equal(result.result.isError, true);
    assert.equal(result.result.content[0].text, 'nodered_binding_scope_refused');
  }
});

test('notice, storage and other prior routes pass through unchanged', async () => {
  const seen = [];
  const blocked = () => {throw Error('unexpected binding dispatch');};
  const route = makeBindingRoute(async request => {seen.push(request); return {prior: request};}, blocked, blocked, blocked);
  for (const [name, action] of [['admin_action_apply', 'storage_plan_npm_logs'],
    ['admin_action_apply', 'migrate_two_notice_aliases'], ['admin_action_revoke', 'storage_revoke_example'],
    ['ha_notifications', undefined], ['events_status', undefined], ['maintenance_capabilities', undefined]]) {
    const request = call(name, action ? {...args(action)} : {host: 'raspberry'});
    const result = await route(request);
    assert.equal(seen.at(-1), request);
    assert.equal(result.prior, request);
  }
});

test('listing preserves annotations and prior schemas while restricting each action enum', async () => {
  const descriptors = [...tools, 'ha_notifications'].map(name => ({name, description: 'prior',
    inputSchema: {type: 'object', additionalProperties: false, properties: {original: {type: 'string'}}, required: ['original']},
    annotations: {readOnlyHint: false, destructiveHint: true, idempotentHint: false}}));
  const original = structuredClone(descriptors);
  const response = {result: {tools: descriptors}};
  const route = makeBindingRoute(async () => response, () => {}, () => {});
  assert.equal(await route({method: 'tools/list'}), response);
  assert.deepEqual(descriptors.map(row => row.name), original.map(row => row.name));
  for (const [index, descriptor] of descriptors.entries()) {
    assert.deepEqual(descriptor.annotations, original[index].annotations);
    if (!tools.includes(descriptor.name)) {assert.deepEqual(descriptor, original[index]); continue;}
    assert.deepEqual(descriptor.inputSchema.oneOf[0], original[index].inputSchema);
    const extension = descriptor.inputSchema.oneOf[1];
    assert.equal(extension.type, 'object'); assert.equal(extension.additionalProperties, false);
    assert.deepEqual(extension.required, ['host', 'action', 'idempotency_key']);
    assert.deepEqual(extension.properties.host, {const: 'raspberry'});
    assert.deepEqual(extension.properties.idempotency_key, {type: 'string', pattern: '^nodered-peer-[a-f0-9]{32}$'});
    assert.deepEqual(extension.properties.action.enum, descriptor.name === 'admin_action_revoke' ? [revoke] : legacyActions);
  }
});

test('missing schemas and upstream errors are left unchanged', async () => {
  const response = {result: {tools: [{name: 'admin_action_revoke', annotations: {destructiveHint: true}}]}};
  const expected = structuredClone(response);
  assert.deepEqual(await makeBindingRoute(async () => response, () => {}, () => {})({method: 'tools/list'}), expected);
  const failure = {result: {isError: true, content: [{type: 'text', text: 'upstream'}]}};
  assert.equal(await makeBindingRoute(async () => failure, () => {}, () => {})(call('ha_notifications', {})), failure);
});
