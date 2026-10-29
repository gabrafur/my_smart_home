import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

test('notice pin reconciliation preserves authority and refuses unreviewed drift', () => {
  const suite = fileURLToPath(new URL('./runtime-source/administrative-recovery/', import.meta.url));
  const result = spawnSync('python3', ['-I', '-S', '-B', '-m', 'unittest', 'discover',
    '-s', suite, '-p', 'test_notice_dependency_review.py'],
  {encoding: 'utf8', timeout: 10000, maxBuffer: 32768});
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Ran 12 tests/);
});
