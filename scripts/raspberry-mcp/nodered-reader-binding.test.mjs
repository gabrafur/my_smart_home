import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const folder = new URL('./runtime-source/nodered-reader-binding/', import.meta.url);
test('closed reader binding covers lifecycle, protected files and synthetic transports', () => {
  const result = spawnSync('python3', ['-I', '-S', '-B', '-m', 'unittest', 'discover',
    '-s', fileURLToPath(folder), '-p', 'test_*.py'], {
    encoding: 'utf8', timeout: 15000, maxBuffer: 131072,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const count = result.stderr.match(/Ran (\d+) tests?/);
  assert.ok(count, result.stderr);
  assert.ok(Number(count[1]) >= 177, result.stderr);
});

test('frontend preserves prior tools while exposing the fixed revocation pair', () => {
  const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1',
    fileURLToPath(new URL('test_binding_route.mjs', folder))], {
    encoding: 'utf8', timeout: 10000, maxBuffer: 65536,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('export preserves capture provenance and declares reviewed updates', () => {
  const map = JSON.parse(fs.readFileSync(new URL('./runtime-source/SOURCE-MAP.json', import.meta.url)));
  const entries = Object.entries(map.files).filter(([name]) => name.startsWith('nodered-reader-binding/'));
  assert.equal(entries.length, 8);
  const reviewedUpdates = {
  "controller.py": {
    "source_sha256": "8132b908d74d584802d9e1f6281e78e9a65cbde0f82543b7f5a90ec157d7621d",
    "normalization": "reviewed_reference_update_server_incident_correlation_and_duplicate_guard;not_original_captured_runtime_bytes"
  },
  "runtime.py": {
    "source_sha256": "34c98eb8b2619bc25d48016b96917da8be91275e673c627cc04e48e935922421",
    "normalization": "reviewed_reference_update_incident_correlation_discovery;not_original_captured_runtime_bytes"
  },
  "server.py": {
    "source_sha256": "f1c8ce5394a8bb3fafb94476ccc6b63dc4716cb2e9841684f0a8a9e4fe6535a3",
    "normalization": "reviewed_reference_update_closed_incident_refusal_codes;not_original_captured_runtime_bytes"
  }
};
  for (const [name, row] of entries) {
    const bytes = fs.readFileSync(new URL('./runtime-source/' + name, import.meta.url));
    const digest = crypto.createHash('sha256').update(bytes).digest('hex');
    assert.equal(digest, row.export_sha256);
    const declared = reviewedUpdates[name.split('/').at(-1)];
    if (declared) {
      assert.equal(row.source_sha256, declared.source_sha256);
      assert.deepEqual(row.normalizations, [declared.normalization]);
      assert.notEqual(digest, row.source_sha256);
    } else {
      assert.equal(digest, row.source_sha256);
      assert.deepEqual(row.normalizations, []);
    }
    assert.equal(row.native_owner_uid, 0);
    assert.equal(row.native_mode, '0644');
  }
  for (const name of ['approval.json', 'ledger.json', 'operation.lock', 'revoked']) {
    assert.equal(fs.existsSync(new URL(name, folder)), false);
  }
});
