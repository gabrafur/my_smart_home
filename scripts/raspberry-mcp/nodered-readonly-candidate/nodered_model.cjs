'use strict';
// Pure projection only. The broker owns authentication, collection and seals.
const crypto = require('node:crypto');
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const SOURCE_FIELDS = new Set(['func', 'initialize', 'finalize', 'template', 'html', 'source']);
const META = new Set(['id', 'type', 'z', 'name', 'label', 'wires', 'x', 'y']);
const SENSITIVE_KEY = /(?:credential|password|passwd|secret|token|authorization|cookie|headers?|context|history|logs?|email|phone|address|latitude|longitude|coordinates?|location|vehicle|vin|plate|person|entity.?id|^(?:env|lat|lon|lng)$)/i;
const COVERAGE = ['runtime_inventory_only', 'field_by_field_reviewed_public_match', 'sanitized_before_chunking', 'no_context_history_logs_or_credentials', 'not_execution_readiness_or_functional_success'];
const fail = () => { throw new Error('nodered_request_refused'); };
const plain = x => x !== null && typeof x === 'object' && !Array.isArray(x) && (Object.getPrototypeOf(x) === Object.prototype || Object.getPrototypeOf(x) === null);
const sha = x => crypto.createHash('sha256').update(x).digest('hex');
function canonical(x, depth = 0) {
  if (depth > 16) fail();
  if (x === null || typeof x === 'boolean' || typeof x === 'string') return JSON.stringify(x);
  if (typeof x === 'number' && Number.isFinite(x)) return JSON.stringify(x);
  if (Array.isArray(x) && x.length <= 8192) return '[' + x.map(v => canonical(v, depth + 1)).join(',') + ']';
  if (plain(x) && Object.keys(x).length <= 256) return '{' + Object.keys(x).sort().map(k => JSON.stringify(k) + ':' + canonical(x[k], depth + 1)).join(',') + '}';
  fail();
}
function exactArgs(args, names) {
  if (!plain(args) || Object.keys(args).length !== names.length || names.some(k => !Object.hasOwn(args, k)) || args.host !== 'raspberry') fail();
}
function safeField(k, reviewed) { return reviewed && /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(k) ? k : 'field_sha256_' + sha(k).slice(0, 16); }
function sanitize(text) {
  const reasons = new Set();
  const replace = (regex, reason, replacement) => { text = text.replace(regex, (...a) => { reasons.add(reason); return replacement ? replacement(...a) : '[REDACTED:' + reason + ']'; }); };
  replace(/\b(?:Bearer\s+)[A-Za-z0-9._~+\/-]+=*/gi, 'authentication_token');
  replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,})\b/g, 'authentication_token');
  replace(/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, 'authentication_token');
  replace(/((?:["']?(?:password|passwd|secret|token|api[_-]?key|authorization)["']?)\s*[:=]\s*)(["'`])[^"'`\r\n]*\2/gi, 'secret_literal', (all, prefix) => prefix + '"[REDACTED:secret_literal]"');
  replace(/\b(https?:\/\/)[^\s/"'<>]+@/gi, 'url_credentials', (all, prefix) => prefix + '[REDACTED:url_credentials]@');
  replace(/([?&][A-Za-z0-9_-]*(?:token|password|secret|code|auth|key|signature|sig|session)[A-Za-z0-9_-]*=)[^\s&#"'<>]*/gi, 'url_secret_query', (all, prefix) => prefix + '[REDACTED:url_secret_query]');
  replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, 'email');
  replace(/(?<![\w.])-?\d{1,3}\.\d{4,}(?![\w.])/g, 'possible_coordinate_literal');
  replace(/(?<![\w])\+?\d[\d ()-]{7,}\d(?![\w])/g, 'possible_phone_literal');
  replace(/\b[A-HJ-NPR-Z0-9]{17}\b/g, 'possible_vehicle_identifier');
  replace(/\b(?:rua|avenida|av\.|travessa|alameda|street|avenue|road)\s+[^\r\n"'`;]{3,100}/gi, 'possible_address');
  return { text, reasons: [...reasons].sort() };
}
function cleanValue(value, field, redactions, depth = 0) {
  if (depth > 16) fail();
  if (typeof value === 'string') {
    const clean = sanitize(value);
    for (const reason of clean.reasons) redactions.push({ field, reason });
    return clean.text;
  }
  if (typeof value === 'number' && Math.abs(value) <= 180 && /\.\d{4,}/.test(String(value))) {
    redactions.push({ field, reason: 'possible_coordinate_literal' });
    return '[REDACTED:possible_coordinate_literal]';
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (Array.isArray(value)) return value.map(v => cleanValue(v, field, redactions, depth + 1));
  const out = Object.create(null);
  for (const [k, v] of Object.entries(value)) {
    const path = field + '.' + safeField(k, true);
    if (SENSITIVE_KEY.test(k)) redactions.push({ field: path, reason: 'sensitive_field' });
    else out[k] = cleanValue(v, path, redactions, depth + 1);
  }
  return out;
}
function prepare(runtimeFlows, reviewedFlows, context) {
  if (!plain(context) || typeof context.observed_at !== 'string' || typeof context.now !== 'string' || !/^\d{4}-\d\d-\d\dT.*Z$/.test(context.observed_at) || !/^\d{4}-\d\d-\d\dT.*Z$/.test(context.now)) fail();
  const observed = Date.parse(context.observed_at), now = Date.parse(context.now);
  if (!Number.isFinite(observed) || !Number.isFinite(now) || now < observed || typeof context.runtime_version !== 'string' || !/^[0-9][A-Za-z0-9.+_-]{0,63}$/.test(context.runtime_version) || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(context.public_head)) fail();
  if (!Array.isArray(runtimeFlows) || !Array.isArray(reviewedFlows) || runtimeFlows.length > 8192 || reviewedFlows.length > 8192) fail();
  const encoded = canonical(runtimeFlows), reviewedEncoded = canonical(reviewedFlows);
  if (encoded.length > 8 * 1024 * 1024 || reviewedEncoded.length > 8 * 1024 * 1024) fail();
  const makeMap = rows => {
    const map = new Map();
    for (const row of rows) {
      if (!plain(row) || typeof row.id !== 'string' || !ID.test(row.id) || map.has(row.id) || typeof row.type !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_ .:/-]{0,127}$/.test(row.type)) fail();
      map.set(row.id, row);
    }
    return map;
  };
  const runtime = makeMap(runtimeFlows), reviewed = makeMap(reviewedFlows);
  if (context.snapshot_nonce !== undefined && (typeof context.snapshot_nonce !== 'string' || !/^[a-f0-9]{32}$/.test(context.snapshot_nonce))) fail();
  // Snapshot identity contains approved metadata and drift booleans only. Never
  // hash raw private values, even when they are withheld from the projection.
  const structure = [...runtime.values()].sort((a,b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).map(node => {
    const ref = reviewed.get(node.id);
    return {
      id: node.id, type: node.type,
      flow_id: typeof node.z === 'string' && ID.test(node.z) && runtime.has(node.z) ? node.z : null,
      connections: Array.isArray(node.wires) ? node.wires.map(row => Array.isArray(row) ? row.filter(id => typeof id === 'string' && ID.test(id) && runtime.has(id)) : []) : [],
      reviewed_present: !!ref,
      field_matches: Object.keys(node).sort().map(k => !!ref && node.type === ref.type && Object.hasOwn(ref,k) && canonical(node[k]) === canonical(ref[k]))
    };
  });
  const snapshot_id = sha(canonical({ structure, observed_at: context.observed_at, runtime_version: context.runtime_version, public_head: context.public_head, nonce: context.snapshot_nonce || null }));
  const envelope = { source: 'raspberry_NodeRED_runtime_reviewed_public_projection', observed_at: context.observed_at, age_seconds: Math.round((now - observed) / 1000 * 1000) / 1000, collection_error: null, coverage: [...COVERAGE], snapshot_id, runtime_version: context.runtime_version, public_head: context.public_head, functional_recovery_proven: false };
  return { runtime, reviewed, envelope };
}
const isFlow = row => row.type === 'tab' || row.type === 'subflow';
function metadata(node, p) {
  const reviewed = p.reviewed.get(node.id), redacted_fields = [];
  const out = { id: node.id, type: node.type, origin: 'runtime', flow_id: null, title: null, connections: [], connections_total: 0, connections_truncated: false, reviewed_node_present: !!reviewed, redacted_fields };
  if (typeof node.z === 'string' && ID.test(node.z) && p.runtime.has(node.z) && isFlow(p.runtime.get(node.z))) out.flow_id = node.z;
  const titleField = isFlow(node) ? 'label' : 'name';
  if (typeof node[titleField] === 'string' && node[titleField].length) {
    if (reviewed && node.type === reviewed.type && node[titleField] === reviewed[titleField]) {
      const clean = sanitize(node[titleField]);
      if (clean.reasons.length || clean.text.length > 160) redacted_fields.push({ field: 'title', reason: 'title_requires_redaction' });
      else out.title = clean.text;
    } else redacted_fields.push({ field: 'title', reason: 'runtime_title_not_reviewed_public' });
  }
  if (Array.isArray(node.wires)) {
    for (let output = 0; output < node.wires.length; output++) {
      if (!Array.isArray(node.wires[output])) continue;
      for (const id of node.wires[output]) if (typeof id === 'string' && ID.test(id) && p.runtime.has(id)) {
        out.connections_total++;
        if (out.connections.length < 256) out.connections.push({ output, node_id: id });
      }
    }
  }
  out.connections_truncated = out.connections_total > out.connections.length;
  return out;
}
function projection(node, p) {
  const reviewed = p.reviewed.get(node.id), parameters = Object.create(null), sources = [], redacted_fields = [], drift = [];
  for (const k of Object.keys(node).sort()) {
    if (META.has(k)) continue;
    const allowed = reviewed && node.type === reviewed.type && Object.hasOwn(reviewed, k);
    const field = safeField(k, allowed), matching = !!allowed && canonical(node[k]) === canonical(reviewed[k]);
    const sourceField = SOURCE_FIELDS.has(k) && typeof node[k] === 'string';
    const runtime_sha256 = sourceField && matching ? sha(sanitize(node[k]).text) : null;
    drift.push({ field, reviewed_match: matching, runtime_sha256, reviewed_sha256: runtime_sha256, hash_basis: runtime_sha256 ? 'sanitized_reviewed_source' : null });
    if (!matching) { redacted_fields.push({ field, reason: 'runtime_field_not_matching_reviewed_public' }); continue; }
    if (SENSITIVE_KEY.test(k)) { redacted_fields.push({ field, reason: 'sensitive_field' }); continue; }
    if (SOURCE_FIELDS.has(k) && typeof node[k] === 'string') {
      const clean = sanitize(node[k]);
      for (const reason of clean.reasons) redacted_fields.push({ field, reason });
      sources.push({ field, text: clean.text, runtime_sha256, hash_basis: 'sanitized_reviewed_source' });
    } else parameters[k] = cleanValue(node[k], field, redacted_fields);
  }
  return { parameters, sources, redacted_fields, field_drift: drift };
}
function inventory(runtimeFlows, reviewedFlows, args, context) {
  exactArgs(args, ['host', 'kind', 'flow_id', 'page_size', 'cursor']);
  if (!['flows', 'nodes'].includes(args.kind) || !Number.isInteger(args.page_size) || args.page_size < 1 || args.page_size > 16 || (args.flow_id !== null && (typeof args.flow_id !== 'string' || !ID.test(args.flow_id))) || (args.cursor !== null && (typeof args.cursor !== 'string' || args.cursor.length > 512))) fail();
  const p = prepare(runtimeFlows, reviewedFlows, context);
  if (args.flow_id !== null && (!p.runtime.has(args.flow_id) || !isFlow(p.runtime.get(args.flow_id)))) fail();
  if (args.kind === 'flows' && args.flow_id !== null) fail();
  const selector = sha(canonical({ kind: args.kind, flow_id: args.flow_id, page_size: args.page_size }));
  let offset = 0;
  if (args.cursor !== null) {
    let cur;
    try {
      if (!/^[A-Za-z0-9_-]+$/.test(args.cursor)) fail();
      const raw = Buffer.from(args.cursor, 'base64url');
      if (raw.toString('base64url') !== args.cursor) fail();
      cur = JSON.parse(raw.toString('utf8'));
    } catch { fail(); }
    if (!plain(cur) || Object.keys(cur).sort().join(',') !== 'offset,selector,snapshot_id' || cur.snapshot_id !== p.envelope.snapshot_id || cur.selector !== selector || !Number.isInteger(cur.offset) || cur.offset < 1) fail();
    offset = cur.offset;
  }
  const rows = [...p.runtime.values()].filter(n => args.kind === 'flows' ? isFlow(n) : !isFlow(n) && (args.flow_id === null || n.z === args.flow_id)).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  if (offset > rows.length || (args.cursor !== null && offset % args.page_size !== 0)) fail();
  const end = Math.min(offset + args.page_size, rows.length);
  const next_cursor = end < rows.length ? Buffer.from(JSON.stringify({ snapshot_id: p.envelope.snapshot_id, selector, offset: end })).toString('base64url') : null;
  return { ...p.envelope, kind: args.kind, flow_id: args.flow_id, order: 'id_ascending', items: rows.slice(offset, end).map(n => metadata(n, p)), pagination: { page_size: args.page_size, offset, total: rows.length, next_cursor } };
}
function nodeRead(runtimeFlows, reviewedFlows, args, context) {
  exactArgs(args, ['host', 'node_id', 'view', 'offset', 'limit']);
  if (typeof args.node_id !== 'string' || !ID.test(args.node_id) || !['metadata', 'parameters', 'source'].includes(args.view) || !Number.isInteger(args.offset) || args.offset < 0 || args.offset > 262144 || !Number.isInteger(args.limit) || args.limit < 1 || args.limit > 4096) fail();
  const p = prepare(runtimeFlows, reviewedFlows, context), node = p.runtime.get(args.node_id);
  if (!node || isFlow(node)) fail();
  const details = projection(node, p), meta = metadata(node, p);
  const base = { ...p.envelope, node: meta, view: args.view, redacted_fields: [...meta.redacted_fields, ...details.redacted_fields], field_drift: details.field_drift };
  if (args.view === 'source') {
    const text = details.sources.map(s => '// field: ' + s.field + '\n' + s.text).join('\n\n');
    if (text.length > 262144 || args.offset > text.length) fail();
    const end = Math.min(args.offset + args.limit, text.length);
    return { ...base, text: text.slice(args.offset, end), sanitized_source_sha256: sha(text), source_fields: details.sources.map(({field, runtime_sha256, hash_basis}) => ({field, runtime_sha256, hash_basis})), pagination: { offset: args.offset, limit: args.limit, total_characters: text.length, next_offset: end < text.length ? end : null } };
  }
  if (args.offset !== 0) fail();
  return { ...base, parameters: args.view === 'parameters' ? details.parameters : undefined, pagination: { offset: 0, limit: args.limit, next_offset: null } };
}
module.exports = { inventory, nodeRead };
