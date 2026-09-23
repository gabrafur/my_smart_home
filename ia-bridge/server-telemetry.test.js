const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const vm = require('node:vm');
const test = require('node:test');

// Execute the actual HTTP callback with synthetic readers, without booting CLIs,
// touching session history, or probing external services.
const source = fs.readFileSync(require.resolve('./server'), 'utf8');
const callback = source.slice(source.indexOf('const server = http.createServer('),
  source.indexOf('\nensureClaudeWorkspaceTrust();'));

test('telemetry failures return JSON 500 and leave the bridge healthy', async (t) => {
  let failure = 'permission';
  const read = () => {
    if (failure === 'permission') throw Object.assign(new Error('synthetic access denied'), { code: 'EACCES' });
    if (failure === 'serialization') { const value = {}; value.self = value; return value; }
    return { status: 'ok' };
  };
  const server = vm.runInNewContext(`${callback}\nserver;`, {
    http, URL, console: { error() {} },
    codexUsage: { read, readLocalAiLive: read, readLocalAiHistory: read },
    codexRateLimits: { readEvent: () => null },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const mode of ['permission', 'serialization', null]) {
    failure = mode;
    for (const route of ['/usage', '/local-ai/live', '/local-ai/history']) {
      const response = await fetch(base + route);
      assert.equal(response.status, mode ? 500 : 200);
      assert.equal((await response.json()).status, mode ? 'error' : 'ok');
      assert.equal((await fetch(base + '/health')).status, 200);
    }
  }
});
