// Candidate only. Internal protected-file bindings; no MCP entrypoint or deploy.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { normalizedIdentity } = require('./attestation_model.cjs');
const { validateDelta, validatePrepared } = require('./effects/nodered_effect.cjs');

const LIMIT = 1048576;
const CHECKS = Object.freeze(['source_consistency', 'pure_function_regression',
 'dry_run_regression', 'layout', 'left_margin', 'render_review', 'manual_tests',
 'observability', 'unchanged_scope', 'rollback']);
const REVIEW_FIELDS = ['schema_version', 'operation_id', 'task_id', 'principal_sha256',
 'component_id', 'send_id', 'before_sha256', 'after_sha256', 'before_file_sha256',
 'after_file_sha256', 'source_set_sha256', 'validation_profile_sha256',
 'validation_sha256', 'approved_at', 'expires_at'];
// Publish the apply permit last, after its own rollback artifacts are durable.
const OUTPUTS = [['apply', 'prepared'], ['rollback', 'prepared'],
 ['rollback', 'review'], ['apply', 'review']];
const need = (ok, reason) => { if (!ok) throw Error(reason); };
const sha = raw => crypto.createHash('sha256').update(raw).digest('hex');
const bytes = value => Buffer.from(JSON.stringify(value) + '\n');
const isId = x => typeof x === 'string' && /^[a-f0-9]{32}$/.test(x);
const isSha = x => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
const exact = (value, fields) => value && typeof value === 'object' &&
 !Array.isArray(value) && Object.keys(value).length === fields.length &&
 fields.every(k => Object.hasOwn(value, k));
function finite(value) { return typeof value === 'number' && Number.isFinite(value); }

function directory(folder, owner) {
 need(path.isAbsolute(folder), 'absolute_internal_directory_required');
 // Parents must not be symlinks or writable by another unprivileged principal.
 // Root-owned sticky directories support isolated test fixtures under /tmp.
 let current = path.parse(folder).root;
 for (const part of folder.split(path.sep).filter(Boolean)) {
  current = path.join(current, part);
  const s = fs.lstatSync(current);
  need(s.isDirectory() && !s.isSymbolicLink() && (s.uid === 0 || s.uid === owner) &&
   (!(s.mode & 0o022) || (s.uid === 0 && (s.mode & 0o1000))), 'unsafe_revision_parent');
 }
 const s = fs.lstatSync(folder);
 need(s.uid === owner && (s.mode & 0o7777) === 0o700, 'unsafe_revision_directory');
 return [s.dev, s.ino];
}
function sameDirectory(folder, owner, identity) {
 const current = directory(folder, owner);
 need(current[0] === identity[0] && current[1] === identity[1], 'revision_directory_replaced');
}
function read(folder, name, owner, limit = LIMIT + 8192) {
 const id = directory(folder, owner);
 const fd = fs.openSync(path.join(folder, name), fs.constants.O_RDONLY |
  fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
 try {
  const before = fs.fstatSync(fd, { bigint: true });
  need(before.isFile() && before.uid === BigInt(owner) && (before.mode & 0o7777n) === 0o600n &&
   before.nlink === 1n && before.size > 0n && before.size <= BigInt(limit), 'unsafe_revision_file');
  const raw = Buffer.alloc(Number(before.size)); let offset = 0;
  while (offset < raw.length) {
   const count = fs.readSync(fd, raw, offset, raw.length - offset, null);
   need(count > 0, 'revision_short_read'); offset += count;
  }
  const after = fs.fstatSync(fd, { bigint: true });
  need(['dev', 'ino', 'size', 'ctimeNs', 'mtimeNs'].every(k => before[k] === after[k]),
   'revision_changed_during_read');
  sameDirectory(folder, owner, id);
  return { raw, value: JSON.parse(raw.toString('utf8')),
   identity: [String(before.dev), String(before.ino)] };
 } finally { fs.closeSync(fd); }
}
function exists(file) {
 try { fs.lstatSync(file); return true; }
 catch (e) { if (e.code === 'ENOENT') return false; throw e; }
}
function sync(folder) {
 const fd = fs.openSync(folder, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
 try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function writeNew(folder, name, value, owner, identity) {
 sameDirectory(folder, owner, identity);
 const raw = bytes(value); need(raw.length <= LIMIT + 8192, 'revision_output_limit');
 const fd = fs.openSync(path.join(folder, name), fs.constants.O_WRONLY | fs.constants.O_CREAT |
  fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
 let fileIdentity;
 try {
  fs.writeFileSync(fd, raw); fs.fsyncSync(fd);
  const info = fs.fstatSync(fd, { bigint: true }); fileIdentity = [String(info.dev), String(info.ino)];
 }
 finally { fs.closeSync(fd); }
 sync(folder); sameDirectory(folder, owner, identity);
 return { sha256: sha(raw), identity: fileIdentity };
}

function assemble(review, validation, before, after, now) {
 need(exact(review, REVIEW_FIELDS) && review.schema_version === 1 &&
  isId(review.operation_id) && isId(review.task_id) && isId(review.send_id) &&
  review.component_id === 'observacao_host', 'revision_review_scope_refused');
 for (const key of REVIEW_FIELDS.filter(k => k.endsWith('sha256'))) need(isSha(review[key]), 'revision_hash_required');
 need(finite(now) && finite(review.approved_at) && finite(review.expires_at) &&
  0 <= review.approved_at && review.approved_at <= now && now < review.expires_at &&
  review.expires_at - review.approved_at <= 86400, 'revision_review_expired_or_future');
 need(sha(before.raw) === review.before_file_sha256 && sha(after.raw) === review.after_file_sha256 &&
  sha(validation.raw) === review.validation_sha256, 'reviewed_artifact_bytes_changed');
 const v = validation.value;
 need(exact(v, ['schema_version', 'source_set_sha256', 'validation_profile_sha256',
  'before_sha256', 'after_sha256', 'observed_at', 'checks']) && v.schema_version === 1 &&
  ['source_set_sha256', 'validation_profile_sha256', 'before_sha256', 'after_sha256'].every(k => v[k] === review[k]) &&
  finite(v.observed_at) && 0 <= v.observed_at && v.observed_at <= review.approved_at &&
  exact(v.checks, CHECKS) && CHECKS.every(k => v.checks[k] === 'passed'), 'bound_validation_incomplete');
 for (const nodes of [before.value, after.value]) {
  need(Array.isArray(nodes) && nodes.length > 0 && nodes.length <= 2048, 'revision_node_bound');
  const ids = new Set(); let tabs = 0;
  for (const n of nodes) {
   need(n && typeof n.id === 'string' && !ids.has(n.id), 'revision_node_identity_refused'); ids.add(n.id);
   if (n.id === 'host_observer_tab') { need(n.type === 'tab', 'revision_tab_refused'); tabs++; }
   else need(n.z === 'host_observer_tab' && n.type !== 'tab', 'revision_foreign_scope_refused');
  }
  need(tabs === 1, 'revision_tab_missing');
 }
 need(normalizedIdentity(before.value) === review.before_sha256 &&
  normalizedIdentity(after.value) === review.after_sha256, 'revision_configuration_identity_changed');
 validateDelta(before.value, after.value);
 const records = {};
 for (const action of ['apply', 'rollback']) {
  const rollback = action === 'rollback';
  const prepared = { operation_id: review.operation_id, task_id: review.task_id,
   principal_sha256: review.principal_sha256, component_id: review.component_id,
   before_sha256: review[rollback ? 'after_sha256' : 'before_sha256'],
   after_sha256: review[rollback ? 'before_sha256' : 'after_sha256'],
   candidate_nodes: rollback ? before.value : after.value };
  const binding = { ...validatePrepared(prepared), action };
  records[action] = { prepared, review: { binding, send_id: review.send_id,
   identity_kind: 'nodered_scoped_configuration_v1', isolated_tests_passed: true,
   reviewed_scope: true, expires_at: review.expires_at } };
 }
 return records;
}

class RevisionStore {
 constructor({ sealedRoot, preparedRoot, reviewsRoot, journalRoot, approvedReviews,
  acquire, owner = 0, clock = () => Date.now() / 1000 }) {
  need(typeof acquire === 'function' && Number.isSafeInteger(owner) && owner >= 0,
   'internal_review_bootstrap_required');
  this.paths = { sealedRoot, preparedRoot, reviewsRoot, journalRoot };
  need(new Set(Object.values(this.paths)).size === 4, 'revision_directory_collision');
  this.owner = owner; this.clock = clock; this.acquire = acquire;
  this.approved = Object.freeze({ ...approvedReviews });
  this.identities = Object.fromEntries(Object.entries(this.paths).map(([k, v]) => [k, directory(v, owner)]));
 }
 guard() {
  for (const [key, folder] of Object.entries(this.paths)) {
   sameDirectory(folder, this.owner, this.identities[key]);
   need(!exists(path.join(folder, 'revoked')), 'revision_publication_revoked');
  }
 }
 publish(op) {
  need(isId(op) && isSha(this.approved[op]), 'unregistered_review'); this.guard();
  const lease = this.acquire(); need(lease && typeof lease.check === 'function' &&
   typeof lease.release === 'function', 'protected_revision_lock_required');
  try {
   const guard = () => { lease.check(); this.guard(); };
   guard();
   const journal = path.join(this.paths.journalRoot, op);
   if (exists(journal)) return this.inspect(op);
   const sealed = path.join(this.paths.sealedRoot, op);
   const review = read(sealed, 'review.json', this.owner, 16384);
   need(sha(review.raw) === this.approved[op] && review.value.operation_id === op, 'sealed_review_changed');
   const records = assemble(review.value, read(sealed, 'validation.json', this.owner, 16384),
    read(sealed, 'before.json', this.owner), read(sealed, 'after.json', this.owner), this.clock());
   const outputs = [];
   for (const [action, kind] of OUTPUTS) {
    const folder = this.paths[kind === 'prepared' ? 'preparedRoot' : 'reviewsRoot'];
    const name = op + '-' + action + '.json';
    need(!exists(path.join(folder, name)), 'existing_revision_output_requires_reconciliation');
    outputs.push({ folder, name, value: records[action][kind], identity: directory(folder, this.owner) });
   }
   const journals = fs.readdirSync(this.paths.journalRoot);
   need(journals.length < 64, 'revision_journal_capacity');
   let used = 0;
   for (const key of ['preparedRoot', 'reviewsRoot']) {
    const entries = fs.readdirSync(this.paths[key]);
    need(entries.length <= 126, 'revision_output_capacity');
    for (const name of entries) {
     need(/^[a-f0-9]{32}-(apply|rollback)\.json$/.test(name), 'unknown_revision_output');
     const info = fs.lstatSync(path.join(this.paths[key], name));
     need(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 &&
      info.uid === this.owner && (info.mode & 0o7777) === 0o600 &&
      info.size <= LIMIT + 8192, 'unsafe_existing_revision_output');
     used += info.size;
    }
   }
   need(used + outputs.reduce((n, o) => n + bytes(o.value).length, 0) <= 32 * LIMIT,
    'revision_storage_capacity');
   guard(); fs.mkdirSync(journal, { mode: 0o700 }); sync(this.paths.journalRoot);
   const jid = directory(journal, this.owner);
   writeNew(journal, 'intent.json', { operation_id: op, review_sha256: this.approved[op],
    output_sha256: outputs.map(o => sha(bytes(o.value))), automatic_retry: false }, this.owner, jid);
   const published = [];
   for (const o of outputs) {
    guard(); need(this.clock() < review.value.expires_at, 'revision_review_expired_during_publication');
    published.push(writeNew(o.folder, o.name, o.value, this.owner, o.identity));
   }
   guard();
   writeNew(journal, 'receipt.json', { operation_id: op, review_sha256: this.approved[op],
    state: 'protected_records_published_not_deployed', output_sha256: outputs.map(o => sha(bytes(o.value))),
    output_identities: published.map(o => o.identity),
    automatic_retry: false }, this.owner, jid);
   return this.inspect(op);
  } finally { lease.release(); }
 }
 inspect(op) {
  need(isId(op) && isSha(this.approved[op]), 'unregistered_review');
  const folder = path.join(this.paths.journalRoot, op);
  directory(folder, this.owner);
  const incomplete = { operation_id: op, state: 'publication_incomplete_reconcile_only',
   automatic_retry: false, deployment_attempted: false };
  if (!exists(path.join(folder, 'receipt.json'))) return incomplete;
  const r = read(folder, 'receipt.json', this.owner, 16384).value;
  need(exact(r, ['operation_id', 'review_sha256', 'state', 'output_sha256', 'output_identities', 'automatic_retry']) &&
   r.operation_id === op && r.review_sha256 === this.approved[op] &&
   r.state === 'protected_records_published_not_deployed' && r.automatic_retry === false &&
   Array.isArray(r.output_sha256) && r.output_sha256.length === 4 && r.output_sha256.every(isSha) &&
   Array.isArray(r.output_identities) && r.output_identities.length === 4 && r.output_identities.every(id =>
    Array.isArray(id) && id.length === 2 && id.every(n => typeof n === 'string' && /^[0-9]+$/.test(n))),
   'publication_receipt_refused');
  let i = 0;
  for (const [action, kind] of OUTPUTS) {
   const key = kind === 'prepared' ? 'preparedRoot' : 'reviewsRoot';
   const item = read(this.paths[key], op + '-' + action + '.json', this.owner);
   need(sha(item.raw) === r.output_sha256[i] && item.identity.every((n, j) => n === r.output_identities[i][j]),
    'published_record_changed'); i++;
  }
  return { operation_id: op, state: r.state, automatic_retry: false, deployment_attempted: false };
 }
}
module.exports = { RevisionStore, assemble, CHECKS };
