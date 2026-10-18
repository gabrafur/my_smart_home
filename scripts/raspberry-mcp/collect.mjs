// Manual one-shot collector; never imported/executed by the MCP server.
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { SERVICES, project } from './core.mjs';
const ROOT = '/mnt/data/docker';
export function logSummary(service, text) {
  const lines = text.split('\n').filter(Boolean).slice(-100);
  return { service, status: 'sampled', sampled_lines: lines.length,
    error_lines: lines.filter(x => /\b(error|fatal|exception)\b/i.test(x)).length,
    warning_lines: lines.filter(x => /\bwarn(?:ing)?\b/i.test(x)).length };
}
export function backupResult(text) {
  const fields = Object.fromEntries(text.split('\n').map(line => line.split('=', 2)));
  return { status: fields.status, finished_at: fields.finished_at };
}
export function collect(run, read, disk) {
  const source = { observed_at: new Date().toISOString(), services: [], logs: [], backups: {} };
  for (const service of SERVICES) {
    try {
      const [state, health, image, ...labels] = run(['inspect', '--format', '{{json .State.Status}}|{{if .State.Health}}{{json .State.Health.Status}}{{else}}"not_configured"{{end}}|{{json .Config.Image}}|{{json (index .Config.Labels "io.hass.version")}}|{{json (index .Config.Labels "org.opencontainers.image.version")}}|{{json (index .Config.Labels "org.label-schema.version")}}', service]).trim().split('|').map(x => JSON.parse(x));
      source.services.push({service, state, health, version: [...labels, image.split(':').at(-1)].find(x => typeof x === 'string' && /^\d{1,4}\.\d{1,4}(?:\.\d{1,4})?$/.test(x))});
    } catch { source.services.push({service}); }
    try { source.logs.push(logSummary(service, run(['logs', '--since', '15m', '--tail', '100', service]))); }
    catch { source.logs.push({service, status: 'unavailable'}); }
  }
  try { source.backups.git = backupResult(read()); } catch { /* unknown */ }
  try { source.disk = disk(); } catch { /* unknown */ }
  return project(source);
}
function runDocker(args) {
  const result = spawnSync('/usr/bin/docker', args, { timeout: 1500, killSignal: 'SIGKILL', maxBuffer: 65536, encoding: 'utf8', stdio: ['ignore','pipe','pipe'], env: { PATH: '/usr/bin:/bin', DOCKER_HOST: 'unix:///var/run/docker.sock' } });
  if (result.error || result.status !== 0) throw Error('unavailable');
  return args[0] === 'logs' ? result.stdout + result.stderr : result.stdout;
}
function readBackup() {
  const fd = fs.openSync(`${ROOT}/homeassistant/.git-backup-trigger/result`, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    if (!fs.fstatSync(fd).isFile()) throw Error('unavailable');
    const bytes = Buffer.alloc(4097), size = fs.readSync(fd, bytes, 0, bytes.length, 0);
    if (size > 4096) throw Error('unavailable');
    return bytes.subarray(0,size).toString('utf8');
  } finally { fs.closeSync(fd); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = collect(runDocker, readBackup, () => {
    const d = fs.statfsSync(ROOT);
    return { total_bytes: d.blocks*d.bsize, available_bytes: d.bavail*d.bsize };
  });
  process.stdout.write(JSON.stringify(result) + '\n');
}
