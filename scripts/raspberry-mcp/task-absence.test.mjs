import assert from 'node:assert/strict';
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {makeTaskAbsenceRoute} from './task-absence/task-absence-route.mjs';

const id = 'a'.repeat(32);
const call = (kind, name = 'codex_task_status') => ({jsonrpc: '2.0', id: 7, method: 'tools/call', params: {name, arguments: {host: 'raspberry', kind, operation_id: id}}});
const error = text => ({jsonrpc: '2.0', id: 7, result: {isError: true, content: [{type: 'text', text}]}});
const via = (response, request) => makeTaskAbsenceRoute(async () => response)(request);

for (const [reason, kind] of [['task_not_found', 'creation'], ['send_not_found', 'turn']]) {
  const r = await via(error(reason), call(kind));
  assert.equal(r.result.isError, false);
  const v = r.result.structuredContent;
  assert.deepEqual(JSON.parse(r.result.content[0].text), v);
  assert.equal(v.state, 'absent'); assert.equal(v.reason, reason); assert.equal(v.operation_id, id);
  // Absence never authorizes an effect or a retry.
  assert.equal(v.new_task_authorized, false); assert.equal(v.automatic_retry, false);
}
// Refusals, uncertainty, mismatched kinds, other tools and successes pass through untouched.
for (const [response, request] of [
  [error('invalid_task_identifier'), call('creation')], [error('operation_unavailable'), call('creation')],
  [error('task_not_found'), call('turn')], [error('send_not_found'), call('creation')],
  [error('task_not_found'), call('creation', 'codex_task_send')],
  [{jsonrpc: '2.0', id: 7, result: {structuredContent: {state: 'created'}}}, call('creation')],
  [{jsonrpc: '2.0', id: 7, error: {code: -32602, message: 'x'}}, call('creation')],
]) assert.equal(await via(response, request), response);
const listed = {jsonrpc: '2.0', id: 1, result: {tools: []}};
assert.equal(await via(listed, {jsonrpc: '2.0', id: 1, method: 'tools/list'}), listed);

// The operator pins exactly the reviewed sources of this repository.
const here = fileURLToPath(new URL('.', import.meta.url));
const check = spawnSync('python3', ['-B', here + 'task-absence/install.py', 'selftest'], {encoding: 'utf8'});
assert.equal(check.status, 0, check.stderr);
assert.equal(JSON.parse(check.stdout).state, 'sources_match');
console.log('task absence route: typed absence, untouched refusals and pinned sources passed');
