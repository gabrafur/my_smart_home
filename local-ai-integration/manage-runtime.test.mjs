import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadLock, validateLock, verifyInstalled } from './manage-runtime.mjs';

test('accepts only the immutable canonical release coordinates', () => {
  const lock = loadLock();
  assert.deepEqual(validateLock(lock), []);
  assert.match(lock.commit, /^[0-9a-f]{40}$/);
  assert.match(lock.asset_sha256, /^[0-9a-f]{64}$/);
  assert.equal(lock.asset_url, `${lock.repository}/releases/download/${lock.tag}/local-ai-rtx-${lock.version}.tar.gz`);
  assert.ok(validateLock({ ...lock, asset_url: 'https://example.invalid/release.tar.gz' }).includes('unexpected_asset_url'));
});
test('verifies the installed runtime contract and required files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-ai-rtx-contract-'));
  try {
    const lock = loadLock();
    fs.mkdirSync(path.join(root, 'contracts'));
    fs.writeFileSync(path.join(root, 'contracts', 'runtime-manifest.json'), JSON.stringify({
      name: 'local-ai-rtx', runtime_version: lock.version, mcp: { server_name: 'local-ai-rtx' },
    }));
    fs.writeFileSync(path.join(root, 'VERSION'), `${lock.version}\n`);
    for (const filename of ['mcp_server.py', 'local-ai.py', 'post_tool_routing.py', 'model-registry.json']) {
      fs.writeFileSync(path.join(root, filename), 'fixture\n');
    }
    assert.deepEqual(verifyInstalled(root, lock), []);
    fs.unlinkSync(path.join(root, 'mcp_server.py'));
    assert.ok(verifyInstalled(root, lock).includes('runtime_file_missing:mcp_server.py'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
