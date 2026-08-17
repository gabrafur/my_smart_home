const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  END_MARKER,
  START_MARKER,
  configureLocalAiMcp,
  replaceManagedBlock,
} = require('./configure-local-ai-mcp');

test('configures the Local AI MCP idempotently while preserving other settings', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'local-ai-mcp-'));
  const runtimeDir = path.join(directory, 'runtime');
  const configPath = path.join(directory, 'codex', 'config.toml');
  fs.mkdirSync(runtimeDir);
  fs.mkdirSync(path.dirname(configPath));
  fs.writeFileSync(path.join(runtimeDir, 'mcp_server.py'), '# test\n');
  fs.writeFileSync(configPath, 'model = "gpt-5.6-terra"\n');

  configureLocalAiMcp({ runtimeDir, configPath });
  const once = fs.readFileSync(configPath, 'utf8');
  configureLocalAiMcp({ runtimeDir, configPath });
  const twice = fs.readFileSync(configPath, 'utf8');

  assert.equal(twice, once);
  assert.match(twice, /model = "gpt-5\.6-terra"/);
  assert.equal((twice.match(new RegExp(START_MARKER, 'g')) || []).length, 1);
  assert.equal((twice.match(new RegExp(END_MARKER, 'g')) || []).length, 1);
  assert.match(twice, /default_tools_approval_mode = "auto"/);
  assert.equal(fs.statSync(configPath).mode & 0o777, 0o600);
});

test('refuses to overwrite an unmanaged Local AI MCP entry', () => {
  assert.throws(
    () => replaceManagedBlock('[mcp_servers.local-ai-rtx]\nenabled = true\n', 'managed'),
    /unmanaged local-ai-rtx/,
  );
});
