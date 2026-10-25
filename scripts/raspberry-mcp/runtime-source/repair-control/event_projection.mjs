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
  coverage:['live_subscription_status_only','HA_sanitized_notices_only',
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
