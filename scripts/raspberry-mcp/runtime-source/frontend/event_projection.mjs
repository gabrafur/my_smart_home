// Only validated aggregate metadata crosses the projection boundary.
export function projectSummary(status, now=Date.now()) {
 const queue=status.delivery_queue, op=status.delivery_opportunity;
 const unknown=reason=>({state:'unknown',collection_error:reason});
 if(status.delivery_summary_version!=='notification_summary_v1')return unknown('summary_not_loaded');
 if(!queue||queue.state!=='observed'||queue.collection_error!==null||!op||op.state!=='observed')
  return unknown('summary_scope_or_collection_unconfirmed');
 const integer=v=>Number.isSafeInteger(v)&&v>=0;
 const counts=['eligible_event_records','notification_groups','revisions_coalescible','max_groups_per_delivery',
  'durable_summary_batches','durable_covered_event_records','covered_revisions_coalesced',
  'archived_event_records','history_archive_limit'];
 if(counts.some(k=>!integer(queue[k]))||queue.eligible_event_records>256||
  queue.notification_groups>queue.eligible_event_records||queue.max_groups_per_delivery!==8||
  queue.revisions_coalescible!==queue.eligible_event_records-queue.notification_groups||
  queue.history_archive_limit!==4096||queue.archived_event_records>4096||
  !queue.archive_reasons||typeof queue.archive_reasons!=='object'||Array.isArray(queue.archive_reasons)||
  Object.entries(queue.archive_reasons).some(([k,v])=>!['covered_by_summary','eligibility_window_elapsed'].includes(k)||!integer(v))||
  Object.values(queue.archive_reasons).reduce((a,b)=>a+b,0)!==queue.archived_event_records)
  return unknown('summary_counts_unconfirmed');
 const timestamp=v=>typeof v==='string'&&Number.isFinite(Date.parse(v));
 const oldest=queue.oldest_eligible_at,newest=queue.newest_eligible_at;
 const observed=Date.parse(status.observed_at);
 if(!Number.isFinite(observed)||observed>now+1000||now-observed>20000)return unknown('summary_time_unconfirmed');
 if(queue.eligible_event_records===0 ? oldest!==null||newest!==null||queue.oldest_eligible_age_seconds!==null :
  !timestamp(oldest)||!timestamp(newest)||Date.parse(oldest)>Date.parse(newest)||
  Date.parse(newest)>observed+1000||!Number.isFinite(queue.oldest_eligible_age_seconds)||
  queue.oldest_eligible_age_seconds<0||Math.abs((observed-Date.parse(oldest))/1000-queue.oldest_eligible_age_seconds)>1)
  return unknown('summary_time_unconfirmed');
 const reasons=['subscription_inactive','no_eligible_events','rolling_daily_attempt_limit_reached','minimum_spacing','ready'];
 if(!reasons.includes(op.block_reason)||!integer(op.attempts_last_24h)||
  ![6,144].includes(op.maximum_attempts_per_day)||op.minimum_attempt_spacing_seconds!==600||
  op.maximum_attempts_per_day===144&&op.delivery_cadence_version!=='grouped_minimum_spacing_v2'||
  op.poll_allowance_seconds!==2||op.opportunity_is_not_delivery_guarantee!==true||
  typeof op.within_subscription_validity!=='boolean'||typeof op.requires_subscription_renewal!=='boolean')
  return unknown('delivery_opportunity_unconfirmed');
 const next=op.next_opportunity_at,expiry=op.subscription_expires_at;
 if(!timestamp(op.budget_available_at)||!timestamp(op.spacing_available_at)||
  next!==null&&!timestamp(next)||expiry!==null&&!timestamp(expiry)||
  next!==null&&(Date.parse(next)<observed-1000||
   op.within_subscription_validity!==(expiry!==null&&Date.parse(next)<Date.parse(expiry))))
  return unknown('delivery_opportunity_time_conflicting');
 // Construct a closed response; never spread unreviewed server strings.
 const cleanQueue={state:'observed',collection_error:null};for(const k of counts)cleanQueue[k]=queue[k];
 Object.assign(cleanQueue,{oldest_eligible_at:oldest,newest_eligible_at:newest,
  oldest_eligible_age_seconds:queue.oldest_eligible_age_seconds,
  ordering:'current_then_latest_change_desc_no_severity_inferred',archive_reasons:{...queue.archive_reasons},
  archive_full_behavior:'fail_closed_no_silent_discard',existing_intents_excluded_including_uncertain:true});
 const cleanOp={state:'observed',block_reason:op.block_reason,attempts_last_24h:op.attempts_last_24h,
  budget_available_at:op.budget_available_at,spacing_available_at:op.spacing_available_at,
  next_opportunity_at:next,subscription_expires_at:expiry,
  within_subscription_validity:op.within_subscription_validity,requires_subscription_renewal:op.requires_subscription_renewal,
  poll_allowance_seconds:2,opportunity_is_not_delivery_guarantee:true,
  delivery_cadence_version:op.maximum_attempts_per_day===144?'grouped_minimum_spacing_v2':'legacy_six_attempts_v1',
  maximum_attempts_per_day:op.maximum_attempts_per_day,minimum_attempt_spacing_seconds:600};
 return {state:'observed',version:'notification_summary_v1',queue:cleanQueue,opportunity:cleanOp};
}

// Budget and a subscription lease are separate observations. Never infer a model run.
function projectDelivery(status, active, sourceFresh, now) {
 const integer=(value,minimum=0,maximum=4096)=>Number.isSafeInteger(value)&&value>=minimum&&value<=maximum?value:null;
 const attempts=integer(status.attempts_last_24h);
 const maximum=integer(status.maximum_attempts_per_day,1);
 const spacing=integer(status.minimum_attempt_spacing_seconds,0,86400);
 const legacy=integer(status.queued_event_records,0,10000);
 const semantics=status.queued_event_records_semantics;
 const declared=semantics==='eligible_pending_current_active_principal';
 const retained=integer(status.retained_event_records,0,10000)??(!declared?legacy:null);
 const reportedPending=integer(status.eligible_pending_event_records,0,10000);
 const countsReady=declared&&status.event_count_collection_error===null&&retained!==null&&
  reportedPending!==null&&legacy===reportedPending&&reportedPending<=retained;
 const pending=countsReady?reportedPending:null;
 const countError=countsReady?null:declared?'event_count_scope_or_collection_unconfirmed':'legacy_total_only_pending_unknown';
 const allowed=new Set(['budget_held','idle','webhook_accepted','delivery_refused','uncertain','reconciliation_required','not_attempted']);
 const last=allowed.has(status.last_dispatch?.state)?status.last_dispatch.state:null;
 let state='unknown',reason='delivery_not_confirmed';
 if(!active){state='inactive';reason='subscription_inactive';}
 else if(['uncertain','reconciliation_required'].includes(last)){
  state='reconciliation_required';
  const blockers=new Set(['event_history_archive_full','event_storage_full','clock_reconciliation_required',
   'summary_scope_unconfirmed','summary_event_unconfirmed','summary_payload_limit','event_dispatch_reconciliation_required']);
  reason=last==='reconciliation_required'&&blockers.has(status.last_dispatch?.reason)?status.last_dispatch.reason:'dispatch_result_uncertain';
 }else if(attempts!==null&&maximum!==null&&attempts>=maximum){
  state='budget_held';reason='rolling_daily_attempt_limit_reached';
 }else if(last==='budget_held'){
  state='budget_held';reason='budget_or_spacing_hold_observed';
 }else if(!sourceFresh)reason='source_evidence_unavailable';
 return {state,reason,last_dispatch_state:last,attempts_last_24h:attempts,
  maximum_attempts_per_day:maximum,minimum_attempt_spacing_seconds:spacing,
  queued_event_records:pending,queued_event_records_semantics:'eligible_pending_current_active_principal',
  retained_event_records:retained,eligible_pending_event_records:pending,
  event_count_collection_error:countError,
  event_count_coverage:['pending_active_same_principal_topic_last24h_and_subscription_start',
   'existing_intents_excluded_including_uncertain','count_not_delivery_or_assistant_execution'],
  summary:projectSummary(status,now),
  assistant_execution:'unknown',automatic_retry:false};
}

// Closed projection: server status is not proof of assistant execution.
export function projectEvents(status, now=Date.now()) {
 const unknown=reason=>({state:'unknown',reason,assistant_execution:'unknown'});
 if(!status||typeof status!=='object'||status.collection_error||status.subscription_diagnostic_error)
  return unknown('event_status_unavailable');
 const lease=status.subscription_lease;
 const observed=Date.parse(status.observed_at);
 const expires=Date.parse(lease?.expires_at);
 if(!Number.isFinite(observed)||observed>now+1000||now-observed>20000)
  return unknown('event_status_time_missing_stale_or_conflicting');
 if(!Number.isSafeInteger(status.active_subscriptions)||status.active_subscriptions<0||status.active_subscriptions>1)
  return unknown('event_subscription_count_unconfirmed');
 if(!lease||!['active','expired','inactive','not_collected'].includes(lease.state))
  return unknown('event_lease_unconfirmed');
 if(lease.state==='active'&&(!Number.isFinite(expires)||expires<=now||status.active_subscriptions!==1))
  return unknown('event_lease_conflicting');
 if(lease.state!=='active'&&status.active_subscriptions!==0)
  return unknown('event_lease_conflicting');
 const health=status.source_health;
 const sourceObserved=Date.parse(health?.observed_at);
 const sourceFresh=health?.state==='observed'&&health.collection_error==null&&
  Number.isFinite(sourceObserved)&&sourceObserved<=now+1000&&now-sourceObserved<=15000;
 return {state:lease.state==='active'?'active':'inactive',observed_at:status.observed_at,
  subscription_state:lease.state,active_subscriptions:status.active_subscriptions,
  expires_at:Number.isFinite(expires)?lease.expires_at:null,
  source_state:sourceFresh?'observed':'unknown',assistant_execution:'unknown',
  delivery:projectDelivery(status,lease.state==='active',sourceFresh,now),
  coverage:['live_subscription_and_dispatch_status_only','HA_sanitized_notices_only',
   'webhook_acceptance_not_assistant_execution','not_PC_off_or_24h_proof']};
}

export function correctCapabilities(value, eventStatus, now=Date.now()) {
 const out=structuredClone(value);
 const data=out?.evidence?.data;
 if(!data)return out;
 delete data.native_events;
 if(data.ha_notification_observer){
  delete data.ha_notification_observer.events_discovery_only;
  delete data.ha_notification_observer.events_subscription_enabled;
  data.ha_notification_observer.event_subscription_interface_implemented=true;
 }
 data.events={capability_static:{implemented:true,sanitized_HA_notifications_only:true,
  verified_callback_required:true,automatic_retry:false},
  current_observation:projectEvents(eventStatus,now)};
 data.capability_semantics='static_interfaces_are_not_current_health_or_approval';
 return out;
}
