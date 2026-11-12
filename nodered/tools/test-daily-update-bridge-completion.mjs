import assert from 'node:assert/strict';
import fs from 'node:fs';

const flows = JSON.parse(fs.readFileSync(new URL('../flows.json', import.meta.url)));
const completion = flows.filter(n => n.z === 'daily_host_updates_tab' && n.func?.includes('daily_update_bridge_exit_failed'));
assert(completion.length > 10, 'exercise every generated completion handler');
for (const n of completion) {
  const run = new Function('msg', 'node', n.func);
  for (const payload of [0, {code: 0}]) {
    run({payload}, {status: () => {}, error: () => assert.fail('successful command must be silent')});
  }
  for (const [payload, reason, code] of [
    [{code: 1}, 'exit_status', '1'],
    [{code: null, signal: 'SIGTERM', message: 'PRIVATE'}, 'interrupted', 'null'],
    [{code: 'ETIMEDOUT', message: 'PRIVATE'}, 'ETIMEDOUT', 'null'],
    [{code: 'ENOENT'}, 'ENOENT', 'null'],
    [{}, 'unknown_result', 'null'],
    [null, 'unknown_result', 'null'],
    [{code: 'PRIVATE', signal: 'PRIVATE'}, 'unknown_result', 'null'],
  ]) {
    const errors = [];
    const node = {status: () => {}, error: (message, msg) => errors.push({message, msg})};
    assert.equal(run({payload, _msgid: 'synthetic'}, node), null);
    assert.equal(errors.length, 1);
    assert(errors[0].message.includes('reason=' + reason));
    assert(errors[0].message.includes('code=' + code));
    assert.doesNotMatch(JSON.stringify(errors), /NaN|PRIVATE/);
    errors.length = 0;
    run({payload, _daily_update_test: true}, node);
    assert.equal(errors.length, 0, 'dry run must never notify');
  }
}
console.log('Daily update completion: numeric failure, signal, typed errors and unknown outcomes preserved without private payloads.');
