const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { RevisionStore, CHECKS } = require('./revision_store.cjs');
const { normalizedIdentity } = require('./attestation_model.cjs');
const { NodeRedWorker, ReceiptStore } = require('./effects/nodered_effect.cjs');
const OP = 'a'.repeat(32), TASK = 'b'.repeat(32), PRINCIPAL = 'c'.repeat(64);
const raw = value => Buffer.from(JSON.stringify(value) + '\n');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
function fixture(t) {
 const root = fs.mkdtempSync(path.join(os.tmpdir(), 'component-revision-test-'));
 fs.chmodSync(root, 0o700); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
 const paths = Object.fromEntries(['sealedRoot', 'preparedRoot', 'reviewsRoot', 'journalRoot'].map(k => {
  const p = path.join(root, k); fs.mkdirSync(p, { mode: 0o700 }); return [k, p];
 }));
 const sealed = path.join(paths.sealedRoot, OP); fs.mkdirSync(sealed, { mode: 0o700 });
 const before = [{ id: 'host_observer_tab', type: 'tab' },
  { id: 'f1', z: 'host_observer_tab', type: 'function', func: 'return msg;', wires: [[]] }];
 const after = structuredClone(before); after[1].func = 'msg.synthetic = true; return msg;';
 const validation = { schema_version: 1, source_set_sha256: 'd'.repeat(64),
  validation_profile_sha256: 'e'.repeat(64), before_sha256: normalizedIdentity(before),
  after_sha256: normalizedIdentity(after), observed_at: 90,
  checks: Object.fromEntries(CHECKS.map(k => [k, 'passed'])) };
 const review = { schema_version: 1, operation_id: OP, task_id: TASK, principal_sha256: PRINCIPAL,
  component_id: 'observacao_host', send_id: 'f'.repeat(32), before_sha256: validation.before_sha256,
  after_sha256: validation.after_sha256, before_file_sha256: sha(raw(before)), after_file_sha256: sha(raw(after)),
  source_set_sha256: validation.source_set_sha256, validation_profile_sha256: validation.validation_profile_sha256,
  validation_sha256: sha(raw(validation)), approved_at: 95, expires_at: 200 };
 const state = { now: 100, held: false, acquisitions: 0, releases: 0, checks: 0, failOn: 0 };
 const f = { root, paths, sealed, before, after, review, validation, state };
 f.write = (name, value) => fs.writeFileSync(path.join(sealed, name), raw(value), { mode: 0o600 });
 f.seal = () => {
  f.review.before_file_sha256 = sha(raw(f.before)); f.review.after_file_sha256 = sha(raw(f.after));
  f.validation.before_sha256 = f.review.before_sha256 = normalizedIdentity(f.before);
  f.validation.after_sha256 = f.review.after_sha256 = normalizedIdentity(f.after);
  f.review.validation_sha256 = sha(raw(f.validation));
  for (const [name, value] of [['before.json', f.before], ['after.json', f.after],
   ['validation.json', f.validation], ['review.json', f.review]]) f.write(name, value);
  return sha(raw(f.review));
 };
 f.store = () => new RevisionStore({ ...paths, owner: process.getuid(),
  approvedReviews: { [OP]: sha(raw(f.review)) }, clock: () => state.now,
  acquire: () => {
   if (state.held) throw Error('synthetic_lock_busy'); state.held = true; state.acquisitions++;
   return { check: () => { assert.equal(state.held, true); state.checks++;
    if (state.checks === state.failOn) throw Error('synthetic_guard_refusal');
   }, release: () => { state.held = false; state.releases++; } };
  } });
 f.seal(); return f;
}
function outputs(f) { return Object.values(f.paths).slice(1, 3).flatMap(p => fs.readdirSync(p)); }

test('publishes worker-compatible exact apply/rollback records and immutable replay', t => {
 const f = fixture(t), store = f.store();
 assert.equal(store.publish(OP).state, 'protected_records_published_not_deployed');
 const prepared = action => JSON.parse(fs.readFileSync(path.join(f.paths.preparedRoot, OP + '-' + action + '.json')));
 assert.deepEqual(prepared('apply').candidate_nodes, f.after);
 assert.deepEqual(prepared('rollback').candidate_nodes, f.before);
 assert.equal(prepared('apply').before_sha256, prepared('rollback').after_sha256);
 const before = outputs(f).map(name => fs.statSync(path.join(f.paths.preparedRoot, name)).ino);
 assert.equal(store.publish(OP).deployment_attempted, false);
 assert.deepEqual(outputs(f).map(name => fs.statSync(path.join(f.paths.preparedRoot, name)).ino), before);
 assert.equal(f.state.acquisitions, f.state.releases);
 const review = JSON.parse(fs.readFileSync(path.join(f.paths.reviewsRoot, OP + '-apply.json')));
 assert.equal(review.binding.principal_sha256, PRINCIPAL); assert.equal(review.send_id, f.review.send_id);
});

test('generated records drive one synthetic worker apply and own rollback', async t => {
 const f = fixture(t); f.store().publish(OP); let flows = structuredClone(f.before), rev = '0'.repeat(64), posts = 0;
 const client = { async login() {}, async revoke() { return true; },
  async configuration() { return { rev, flows: structuredClone(flows) }; },
  async deploy(expected, next) { assert.equal(expected, rev); flows = next; posts++; rev = String(posts).repeat(64);
   return { status: 200, data: { rev } }; } };
 for (const action of ['apply', 'rollback']) {
  const state = path.join(f.root, action); fs.mkdirSync(state, { mode: 0o700 });
  const prepared = JSON.parse(fs.readFileSync(path.join(f.paths.preparedRoot, OP + '-' + action + '.json')));
  const worker = new NodeRedWorker({ client, store: new ReceiptStore(state, action), purpose: action, clock: () => f.state.now,
   admission: async binding => ({ ...binding, identity_kind: 'nodered_scoped_configuration_v1',
    registered_task: true, reviewed_candidate: true, principal_matches: true, shared_budget_reserved: true,
    global_admin_idle: true, resources_available: true, maintenance_lock_held: true,
    observed_at: f.state.now, expires_at: f.review.expires_at }) });
  assert.equal((await worker.execute(prepared)).state, 'applied');
  assert.equal((await worker.execute(prepared)).duplicate, true);
 }
 assert.equal(posts, 2); assert.deepEqual(flows, f.before);
});

test('unregistered or altered protected review is refused before any output', t => {
 const f = fixture(t), store = f.store();
 assert.throws(() => store.publish('0'.repeat(32)), /unregistered_review/);
 f.review.task_id = '1'.repeat(32); f.write('review.json', f.review);
 assert.throws(() => store.publish(OP), /sealed_review_changed/); assert.deepEqual(outputs(f), []);
});
test('raw artifact drift and stale validation cannot borrow a passed receipt', t => {
 const f = fixture(t); f.write('after.json', [...f.after].reverse());
 assert.throws(() => f.store().publish(OP), /reviewed_artifact_bytes_changed/);
 f.seal(); f.validation.source_set_sha256 = '0'.repeat(64); f.seal();
 assert.throws(() => f.store().publish(OP), /bound_validation_incomplete/); assert.deepEqual(outputs(f), []);
});
test('every validation gate and exact profile are required', t => {
 const f = fixture(t); f.validation.checks.layout = true; f.seal();
 assert.throws(() => f.store().publish(OP), /bound_validation_incomplete/);
 f.validation.checks.layout = 'passed'; delete f.validation.checks.rollback; f.seal();
 assert.throws(() => f.store().publish(OP), /bound_validation_incomplete/);
});
test('unsupported component, foreign node and topology change are refused', t => {
 const f = fixture(t); f.review.component_id = 'localizacao_pessoas'; f.seal();
 assert.throws(() => f.store().publish(OP), /revision_review_scope_refused/);
 f.review.component_id = 'observacao_host'; f.after[1].z = 'foreign'; f.seal();
 assert.throws(() => f.store().publish(OP), /revision_foreign_scope_refused/);
 f.after[1].z = 'host_observer_tab'; f.after[1].wires = [['new-target']]; f.seal();
 assert.throws(() => f.store().publish(OP), /effect_boundary_or_configuration_change_refused/);
});
test('expiry, future approval and validation after approval fail closed', t => {
 const f = fixture(t); f.state.now = 201;
 assert.throws(() => f.store().publish(OP), /revision_review_expired_or_future/);
 f.state.now = 94; assert.throws(() => f.store().publish(OP), /revision_review_expired_or_future/);
 f.state.now = 100; f.validation.observed_at = 96; f.seal();
 assert.throws(() => f.store().publish(OP), /bound_validation_incomplete/);
});
test('symlink, hardlink and unsafe file mode are rejected', t => {
 const f = fixture(t), file = path.join(f.sealed, 'review.json'), original = fs.readFileSync(file);
 fs.unlinkSync(file); fs.symlinkSync('missing', file);
 assert.throws(() => f.store().publish(OP)); fs.unlinkSync(file);
 fs.writeFileSync(file, original, { mode: 0o600 }); fs.linkSync(file, path.join(f.root, 'hardlink'));
 assert.throws(() => f.store().publish(OP), /unsafe_revision_file/); fs.unlinkSync(path.join(f.root, 'hardlink'));
 fs.chmodSync(file, 0o644); assert.throws(() => f.store().publish(OP), /unsafe_revision_file/);
});
test('protected directory replacement and dangling revocation are rejected', t => {
 const f = fixture(t), store = f.store();
 fs.renameSync(f.paths.preparedRoot, f.paths.preparedRoot + '-old'); fs.mkdirSync(f.paths.preparedRoot, { mode: 0o700 });
 assert.throws(() => store.publish(OP), /revision_directory_replaced/);
 fs.symlinkSync('absent', path.join(f.paths.reviewsRoot, 'revoked'));
 assert.throws(() => f.store().publish(OP), /revision_publication_revoked/);
});
test('busy lease refuses without records and releases after validation failure', t => {
 const f = fixture(t); f.state.held = true;
 assert.throws(() => f.store().publish(OP), /synthetic_lock_busy/); assert.deepEqual(outputs(f), []);
 f.state.held = false; f.write('after.json', []);
 assert.throws(() => f.store().publish(OP)); assert.equal(f.state.held, false);
});
test('interrupted publication remains reconciliation-only and never writes again', t => {
 const f = fixture(t), store = f.store(); f.state.failOn = 4;
 assert.throws(() => store.publish(OP), /synthetic_guard_refusal/);
 const existing = fs.readdirSync(f.paths.preparedRoot); assert.equal(existing.length, 1);
 const ino = fs.statSync(path.join(f.paths.preparedRoot, existing[0])).ino;
 f.state.failOn = 0;
 assert.equal(store.publish(OP).state, 'publication_incomplete_reconcile_only');
 assert.deepEqual(fs.readdirSync(f.paths.preparedRoot), existing);
 assert.equal(fs.statSync(path.join(f.paths.preparedRoot, existing[0])).ino, ino);
 assert.equal(f.state.held, false);
});
test('existing foreign output is never overwritten and changed publication is detected', t => {
 const f = fixture(t), file = path.join(f.paths.preparedRoot, OP + '-apply.json');
 fs.writeFileSync(file, '{}', { mode: 0o600 });
 assert.throws(() => f.store().publish(OP), /existing_revision_output_requires_reconciliation/);
 assert.equal(fs.readFileSync(file, 'utf8'), '{}'); fs.unlinkSync(file); const store = f.store(); store.publish(OP);
 fs.writeFileSync(file, '{}'); assert.throws(() => store.publish(OP), /published_record_changed/);
});
test('journal and output bounds are enforced before publication intent', t => {
 const f = fixture(t);
 for (let i = 0; i < 64; i++) fs.mkdirSync(path.join(f.paths.journalRoot, i.toString(16).padStart(32, '0')), { mode: 0o700 });
 assert.throws(() => f.store().publish(OP), /revision_journal_capacity/); assert.deepEqual(outputs(f), []);
 assert.equal(fs.existsSync(path.join(f.paths.journalRoot, OP)), false);
});
test('same bytes on a replacement inode do not become this publication', t => {
 const f = fixture(t), store = f.store(); store.publish(OP);
 const file = path.join(f.paths.preparedRoot, OP + '-apply.json'), content = fs.readFileSync(file);
 fs.renameSync(file, file + '-original'); fs.writeFileSync(file, content, { mode: 0o600 });
 assert.throws(() => store.publish(OP), /published_record_changed/);
});
test('Python admission consumes actual publication and rejects incomplete or replaced records', t => {
 const f = fixture(t); f.store().publish(OP);
 const script = `import json,os,sys
from pathlib import Path
sys.path.insert(0,sys.argv[1])
from revision_review import PublishedNodeRedReviews
p=json.loads(sys.argv[2]);op=p['op']
r=PublishedNodeRedReviews(p['reviews'],p['prepared'],p['journal'],{op:p['sha']},os.getuid())
row=json.loads((Path(p['reviews'])/(op+'-apply.json')).read_bytes())
assert r.read(row['binding'],p['principal'])==row
receipt=Path(p['journal'])/op/'receipt.json'
receipt.rename(receipt.with_suffix('.held'))
try:r.read(row['binding'],p['principal']);raise AssertionError('partial publication admitted')
except FileNotFoundError:pass
receipt.with_suffix('.held').rename(receipt)
original=Path(p['prepared'])/(op+'-rollback.json');content=original.read_bytes()
original.rename(original.with_suffix('.held'));original.write_bytes(content);original.chmod(0o600)
try:r.read(row['binding'],p['principal']);raise AssertionError('foreign inode admitted')
except ValueError as e:assert str(e)=='published_record_changed'
print('publication_admission_verified')
`;
 const result = spawnSync('python3', ['-I', '-S', '-B', '-c', script, __dirname,
  JSON.stringify({ op: OP, principal: PRINCIPAL, sha: sha(raw(f.review)), reviews: f.paths.reviewsRoot,
   prepared: f.paths.preparedRoot, journal: f.paths.journalRoot })], { encoding: 'utf8', timeout: 5000 });
 assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout.trim(), 'publication_admission_verified');
});
