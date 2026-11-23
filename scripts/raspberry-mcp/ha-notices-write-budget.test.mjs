// The HA notice collector heartbeat must not rewrite its files with fsync on
// every 5 s tick: that was ~8 GiB/day of synchronous writes on the SD card.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const exported = process.env.HA_NOTICES_COLLECTOR_DIR || path.join(here, 'runtime-source', 'ha-notices');
const require = createRequire(path.join(exported, 'x.cjs'));
const collector = require('./notification_collector.cjs');
const {NotificationState} = require('./notification_state.cjs');
const source = fs.readFileSync(path.join(exported, 'notification_collector.cjs'), 'utf8');

// Clock fields alone never count as a content change.
const state = new NotificationState(null);
const first = {...state.snapshot(1_000), private_content: {state: 'observed', observed_at: 'a'}};
const later = {...state.snapshot(61_000), private_content: {state: 'observed', observed_at: 'b'}};
later.last_transport_confirmation_at = new Date(60_000).toISOString();
assert.notEqual(first.observed_at, later.observed_at);
assert.equal(collector.snapshotContent(first), collector.snapshotContent(later));
assert.notEqual(collector.snapshotContent(first),
  collector.snapshotContent({...later, collection_error: 'connection_closed'}));
const events = {schema_version: 1, events: [], sequence: 3, published_at: 'x', capture: {state: 'observed', observed_at: 'x'}};
assert.equal(collector.eventsContent(events),
  collector.eventsContent({...events, published_at: 'y', capture: {state: 'observed', observed_at: 'y'}}));
assert.notEqual(collector.eventsContent(events), collector.eventsContent({...events, sequence: 4}));

// The public snapshot stays fresh for its 20 s staleness reader.
assert.ok(collector.PUBLIC_REFRESH_MS <= 10_000);
assert.match(source, /now-publicAt>=PUBLIC_REFRESH_MS/);
assert.match(source, /if\(changed\)\{atomic\(STATE,'cache\.json'/);
assert.match(source, /if\(eventContent!==publishedEvents\)/);

// A non-durable write still lands atomically with the requested mode.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ha-notices-'));
fs.chmodSync(dir, 0o700);
collector.atomic(dir, 'snapshot.json', {ok: true}, 0o640, false);
collector.atomic(dir, 'cache.json', {ok: true}, 0o600);
assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'snapshot.json'))), {ok: true});
assert.equal(fs.statSync(path.join(dir, 'snapshot.json')).mode & 0o777, 0o640);
assert.equal(fs.statSync(path.join(dir, 'cache.json')).mode & 0o777, 0o600);
assert.deepEqual(fs.readdirSync(dir).filter((name) => name.endsWith('.new')), []);
fs.rmSync(dir, {recursive: true});
console.log('HA notice collector write budget passed.');
