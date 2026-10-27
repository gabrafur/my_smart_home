import assert from 'node:assert/strict';
import {hostTimingTransition as observe} from './host-observation-timing.mjs';
import {frame} from './host-timing-fixtures.mjs';

const healthy=observe(observe(null,frame()),frame(20));
const prior=structuredClone(healthy);
const rejected=frame(40);rejected.reader.boot_id_sha256='c'.repeat(64);
const bad=observe(healthy,rejected);
assert.equal(bad.collection_error,'reader_clock_unavailable');
assert.equal(bad.invalid_reason_history.counts.reader_clock_unavailable,1);
assert.deepEqual(bad.invalid_reason_history.recent,[{reason:'reader_clock_unavailable',observed_at:new Date(rejected.now_ms).toISOString(),epoch:healthy.epoch}]);
assert.deepEqual(healthy,prior,'inputs remain immutable');
const recovered=observe(bad,frame(60));
assert.equal(recovered.state,'observed');
assert.deepEqual(recovered.invalid_reason_history,bad.invalid_reason_history,'recovery retains the reason');
assert.equal(recovered.invalid_observations,1);

const legacy=structuredClone(healthy);delete legacy.invalid_reason_history;
legacy.invalid_observations=1;legacy.past_counters[19]=2;
const migrated=observe(legacy,frame(40));
assert.equal(migrated.epoch,legacy.epoch,'instrumentation must not restart the measurement epoch');
assert.equal(migrated.started_at,legacy.started_at);
assert.deepEqual(migrated.anchors[0],legacy.anchors[0]);
assert.equal(migrated.invalid_reason_history.unattributed_prior_count,3);
assert.ok(Object.values(migrated.invalid_reason_history.counts).every(n=>n===0));
const afterMigration=observe(migrated,rejected);
assert.equal(afterMigration.invalid_reason_history.unattributed_prior_count,3);
assert.equal(afterMigration.invalid_reason_history.counts.reader_clock_unavailable,1);

const uncovered=structuredClone(recovered);uncovered.invalid_observations+=2;
const resumed=observe(uncovered,frame(80));
assert.equal(resumed.invalid_reason_history.covered_total,3);
assert.equal(resumed.invalid_reason_history.unattributed_prior_count,2);
assert.deepEqual(resumed.invalid_reason_history.counts,recovered.invalid_reason_history.counts);
assert.equal(resumed.epoch,recovered.epoch,'old-producer observations remain unknown without resetting the window');

const restarted=observe(recovered,{...frame(80),runtime_restarted:true});
assert.equal(restarted.epoch,recovered.epoch+1);
assert.deepEqual(restarted.invalid_reason_history,recovered.invalid_reason_history);
assert.equal(restarted.past_counters[19],1);
assert.deepEqual(observe(JSON.parse(JSON.stringify(restarted)),frame(100)).invalid_reason_history,restarted.invalid_reason_history);

let repeated=healthy;
for(let i=0;i<40;i++)repeated=observe(repeated,rejected);
assert.equal(repeated.invalid_reason_history.recent.length,16);
assert.equal(repeated.invalid_reason_history.counts.reader_clock_unavailable,40);
assert.equal(repeated.invalid_observations,40);
assert.equal(repeated.sources.resources.observed,healthy.sources.resources.observed);
assert.ok(JSON.stringify(repeated.invalid_reason_history).length<3000);

for(const [alter,reason]of [
 [x=>x.limits.event_latency_ms=0,'measurement_policy_unavailable'],
 [x=>x.report=null,'report_unavailable_or_stale'],
 [x=>x.report.timing_v1.resource_sample_sequence=-1,'producer_timing_unavailable'],
 [x=>x.report.timing_v1.clock_stable=false,'producer_clock_unstable'],
 [x=>x.reader.boot_id_sha256='c'.repeat(64),'reader_clock_unavailable'],
 [x=>x.reader.monotonic_seconds=0,'clock_alignment_unconfirmed'],
 [x=>x.report.timing_v1.resource_sample_sequence=0,'producer_counter_reversed']]){
 const input=structuredClone(frame(40));alter(input);const result=observe(healthy,input);
 assert.equal(result.collection_error,reason);
 assert.equal(result.invalid_reason_history.counts[reason],1);
 assert.equal(result.invalid_reason_history.recent.at(-1).reason,reason);
}
const unknownTime=frame(40);unknownTime.now_ms=NaN;
assert.equal(observe(healthy,unknownTime).invalid_reason_history.recent[0].observed_at,null);
for(const alter of [
 x=>x.invalid_reason_history.counts.PRIVATE_SENTINEL=1,
 x=>x.invalid_reason_history.unattributed_prior_count=1,
 x=>x.invalid_reason_history.recent=Array(17).fill({reason:'reader_clock_unavailable',observed_at:null,epoch:1}),
 x=>x.invalid_reason_history.recent=[{reason:'PRIVATE_SENTINEL',observed_at:null,epoch:1}]
]){
 const input=structuredClone(healthy);alter(input);const result=observe(input,frame(40));
 assert.equal(result.state,'unknown');assert.equal(result.collection_error,'reason_history_invalid');
 assert.deepEqual(result.sources,input.sources,'corrupt reason metadata never resets counters');
 assert.deepEqual(result.invalid_reason_history,input.invalid_reason_history,'preserve corrupt evidence for explicit review');
}
console.log('Passive reason history: attribution, recovery, legacy unknowns, restart, bounded retention and fail-closed corruption passed.');
