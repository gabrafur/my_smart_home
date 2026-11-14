import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

test('cloud rollback Python regressions use synthetic backends and files', () => {
  const result=spawnSync('python3', [
    '-I', '-S', '-B', '-m', 'unittest', 'discover',
    '-s', fileURLToPath(new URL('./', import.meta.url)),
    '-p', 'test_rollback_cloud_*.py',
  ], {encoding:'utf8', timeout:30_000, maxBuffer:128*1024});
  assert.equal(result.status,0,result.stdout+result.stderr);
  assert.match(result.stderr,/Ran \d+ tests/);
  assert.doesNotMatch(result.stderr,/skipped=/);
});
