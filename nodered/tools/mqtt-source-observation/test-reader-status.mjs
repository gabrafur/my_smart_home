import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {canonical,schema} from './consumer_protocol.mjs';
import {clockDomain,decodeReaderStatus,ReaderStatusInvalid,localClock} from './reader_status.mjs';
const boot='00000000-0000-0000-0000-000000000001\n',offsets='monotonic 0 0\nboottime 0 0\n';
const domain=createHash('sha256').update(boot.trim()).digest('hex');
const fixture=()=>({schema_version:1,source:'fixed_mqtt_metadata_reader',reader_instance_sha256:'a'.repeat(64),
 clock_domain_sha256:domain,reader_started_boottime_ns:'1',reader_observed_boottime_ns:'100000',
 reader_observed_monotonic_ns:'10000',authorization_state:'active',source_authorized:true,last_intake_state:'accepted',
 last_successful_intake_completed_boottime_ns:'99999',accepted_frames:'1',reader_sessions:'1',
 faults:Object.fromEntries(schema.faults.map(k=>[k,'0'])),full24h_proven:false,all_event_latency_proven:false});
const raw=value=>Buffer.from(canonical(value));
test('clock domain matches Python boot SHA and requires both zero kernel offsets',()=>{
 assert.equal(clockDomain(boot,offsets),domain);
 for(const value of ['monotonic 1 0\nboottime 0 0\n','monotonic 0 0\n','monotonic 0 0\nmonotonic 0 0\n','monotonic 0 0\nboottime 0 0\nextra 0 0'])
  assert.throws(()=>clockDomain(boot,value),ReaderStatusInvalid);
});
test('exact nanosecond age rounds conservatively without assigning a freshness class',()=>{
 const v=decodeReaderStatus(raw(fixture()),{domain,nowNs:10100001n});
 assert.equal(v.status_age_ns,'10090001');assert.equal(v.status_age_ms,11);
 assert.equal(v.source_authorized,true);assert.equal(v.clock_domain_matches,true);
 assert.equal('fresh' in v,false);
});
test('old data stays a numeric age for the canonical visual rule',()=>{
 const v=decodeReaderStatus(raw(fixture()),{domain,nowNs:100000000000n});
 assert.equal(v.status_age_ms,100000);assert.equal(v.clock_ordered,true);
});
test('clock mismatch and future source clocks remain unknown rather than zero age',()=>{
 for(const clock of [{domain:'b'.repeat(64),nowNs:20000n},{domain,nowNs:9999n}]){
  const v=decodeReaderStatus(raw(fixture()),clock);assert.equal(v.status_age_ms,null);assert.equal(v.clock_ordered,false);
 }
});
test('disabled and revoked states are facts rather than a consumer decision',()=>{
 for(const state of ['disabled','expired','revoked']){
  const v=fixture();v.authorization_state=state;v.source_authorized=false;
  assert.equal(decodeReaderStatus(raw(v),{domain,nowNs:20000n}).source_authorized,false);
 }
});
test('invalid authorization may explicitly have unknown authorization',()=>{
 const v=fixture();v.authorization_state='invalid';v.source_authorized=null;
 assert.equal(decodeReaderStatus(raw(v),{domain,nowNs:20000n}).source_authorized,null);
});
test('closed schemas and counter/timestamp inconsistencies fail without echoing private text',()=>{
 for(const mutate of [
  v=>v.extra='PRIVATE_CANARY',v=>v.source='PRIVATE_CANARY',v=>v.schema_version=2,
  v=>v.source_authorized=false,v=>v.reader_started_boottime_ns='100001',
  v=>v.last_successful_intake_completed_boottime_ns='100001',v=>v.accepted_frames='-1',
  v=>v.reader_observed_monotonic_ns='18446744073709551616',v=>v.faults.extra='0',
  v=>v.full24h_proven=true,v=>v.reader_instance_sha256='bad',
 ]){
  const v=fixture();mutate(v);
  assert.throws(()=>decodeReaderStatus(raw(v),{domain,nowNs:20000n}),e=>e instanceof ReaderStatusInvalid&&!e.message.includes('PRIVATE'));
 }
});
test('noncanonical, duplicate, oversized or nonascii status bytes fail closed',()=>{
 for(const v of [Buffer.from('{}\n'),Buffer.from('{"schema_version":1,"schema_version":1}'),Buffer.alloc(8193),Buffer.from('é')])
  assert.throws(()=>decodeReaderStatus(v,{domain,nowNs:20000n}),ReaderStatusInvalid);
});
test('actual local namespace has a valid clock domain and monotonic sample',()=>{
 const v=localClock();assert.match(v.domain,/^[a-f0-9]{64}$/);assert.ok(v.nowNs>0n);
});
