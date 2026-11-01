// Trusted harness, executed only in the existing unprivileged no-network jail.
// node:vm is used for determinism here, not as the security boundary.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {pathToFileURL} from 'node:url';
export function probeReset(rows) {
  const node = rows.find(n => n.id === 'host_obs_test_build');
  assert.equal(node?.type, 'function');
  assert.equal(node.z, 'host_observer_tab');
  assert.equal(typeof node.func, 'string');
  assert.ok(Buffer.byteLength(node.func) <= 131072);
  const result = vm.runInNewContext(`(() => {
    const values = new Map(); let statuses = 0, effects = 0;
    const msg = {_host_observer_test: true, payload: 'reset'};
    const flow = {get(k) { return values.get(k); }, set(k,v) { values.set(k,v); }};
    const node = {status() {statuses++;}, error() {effects++;}, warn() {effects++;},
      send() {effects++;}, log() {effects++;}};
    const returned = (function(msg,flow,node){${node.func}\n})(msg,flow,node);
    return {statuses, effects, returned_null: returned === null,
      production_keys_written: [...values.keys()].filter(k => !k.endsWith('__test')).length};
  })()`, Object.create(null), {timeout: 100, contextCodeGeneration: {strings: false, wasm: false}});
  assert.equal(result.effects, 0);
  assert.equal(result.returned_null, true);
  assert.equal(result.production_keys_written, 0);
  return {schema_version: 1, source: 'isolated_exact_loaded_candidate_reset_probe',
    function_sha256: crypto.createHash('sha256').update(node.func).digest('hex'),
    status_callbacks: result.statuses, passed: result.statuses === 0,
    external_effects: 0, production_context_writes: 0,
    observed_at: Date.now() / 1000,
    coverage: ['host_observer_test_reset_status_isolation'],
    native_full_flow_replay: false, physical_health: 'unknown'};
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assert.equal(process.argv.length, 2);
  const after = probeReset(JSON.parse(fs.readFileSync('/workspace/nodered/flows.json', 'utf8')));
  assert.equal(after.passed, true);
  process.stdout.write(JSON.stringify(after) + '\n');
}
