import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {decodeEnvelope,canonical,digest,ackFor,receiptFacts,sumCounts,zeroCounts,ProtocolInvalid,uint} from './consumer_protocol.mjs';
const fixture=JSON.parse(readFileSync(new URL('./synthetic-protocol-fixture.json',import.meta.url),'utf8'));
const clone=x=>structuredClone(x);
function rehash(value){
  if(value.body.packet)value.body.packet.sha256=digest(value.body.packet.body);
  value.sha256=digest(value.body);return value;
}
const decode=value=>decodeEnvelope(canonical(value));
test('Python canonical envelope and packet SHA agree with JavaScript',()=>{
  const value=decode(fixture.first);
  assert.equal(value.sha256,digest(value.body));
  assert.equal(value.body.packet.sha256,digest(value.body.packet.body));
  assert.equal(value.body.packet.body.aggregate.counts.stats.publish_in.observed,'2');
});
test('exact bucket identity forms the only allowed ACK fields',()=>{
  const packet=decode(fixture.first).body.packet;
  assert.deepEqual(ackFor(packet),{schema_version:1,bucket_id:'1',sha256:packet.sha256});
});
test('absolute nanoseconds above JS safe integer remain decimal strings',()=>{
  const value=clone(fixture.first);value.body.packet.body.published_at_ns='9007199254740993';
  const result=decode(rehash(value));assert.equal(result.body.packet.body.published_at_ns,'9007199254740993');
});
test('tampering without recomputing both hashes is rejected',()=>{
  const value=clone(fixture.first);value.body.packet.body.aggregate.counts.frames='999';
  assert.throws(()=>decode(value),ProtocolInvalid);
});
test('duplicate JSON keys never override a conflicting earlier value',()=>{
  const raw=canonical(fixture.first).replace('"schema_version":1','"schema_version":2,"schema_version":1');
  assert.throws(()=>decodeEnvelope(raw),ProtocolInvalid);
});
test('noncanonical trailing whitespace is rejected before ACK',()=>{
  assert.throws(()=>decodeEnvelope(canonical(fixture.first)+'\n'),ProtocolInvalid);
});
test('rehashing cannot hide extra private fields',()=>{
  const value=clone(fixture.first);value.body.private='PRIVATE_CANARY';
  assert.throws(()=>decode(rehash(value)),ProtocolInvalid);
});
test('rehashing cannot hide inconsistent expected and observed counters',()=>{
  const value=clone(fixture.first);value.body.packet.body.aggregate.counts.stats.publish_in.expected='3';
  assert.throws(()=>decode(rehash(value)),ProtocolInvalid);
});
test('rehashing cannot skip a not-yet-acknowledged bucket',()=>{
  const value=clone(fixture.first);value.body.packet.body.bucket_id='3';
  assert.throws(()=>decode(rehash(value)),ProtocolInvalid);
});
test('previous receipt must agree with separately retained Root receipt',()=>{
  const value=clone(fixture.second);value.body.packet.body.previous_ack=null;
  assert.throws(()=>decode(rehash(value)),ProtocolInvalid);
});
test('known timing cannot omit its source timestamp',()=>{
  const value=clone(fixture.first);value.body.packet.body.aggregate.oldest_source_ns.publish_in=null;
  assert.throws(()=>decode(rehash(value)),ProtocolInvalid);
});
test('receipt bound includes delay after the socket reader and publication',()=>{
  const packet=decode(fixture.first).body.packet,receipt=decode(fixture.done).body.last_ack;
  const facts=receiptFacts(packet,receipt).by_kind.publish_in;
  assert.equal(facts.source_to_consumer_upper_ns,'350');
  assert.equal(facts.source_to_consumer_upper_ms,1);
  assert.equal(facts.timed,'2');
});
test('recomputed source-to-ACK bound rejects a forged advertised maximum',()=>{
  const packet=decode(fixture.first).body.packet,receipt=clone(fixture.done.body.last_ack);
  receipt.source_to_ack.publish_in.upper_ns='1';
  assert.throws(()=>receiptFacts(packet,receipt),ProtocolInvalid);
});
test('clock discontinuity remains unknown rather than zero latency',()=>{
  const packet=decode(fixture.first).body.packet,receipt=clone(fixture.done.body.last_ack);
  receipt.ack_clock_domain_id='e'.repeat(64);receipt.ack_at_ns='20';receipt.clock_ordered=false;receipt.publication_to_ack_ns=null;
  for(const row of Object.values(receipt.source_to_ack)){row.timing_unknown=row.observed;row.timed='0';row.upper_ns=null;}
  const facts=receiptFacts(packet,receipt);
  assert.equal(facts.clock_ordered,false);assert.equal(facts.by_kind.publish_in.timing_unknown,'2');
  assert.equal(facts.by_kind.publish_in.source_to_consumer_upper_ms,null);
});
test('ceiling conversion preserves a one-nanosecond crossing of 10 seconds',()=>{
  const packet=decode(fixture.first).body.packet,receipt=clone(fixture.done.body.last_ack);
  receipt.ack_at_ns='10000000151';receipt.publication_to_ack_ns='9999999751';
  receipt.source_to_ack.publish_in.upper_ns='10000000001';
  const facts=receiptFacts(packet,receipt).by_kind.publish_in;
  assert.equal(facts.source_to_consumer_upper_ns,'10000000001');
  assert.equal(facts.source_to_consumer_upper_ms,10001);
});
test('128-bit cumulative counters are added without Number rounding',()=>{
  const a=zeroCounts(),b=zeroCounts(),large=1n<<90n;
  a.frames=large.toString();b.frames='1';
  for(const key of ['expected','observed','timed'])a.stats.publish_in[key]=large.toString();
  for(const key of ['expected','observed','timed'])b.stats.publish_in[key]='1';
  const result=sumCounts(a,b);
  assert.equal(result.frames,(large+1n).toString());assert.equal(result.stats.publish_in.observed,(large+1n).toString());
  assert.throws(()=>uint(Number.MAX_SAFE_INTEGER),ProtocolInvalid);
});
test('bad JSON error does not echo private source text',()=>{
  assert.throws(()=>decodeEnvelope('PRIVATE_CANARY'),error=>error.message==='metadata_protocol_invalid');
});
test('oversized and non-ASCII envelopes fail closed',()=>{
  assert.throws(()=>decodeEnvelope(' '.repeat(65537)),ProtocolInvalid);
  assert.throws(()=>decodeEnvelope(Buffer.from([255])),ProtocolInvalid);
});
test('counter overflow is rejected rather than wrapped',()=>{
  const a=zeroCounts(),b=zeroCounts();a.frames=((1n<<128n)-1n).toString();b.frames='1';
  assert.throws(()=>sumCounts(a,b),ProtocolInvalid);
});
