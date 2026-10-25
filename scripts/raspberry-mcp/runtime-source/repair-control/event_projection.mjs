// Budget and a subscription lease are separate observations. Never infer a model run.
function projectDelivery(status, active, sourceFresh) {
 const integer=(value,minimum=0,maximum=4096)=>Number.isSafeInteger(value)&&value>=minimum&&value<=maximum?value:null;
 const attempts=integer(status.attempts_last_24h);
 const maximum=integer(status.maximum_attempts_per_day,1);
 const spacing=integer(status.minimum_attempt_spacing_seconds,0,86400);
 const queued=integer(status.queued_event_records,0,10000);
 const allowed=new Set(['budget_held','idle','webhook_accepted','delivery_refused','uncertain','reconciliation_required','not_attempted']);
 const last=allowed.has(status.last_dispatch?.state)?status.last_dispatch.state:null;
 let state='unknown',reason='delivery_not_confirmed';
 if(!active){state='inactive';reason='subscription_inactive';}
 else if(['uncertain','reconciliation_required'].includes(last)){
  state='reconciliation_required';reason='dispatch_result_uncertain';
 }else if(attempts!==null&&maximum!==null&&attempts>=maximum){
  state='budget_held';reason='rolling_daily_attempt_limit_reached';
 }else if(last==='budget_held'){
  state='budget_held';reason='budget_or_spacing_hold_observed';
 }else if(!sourceFresh)reason='source_evidence_unavailable';
 return {state,reason,last_dispatch_state:last,attempts_last_24h:attempts,
  maximum_attempts_per_day:maximum,minimum_attempt_spacing_seconds:spacing,
  queued_event_records:queued,assistant_execution:'unknown',automatic_retry:false};
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
  delivery:projectDelivery(status,lease.state==='active',sourceFresh),
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
