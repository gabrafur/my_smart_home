import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

for (const directory of [new URL('.', import.meta.url),
    new URL('../raspberry-mcp/procmon-observability/', import.meta.url),
    new URL('../raspberry-mcp/runtime-source/repair-control/', import.meta.url),
    new URL('../raspberry-mcp/runtime-source/native-events/', import.meta.url)]) {
  test(`isolated Python regressions: ${fileURLToPath(directory)}`, () => {
    const result = spawnSync('python3', ['-B', '-m', 'unittest', 'discover',
      '-s', fileURLToPath(directory), '-p', 'test_*.py'], {
      encoding: 'utf8', timeout: 30_000, maxBuffer: 65536,
      env: {...process.env, PYTHONDONTWRITEBYTECODE: '1'},
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.error, undefined);
  });
}
