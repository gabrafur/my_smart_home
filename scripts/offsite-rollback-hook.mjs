import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

export function runRollbackCloudContinuation({root, run = spawnSync} = {}) {
  const policyFile = path.join(root, '.local-secrets/rollback-cloud-daily.json');
  if (!fs.existsSync(policyFile)) return {state: 'not_configured', retired: 0};
  const result = run('/usr/bin/python3', ['-I', '-S', '-B', path.join(root, 'scripts/rollback_cloud_daily.py')], {
    cwd: root, encoding: 'utf8', timeout: 45 * 60 * 1000, maxBuffer: 65536,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0 || result.error) {
    return {state: 'uncertain', reason: 'inspect_same_daily_receipts', retired: 0, automatic_retry: false};
  }
  try {
    const row = JSON.parse(result.stdout);
    if (!['observed', 'deferred', 'blocked'].includes(row.state)
        || !Number.isInteger(row.retired) || row.retired < 0 || row.retired > 2) throw Error();
    return {state: row.state, retired: row.retired, compressed_bytes: row.compressed_bytes ?? 0,
      blocked: Array.isArray(row.blocked) ? row.blocked.length : 0,
      reason: typeof row.reason === 'string' && /^[a-z][a-z0-9_]{0,95}$/.test(row.reason) ? row.reason : 'none',
      automatic_retry: false};
  } catch {
    return {state: 'uncertain', reason: 'inspect_same_daily_receipts', retired: 0, automatic_retry: false};
  }
}
