import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

test('metadata reader protocol, conservation, persistence and ownership fixtures', t => {
  const suite=fileURLToPath(new URL('./runtime-source/mqtt-observation/',import.meta.url));
  const result=spawnSync('python3',['-I','-S','-B','-m','unittest','discover','-s',suite,'-p','test_*.py'],{
    // More than 400 socket/process fixtures share this outer budget. Their
    // individual protocol deadlines still detect stalled operations.
    encoding:'utf8',timeout:90_000,maxBuffer:131072,
  });
  assert.equal(result.error,undefined);
  assert.equal(result.status,0,result.stderr);
  assert.match(result.stderr,/Ran \d+ tests/);
  const skipped=/skipped=(\d+)/.exec(result.stderr);
  if(skipped)t.diagnostic(`${skipped[1]} ownership fixtures require an isolated Root runner; this suite never escalates.`);
});
