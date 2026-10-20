// Pure projection boundary: no source text or arbitrary keys reach MCP responses.
export const SERVICES = ['homeassistant', 'nodered', 'mosquitto'];
export const TOOLS = ['service_health', 'service_versions', 'disk_space', 'backup_results', 'log_summary'];
export const MAX_BYTES = 16384;
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const integer = x => Number.isSafeInteger(x) && x >= 0 ? x : null;
const pick = (x, values) => values.includes(x) ? x : 'unknown';
const timestamp = x => typeof x === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(x) && Number.isFinite(Date.parse(x)) ? x : null;
export function project(source) {
  if (!object(source)) throw Error('unavailable');
  return {
    host: 'raspberry', observed_at: timestamp(source.observed_at),
    services: SERVICES.map(service => {
      const row = source.services?.find?.(x => x?.service === service) ?? {};
      return { service, state: pick(row.state, ['running', 'exited', 'restarting', 'paused', 'created', 'dead']),
        health: pick(row.health, ['healthy', 'unhealthy', 'starting', 'not_configured']),
        version: typeof row.version === 'string' && /^\d{1,4}\.\d{1,4}(?:\.\d{1,4})?$/.test(row.version) ? row.version : null };
    }),
    disk: { total_bytes: integer(source.disk?.total_bytes), available_bytes: integer(source.disk?.available_bytes) },
    backups: { git: { status: pick(source.backups?.git?.status, ['success', 'failed', 'deferred']),
      finished_at: timestamp(source.backups?.git?.finished_at) }, offsite: { status: 'unknown' } },
    logs: SERVICES.map(service => {
      const row = source.logs?.find?.(x => x?.service === service) ?? {};
      return { service, status: pick(row.status, ['sampled', 'unavailable']),
        sampled_lines: integer(row.sampled_lines), error_lines: integer(row.error_lines), warning_lines: integer(row.warning_lines) };
    }),
  };
}
export function validateCall(params) {
  if (!object(params) || Object.keys(params).some(k => !['name', 'arguments', '_meta'].includes(k)) || !TOOLS.includes(params.name)) throw Error('invalid_parameters');
  // MCP request metadata is protocol context, never tool arguments or output.
  if ('_meta' in params && !object(params._meta)) throw Error('invalid_parameters');
  const args = params.arguments;
  if (!object(args) || Object.keys(args).some(k => !['host', ...(params.name === 'log_summary' ? ['service'] : [])].includes(k)) || args.host !== 'raspberry') throw Error('invalid_parameters');
  if (params.name === 'log_summary' && !SERVICES.includes(args.service)) throw Error('invalid_parameters');
  return args;
}
export function descriptors() {
  return TOOLS.map(name => ({ name, description: `Read ${name} from a bounded sanitized Raspberry snapshot. Use for diagnostics only; timestamps describe observations, not live availability. Logs contain counts only. No remote hosts or actions.`,
    inputSchema: { type: 'object', additionalProperties: false, properties: { host: { type: 'string', enum: ['raspberry'] }, ...(name === 'log_summary' ? { service: { type: 'string', enum: SERVICES } } : {}) }, required: name === 'log_summary' ? ['host', 'service'] : ['host'] },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } }));
}
export function call(params, source) {
  const args = validateCall(params);
  const s = project(source);
  const data = { service_health: s.services.map(({service,state,health}) => ({service,state,health})), service_versions: s.services.map(({service,version}) => ({service,version})), disk_space: s.disk, backup_results: s.backups, log_summary: s.logs.find(x => x.service === args.service) }[params.name];
  return { host: s.host, observed_at: s.observed_at, data };
}
