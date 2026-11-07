const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { CodexUsageReader, scanCodexUsage } = require('./usage');

// Fixed synthetic clock; no household event timestamps are used in fixtures.
function syntheticTime(day, hour, minute = 0, second = 0) {
  return new Date(Date.UTC(2026, 7, day, hour, minute, second)).toISOString();
}

function event(total, timestamp = syntheticTime(16, 10, 0, 0), extra = {}) {
  return JSON.stringify({ timestamp, type: 'event_msg', payload: {
    type: 'token_count', info: { total_token_usage: { input_tokens: total, total_tokens: total } },
    rate_limits: { plan_type: 'plus', primary: { used_percent: total, window_minutes: 10080, resets_at: 1787499010 } },
  }, ...extra });
}

function fixture(t, options = { appendOnlySessionFiles: true }) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-incremental-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'session.jsonl');
  const reader = new CodexUsageReader(directory, null, null, 0, null, null, null, options);
  return { directory, file, reader };
}

function countReads(t, target) {
  const actual = fs.readSync; let bytes = 0;
  const identity = fs.statSync(target);
  fs.readSync = function counted(fd, ...args) {
    const stat = fs.fstatSync(fd); const count = actual.call(this, fd, ...args);
    if (stat.dev === identity.dev && stat.ino === identity.ino) bytes += count;
    return count;
  };
  t.after(() => { fs.readSync = actual; });
  return { get bytes() { return bytes; }, reset() { bytes = 0; } };
}

test('active growing session reads only append plus bounded anchors', (t) => {
  const { file, reader } = fixture(t);
  const irrelevant = `${JSON.stringify({ type: 'response_item', text: 'fictional'.repeat(128) })}\n`;
  fs.writeFileSync(file, irrelevant.repeat(1024) + `${event(100)}\n`);
  const reads = countReads(t, file);
  assert.equal(reader.read().totals.total_tokens, 100);
  reads.reset(); const append = `${event(150, syntheticTime(16, 10, 1, 0))}\n`;
  fs.appendFileSync(file, append);
  assert.equal(reader.read().totals.total_tokens, 150);
  assert.ok(reads.bytes <= Buffer.byteLength(append) + 4096, `unexpected indexed read bytes: ${reads.bytes}`);
  reads.reset(); assert.equal(reader.read().totals.total_tokens, 150); assert.equal(reads.bytes, 0);
});

test('complete trailing event is provisional and commits only once', (t) => {
  const { file, reader } = fixture(t);
  fs.writeFileSync(file, event(10));
  assert.equal(reader.read().totals.total_tokens, 10);
  fs.appendFileSync(file, '\n'); assert.equal(reader.read().totals.total_tokens, 10);
  fs.appendFileSync(file, event(25, syntheticTime(16, 10, 1, 0)));
  assert.equal(reader.read().totals.total_tokens, 25);
  fs.appendFileSync(file, '\n'); assert.equal(reader.read().totals.total_tokens, 25);
  assert.equal(reader.read().totals.events, 2);
});

test('partial JSON and split UTF-8 survive multiple polls without double counting', (t) => {
  const { file, reader } = fixture(t);
  fs.writeFileSync(file, `${event(10)}\r\n`);
  const next = Buffer.from(event(30, syntheticTime(16, 10, 1, 0), { note: 'ação fictícia' }));
  const split = next.indexOf(Buffer.from('ç')) + 1;
  fs.appendFileSync(file, next.subarray(0, split));
  assert.equal(reader.read().totals.total_tokens, 10);
  assert.equal(reader.read().totals.total_tokens, 10);
  fs.appendFileSync(file, next.subarray(split));
  assert.equal(reader.read().totals.total_tokens, 30);
  fs.appendFileSync(file, '\r\n'); assert.equal(reader.read().totals.total_tokens, 30);
});

test('truncation and replacement rotation discard only the old file index', (t) => {
  const { directory, file, reader } = fixture(t);
  const other = path.join(directory, 'other.jsonl');
  fs.writeFileSync(other, `${event(3)}\n`); fs.writeFileSync(file, `${event(100)}\n${event(150)}\n`);
  assert.equal(reader.read().totals.total_tokens, 153);
  fs.writeFileSync(file, `${event(7)}\n`); assert.equal(reader.read().totals.total_tokens, 10);
  const replacement = path.join(directory, 'replacement.tmp'); fs.writeFileSync(replacement, `${event(20)}\n`);
  fs.renameSync(replacement, file); assert.equal(reader.read().totals.total_tokens, 23);
  fs.rmSync(file); assert.equal(reader.read().totals.total_tokens, 3);
});

test('copy-truncate regrowth with changed prefix rebuilds instead of adding deltas', (t) => {
  const { file, reader } = fixture(t);
  fs.writeFileSync(file, `${event(100)}\n`); assert.equal(reader.read().totals.total_tokens, 100);
  fs.writeFileSync(file, `${event(5, syntheticTime(17, 10, 0, 0))}\n${JSON.stringify({ fictional_padding: 'x'.repeat(1024) })}\n`);
  assert.equal(reader.read().totals.total_tokens, 5);
});

test('same-size rewrite invalidates the fingerprint without reusing totals', (t) => {
  const { file, reader } = fixture(t);
  fs.writeFileSync(file, `${event(10)}\n`); assert.equal(reader.read().totals.total_tokens, 10);
  const previous = fs.statSync(file); fs.writeFileSync(file, `${event(20)}\n`);
  fs.utimesSync(file, previous.atime, new Date(previous.mtimeMs + 1000));
  assert.equal(reader.read().totals.total_tokens, 20);
});

test('concurrent append is included once on the next stable snapshot', (t) => {
  const { file, reader } = fixture(t);
  fs.writeFileSync(file, `${event(10)}\n`);
  const actual = fs.readSync; const identity = fs.statSync(file); let appended = false;
  fs.readSync = function appendDuringRead(fd, ...args) {
    const stat = fs.fstatSync(fd); const count = actual.call(this, fd, ...args);
    if (!appended && stat.dev === identity.dev && stat.ino === identity.ino) {
      appended = true; fs.appendFileSync(file, `${event(25, syntheticTime(16, 10, 1, 0))}\n`);
    }
    return count;
  };
  try { assert.equal(reader.read().totals.total_tokens, 10); }
  finally { fs.readSync = actual; }
  assert.equal(reader.read().totals.total_tokens, 25);
  assert.equal(reader.read().totals.total_tokens, 25);
});

test('unchanged files without token events are cached rather than rescanned', (t) => {
  const { file, reader } = fixture(t);
  fs.writeFileSync(file, `${JSON.stringify({ type: 'response_item', text: 'fictional' })}\n`);
  const reads = countReads(t, file); assert.equal(reader.read().status, 'no_data');
  reads.reset(); assert.equal(reader.read().status, 'no_data'); assert.equal(reads.bytes, 0);
});

test('incremental daily resets and snapshots match a fresh scan', (t) => {
  const { directory, file, reader } = fixture(t);
  fs.writeFileSync(file, `${event(100, syntheticTime(15, 23, 59, 59))}\n`); reader.read();
  fs.appendFileSync(file, `${event(150, syntheticTime(16, 0, 0, 1))}\n{fictional-invalid}\n${event(20, syntheticTime(16, 0, 0, 2))}`);
  const indexed = reader.read(); const fresh = scanCodexUsage(directory);
  assert.equal(indexed.totals.total_tokens, 170);
  assert.deepEqual(indexed.totals, fresh.totals); assert.deepEqual(indexed.daily, fresh.daily);
  // The dashboard reader intentionally requires an independent account sample.
  // A raw historical scan may expose the session limit; those contracts differ.
  assert.equal(indexed.rate_limit, null);
  assert.equal(indexed.rate_limit_updated_at, null);
  assert.equal(fresh.rate_limit.used_percent, 20);
  assert.equal(indexed.source_updated_at, fresh.source_updated_at);
});

test('concurrent truncation rebuilds a fresh snapshot without cached deltas', (t) => {
  const { file, reader } = fixture(t);
  fs.writeFileSync(file, `${event(10)}\n`); reader.read();
  fs.appendFileSync(file, `${JSON.stringify({ fictional_padding: 'x'.repeat(100000) })}\n${event(40)}\n`);
  const actual = fs.readSync; const identity = fs.statSync(file); let truncated = false;
  fs.readSync = function truncateDuringRead(fd, ...args) {
    const stat = fs.fstatSync(fd); const count = actual.call(this, fd, ...args);
    if (!truncated && stat.dev === identity.dev && stat.ino === identity.ino) {
      truncated = true; fs.writeFileSync(file, `${event(7, syntheticTime(17, 10, 0, 0))}\n`);
    }
    return count;
  };
  try { assert.equal(reader.read().totals.total_tokens, 7); }
  finally { fs.readSync = actual; }
  assert.equal(reader.read().totals.total_tokens, 7);
});

test('a malformed continuation removes only the provisional final event', (t) => {
  const { file, reader } = fixture(t);
  fs.writeFileSync(file, event(10)); assert.equal(reader.read().totals.total_tokens, 10);
  fs.appendFileSync(file, '{fictional-broken-continuation');
  assert.equal(reader.read().totals.total_tokens, 0);
  fs.appendFileSync(file, `\n${event(30)}\n`); assert.equal(reader.read().totals.total_tokens, 30);
});

test('unreadable file degrades historical totals and keeps independent account data', (t) => {
  const { directory, file, reader } = fixture(t);
  fs.writeFileSync(file, `${event(10)}\n`);
  const denied = path.join(directory, 'denied.jsonl'); fs.writeFileSync(denied, `${event(20)}\n`);
  const actual = fs.openSync;
  fs.openSync = function denyOneSource(name, ...args) {
    if (name === denied) { const error = new Error('synthetic_permission_denied'); error.code = 'EACCES'; throw error; }
    return actual.call(this, name, ...args);
  };
  try {
    const usage = reader.read({ timestamp: new Date(), rateLimits: {
      plan_type: 'plus', primary: { used_percent: 42, window_minutes: 10080, resets_at: 1787499010 },
    } });
    assert.equal(usage.status, 'degraded'); assert.equal(usage.error, 'session_source_unreadable');
    assert.equal(usage.totals, null); assert.equal(usage.analytics, null); assert.equal(usage.rate_limit.used_percent, 42);
  } finally { fs.openSync = actual; }
  assert.equal(reader.read().totals.total_tokens, 30);
});

test('uncontracted source rebuilds after an intermediate edit plus append', (t) => {
  const { file, reader } = fixture(t, {});
  const padding = `${JSON.stringify({ type: 'response_item', fictional_padding: 'x'.repeat(2048) })}\n`;
  const initial = padding + `${event(50)}\n` + padding + `${event(10)}\n` + padding + `${event(20)}\n` + padding;
  fs.writeFileSync(file, initial); assert.equal(reader.read().totals.total_tokens, 70);
  // The old prefix/suffix512 are unchanged; only a middle counter changes.
  const edited = initial.replace(event(10), event(60)); assert.equal(edited.length, initial.length);
  fs.writeFileSync(file, edited + `${event(40)}\n`);
  const usage = reader.read(); assert.equal(usage.totals.total_tokens, 100);
  assert.equal(usage.session_collection.strategy, 'strict_snapshot');
});

test('strict history snapshots coalesce for30s while live account data refreshes', (t) => {
  const { file, reader } = fixture(t, { historicalRefreshMs: 30_000 });
  const now = new Date(syntheticTime(16, 11, 0, 0)); fs.writeFileSync(file, `${event(10)}\n`);
  const first = reader.readCodexUsage(now); assert.equal(first.totals.total_tokens, 10);
  fs.appendFileSync(file, `${event(20, syntheticTime(16, 10, 1, 0))}\n`);
  const timestamp = new Date(now.valueOf() + 5000);
  const cached = reader.readCodexUsage(timestamp, { timestamp, rateLimits: {
    plan_type: 'plus', primary: { used_percent: 42, window_minutes: 10080, resets_at: 1787499010 },
  } });
  assert.equal(cached.totals.total_tokens, 10); assert.equal(cached.rate_limit.used_percent, 42);
  assert.equal(cached.rate_limit_updated_at, timestamp.toISOString());
  assert.equal(cached.session_collection.state, 'cached_snapshot'); assert.equal(cached.session_collection.age_seconds, 5);
  assert.equal(cached.session_collection.observed_at, now.toISOString());
  const fresh = reader.readCodexUsage(new Date(now.valueOf() + 30_000));
  assert.equal(fresh.totals.total_tokens, 20); assert.equal(fresh.session_collection.state, 'sampled');
  assert.equal(fresh.session_collection.age_seconds, 0);
});

test('coalesced session history does not cache Local AI telemetry', (t) => {
  const { directory, file } = fixture(t);
  const telemetry = path.join(directory, 'local.json'); fs.writeFileSync(file, `${event(10)}\n`);
  fs.writeFileSync(telemetry, JSON.stringify({ totals: { calls: 1 } }));
  const reader = new CodexUsageReader(directory, telemetry, null, 0, null, null, null, { historicalRefreshMs: 30_000 });
  assert.equal(reader.read().local_ai.totals.calls, 1);
  fs.appendFileSync(file, `${event(20)}\n`); fs.writeFileSync(telemetry, JSON.stringify({ totals: { calls: 2 } }));
  const next = reader.read(); assert.equal(next.totals.total_tokens, 10);
  assert.equal(next.local_ai.totals.calls, 2); assert.equal(next.session_collection.state, 'cached_snapshot');
});
