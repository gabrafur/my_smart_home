import fs from 'node:fs';
import {pathToFileURL} from 'node:url';

export const SERVICES = ['homeassistant', 'nodered', 'mosquitto', 'portainer',
  'appdaemon', 'matter_server', 'zigbee2mqtt', 'ai-bridge',
  'docs-review-scheduler', 'kia-uvo-codex-merge'];
export const UNITS = ['docker', 'procmon', 'mcp_collection', 'external_heartbeat',
  'events', 'ha_notices', 'host_observation'];
const ACTIONS = {docker: ['start', 'die', 'restart', 'destroy', 'health_status: healthy',
  'health_status: unhealthy', 'health_status: starting'], systemd: ['started', 'stopped', 'failed']};
export const METRICS = ['memory_available_bytes', 'memory_total_bytes', 'disk_used_percent',
  'inodes_used_percent', 'temperature_celsius', 'oom_kill_count', 'cpu_busy_percent'];
const sha = x => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
const stamp = x => typeof x === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(x) && Number.isFinite(Date.parse(x)) && new Date(x).toISOString().slice(0, 19) === x.slice(0, 19);
const count = x => Number.isSafeInteger(x) && x >= 0;
const need = x => { if (!x) throw new Error('invalid_observation'); };

export function projectObservation(value) {
  need(value && value.schema_version === 1 && value.source === 'fixed_readonly_host_observer');
  need(stamp(value.observed_at) && sha(value.instance_id) && sha(value.boot_id_sha256));
  need(count(value.sequence) && count(value.evicted_event_records) && value.evicted_event_records <= value.sequence);
  const sources = {};
  for (const name of ['docker', 'systemd']) {
    const row = value.sources?.[name];
    need(row && ['unknown', 'connected'].includes(row.state));
    need([null, 'starting', 'stream_unavailable_or_invalid'].includes(row.collection_error));
    need(row.state !== 'connected' || row.collection_error === null);
    sources[name] = {state: row.state, collection_error: row.collection_error};
  }
  need(Array.isArray(value.events) && value.events.length <= 64);
  const seen = new Set(); let sequence = 0;
  const events = value.events.map(row => {
    need(row && sha(row.id) && !seen.has(row.id)); seen.add(row.id);
    need(ACTIONS[row.source]?.includes(row.action));
    need((row.source === 'docker' ? SERVICES : UNITS).includes(row.service));
    need(count(row.sequence) && row.sequence > sequence && row.sequence <= value.sequence); sequence = row.sequence;
    need(stamp(row.occurred_at) && stamp(row.observed_at));
    const delay = Date.parse(row.observed_at) - Date.parse(row.occurred_at);
    need(delay >= -1000 && delay <= 60000 && Date.parse(row.observed_at) <= Date.parse(value.observed_at) + 1000);
    need(Number.isFinite(row.source_to_observer_ms) && row.source_to_observer_ms >= 0 &&
      Math.abs(row.source_to_observer_ms - Math.max(0, delay)) <= 2);
    return Object.fromEntries(['id', 'source', 'service', 'action', 'occurred_at',
      'observed_at', 'source_to_observer_ms', 'sequence'].map(key => [key, row[key]]));
  });
  const resource = value.resources;
  need(resource && stamp(resource.observed_at) && Date.parse(resource.observed_at) <= Date.parse(value.observed_at) + 1000);
  need(Array.isArray(resource.collection_errors) && resource.collection_errors.length <= 8 &&
    resource.collection_errors.every(x => [...METRICS, 'cpu_ticks'].includes(x)));
  const data = {};
  for (const metric of METRICS) {
    const x = resource.data?.[metric]; need(x === null || Number.isFinite(x) && x >= 0);
    if (x !== null && metric.endsWith('_percent')) need(x <= 100);
    if (x !== null && metric.endsWith('_bytes')) need(Number.isSafeInteger(x));
    if (x !== null && metric === 'oom_kill_count') need(Number.isSafeInteger(x));
    data[metric] = x;
  }
  return {schema_version: 1, source: value.source, observed_at: value.observed_at,
    instance_id: value.instance_id, boot_id_sha256: value.boot_id_sha256,
    sequence: value.sequence, evicted_event_records: value.evicted_event_records,
    sources, events, resources: {observed_at: resource.observed_at,
      data, collection_errors: [...resource.collection_errors]},
    coverage: ['allowlisted_current_stream_observations', 'partial_reconnect_and_ring_history',
      'not_initial_inventory_or_application_readiness', 'not_Eva_execution_PC_off_or_24h']};
}

export function safeMetadata(info, directory = false) {
  return (directory ? info.isDirectory() : info.isFile()) && info.uid === 0 && info.gid === 0 &&
    (info.mode & 0o7777) === (directory ? 0o755 : 0o644) && (directory || info.nlink === 1 && info.size <= 65536);
}

export function readFixedObservation() {
  // No client supplied path/arguments; parent and opened file must remain root-owned.
  const parent = '/data/.host-health-observer';
  let fd, directory;
  try {
    directory = fs.openSync(parent, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    if (!safeMetadata(fs.fstatSync(directory), true)) throw new Error('unsafe_observation');
    fd = fs.openSync(`/proc/self/fd/${directory}/report.json`, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    if (!safeMetadata(fs.fstatSync(fd))) throw new Error('unsafe_observation');
    const buffer = Buffer.alloc(65537); const length = fs.readSync(fd, buffer, 0, buffer.length, 0);
    if (length > 65536) throw new Error('oversized_observation');
    return {schema_version: 1, collection_error: null, report: projectObservation(JSON.parse(buffer.subarray(0, length).toString('utf8')))};
  } catch {
    return {schema_version: 1, collection_error: 'source_invalid_or_unavailable', report: null};
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (directory !== undefined) fs.closeSync(directory);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 2) { process.stdout.write('{"schema_version":1,"collection_error":"arguments_refused","report":null}\n'); process.exitCode = 64; }
  else process.stdout.write(`${JSON.stringify(readFixedObservation())}\n`);
}
