// Only the trusted local collector unit executes this, never an MCP tool.
// collectDefault runs in this process to avoid a second Node runtime in the
// 64 MiB unit; its pure injected collect API and snapshot schema remain intact.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { project, MAX_BYTES } from './core.mjs';
import { collectDefault } from './collect.mjs';
const directory = '/run/raspberry-mcp';
const temporaryFor = pid => `${directory}/snapshot.${pid}.tmp`;
const monotonicMs = () => Number(process.hrtime.bigint()) / 1e6;
const elapsed = start => Math.max(0, Math.min(15000, Math.floor(monotonicMs() - start)));
const phases = new Set(['collect', 'project', 'serialize', 'temporary_write', 'rename']);
const failures = new Set(['collector_failure', 'docker_timeout', 'docker_failed', 'docker_budget_exhausted']);

export function serializeSnapshot(snapshot, maxBytes = MAX_BYTES) {
  const output = JSON.stringify(project(snapshot));
  if (Buffer.byteLength(output) > maxBytes) throw Error('snapshot_bound');
  return output;
}

export function diagnosticLine({phase, failure_class, elapsed_ms, docker_calls = 0,
  docker_timeouts = 0, docker_failures = 0, docker_elapsed_ms = 0,
  docker_budget_exhausted = false, backup_read_ms = null, disk_stat_ms = null}) {
  const row = {schema_version: 1, source: 'mcp_collection_phase_v1',
    phase: phases.has(phase) ? phase : 'collect',
    failure_class: failures.has(failure_class) ? failure_class : 'collector_failure',
    elapsed_ms: Number.isSafeInteger(elapsed_ms) ? Math.max(0, Math.min(15000, elapsed_ms)) : 0,
    docker_calls: Number.isSafeInteger(docker_calls) ? Math.max(0, Math.min(6, docker_calls)) : 0,
    docker_timeouts: Number.isSafeInteger(docker_timeouts) ? Math.max(0, Math.min(6, docker_timeouts)) : 0,
    docker_failures: Number.isSafeInteger(docker_failures) ? Math.max(0, Math.min(6, docker_failures)) : 0,
    docker_elapsed_ms: Number.isSafeInteger(docker_elapsed_ms) ? Math.max(0, Math.min(8000, docker_elapsed_ms)) : 0,
    docker_budget_exhausted: docker_budget_exhausted === true,
    backup_read_ms: Number.isSafeInteger(backup_read_ms) ? Math.max(0, Math.min(15000, backup_read_ms)) : null,
    disk_stat_ms: Number.isSafeInteger(disk_stat_ms) ? Math.max(0, Math.min(15000, disk_stat_ms)) : null};
  const line = JSON.stringify(row);
  if (Buffer.byteLength(line) > 768) throw Error('diagnostic_frame_limit');
  return line + '\n';
}

// Optional dependencies are fixed defaults; tests inject only memory fakes.
// All production file paths remain constants and exceptions are never copied.
export function publishOnce({collect = collectDefault, writeFile = fs.writeFileSync,
  rename = fs.renameSync, unlink = fs.unlinkSync, writeError = text => process.stderr.write(text),
  pid = process.pid} = {}) {
  const start = monotonicMs();
  const temporary = temporaryFor(pid);
  let phase = 'collect', diagnostics = null;
  let published = false;
  try {
    const result = collect();
    diagnostics = result?.diagnostics ?? null;
    phase = 'project';
    const output = serializeSnapshot(result?.snapshot);
    phase = 'serialize';
    phase = 'temporary_write';
    writeFile(temporary, output, {flag: 'wx', mode: 0o640});
    phase = 'rename';
    rename(temporary, `${directory}/snapshot.json`);
    published = true;
    if (diagnostics && (diagnostics.docker_failures > 0 || diagnostics.docker_timeouts > 0)) {
      try {
        writeError(diagnosticLine({...diagnostics, phase: 'collect',
          failure_class: diagnostics.docker_budget_exhausted ? 'docker_budget_exhausted' :
            diagnostics.docker_timeouts > 0 ? 'docker_timeout' : 'docker_failed',
          elapsed_ms: diagnostics.elapsed_ms}));
      } catch { /* diagnostics after atomic publication cannot invalidate the snapshot */ }
    }
    return 0;
  } catch {
    if (published) return 0;
    try { unlink(temporary); } catch { /* fixed temp cleanup is best-effort */ }
    writeError('collector_failed\n');
    try {
      writeError(diagnosticLine({...diagnostics, phase,
        failure_class: diagnostics?.docker_budget_exhausted ? 'docker_budget_exhausted' :
          diagnostics?.docker_timeouts > 0 ? 'docker_timeout' : 'collector_failure',
        elapsed_ms: elapsed(start)}));
    } catch { /* never replace the fixed failure marker with detail */ }
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = publishOnce();
}
