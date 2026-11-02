import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

test('bounded task observer rejects unregistered queries and source drift', () => {
  const directory = fileURLToPath(new URL('./runtime-source/task-terminal-observer/', import.meta.url));
  const result = spawnSync('python3', ['-I', '-S', '-B', '-m', 'unittest', 'discover',
    '-s', directory, '-p', 'test_*.py'], {encoding: 'utf8', timeout: 10000, maxBuffer: 65536});
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Ran 13 tests/);
});
