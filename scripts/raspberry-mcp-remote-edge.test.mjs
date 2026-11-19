import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

for (const directory of ['scripts/raspberry-mcp/portable-http', 'scripts/raspberry-mcp/remote-edge']) {
  test(`loopback MCP transport and OAuth edge tests: ${directory}`, () => {
    const result = spawnSync('python3', ['-B', '-m', 'unittest', 'discover', '-s', directory, '-p', 'test_*.py'], {
      cwd: fileURLToPath(new URL('../', import.meta.url)), encoding: 'utf8',
      timeout: 60000, maxBuffer: 65536,
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.error, undefined);
  });
}
