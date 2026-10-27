import assert from 'node:assert/strict';
import {hostTimingTransition as observe} from './host-observation-timing.mjs';
import {projectProducerTiming} from './host-timing-protocol.mjs';
import {wall, hash, limits, frame, event} from './host-timing-fixtures.mjs';
let state=observe(null,frame());assert.equal(state.state,'observed');assert.equal(state.epoch_reason,'initial_baseline');assert.equal(state.sources.resources.observed,0);
state=observe(state,frame(20));assert.equal(state.sources.resources.expected,1);assert.equal(state.sources.resources.observed,1);assert.equal(state.sources.resources.missing,0);
const before=structuredClone(state);state=observe(state,frame(20));assert.deepEqual(state,before,'repeat poll must not count another sample or report');
state=observe(state,frame(40,{docker:0,systemd:1},[event(40,1)]));assert.equal(state.sources.systemd.expected,1);assert.equal(state.sources.systemd.observed,1);assert.equal(state.sources.systemd.over_contract,0);assert.ok(state.sources.systemd.max_source_to_canvas_upper_ms>=1399);
state=observe(state,frame(60,{docker:0,systemd:1},[event(40,1)]));assert.equal(state.sources.systemd.observed,1,'retained ring is never replayed');
let gap=observe(state,frame(120,{docker:0,systemd:4},[event(120,4)]));assert.equal(gap.sources.resources.missing,2);assert.equal(gap.sources.systemd.missing,2);assert.equal(gap.report_gaps,1);
let transient=frame(80,{docker:0,systemd:1},[event(40,1)]);transient.report.timing_v1.source_fault_counts.systemd=1;
let faults=observe(state,transient);assert.equal(faults.source_faults,1,'transient disconnect remains counted after latest source is connected');
let badMetric=frame(80,{docker:0,systemd:1});badMetric.report.resources.data.cpu_busy_percent=null;let unknown=observe(state,badMetric);assert.equal(unknown.sources.resources.unknown,1);
let late=frame(80,{docker:1,systemd:1},[event(80,2,'docker')]);late.report.events[0].source_to_observer_ms=10000;
assert.equal(observe(state,late).sources.docker.over_contract,1,'explicit alignment bound is included');
let clock=frame(80,{docker:1,systemd:1},[event(80,2,'docker')]);clock.report.events[0].source_to_observer_ms=null;clock.report.events[0].source_clock_ordered=null;
assert.equal(observe(state,clock).sources.docker.unknown,1,'unknown source clocks are not zero latency');
for(const alter of [x=>x.reader.boot_id_sha256='c'.repeat(64),x=>x.reader.monotonic_seconds=1,x=>x.report.timing_v1.clock_stable=false,x=>x.report=null,x=>x.limits={event_latency_ms:0,resource_latency_ms:60000}]){
 const input=frame(80,{docker:0,systemd:1});alter(input);const invalid=observe(state,input);assert.equal(invalid.state,'unknown');assert.equal(invalid.sources.resources.observed,state.sources.resources.observed);assert.ok(invalid.invalid_observations>state.invalid_observations);
}
const backwards=frame(80);backwards.report.timing_v1.resource_sample_sequence=1;assert.equal(observe(state,backwards).collection_error,'producer_counter_reversed');
for(const alter of [x=>x.runtime_restarted=true,x=>x.report.instance_id='d'.repeat(64),x=>x.limits={event_latency_ms:9000,resource_latency_ms:60000},x=>x.report.timing_v1.clock_change_count=1,x=>x.now_ms+=2000]){
 const input=frame(80,{docker:0,systemd:1});alter(input);const epoch=observe(state,input);assert.equal(epoch.epoch,state.epoch+1);assert.equal(epoch.sources.resources.observed,0);assert.equal(epoch.previous_epochs,1);assert.ok(epoch.historical_unknown_epochs>0);assert.ok(epoch.past_counters.some(x=>x>0));
}
const corrupt=observe({version:1,instance:hash,sources:{}},frame(80));assert.equal(corrupt.state,'unknown');assert.equal(corrupt.collection_error,'accounting_state_invalid');
let run=observe(null,frame());
for(let tick=20;tick<=90000;tick+=20)run=observe(run,frame(tick));
assert.equal(run.state,'observed');assert.equal(run.sources.resources.expected,4500);assert.equal(run.sources.resources.observed,4500);assert.equal(run.sources.resources.missing,0);assert.equal(run.window24h.state,'candidate');assert.ok(run.window24h.minimum_span_seconds>=86400);assert.equal(run.anchors.length,25);assert.ok(JSON.stringify(run).length<16000);
assert.ok(run.window24h.counters.every(Number.isSafeInteger));assert.equal(run.window24h.counters[10],4320);assert.equal(run.window24h.counters[11],4320);
const proto=frame().report;const sanitized=projectProducerTiming({...proto,timing_v1:{...proto.timing_v1,private:'PRIVATE_SENTINEL'}});assert.equal(sanitized.state,'observed');assert.ok(!JSON.stringify(sanitized).includes('PRIVATE_SENTINEL'));
assert.equal(projectProducerTiming({...proto,timing_v1:{...proto.timing_v1,source_event_counts:{docker:99,systemd:0}}}).state,'unknown');
console.log('Passive host timing: healthy samples, identity accounting, losses, transient faults, clock/restart epochs and bounded synthetic 25h windows passed.');
