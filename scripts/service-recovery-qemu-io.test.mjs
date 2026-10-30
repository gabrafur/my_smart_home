import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

test('fixed VM disk worker profile preserves the existing sandbox and limits', () => {
  const r = spawnSync('python3', ['-I', '-S', '-B', '-m', 'unittest', 'discover',
    '-s', fileURLToPath(new URL('../restore/', import.meta.url)), '-p', 'test_qemu_io.py'],
  {encoding: 'utf8', timeout: 10000, maxBuffer: 32768});
  assert.equal(r.error, undefined);assert.equal(r.status, 0, r.stdout+r.stderr);
  assert.match(r.stderr, /Ran 5 tests/);
});
