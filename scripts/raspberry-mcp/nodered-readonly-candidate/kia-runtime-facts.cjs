'use strict';
// Fixed native facts require a separately approved Root-owned binding.
const fs = require('node:fs');
const http = require('node:http');

const FIXED_BINDING = '/etc/raspberry-nodered-diagnostics/kia-runtime-binding.json';
const REVOKED = '/var/lib/raspberry-nodered-diagnostics/kia-runtime-facts-revoked';
const ROLES = Object.freeze([
  ['fuel', 'sensor', '_fuel_level'],
  ['scanned', 'sensor', '_last_scanned_at'],
  ['force_refresh', 'button', '_force_refresh'],
  ['hazard', 'button', '_start_hazard_lights_and_horn'],
  ['recent_trip', 'sensor', '_recent_trip_info'],
  ['remote_command', 'sensor', '_remote_command_status'],
].map(Object.freeze));
const ROLE_NAMES = ROLES.map(row => row[0]);
const SCOPE = 'six_Kia_native_state_kinds_and_scan_timestamp_only';
const KINDS = new Set(['missing', 'unknown', 'unavailable', 'value']);
const FIELDS = ['native_scanned_at', 'role', 'state_kind'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype;
const exact = (value, keys) => object(value)
  && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
const validId = value => typeof value === 'string' && /^(sensor|button)\.[a-z0-9_]{1,128}$/.test(value);
const validNativeId = value => typeof value === 'string'
  && /^(?:[a-f0-9]{32}|[0-9A-HJKMNP-TV-Z]{26})$/.test(value);
function stamp(value) {
  if (typeof value !== 'string' || value.length > 40
      || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|[+-]\d\d:\d\d)$/.test(value)
      || !Number.isFinite(Date.parse(value))
      || new Date(value.slice(0, 19) + 'Z').toISOString().slice(0, 19) !== value.slice(0, 19)) return null;
  return new Date(value).toISOString();
}

function bindTargets(registry) {
  if (!Array.isArray(registry) || registry.length > 20000) throw Error('registry_bound');
  const selected = {};
  const matched = [];
  for (const [role, domain, suffix] of ROLES) {
    const rows = registry.filter(row => object(row) && row.platform === 'kia_uvo'
      && validId(row.entity_id) && row.entity_id.startsWith(domain + '.')
      && row.entity_id.endsWith(suffix));
    if (rows.length !== 1) throw Error('role_missing_or_ambiguous');
    selected[role] = rows[0].entity_id;
    matched.push(rows[0]);
  }
  for (const key of ['device_id', 'config_entry_id']) {
    if (matched.some(row => !validNativeId(row[key]))
        || new Set(matched.map(row => row[key])).size !== 1) throw Error('same_device_and_entry_required');
  }
  return selected;
}

function validateBinding(binding) {
  if (!exact(binding, ['schema_version', 'scope', 'enabled', 'approval_sha256', 'entities'])
      || binding.schema_version !== 1 || binding.scope !== SCOPE || binding.enabled !== true
      || typeof binding.approval_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(binding.approval_sha256)
      || !exact(binding.entities, ROLE_NAMES)) throw Error('binding_unarmed_or_invalid');
  for (const [role, domain, suffix] of ROLES) {
    const id = binding.entities[role];
    if (!validId(id) || !id.startsWith(domain + '.') || !id.endsWith(suffix)) throw Error('binding_target_invalid');
  }
  if (new Set(Object.values(binding.entities)).size !== ROLES.length) throw Error('binding_target_invalid');
  return binding.entities;
}

function loadBinding() {
  let fd;
  try {
    if (fs.existsSync(REVOKED)) throw Error('binding_revoked');
    const parent = fs.lstatSync('/etc/raspberry-nodered-diagnostics');
    if (!parent.isDirectory() || parent.uid !== 0 || (parent.mode & 0o022) !== 0
        || fs.realpathSync(FIXED_BINDING) !== FIXED_BINDING) throw Error('binding_parent_invalid');
    fd = fs.openSync(FIXED_BINDING, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const info = fs.fstatSync(fd);
    if (!info.isFile() || info.uid !== 0 || info.nlink !== 1 || (info.mode & 0o022) !== 0
        || info.size > 4096) throw Error('binding_file_invalid');
    const binding = JSON.parse(fs.readFileSync(fd, 'utf8'));
    validateBinding(binding);
    return binding;
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function buildTemplate(binding) {
  const entities = validateBinding(binding);
  const pairs = ROLES.map(([role]) => [role, entities[role]]);
  return [
    '{% set ns = namespace(rows=[]) %}',
    '{% for role, eid in ' + JSON.stringify(pairs) + ' %}',
    '{% set s = states[eid] %}',
    '{% set kind = "missing" if s is none else "unavailable" if s.state == "unavailable" else "unknown" if s.state == "unknown" else "value" %}',
    '{% set scanned = as_datetime(s.state, none) if role == "scanned" and s is not none else none %}',
    '{% set row = {"role": role, "state_kind": kind, "native_scanned_at": scanned.isoformat() if scanned is not none and scanned.tzinfo is not none else none} %}',
    '{% set ns.rows = ns.rows + [row] %}',
    '{% endfor %}',
    '{{ {"schema_version": 1, "rows": ns.rows} | to_json }}',
  ].join('\n');
}

function parseFacts(raw) {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > 16384) throw Error('native_fact_bound');
  const value = JSON.parse(raw);
  if (!exact(value, ['schema_version', 'rows']) || value.schema_version !== 1
      || !Array.isArray(value.rows) || value.rows.length !== ROLES.length) throw Error('native_fact_schema');
  const rows = [];
  for (const role of ROLE_NAMES) {
    const matches = value.rows.filter(row => object(row) && row.role === role);
    if (matches.length !== 1 || !exact(matches[0], FIELDS)) throw Error('native_fact_schema');
    const row = matches[0];
    if (!KINDS.has(row.state_kind)) throw Error('native_fact_schema');
    const clean = {role, state_kind: row.state_kind};
    for (const key of ['native_scanned_at']) {
      clean[key] = row[key] === null ? null : stamp(row[key]);
      if (row[key] !== null && clean[key] === null) throw Error('native_fact_schema');
    }
    if (role !== 'scanned' && clean.native_scanned_at !== null) throw Error('native_fact_schema');
    if (['missing', 'unknown', 'unavailable'].includes(row.state_kind) && clean.native_scanned_at !== null) throw Error('native_fact_schema');
    rows.push(clean);
  }
  return rows;
}

function requestTemplate(token, template, transport = http) {
  return new Promise(resolve => {
    let done = false, req, timer;
    const finish = value => { if (done) return; done = true; clearTimeout(timer); resolve(value); };
    const body = Buffer.from(JSON.stringify({template}));
    if (body.length > 8192) return finish({error: 'native_template_bound'});
    timer = setTimeout(() => { finish({error: 'native_template_timeout'}); req?.destroy(); }, 1000);
    try {
      req = transport.request({host: '127.0.0.1', port: 8123, path: '/api/template', method: 'POST',
        headers: {Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', 'Content-Length': body.length}, agent: false}, res => {
        let chunks = [], bytes = 0;
        res.on('error', () => finish({error: 'native_template_transport'}));
        res.on('aborted', () => finish({error: 'native_template_transport'}));
        res.on('data', chunk => {
          bytes += chunk.length;
          if (bytes > 16384) { finish({error: 'native_template_response_bound'}); req.destroy(); }
          else chunks.push(chunk);
        });
        res.on('end', () => {
          if (res.statusCode !== 200) return finish({error: 'native_template_http_refused'});
          try { finish({rows: parseFacts(Buffer.concat(chunks).toString('utf8'))}); }
          catch { finish({error: 'native_fact_schema'}); }
          chunks = [];
        });
      });
      req.on('error', () => finish({error: 'native_template_transport'}));
      req.end(body);
    } catch { finish({error: 'native_template_transport'}); }
  });
}

async function collectRuntime(token, identityVerified, dependencies = {}) {
  const result = {schema_version: 1, source: 'HA_six_fixed_Kia_runtime_facts',
    observed_at: new Date().toISOString(), state: 'unknown', collection_error: null,
    scope_approved: false, request_attempted: false, rows: null,
    vehicle_values_or_locations_returned: false, service_calls: 0, new_subscriptions: 0,
    loaded_code_identity_proven: false, natural_polling_proven: false,
    current_functional_health_proven: false, historical_failure_cause_proven: false};
  if (identityVerified !== true || typeof token !== 'string' || token.length < 1 || token.length > 4096) {
    result.collection_error = 'native_identity_unconfirmed'; return result;
  }
  let binding, template;
  try {
    binding = (dependencies.loadBinding || loadBinding)();
    template = buildTemplate(binding);
    result.scope_approved = true;
  } catch { result.collection_error = 'native_scope_unarmed_or_invalid'; return result; }
  result.request_attempted = true;
  const response = await requestTemplate(token, template, dependencies.transport || http);
  if (response.error) result.collection_error = response.error;
  else { result.state = 'observed'; result.rows = response.rows; }
  return result;
}

function projectRuntimeFacts(value) {
  const base = {schema_version: 1, source: 'HA_six_fixed_Kia_runtime_facts', observed_at: null,
    state: 'unknown', collection_error: 'native_fact_producer_invalid', scope_approved: false,
    request_attempted: false, rows: null, vehicle_values_or_locations_returned: false,
    service_calls: 0, new_subscriptions: 0, loaded_code_identity_proven: false,
    natural_polling_proven: false, current_functional_health_proven: false,
    historical_failure_cause_proven: false};
  const errors = new Set(['native_identity_unconfirmed', 'native_scope_unarmed_or_invalid',
    'native_template_bound', 'native_template_timeout', 'native_template_transport',
    'native_template_response_bound', 'native_template_http_refused', 'native_fact_schema']);
  if (!exact(value, Object.keys(base)) || value.schema_version !== 1 || value.source !== base.source
      || !stamp(value.observed_at) || !['observed', 'unknown'].includes(value.state)
      || typeof value.scope_approved !== 'boolean' || typeof value.request_attempted !== 'boolean'
      || value.request_attempted && !value.scope_approved
      || value.vehicle_values_or_locations_returned !== false || value.service_calls !== 0
      || value.new_subscriptions !== 0 || value.loaded_code_identity_proven !== false
      || value.natural_polling_proven !== false || value.current_functional_health_proven !== false
      || value.historical_failure_cause_proven !== false) return base;
  if (value.state === 'unknown') {
    if (!errors.has(value.collection_error) || value.rows !== null) return base;
    return {...base, observed_at: stamp(value.observed_at), collection_error: value.collection_error,
      scope_approved: value.scope_approved, request_attempted: value.request_attempted};
  }
  if (value.collection_error !== null || !value.scope_approved || !value.request_attempted) return base;
  try {
    const rows = parseFacts(JSON.stringify({schema_version: 1, rows: value.rows}));
    return {...base, observed_at: stamp(value.observed_at), state: 'observed', collection_error: null,
      scope_approved: true, request_attempted: true, rows};
  } catch { return base; }
}

module.exports = {ROLES, SCOPE, bindTargets, validateBinding, buildTemplate, parseFacts, collectRuntime, projectRuntimeFacts};
