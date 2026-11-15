// Synthetic source/store replay. No policy, real store, network or household effects.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { PrivateNoticeModel } = require('./private_notice_model.cjs');
const { PrivateCapture } = require('./private_capture.cjs');
const ordered = value => Array.isArray(value) ? value.map(ordered)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])])) : value;
const frame = () => ({ type: 'current', notifications: {
  fixture_notice: { notification_id: 'fixture_notice', title: 'Fixture title',
    message: 'Fixture body', created_at: '2026-11-15T01:00:00Z' }
} });

function store() {
  let snapshot = null;
  let loseReply = false;
  return {
    load: () => ({ snapshot: structuredClone(snapshot), digest: snapshot ? 'a'.repeat(64) : null }),
    commit: value => {
      snapshot = JSON.parse(JSON.stringify(ordered(value)));
      if (loseReply) { loseReply = false; throw Error('private_store_reply_unconfirmed'); }
      return { state: 'private_observation_committed', digest: 'a'.repeat(64) };
    },
    loseNextReply: () => { loseReply = true; },
    snapshot: () => structuredClone(snapshot)
  };
}

test('canonical reload accepts identical content and preserves immutable first observation', () => {
  const backend = store();
  new PrivateCapture(backend).observe(frame(), [], '2026-11-15T01:01:00Z');
  const original = backend.snapshot().records[0];
  const capture = new PrivateCapture(backend);
  capture.observe(frame(), [], '2026-11-15T01:02:00Z');
  const after = backend.snapshot();
  assert.deepEqual(after.records[0], original);
  assert.equal(after.observed_at, '2026-11-15T01:02:00.000Z');
  assert.equal(after.sequence, 0);
  assert.equal(capture.status().collection_error, null);
});

test('repeated current frames after reconnect preserve one record and no false events', () => {
  const backend = store();
  const capture = new PrivateCapture(backend);
  capture.observe(frame(), [], '2026-11-15T01:01:00Z');
  capture.reconnect();
  capture.observe(frame(), [], '2026-11-15T01:02:00Z');
  capture.reconnect();
  capture.observe(frame(), [], '2026-11-15T01:03:00Z');
  assert.equal(backend.snapshot().records.length, 1);
  assert.equal(backend.snapshot().sequence, 0);
});

test('uncertain commit is observed before accepting the next current frame', () => {
  const backend = store();
  const capture = new PrivateCapture(backend);
  backend.loseNextReply();
  assert.throws(() => capture.observe(frame(), [], '2026-11-15T01:01:00Z'), /private_store_reply_unconfirmed/);
  assert.equal(capture.uncertain, true);
  capture.observe(frame(), [], '2026-11-15T01:02:00Z');
  assert.equal(capture.uncertain, false);
  assert.equal(capture.pending, null);
  assert.equal(backend.snapshot().records.length, 1);
  assert.equal(backend.snapshot().sequence, 0);
});

test('new content produces a new private revision and one update after reload', () => {
  const backend = store();
  new PrivateCapture(backend).observe(frame(), [], '2026-11-15T01:01:00Z');
  const next = frame(); next.notifications.fixture_notice.message = 'Changed fixture body';
  new PrivateCapture(backend).observe(next, [], '2026-11-15T01:02:00Z');
  assert.equal(backend.snapshot().records.length, 2);
  assert.equal(backend.snapshot().events.length, 1);
  assert.equal(backend.snapshot().events[0].phase, 'updated');
});

test('tampering with immutable content while keeping its digest remains rejected', () => {
  const backend = store();
  new PrivateCapture(backend).observe(frame(), [], '2026-11-15T01:01:00Z');
  const bad = backend.snapshot(); bad.records[0].text.message = 'Tampered fixture';
  assert.throws(() => new PrivateNoticeModel(bad), /invalid_private_projection/);
});

// Private body remains data. Only opaque references enter event projections.
test('sanitization removes fixture credentials while retaining diagnostic text', () => {
  const { projectPersistent } = require('./notification_text.cjs');
  const projected = projectPersistent({ notification_id: 'synthetic_notice', title: 'Fixture title',
    message: 'Diagnostic detail password=FIXTURE_PASSWORD_VALUE\nAuthorization: Bearer FIXTURE_BEARER_VALUE\nOTP 123456' },
    '2026-11-15T01:01:00Z');
  assert.equal(projected.text.message.includes('Diagnostic detail'), true);
  for (const secret of ['FIXTURE_PASSWORD_VALUE', 'FIXTURE_BEARER_VALUE', '123456'])
    assert.equal(projected.text.message.includes(secret), false);
  assert.equal(projected.execution_authority, false);
  assert.equal(projected.untrusted_source_text, true);
});

test('event references never contain a private title or body and removal is not recovery', () => {
  const backend = store();
  const capture = new PrivateCapture(backend);
  capture.observe(frame(), [], '2026-11-15T01:01:00Z');
  capture.observe({ type: 'current', notifications: {} }, [], '2026-11-15T01:02:00Z');
  const events = capture.events();
  assert.equal(JSON.stringify(events).includes('Fixture title'), false);
  assert.equal(JSON.stringify(events).includes('Fixture body'), false);
  assert.equal(events.events[0].phase, 'removed');
  assert.equal(events.events[0].recovery_proven, false);
});

test('a delta before a full baseline is refused before backend access', () => {
  let reads = 0;
  const capture = new PrivateCapture({ load: () => { reads++; throw Error('unexpected_load'); } });
  assert.throws(() => capture.observe({ type: 'updated', notifications: {} }, [], '2026-11-15T01:01:00Z'),
    /private_full_snapshot_required/);
  assert.equal(reads, 0);
});
