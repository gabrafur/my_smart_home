import assert from 'node:assert/strict';
import {test} from 'node:test';
import {projectEvents,correctCapabilities} from './event_projection.mjs';
const {descriptors,makeRepairRoute}=await import(
 import.meta.url==='file:///usr/local/lib/raspberry-repair-control/test_events.mjs'
  ? '/var/lib/raspberry-mcp/root/app/repair-server.mjs' : '../frontend/repair-server.mjs');
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const rpc=require('./repair_rpc.cjs');
const now=Date.parse('2026-10-24T21:00:00Z');
const good=()=>({observed_at:'2026-10-24T21:00:00Z',active_subscriptions:1,
 subscription_lease:{state:'active',expires_at:'2026-10-25T17:17:34Z'},
 source_health:{state:'observed',observed_at:'2026-10-24T20:59:59Z',collection_error:null},
 assistant_run_confirmed:false});
test('static capability and current subscription are distinct',()=>{
 const p=projectEvents(good(),now);
 assert.equal(p.state,'active');assert.equal(p.assistant_execution,'unknown');
 assert.equal(p.source_state,'observed');
 const v=correctCapabilities({evidence:{data:{native_events:{assistant_run_proven:false},
  ha_notification_observer:{events_subscription_enabled:false}}}},good(),now);
 assert.equal(v.evidence.data.events.capability_static.implemented,true);
 assert.equal(v.evidence.data.events.current_observation.state,'active');
 assert.equal(v.evidence.data.ha_notification_observer.events_subscription_enabled,undefined);
});
test('failure or missing/conflicting dates remain unknown',()=>{
 for(const x of [null,{...good(),collection_error:'failed'}, {...good(),observed_at:null},
  {...good(),observed_at:'2099-01-01T00:00:00Z'}, {...good(),active_subscriptions:0},
  {...good(),subscription_lease:{state:'active',expires_at:'2026-10-23T00:00:00Z'}}])
  assert.equal(projectEvents(x,now).state,'unknown');
});
test('stale source does not fabricate delivery/assistant success',()=>{
 const x=good();x.source_health.collection_error='storage_failed';
 const p=projectEvents(x,now);assert.equal(p.state,'active');
 assert.equal(p.source_state,'unknown');assert.equal(p.assistant_execution,'unknown');
});
test('closed task schemas have no prompt/command/path/thread fields',()=>{
 assert.equal(descriptors.length,6);
 for(const d of descriptors){
  assert.equal(d.inputSchema.additionalProperties,false);
  assert.deepEqual(d.inputSchema.required,Object.keys(d.inputSchema.properties));
  for(const k of ['prompt','command','path','thread_id','model','sudo'])
   assert.equal(d.inputSchema.properties[k],undefined);
 }
 assert.deepEqual(descriptors[0].inputSchema.properties.task.enum,['repair_health_summary']);
});
test('fixed RPC rejects other threads/intents and never takes caller prompt',()=>{
 assert.throws(()=>rpc.validate({mode:'send',thread_id:'${OUT_OF_SCOPE_TEST_THREAD_ID}',operation_id:'a'.repeat(32),intent:'repair_health_summary'}));
 assert.throws(()=>rpc.validate({mode:'send',thread_id:rpc.THREADS[0],operation_id:'a'.repeat(32),intent:'continue'}));
 assert.throws(()=>rpc.validate({mode:'send',thread_id:rpc.THREADS[0],operation_id:'a'.repeat(32),intent:'repair_health_summary',text:'arbitrary'}));
 assert.match(rpc.prompt({operation_id:'a'.repeat(32),intent:'repair_health_summary'}),/verify_candidate.py/);
});
test('result is enum-only; unknown fields/text/inconsistent completion withheld',()=>{
 const q={operation_id:'a'.repeat(32)};
 const value={operation_id:q.operation_id,project:'/mnt/data/docker',task:'repair_health_summary',state:'complete',production_changes:false,
  checks:Object.fromEntries(rpc.CHECKS.map(x=>[x,'passed']))};
 assert.equal(rpc.cleanAnswer(JSON.stringify(value),q).answer_withheld,false);
 for(const v of [{...value,summary:'private text'}, {...value,production_changes:true},
  {...value,checks:{...value.checks,dedupe:'not_run'}}])
  assert.equal(rpc.cleanAnswer(JSON.stringify(v),q).answer_withheld,true);
});
test('quota refuses API and paid credits without sending',()=>{
 assert.throws(()=>rpc.quota({account:{type:'apiKey'}},{ordinaryUsageAllowed:true}));
 assert.throws(()=>rpc.quota({account:{type:'chatgpt',planType:'pro'}},
  {ordinaryUsageAllowed:true,rateLimits:{credits:{hasCredits:true}}}));
});
test('unloaded fixed thread resumes without configuration overrides before preflight',async()=>{
 const calls=[];const id=rpc.THREADS[0];
 const thread=state=>({id,status:{type:state},ephemeral:false,cwd:'/home/gabriel',canAcceptDirectInput:state==='idle'});
 const invoke=async(method,params)=>{
  calls.push({method,params});
  if(method==='thread/read')return {thread:thread('notLoaded')};
  if(method==='thread/resume')return {thread:thread('idle')};
  if(method==='account/read')return {account:{type:'chatgpt',planType:'pro'}};
  if(method==='account/rateLimits/read')return {ordinaryUsageAllowed:true,rateLimits:{credits:{hasCredits:false,unlimited:false,balance:null}}};
  throw Error('unexpected effect');
 };
 const out=await rpc.run({mode:'preflight',thread_id:id},invoke);
 assert.equal(out.included_quota_confirmed,true);
 assert.deepEqual(calls.find(x=>x.method==='thread/resume').params,{threadId:id,excludeTurns:true});
 assert.equal(calls.some(x=>['turn/start','thread/start'].includes(x.method)),false);
});
test('resume to active or failed resume never sends and observation does not resume',async()=>{
 const id=rpc.THREADS[0],base={id,status:{type:'notLoaded'},ephemeral:false,cwd:'/home/gabriel',canAcceptDirectInput:false};
 for(const fail of [true,false]){
  const calls=[];
  await assert.rejects(rpc.run({mode:'preflight',thread_id:id},async(method)=>{
   calls.push(method);
   if(method==='thread/read')return {thread:base};
   if(method==='thread/resume'){if(fail)throw Error('synthetic');return {thread:{...base,status:{type:'active'}}};}
   throw Error('unexpected effect');
  }));
  assert.equal(calls.includes('turn/start'),false);
 }
 const calls=[];
 await rpc.run({mode:'metadata',thread_id:id},async method=>{calls.push(method);return {thread:base};});
 assert.deepEqual(calls,['thread/read']);
});
test('capabilities reply updates both wire representations; errors are unknown',async()=>{
 const base={evidence:{data:{ha_notification_observer:{events_subscription_enabled:false}}}};
 const prior=async q=>q.params.name==='events_status'?{result:{isError:true}}:
  {result:{structuredContent:structuredClone(base),content:[{type:'text',text:JSON.stringify(base)}]}};
 const route=makeRepairRoute(prior,()=>{throw Error('not expected')},()=>{throw Error('not expected')});
 const out=await route({method:'tools/call',params:{name:'maintenance_capabilities'}});
 assert.equal(out.result.structuredContent.evidence.data.events.current_observation.state,'unknown');
 assert.deepEqual(JSON.parse(out.result.content[0].text),out.result.structuredContent);
});

test('fixed verifier instruction supplies exact isolated Python command without making script executable',()=>{
 const text=rpc.prompt({operation_id:'a'.repeat(32),intent:'repair_health_summary'});
 assert.ok(text.includes('`/usr/bin/python3 -I -S -B /usr/local/lib/raspberry-repair-control/verify_candidate.py`'));
 assert.ok(text.includes('não altere suas permissões'));
 assert.ok(!text.includes('Execute somente o verificador local'));
});

const budgetNow=Date.parse('2026-10-25T06:00:00Z');
const budgetFixture=()=>({observed_at:'2026-10-25T06:00:00Z',active_subscriptions:1,
 subscription_lease:{state:'active',expires_at:'2026-10-25T17:17:34Z'},
 source_health:{state:'observed',observed_at:'2026-10-25T06:00:00Z',collection_error:null},
 attempts_last_24h:6,maximum_attempts_per_day:6,minimum_attempt_spacing_seconds:600,
 queued_event_records:5,retained_event_records:40,eligible_pending_event_records:5,
 queued_event_records_semantics:'eligible_pending_current_active_principal',event_count_collection_error:null,last_dispatch:{state:'budget_held'}});
test('active lease can have a blocked delivery budget',()=>{
 const p=projectEvents(budgetFixture(),budgetNow);assert.equal(p.state,'active');
 assert.equal(p.delivery.state,'budget_held');
 assert.equal(p.delivery.reason,'rolling_daily_attempt_limit_reached');
 assert.equal(p.delivery.attempts_last_24h,6);assert.equal(p.delivery.queued_event_records,5);
 assert.equal(p.assistant_execution,'unknown');assert.equal(p.delivery.automatic_retry,false);
});
test('spacing hold is not invented as a daily limit or exact retry time',()=>{
 const x=budgetFixture();x.attempts_last_24h=2;
 const p=projectEvents(x,budgetNow).delivery;assert.equal(p.state,'budget_held');
 assert.equal(p.reason,'budget_or_spacing_hold_observed');assert.equal(p.next_retry_at,undefined);
});
test('old acceptance and idle with budget available never prove assistant execution or readiness',()=>{
 for(const state of ['webhook_accepted','idle','delivery_refused','not_attempted']){
  const x=budgetFixture();x.attempts_last_24h=1;x.last_dispatch={state};
  const p=projectEvents(x,budgetNow);assert.equal(p.delivery.state,'unknown');
  assert.equal(p.delivery.assistant_execution,'unknown');
 }
});
test('uncertain dispatch retains reconciliation without automatic effects',()=>{
 for(const state of ['uncertain','reconciliation_required']){
  const x=budgetFixture();x.last_dispatch={state,event_id:'withheld-private-marker'};
  const p=projectEvents(x,budgetNow);assert.equal(p.delivery.state,'reconciliation_required');
  assert.equal(p.delivery.automatic_retry,false);
  assert.equal(JSON.stringify(p).includes('withheld-private-marker'),false);
 }
});
test('missing or malformed counters, stale status and failed collection remain unknown',()=>{
 const x=budgetFixture();delete x.last_dispatch;
 for(const value of [undefined,null,-1,1.5,Infinity,'6',{},100000]){
  x.attempts_last_24h=value;const p=projectEvents(x,budgetNow);
  assert.equal(p.delivery.state,'unknown');assert.equal(p.delivery.attempts_last_24h,null);
 }
 for(const change of [{collection_error:'unavailable'},{observed_at:null},{observed_at:'2026-10-25T06:00:30Z'}])
  assert.equal(projectEvents({...budgetFixture(),...change},budgetNow).state,'unknown');
});
test('inactive subscription stays separate from budget and preserves inputs',()=>{
 const x=budgetFixture();x.active_subscriptions=0;x.subscription_lease.state='inactive';
 const base={evidence:{data:{ha_notification_observer:{}}}},copy=structuredClone(x);
 const p=correctCapabilities(base,x,budgetNow).evidence.data.events;
 assert.equal(p.current_observation.delivery.state,'inactive');
 assert.equal(p.capability_static.implemented,true);assert.deepEqual(x,copy);
 assert.equal(base.evidence.data.events,undefined);
});

test('legacy total is retained evidence and never claimed as a pending backlog',()=>{
 const x=budgetFixture();delete x.queued_event_records_semantics;delete x.retained_event_records;
 delete x.eligible_pending_event_records;delete x.event_count_collection_error;x.queued_event_records=40;
 const p=projectEvents(x,budgetNow).delivery;assert.equal(p.retained_event_records,40);
 assert.equal(p.eligible_pending_event_records,null);assert.equal(p.queued_event_records,null);
 assert.equal(p.event_count_collection_error,'legacy_total_only_pending_unknown');
});
test('inconsistent,failed,missing or private count metadata stays unknown',()=>{
 for(const change of [{eligible_pending_event_records:41},{queued_event_records:6},
  {eligible_pending_event_records:null},{retained_event_records:-1},
  {event_count_collection_error:'PRIVATE_SENTINEL'}]){
  const p=projectEvents({...budgetFixture(),...change},budgetNow).delivery;
  assert.equal(p.eligible_pending_event_records,null);assert.equal(p.queued_event_records,null);
  assert.ok(!JSON.stringify(p).includes('PRIVATE_SENTINEL'));
  assert.equal(p.state,'budget_held');
 }
});
