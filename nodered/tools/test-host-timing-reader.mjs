// The override permits review before replacing the reader used by the live flow.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {frame, event} from './host-timing-fixtures.mjs';
const path = process.env.HOST_TIMING_READER_SOURCE;
const reader = await import(path ? pathToFileURL(path).href : './read-host-observation.mjs');
const base = () => frame(20, {docker: 0, systemd: 1}, [event(20, 1)]).report;

let value = base();
assert.equal(reader.projectObservation(value).timing_v1.state, 'observed');
delete value.timing_v1;
assert.equal(reader.projectObservation(value).timing_v1, undefined);

value = base(); value.timing_v1.resource_sample_sequence = -1;
assert.equal(reader.projectObservation(value).timing_v1.state, 'unknown');
assert.equal(reader.projectObservation(value).events.length, 1);

for (const lag of [null, 0]) {
  value = base();
  value.events[0].occurred_at = value.events[0].observed_at.replace('.950Z', '.999Z');
  value.events[0].source_to_observer_ms = lag;
  assert.equal(reader.projectObservation(value).events[0].source_to_observer_ms, null);
}

value = base(); value.events[0].source_clock_ordered = null;
value.events[0].source_to_observer_ms = null;
assert.equal(reader.projectObservation(value).events[0].source_clock_ordered, null);

value = base(); value.private = 'PRIVATE_SENTINEL';
value.timing_v1.private = 'PRIVATE_SENTINEL'; value.events[0].private = 'PRIVATE_SENTINEL';
assert.ok(!JSON.stringify(reader.projectObservation(value)).includes('PRIVATE_SENTINEL'));
assert.throws(() => reader.projectObservation({...base(), events: Array(65).fill(event(20, 1))}));

const clock = reader.consumerClock();
assert.equal(clock.state, 'observed');
assert.equal(clock.boot_id_sha256, crypto.createHash('sha256')
  .update(fs.readFileSync('/proc/sys/kernel/random/boot_id')).digest('hex'));
assert.ok(clock.monotonic_seconds > 0 && Math.abs(Date.now() - Date.parse(clock.observed_at)) < 1000);
console.log('PASS: reader compatibility, optional timing, uncertain clocks, projection bounds and own clock');
