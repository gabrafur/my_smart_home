import test from 'node:test';
import assert from 'node:assert/strict';
import {projectSummary,projectEvents} from './runtime-source/repair-control/event_projection.mjs';
const now=1800000000000,iso=n=>new Date(n).toISOString();
function good(){return {observed_at:iso(now),delivery_summary_version:'notification_summary_v1',
 delivery_queue:{state:'observed',collection_error:null,eligible_event_records:20,notification_groups:2,
 revisions_coalescible:18,max_groups_per_delivery:8,durable_summary_batches:1,durable_covered_event_records:10,
 covered_revisions_coalesced:9,archived_event_records:0,history_archive_limit:4096,archive_reasons:{},
 oldest_eligible_at:iso(now-15000),newest_eligible_at:iso(now-1000),oldest_eligible_age_seconds:15},
 delivery_opportunity:{state:'observed',block_reason:'rolling_daily_attempt_limit_reached',attempts_last_24h:6,
 budget_available_at:iso(now+100000),spacing_available_at:iso(now),next_opportunity_at:iso(now+100000),
 subscription_expires_at:iso(now+200000),within_subscription_validity:true,requires_subscription_renewal:false,
 poll_allowance_seconds:2,opportunity_is_not_delivery_guarantee:true,maximum_attempts_per_day:6,minimum_attempt_spacing_seconds:600}};}
test('closed summary metadata and budget/lease comparison',()=>{
 const x=good();x.delivery_queue.private='PRIVATE_SENTINEL';x.delivery_opportunity.private='PRIVATE_SENTINEL';
 const p=projectSummary(x,now);assert.equal(p.state,'observed');assert.equal(p.queue.revisions_coalescible,18);
 assert.equal(p.opportunity.within_subscription_validity,true);assert.ok(!JSON.stringify(p).includes('PRIVATE_SENTINEL'));
});
test('missing or failed collection never becomes empty queue',()=>{
 for(const x of [{}, {...good(),delivery_queue:{state:'unknown'}}])assert.equal(projectSummary(x,now).state,'unknown');
});
test('conflicting dates, unknown keys and counts rejected',()=>{
 for(const alter of [x=>x.delivery_queue.notification_groups=21,x=>x.delivery_queue.oldest_eligible_age_seconds=999,
  x=>x.delivery_opportunity.within_subscription_validity=false,x=>x.delivery_queue.archive_reasons={private:1},
  x=>x.delivery_queue.archive_reasons={covered_by_summary:1},x=>x.delivery_queue.eligible_event_records=257,
  x=>x.delivery_opportunity.maximum_attempts_per_day=7,x=>x.delivery_opportunity.minimum_attempt_spacing_seconds=1]){
  const x=good();alter(x);assert.equal(projectSummary(x,now).state,'unknown');}
});
test('next opportunity beyond subscription requires renewal',()=>{
 const x=good();x.delivery_opportunity.subscription_expires_at=iso(now+50000);
 x.delivery_opportunity.within_subscription_validity=false;x.delivery_opportunity.requires_subscription_renewal=true;
 const p=projectSummary(x,now);assert.equal(p.state,'observed');assert.equal(p.opportunity.requires_subscription_renewal,true);
});
test('stale/future observed status rejected',()=>{
 for(const at of [now-20001,now+1001]){const x=good();x.observed_at=iso(at);assert.equal(projectSummary(x,now).state,'unknown');}
});
test('archive pressure differs from an uncertain webhook reply',()=>{
 const x=good();Object.assign(x,{active_subscriptions:1,
  subscription_lease:{state:'active',expires_at:iso(now+200000)},
  source_health:{state:'observed',observed_at:iso(now),collection_error:null},
  last_dispatch:{state:'reconciliation_required',reason:'event_history_archive_full'}});
 assert.equal(projectEvents(x,now).delivery.reason,'event_history_archive_full');
});

import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
test('native event grouping keeps protocol and uncertain intents in synthetic SQLite',()=>{
 const r=spawnSync('python3',['-I','-S','-B','-m','unittest','discover','-s',fileURLToPath(new URL('./runtime-source/native-events/',import.meta.url)),'-p','test_*.py'],{encoding:'utf8',timeout:30000,maxBuffer:131072});
 assert.equal(r.error,undefined);assert.equal(r.status,0,r.stderr);assert.match(r.stderr,/Ran 53 tests/);
});
