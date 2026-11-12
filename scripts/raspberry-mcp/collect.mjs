// Manual one-shot collector. `collect` remains pure/injected; collectDefault
// binds only the fixed local Docker socket, backup result and filesystem root.
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { SERVICES, project } from './core.mjs';

const ROOT = '/mnt/data/docker';
const MAX_COMMAND_MS = 1500;
export const DOCKER_TOTAL_BUDGET_MS = 8000;
const INSPECT_FORMAT = '{{json .State.Status}}|{{if .State.Health}}{{json .State.Health.Status}}{{else}}"not_configured"{{end}}|{{json .Config.Image}}|{{json (index .Config.Labels "io.hass.version")}}|{{json (index .Config.Labels "org.opencontainers.image.version")}}|{{json (index .Config.Labels "org.label-schema.version")}}';
const monotonicMs = () => Number(process.hrtime.bigint()) / 1e6;
const elapsed = (start, now) => Math.min(DOCKER_TOTAL_BUDGET_MS, Math.max(0, Math.floor(now() - start)));

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

// Only the collector's two fixed Docker forms and fixed service allowlist pass.
// This exported seam keeps the shared deadline mechanically testable; it does
// not open a socket or accept a path/command from a caller.
export function createBudgetedDockerRunner(invoke, now = monotonicMs, diagnostics = null) {
  if (typeof invoke !== 'function' || typeof now !== 'function') throw Error('fixed_runner_required');
  const started = now();
  const stats = diagnostics ?? {docker_calls: 0, docker_timeouts: 0, docker_failures: 0,
    docker_elapsed_ms: 0, docker_budget_exhausted: false, last_docker_failure: null};
  return args => {
    const service = Array.isArray(args) ? args.at(-1) : null;
    const allowed = SERVICES.includes(service) && (
      args.length === 4 && args[0] === 'inspect' && args[1] === '--format' && args[2] === INSPECT_FORMAT ||
      args.length === 6 && args[0] === 'logs' && args[1] === '--since' && args[2] === '15m' &&
        args[3] === '--tail' && args[4] === '100');
    if (!allowed) throw Error('fixed_docker_request_refused');
    const remaining = DOCKER_TOTAL_BUDGET_MS - (now() - started);
    const timeout = Math.min(MAX_COMMAND_MS, Math.floor(remaining));
    if (timeout < 1) {
      stats.docker_budget_exhausted = true;
      stats.docker_failures += 1;
      stats.last_docker_failure = 'total_budget_exhausted';
      throw Error('docker_total_budget_exhausted');
    }
    stats.docker_calls += 1;
    const before = now();
    try {
      return invoke(args, timeout);
    } catch (error) {
      stats.docker_failures += 1;
      if (error?.code === 'ETIMEDOUT' || error?.code === 'docker_command_timeout') {
        stats.docker_timeouts += 1;
        stats.last_docker_failure = 'command_timeout';
      } else if (error?.code === 'docker_command_failed') {
        stats.last_docker_failure = 'command_failed';
      } else {
        stats.last_docker_failure = 'spawn_failed';
      }
      throw Error('docker_unavailable');
    } finally {
      stats.docker_elapsed_ms += Math.max(0, Math.min(timeout, now() - before));
    }
  };
}

export function collect(run, read, disk) {
  const source = { observed_at: new Date().toISOString(), services: [], logs: [], backups: {} };
  for (const service of SERVICES) {
    try {
      const [state, health, image, ...labels] = run(['inspect', '--format', INSPECT_FORMAT, service]).trim().split('|').map(x => JSON.parse(x));
      source.services.push({service, state, health, version: [...labels, image.split(':').at(-1)].find(x => typeof x === 'string' && /^\d{1,4}\.\d{1,4}(?:\.\d{1,4})?$/.test(x))});
    } catch { source.services.push({service}); }
    try { source.logs.push(logSummary(service, run(['logs', '--since', '15m', '--tail', '100', service]))); }
    catch { source.logs.push({service, status: 'unavailable'}); }
  }
  try { source.backups.git = backupResult(read()); } catch { /* unknown */ }
  try { source.disk = disk(); } catch { /* unknown */ }
  return project(source);
}

function fixedDocker(args, timeout) {
  const result = spawnSync('/usr/bin/docker', args, {timeout, killSignal: 'SIGKILL', maxBuffer: 65536,
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: {PATH: '/usr/bin:/bin', DOCKER_HOST: 'unix:///var/run/docker.sock'}});
  if (result.error) {
    const error = Error('docker_unavailable');
    error.code = result.error.code === 'ETIMEDOUT' ? 'ETIMEDOUT' : 'docker_spawn_failed';
    throw error;
  }
  if (result.status !== 0) {
    const error = Error('docker_unavailable'); error.code = 'docker_command_failed'; throw error;
  }
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

const safeElapsed = value => Number.isFinite(value) ? Math.max(0, Math.min(15000, Math.floor(value))) : null;
export function collectDefault() {
  const started = monotonicMs();
  const diagnostics = {schema_version: 1, source: 'mcp_collection_phase_v1',
    phase: 'collect', elapsed_ms: 0, docker_calls: 0, docker_timeouts: 0,
    docker_failures: 0, docker_elapsed_ms: 0, docker_budget_exhausted: false,
    last_docker_failure: null, backup_read_ms: null, disk_stat_ms: null};
  const run = createBudgetedDockerRunner((args, timeout) => fixedDocker(args, timeout), monotonicMs, diagnostics);
  const timed = (field, fn) => {
    const before = monotonicMs();
    try { return fn(); }
    finally { diagnostics[field] = safeElapsed(monotonicMs() - before); }
  };
  const snapshot = collect(run,
    () => timed('backup_read_ms', readBackup),
    () => timed('disk_stat_ms', () => {
      const disk = fs.statfsSync(ROOT);
      return {total_bytes: disk.blocks * disk.bsize, available_bytes: disk.bavail * disk.bsize};
    }));
  diagnostics.phase = 'complete';
  diagnostics.elapsed_ms = safeElapsed(monotonicMs() - started);
  diagnostics.docker_elapsed_ms = safeElapsed(diagnostics.docker_elapsed_ms);
  return {snapshot, diagnostics};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // CLI stdout stays byte-compatible with the historical projected snapshot.
  process.stdout.write(JSON.stringify(collectDefault().snapshot) + '\n');
}
