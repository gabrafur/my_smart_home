const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const test = require('node:test');

const { runLocalAiMcpStatus } = require('./local-ai-mcp-health');

test('runs status through an actual MCP JSON-RPC exchange', async () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-ai-mcp-health-'));
  fs.writeFileSync(path.join(runtimeDir, 'mcp_server.py'), '# fixture\n');
  let stdin = '';
  const spawnImpl = (command, args, options) => {
    assert.equal(command, '/usr/bin/python3');
    assert.deepEqual(args, [path.join(runtimeDir, 'mcp_server.py')]);
    assert.equal(options.cwd, runtimeDir);
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stdin = new PassThrough();
    child.stdin.on('data', (chunk) => { stdin += chunk; });
    child.stdin.on('finish', () => {
      const requests = stdin.trim().split(/\n/).map(JSON.parse);
      assert.equal(requests.at(-1).params.name, 'local_ai_status');
      child.stdout.end(`${JSON.stringify({ jsonrpc: '2.0', id: 2, result: { structuredContent: { state: 'LOCAL_AI_AVAILABLE', available: true } } })}\n`);
      child.emit('close', 0);
    });
    child.kill = () => {};
    return child;
  };
  try {
    const result = await runLocalAiMcpStatus({ runtimeDir, spawnImpl, timeoutMs: 1_000 });
    assert.equal(result.state, 'LOCAL_AI_AVAILABLE');
  } finally {
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
});
