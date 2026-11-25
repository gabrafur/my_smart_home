import assert from 'node:assert/strict';
import test from 'node:test';
import {makeObservationRoute} from './observation-route.mjs';
import {makeTaskAbsenceRoute} from './task-absence/task-absence-route.mjs';

const request = (name, args = {}) => ({
  jsonrpc: '2.0', id: 7, method: 'tools/call', params: {name, arguments: {host: 'raspberry', ...args}},
});
const refusal = text => ({jsonrpc: '2.0', id: 7, result: {isError: true, content: [{type: 'text', text}]}});

test('preserves true absence in the same envelope as a known task receipt', async () => {
  const route = makeObservationRoute(makeTaskAbsenceRoute(async () => refusal('task_not_found')));
  const result = (await route(request('codex_task_status', {kind: 'creation', operation_id: 'a'.repeat(32)}))).result;
  assert.equal(result.structuredContent.state, 'absent');
  assert.equal(result.structuredContent.reason, 'task_not_found');
  assert.equal(result.structuredContent.new_task_authorized, false);
  assert.equal(Object.hasOwn(result, 'isError'), false);
});

test('returns separate sanitized refusals for reads and preserves write errors', async () => {
  for (const [name, reason, state] of [
    ['codex_task_status', 'task_v2_source_changed', 'unknown'],
    ['codex_thread_read', 'control_lease_expired', 'access_denied'],
    ['nodered_admin_read', 'metadata_closed_response_required', 'unavailable'],
    ['nodered_admin_read', 'nodered_admin_parameters_refused', 'invalid_request'],
    ['project_read', 'local_changes_detected', 'unavailable'],
  ]) {
    const route = makeObservationRoute(async () => refusal(reason));
    const data = (await route(request(name))).result.structuredContent;
    assert.equal(data.state, state);
    assert.equal(data.reason, state === 'unknown' ? 'observation_unconfirmed' : reason);
  }
  const writeError = refusal('metadata_closed_response_required');
  const route = makeObservationRoute(async () => writeError);
  assert.equal(await route(request('nodered_admin_apply')), writeError);
});

test('incident lookup rejects extra fields and forwards only the exact read request', async () => {
  const calls = [];
  const route = makeObservationRoute(async () => ({result: {tools: []}}), async call => {
    calls.push(call);
    return {state: 'found'};
  });
  const catalogue = await route({method: 'tools/list'});
  assert.equal(catalogue.result.tools[0].annotations.readOnlyHint, true);
  const args = {object_id: 'a'.repeat(64), revision: 'b'.repeat(64)};
  for (const bad of [{...args, path: '/elsewhere'}, {...args, revision: 'b'.repeat(32)}]) {
    const result = await route(request('codex_task_find_incident', bad));
    assert.equal(result.result.structuredContent.state, 'invalid_request');
  }
  const result = await route(request('codex_task_find_incident', args));
  assert.equal(result.result.structuredContent.state, 'found');
  assert.deepEqual(calls, [{name: 'codex_task_find_incident', arguments: {host: 'raspberry', ...args}}]);
});
