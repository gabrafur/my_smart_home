import test from 'node:test';
import assert from 'node:assert/strict';
import {projectLatestDeliveryReceipt} from './runtime-source/frontend/event_projection.mjs';
const now=1800000000000,iso=x=>new Date(x).toISOString();
function sample(){return {latest_delivery_receipt:{schema_version:1,source:'source_event_batch_transport_receipt_v1',
 observed_at:iso(now),age_seconds:0,state:'observed',collection_error:null,batch_id:'a'.repeat(64),
 subscription_id_sha256:'b'.repeat(64),intent_at:iso(now-1000),data_age_seconds:1,dispatch_state:'webhook_accepted',
 batch_membership_verified:true,membership_record_count:1,members_digest_sha256:'c'.repeat(64),
 maximum_members:8,returned_members:1,members_truncated:false,assistant_execution:'unknown',
 members:[{source:'retained_registry_event',event_id:'d'.repeat(64),object_id:'e'.repeat(64),revision:'f'.repeat(64),
  phase:'updated',observed_at:iso(now-1500),age_seconds:1.5,collection_error:null,record_location:'current'}],
 transport:{source:'native_transport_completion',observed_at:iso(now-500),age_seconds:.5,state:'recorded',
  outcome:'response_2xx',sender_duration_ms:500,collection_error:null}}};}
test('validated lineage preserves identities without claiming assistant execution',()=>{
 const result=projectLatestDeliveryReceipt(sample(),now);assert.equal(result.state,'observed');
 assert.equal(result.batch_id,'a'.repeat(64));assert.equal(result.members[0].event_id,'d'.repeat(64));
 assert.equal(result.assistant_execution,'unknown');assert.equal(result.transport.outcome,'response_2xx');
});
test('unreviewed fields are stripped at every level',()=>{
 const s=sample(),r=s.latest_delivery_receipt;r.private='PRIVATE_SENTINEL';r.members[0].private='PRIVATE_SENTINEL';r.transport.private='PRIVATE_SENTINEL';
 assert.equal(JSON.stringify(projectLatestDeliveryReceipt(s,now)).includes('PRIVATE_SENTINEL'),false);
});
test('stale receipt or failed membership cannot expose identities as proof',()=>{
 const s=sample();s.latest_delivery_receipt.observed_at=iso(now-21000);
 assert.equal(projectLatestDeliveryReceipt(s,now).state,'unknown');
 s.latest_delivery_receipt.observed_at=iso(now);s.latest_delivery_receipt.batch_membership_verified=false;
 const result=projectLatestDeliveryReceipt(s,now);assert.equal(result.state,'unknown');assert.equal(result.members,undefined);
});
test('more than eight details or forged source state fail closed',()=>{
 const s=sample(),r=s.latest_delivery_receipt;r.membership_record_count=9;r.members_truncated=true;
 r.members=Array.from({length:9},(_,i)=>({...r.members[0],event_id:i.toString(16).padStart(64,'0')}));r.returned_members=9;
 assert.equal(projectLatestDeliveryReceipt(s,now).state,'unknown');
});
test('uncertain dispatch remains uncertain with a measured sender boundary',()=>{
 const s=sample();s.latest_delivery_receipt.dispatch_state='uncertain';s.latest_delivery_receipt.transport.outcome='outcome_unknown';
 const result=projectLatestDeliveryReceipt(s,now);assert.equal(result.dispatch_state,'uncertain');assert.equal(result.assistant_execution,'unknown');
});

test('native latest delivery receipt stays exact, bounded and read-only',async()=>{
 const {spawnSync}=await import('node:child_process');
 const {fileURLToPath}=await import('node:url');
 const folder=fileURLToPath(new URL('./runtime-source/native-events/',import.meta.url));
 const result=spawnSync('python3',['-I','-S','-B','-m','unittest','discover','-s',folder,'-p','test_latest_delivery_receipt.py'],
  {encoding:'utf8',timeout:15000,maxBuffer:65536});
 assert.equal(result.status,0,result.stderr);assert.match(result.stderr,/Ran 8 tests/);
});
