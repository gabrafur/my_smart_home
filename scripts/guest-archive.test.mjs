import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

test('isolated guest archive boundaries and authentication-before-seal regressions', () => {
  const result = spawnSync('python3', ['-B', '-m', 'unittest', 'discover',
    '-s', 'restore', '-p', 'test_guest_archive.py', '-v'], {
    cwd: fileURLToPath(new URL('../', import.meta.url)), encoding: 'utf8',
    timeout: 15000, maxBuffer: 16384,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.error, undefined);
});
