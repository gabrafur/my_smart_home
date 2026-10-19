// Only the trusted local collector unit executes this, never an MCP tool.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { project, MAX_BYTES } from './core.mjs';
const directory = '/run/raspberry-mcp';
const temporary = `${directory}/snapshot.${process.pid}.tmp`;
try {
  const output = execFileSync('/usr/bin/node', ['/usr/local/lib/raspberry-mcp/collect.mjs'], {
    timeout: 12000, killSignal: 'SIGKILL', maxBuffer: MAX_BYTES, encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin' },
  });
  const bytes = JSON.stringify(project(JSON.parse(output)));
  fs.writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o640 });
  fs.renameSync(temporary, `${directory}/snapshot.json`);
} catch {
  try { fs.unlinkSync(temporary); } catch { /* no leftover */ }
  process.stderr.write('collector_failed\n');
  process.exitCode = 1;
}
