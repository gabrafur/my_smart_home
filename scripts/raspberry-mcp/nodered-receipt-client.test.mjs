import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const {digest, decodeContext, permitted, runClient} = createRequire(import.meta.url)(
 './runtime-source/administrative-recovery/nodered_receipt_client.cjs');
const before=[{id:'baseline'}],after=[{id:'candidate'}],runId='a'.repeat(32);
const encoded=msg=>({status:200,data:msg===undefined?{format:'undefined',msg:'(undefined)'}:
 {format:'Object',msg:JSON.stringify(msg)}});
const input=()=>({action:'deploy_and_replay',username:'logical_admin',password:'x',run_id:runId,
 trace_expected:true,flows:after,expected_loaded_sha256:digest(before),proposed_loaded_sha256:digest(after)});

function mock(options={}){
 let flows=before,fixture,incidents,terminal,confirmations=0;
 const calls=[],events=[];
 const record=(name,value)=>{assert.ok(!events.some(event=>event.name===name));events.push({name,value});};
 const request=async(method,path,data)=>{
  assert.ok(permitted(method,path));calls.push({method,path,data});
  if(path==='/auth/token')return{status:200,data:{access_token:'opaque'}};
  if(path==='/auth/revoke')return{status:options.revokeFails?500:200};
  if(path==='/flows'){
   if(method==='POST'){
    if(options.unknownDeploy)throw Error('http_outcome_unconfirmed');
    flows=data.flows;return{status:200,data:{rev:'next'}};
   }
   return{status:200,data:{rev:'current',flows:options.baselineMismatch?after:flows}};
  }
  if(path.startsWith('/inject/')){
   const props=Object.fromEntries(data.__user_inject_props__.map(p=>[p.p,p.v]));
   assert.equal(props._host_observer_test,'true');
   const name=props.payload;
   if(name==='reset'){
    fixture=props._host_test_run_id?{run_id:props._host_test_run_id,now:1000,sequence:0}:undefined;
    incidents=undefined;
   }else if(name==='healthy'){
    fixture??={now:1000,sequence:0};
    fixture.now+=1000;fixture.sequence++;
    if(incidents?.incidents?.native_systemd_procmon?.notified_at){
     incidents={incidents:{}};
     terminal={...terminal,observer_kind:'host_recovery',completed_at:2000};
     if(!options.oldTerminal)terminal.receipt_sequence++;
    }
   }else if(name==='failure'){
    fixture.now+=1000;fixture.sequence++;
    incidents={incidents:{native_systemd_procmon:{last_seen_at:fixture.now,notified_at:null}}};
   }else{
    fixture.now+=25000;incidents.incidents.native_systemd_procmon.last_seen_at=fixture.now;
    if(++confirmations===1){
     incidents.incidents.native_systemd_procmon.notified_at=fixture.now;
     terminal={simulated:true,dispatched:false,external_call_sent:false,notification_sent:false,
      observer_kind:'host_failure',run_id:options.wrongRun?'b'.repeat(32):runId,
      source_flow_id:'host_observer_tab',receipt_sequence:1,completed_at:1500};
     if(options.oldTerminal){delete terminal.run_id;delete terminal.receipt_sequence;delete terminal.source_flow_id;}
    }else if(options.duplicate)terminal.receipt_sequence++;
   }
   return{status:200,data:'OK'};
  }
  if(path.includes('store=persistent'))return encoded(undefined);
  if(path.includes('fixture'))return encoded(fixture);
  if(path.includes('incidents'))return encoded(incidents);
  if(path.includes('cursor'))return encoded(undefined);
  return encoded(terminal);
 };
 return{request,record,now:()=>100,wait:async()=>{},calls,events};
}

test('transport permits only auth, CAS flows, fixed test injects and named test contexts',()=>{
 for(const path of ['/inject/production','/context/global','/context/flow/host_observer_tab/private?store=persistent',
  '/inject/host_obs_test_healthy?other=1','/flows/other','http://example.invalid/flows'])assert.equal(permitted('POST',path),false);
 assert.equal(permitted('DELETE','/flows'),false);
 assert.equal(permitted('GET','/context/flow/host_observer_tab/host_observer_incidents_v1__test?store=memoryOnly'),true);
});
test('context decoder follows the installed API format without evaluating data',()=>{
 assert.deepEqual(decodeContext(encoded({sequence:2})),{sequence:2});
 assert.equal(decodeContext(encoded(undefined)),undefined);
 for(const value of [{status:404},{status:200,data:{format:'Object',msg:'[]'}},
  {status:200,data:{format:'string',msg:'return credentials'}}])assert.throws(()=>decodeContext(value));
});
test('snapshot is read-only and revokes its opaque session',async()=>{
 const fake=mock(),result=await runClient({...input(),action:'snapshot'},fake);
 assert.equal(result.verified,true);assert.equal(result.submitted,false);assert.equal(result.session_revoked,true);
 assert.deepEqual(result.flows,before);assert.equal(fake.events.length,0);
 assert.equal(fake.calls.filter(call=>call.path.startsWith('/inject/')).length,0);
});
test('CAS mismatch and journal failure precede every deployment effect',async()=>{
 for(const options of [{baselineMismatch:true},{}]){
  const fake=mock(options);
  if(!options.baselineMismatch)fake.record=()=>{throw Error('journal_failed');};
  const result=await runClient(input(),fake);
  assert.equal(result.verified,false);assert.equal(result.submitted,false);
  assert.equal(fake.calls.filter(call=>call.method==='POST'&&call.path==='/flows').length,0);
 }
});
test('uncertain deployment is attempted once, journaled, never followed by inject or retry',async()=>{
 const fake=mock({unknownDeploy:true}),result=await runClient(input(),fake);
 assert.equal(result.verified,false);assert.equal(result.submitted,true);
 assert.deepEqual(fake.events.map(event=>event.name),['deploy-intent']);
 assert.equal(fake.calls.filter(call=>call.method==='POST'&&call.path==='/flows').length,1);
 assert.equal(fake.calls.filter(call=>call.path.startsWith('/inject/')).length,0);
 assert.equal(result.session_revoked,true);
});
test('complete traced protocol proves confirmation, dedupe, recovery and isolated cleanup',async()=>{
 const fake=mock(),result=await runClient(input(),fake);
 assert.equal(result.verified,true);assert.equal(result.replay.steps.length,7);
 assert.equal(result.replay.failure_receipt.run_id,runId);assert.equal(result.replay.deduplicated,true);
 assert.equal(result.replay.recovery_receipt.receipt_sequence,2);
 assert.equal(result.replay.test_context_cleaned,true);assert.equal(result.replay.persistent_test_keys_absent,true);
 assert.equal(fake.calls.filter(call=>call.path.startsWith('/inject/')).length,7);
 assert.equal(fake.events.filter(event=>event.name.endsWith('-intent')).length,8);
});
test('foreign trace and duplicate receipt fail without replaying an inject',async()=>{
 for(const options of [{wrongRun:true},{duplicate:true}]){
  const fake=mock(options),result=await runClient(input(),fake);
  assert.equal(result.verified,false);
  assert.equal(fake.calls.filter(call=>call.path.startsWith('/inject/')).length,options.wrongRun?4:5);
  assert.equal(result.session_revoked,true);
 }
});
test('rollback verifies the original terminal shape with a fresh full dry-run',async()=>{
 const fake=mock({oldTerminal:true}),result=await runClient({...input(),trace_expected:false},fake);
 assert.equal(result.verified,true);assert.equal(result.replay.recovery_receipt.run_id,undefined);
 assert.equal(result.replay.test_context_cleaned,true);
 assert.equal(fake.calls.filter(call=>call.path.startsWith('/inject/')).length,7);
});
test('revocation failure keeps acceptance false after known runtime effects',async()=>{
 const fake=mock({revokeFails:true}),result=await runClient(input(),fake);
 assert.equal(result.verified,false);assert.equal(result.submitted,true);
 assert.equal(result.error,'session_revocation_unconfirmed');
 assert.equal(fake.calls.filter(call=>call.method==='POST'&&call.path==='/flows').length,1);
});
test('root package permits exactly six reviewed function bodies',()=>{
 const file=fileURLToPath(new URL('./runtime-source/administrative-recovery/test_nodered_dry_run_receipts.py',import.meta.url));
 const result=spawnSync('/usr/bin/python3',['-I','-S','-B',file],{encoding:'utf8',timeout:10000,maxBuffer:16384});
 assert.equal(result.status,0,result.stderr);assert.match(result.stderr,/Ran 12 tests/);
});
