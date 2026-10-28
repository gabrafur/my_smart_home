import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {canonical,digest,zeroCounts} from './consumer_protocol.mjs';
import {initialState,validateState,transition,ConsumerInvalid} from './consumer_state.mjs';
const fixture=JSON.parse(readFileSync(new URL('./synthetic-protocol-fixture.json',import.meta.url),'utf8'));
const raw=value=>canonical(value);
const clone=value=>structuredClone(value);
function rehash(value){
  if(value.body.packet)value.body.packet.sha256=digest(value.body.packet.body);
  value.sha256=digest(value.body);return value;
}
test('initial bootstrap records packet and exposes ACK without assuming delivery',()=>{
  const out=transition(null,raw(fixture.first));
  assert.equal(out.state.last_packet,'1');assert.equal(out.state.last_receipt,'0');
  assert.equal(out.state.received_counts.stats.publish_in.observed,'2');
  assert.equal(out.state.acked_counts.stats.publish_in.observed,'0');
  assert.equal(out.ack.bucket_id,'1');assert.equal(out.receipt_facts.length,0);
  assert.equal(out.full24h_proven,false);validateState(out.state);
});
test('a resumed pending packet is identical and never counted twice',()=>{
  const first=transition(null,raw(fixture.first));
  const resumed=transition(JSON.parse(JSON.stringify(first.state)),raw(fixture.first));
  assert.equal(resumed.changed,false);assert.deepEqual(resumed.state,first.state);
  assert.deepEqual(resumed.ack,first.ack);
});
test('resuming after ACK file commit but before observing Root receipt is exact',()=>{
  const first=transition(null,raw(fixture.first)).state;
  const resumed=transition(JSON.parse(JSON.stringify(first)),raw(fixture.done));
  assert.equal(resumed.state.last_receipt,'1');assert.equal(resumed.state.pending,null);
  assert.equal(resumed.state.acked_counts.stats.publish_in.observed,'2');
  assert.equal(resumed.state.timing.publish_in.timed,'2');
  assert.equal(resumed.state.timing.publish_in.max_upper_ns,'350');
  assert.equal(resumed.receipt_facts.length,1);assert.equal(resumed.ack,null);
});
test('a repeated Root receipt is idempotent across process restart',()=>{
  const first=transition(null,raw(fixture.first)).state;
  const done=transition(first,raw(fixture.done)).state;
  const repeat=transition(JSON.parse(JSON.stringify(done)),raw(fixture.done));
  assert.equal(repeat.changed,false);assert.deepEqual(repeat.state,done);
  assert.equal(repeat.receipt_facts.length,0);
});
test('one read can correlate the old receipt and prepare the next immutable packet',()=>{
  const first=transition(null,raw(fixture.first)).state;
  const second=transition(first,raw(fixture.second));
  assert.equal(second.state.last_packet,'2');assert.equal(second.state.last_receipt,'1');
  assert.equal(second.state.received_counts.stats.publish_in.observed,'3');
  assert.equal(second.state.acked_counts.stats.publish_in.observed,'2');
  assert.equal(second.state.pending.body.bucket_id,'2');assert.equal(second.ack.bucket_id,'2');
});
test('missing historical consumer state never silently adopts already acknowledged counters',()=>{
  for(const value of [fixture.done,fixture.second])
    assert.throws(()=>transition(null,raw(value)),error=>error instanceof ConsumerInvalid&&error.code==='consumer_history_missing');
});
test('producer counter rewind is rejected without modifying prior durable state',()=>{
  const first=transition(null,raw(fixture.first)).state,done=transition(first,raw(fixture.done)).state;
  const original=canonical(done);
  assert.throws(()=>transition(done,raw(fixture.first)),error=>error.code==='producer_counter_reversed');
  assert.equal(canonical(done),original);
});
test('a Root receipt cannot be correlated without the saved pending packet',()=>{
  const state=initialState();state.report_clock_domain_id='d'.repeat(64);
  assert.throws(()=>transition(state,raw(fixture.done)),error=>error.code==='uncorrelated_producer_receipt');
});
test('recomputed outer hashes cannot erase an already observed pending packet',()=>{
  const first=transition(null,raw(fixture.first)).state,value=clone(fixture.first);value.body.packet=null;
  assert.throws(()=>transition(first,raw(rehash(value))),error=>error.code==='producer_packet_missing');
});
test('saved pending-body tampering is rejected even if local state CRC is recomputed later',()=>{
  const state=transition(null,raw(fixture.first)).state;
  state.pending.body.aggregate.counts.frames='100';
  assert.throws(()=>validateState(state),ConsumerInvalid);
});
test('consumer source counts must equal acknowledged plus exactly one pending bucket',()=>{
  const state=transition(null,raw(fixture.first)).state;
  state.received_counts=zeroCounts();assert.throws(()=>validateState(state),ConsumerInvalid);
});
test('Root and consumer acknowledgement totals must agree before a new ACK is exposed',()=>{
  const state=transition(null,raw(fixture.first)).state,value=clone(fixture.done);
  value.body.acked_counts.frames='999';
  assert.throws(()=>transition(state,raw(rehash(value))),error=>error.code==='producer_accounting_conflict');
});
test('changed Root receipt identity cannot be accepted twice',()=>{
  const first=transition(null,raw(fixture.first)).state,done=transition(first,raw(fixture.done)).state;
  const value=clone(fixture.done);value.body.last_ack.ack_at_ns='501';
  value.body.last_ack.publication_to_ack_ns='101';value.body.last_ack.source_to_ack.publish_in.upper_ns='351';
  assert.throws(()=>transition(done,raw(rehash(value))),error=>error.code==='producer_receipt_conflict');
});
test('producer clock-domain changes are preserved rather than resetting counters',()=>{
  const first=transition(null,raw(fixture.first)).state,value=clone(fixture.first);
  value.body.source_clock_domain_id='e'.repeat(64);
  const next=transition(first,raw(rehash(value)));
  assert.equal(next.state.clock_domain_changes,'1');
  assert.deepEqual(next.state.received_counts,first.received_counts);
});
test('invalid producer payload does not echo private text or acknowledge anything',()=>{
  assert.throws(()=>transition(null,'PRIVATE_CANARY'),error=>error.code==='producer_report_invalid'&&!error.message.includes('PRIVATE'));
});
