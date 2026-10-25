import assert from 'node:assert/strict';
import {test} from 'node:test';
import {projectEvents,correctCapabilities} from './runtime-source/repair-control/event_projection.mjs';
const now=Date.parse('2026-10-25T06:00:00Z');
const good=()=>({observed_at:'2026-10-25T06:00:00Z',active_subscriptions:1,
 subscription_lease:{state:'active',expires_at:'2026-10-25T17:17:34Z'},
 source_health:{state:'observed',observed_at:'2026-10-25T06:00:00Z',collection_error:null},
 attempts_last_24h:6,maximum_attempts_per_day:6,minimum_attempt_spacing_seconds:600,
 queued_event_records:5,retained_event_records:40,eligible_pending_event_records:5,
 queued_event_records_semantics:'eligible_pending_current_active_principal',event_count_collection_error:null,last_dispatch:{state:'budget_held'}});
test('active lease can have a blocked delivery budget',()=>{
 const p=projectEvents(good(),now);assert.equal(p.state,'active');
 assert.equal(p.delivery.state,'budget_held');
 assert.equal(p.delivery.reason,'rolling_daily_attempt_limit_reached');
 assert.equal(p.delivery.attempts_last_24h,6);assert.equal(p.delivery.queued_event_records,5);
 assert.equal(p.assistant_execution,'unknown');assert.equal(p.delivery.automatic_retry,false);
});
test('spacing hold is not invented as a daily limit or exact retry time',()=>{
 const x=good();x.attempts_last_24h=2;
 const p=projectEvents(x,now).delivery;assert.equal(p.state,'budget_held');
 assert.equal(p.reason,'budget_or_spacing_hold_observed');assert.equal(p.next_retry_at,undefined);
});
test('old acceptance and idle with budget available never prove assistant execution or readiness',()=>{
 for(const state of ['webhook_accepted','idle','delivery_refused','not_attempted']){
  const x=good();x.attempts_last_24h=1;x.last_dispatch={state};
  const p=projectEvents(x,now);assert.equal(p.delivery.state,'unknown');
  assert.equal(p.delivery.assistant_execution,'unknown');
 }
});
test('uncertain dispatch retains reconciliation without automatic effects',()=>{
 for(const state of ['uncertain','reconciliation_required']){
  const x=good();x.last_dispatch={state,event_id:'withheld-private-marker'};
  const p=projectEvents(x,now);assert.equal(p.delivery.state,'reconciliation_required');
  assert.equal(p.delivery.automatic_retry,false);
  assert.equal(JSON.stringify(p).includes('withheld-private-marker'),false);
 }
});
test('missing or malformed counters, stale status and failed collection remain unknown',()=>{
 const x=good();delete x.last_dispatch;
 for(const value of [undefined,null,-1,1.5,Infinity,'6',{},100000]){
  x.attempts_last_24h=value;const p=projectEvents(x,now);
  assert.equal(p.delivery.state,'unknown');assert.equal(p.delivery.attempts_last_24h,null);
 }
 for(const change of [{collection_error:'unavailable'},{observed_at:null},{observed_at:'2026-10-25T06:00:30Z'}])
  assert.equal(projectEvents({...good(),...change},now).state,'unknown');
});
test('inactive subscription stays separate from budget and preserves inputs',()=>{
 const x=good();x.active_subscriptions=0;x.subscription_lease.state='inactive';
 const base={evidence:{data:{ha_notification_observer:{}}}},copy=structuredClone(x);
 const p=correctCapabilities(base,x,now).evidence.data.events;
 assert.equal(p.current_observation.delivery.state,'inactive');
 assert.equal(p.capability_static.implemented,true);assert.deepEqual(x,copy);
 assert.equal(base.evidence.data.events,undefined);
});

test('legacy total is retained evidence and never claimed as a pending backlog',()=>{
 const x=good();delete x.queued_event_records_semantics;delete x.retained_event_records;
 delete x.eligible_pending_event_records;delete x.event_count_collection_error;x.queued_event_records=40;
 const p=projectEvents(x,now).delivery;assert.equal(p.retained_event_records,40);
 assert.equal(p.eligible_pending_event_records,null);assert.equal(p.queued_event_records,null);
 assert.equal(p.event_count_collection_error,'legacy_total_only_pending_unknown');
});
test('inconsistent,failed,missing or private count metadata stays unknown',()=>{
 for(const change of [{eligible_pending_event_records:41},{queued_event_records:6},
  {eligible_pending_event_records:null},{retained_event_records:-1},
  {event_count_collection_error:'PRIVATE_SENTINEL'}]){
  const p=projectEvents({...good(),...change},now).delivery;
  assert.equal(p.eligible_pending_event_records,null);assert.equal(p.queued_event_records,null);
  assert.ok(!JSON.stringify(p).includes('PRIVATE_SENTINEL'));
  assert.equal(p.state,'budget_held');
 }
});
