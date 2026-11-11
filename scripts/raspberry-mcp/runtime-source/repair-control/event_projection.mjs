import {createHash} from 'node:crypto';
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

// Exact lineage is distinct from provider acceptance and assistant execution.
export function projectLatestDeliveryReceipt(status, now=Date.now()) {
 const source='source_event_batch_transport_receipt_projection_v1';
 const unknown=reason=>({source,observed_at:null,age_seconds:null,state:'unknown',
  collection_error:reason,coverage:['no_unreviewed_fields','not_assistant_execution'],assistant_execution:'unknown'});
 const r=status.latest_delivery_receipt;
 const stamp=x=>typeof x==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(x)&&Number.isFinite(Date.parse(x));
 const sha=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
 const number=x=>typeof x==='number'&&Number.isFinite(x)&&x>=0;
 if(!r||r.schema_version!==1||r.source!=='source_event_batch_transport_receipt_v1'||
  !stamp(r.observed_at)||Date.parse(r.observed_at)>now+1000||now-Date.parse(r.observed_at)>20000||
  r.age_seconds!==0||r.assistant_execution!=='unknown'||r.maximum_members!==8)
  return unknown('delivery_receipt_unavailable_or_stale');
 if(r.state==='empty'&&r.collection_error===null&&r.returned_members===0&&Array.isArray(r.members)&&r.members.length===0)
  return {source,observed_at:r.observed_at,age_seconds:Math.max(0,(now-Date.parse(r.observed_at))/1000),
   state:'empty',collection_error:null,members:[],coverage:['no_matching_principal_dispatch'],assistant_execution:'unknown'};
 if(r.state!=='observed'||r.collection_error!==null||!sha(r.batch_id)||!sha(r.subscription_id_sha256)||
  !stamp(r.intent_at)||Date.parse(r.intent_at)>Date.parse(r.observed_at)+1000||!number(r.data_age_seconds)||
  !['webhook_accepted','delivery_refused','uncertain'].includes(r.dispatch_state)||r.batch_membership_verified!==true||
  !Number.isSafeInteger(r.membership_record_count)||r.membership_record_count<1||r.membership_record_count>256||
  !sha(r.members_digest_sha256)||!Array.isArray(r.members)||r.members.length!==Math.min(r.membership_record_count,8)||
  r.returned_members!==r.members.length||r.members_truncated!==(r.membership_record_count>8))
  return unknown('delivery_receipt_binding_unconfirmed');
 const terminal=r.delivery_kind==='task_terminal_summary_v1';
 if(r.delivery_kind!==undefined&&!terminal||terminal&&r.functional_recovery_proven!==false)return unknown('delivery_receipt_kind_unconfirmed');
 const seen=new Set(),members=[];
 for(const m of r.members) {
  if(!m||m.source!=='retained_registry_event'||!sha(m.event_id)||seen.has(m.event_id)||!sha(m.object_id)||!sha(m.revision)||
   !(terminal?m.phase==='terminal'&&typeof m.operation_id==='string'&&/^[a-f0-9]{32}$/.test(m.operation_id)&&['completed','failed','interrupted','not_dispatched'].includes(m.terminal_state)&&createHash('sha256').update('task-terminal-operation-v1:'+m.operation_id).digest('hex')===m.object_id:['added','updated','removed'].includes(m.phase))||!stamp(m.observed_at)||!number(m.age_seconds)||
   Date.parse(m.observed_at)>Date.parse(r.intent_at)+1000||m.collection_error!==null||!['current','archive'].includes(m.record_location))
   return unknown('delivery_receipt_member_unconfirmed');
  seen.add(m.event_id);members.push({source:m.source,event_id:m.event_id,object_id:m.object_id,revision:m.revision,
   phase:m.phase,observed_at:m.observed_at,age_seconds:m.age_seconds,collection_error:null,record_location:m.record_location,
   coverage:['retained_event_identity_only','not_universal_source_clock'],...(terminal?{operation_id:m.operation_id,terminal_state:m.terminal_state}:{})});
 }
 const t=r.transport;
 const errors=[null,'transport_completion_missing','sender_duration_unavailable','completion_clock_unavailable','transport_clock_order_unconfirmed'];
 if(!t||t.source!=='native_transport_completion'||!['recorded','unknown'].includes(t.state)||!errors.includes(t.collection_error)||
  ![null,'response_2xx','response_non2xx','outcome_unknown'].includes(t.outcome)||
  t.observed_at!==null&&!stamp(t.observed_at)||t.age_seconds!==null&&!number(t.age_seconds)||
  t.sender_duration_ms!==null&&(!number(t.sender_duration_ms)||t.sender_duration_ms>1e9)||
  t.state==='recorded'&&(t.collection_error!==null||!stamp(t.observed_at)||!number(t.age_seconds)||
   Date.parse(t.observed_at)<Date.parse(r.intent_at)||Date.parse(t.observed_at)>Date.parse(r.observed_at)+1000))
  return unknown('delivery_receipt_transport_unconfirmed');
 const transport={source:t.source,observed_at:t.observed_at,age_seconds:t.age_seconds,state:t.state,
  outcome:t.outcome,sender_duration_ms:t.sender_duration_ms,collection_error:t.collection_error,
  coverage:['same_subscription_and_batch_join','sender_call_only_not_assistant_execution']};
 return {source,observed_at:r.observed_at,age_seconds:Math.max(0,(now-Date.parse(r.observed_at))/1000),state:'observed',
  collection_error:null,batch_id:r.batch_id,subscription_id_sha256:r.subscription_id_sha256,intent_at:r.intent_at,
  data_age_seconds:r.data_age_seconds,dispatch_state:r.dispatch_state,batch_membership_verified:true,
  membership_record_count:r.membership_record_count,members_digest_sha256:r.members_digest_sha256,
  maximum_members:8,returned_members:members.length,members_truncated:r.members_truncated,members,transport,
  coverage:['same_principal_retained_event_to_batch_to_transport','bounded_member_details_not_whole_history',
   'not_universal_source_clock_or_functional_recovery'],assistant_execution:'unknown',
  ...(terminal?{delivery_kind:'task_terminal_summary_v1',functional_recovery_proven:false}:{})};
}

export function projectClientExecutionPolicy(value, now=Date.now(), scope=null, terminal=null) {
 const unknown={source:'sealed_task_terminal_client_policy',state:'unknown',approval_active:false,continuation_ready:false,execution_proven:false,collection_error:'client_policy_unconfirmed',coverage:['approval_not_executor_admission']};
 const observed=Date.parse(value?.observed_at);
 if(!value||value.source!=='sealed_task_terminal_client_policy'||!Number.isFinite(observed)||observed>now+1000||now-observed>20000||value.age_seconds!==0||value.execution_proven!==false||!['approved','disabled','expired','unknown'].includes(value.state)||typeof value.approval_active!=='boolean')return unknown;
 if(value.state==='unknown')return unknown;
 const p=value.policy;
 const exact=(obj,keys)=>obj&&typeof obj==='object'&&!Array.isArray(obj)&&Object.keys(obj).sort().join(',')===keys.slice().sort().join(',');
 if(!exact(p,['schema_version','kind','enabled','expires_at','client_neutral','target','allowed_tools','identity_recipe','limits','interface_confirmations_required','new_host_schedule_enabled','pending_OTP','uncertain_operations','workflows','authorization_does_not_override_backend'])||!exact(p.identity_recipe,['creation','task_key_prefix','send','terminal'])||!exact(p.limits,['maximum_sends_per_24h','minimum_spacing_seconds','concurrent_new_sends','backend_limits_authoritative'])||p.schema_version!==1||p.kind!=='client_incident_and_task_continuation_v1'||typeof p.enabled!=='boolean'||p.client_neutral!==true||p.target!=='raspberry:/mnt/data/docker'||!Number.isSafeInteger(p.expires_at)||p.expires_at<0||p.expires_at>253402300799||p.interface_confirmations_required!==true||p.authorization_does_not_override_backend!==true||p.new_host_schedule_enabled!==false||p.uncertain_operations!=='observe_same_id_never_replay'||p.pending_OTP!=='stop_dependent_effects'||JSON.stringify(p.allowed_tools)!==JSON.stringify(['codex_task_create','codex_task_send','codex_task_status','codex_task_reconcile','codex_task_list'])||JSON.stringify(p.workflows)!==JSON.stringify(['natural_actionable_ha_notification','registered_task_terminal'])||p.limits?.maximum_sends_per_24h!==48||p.limits?.minimum_spacing_seconds!==60||p.limits?.concurrent_new_sends!==1||p.limits?.backend_limits_authoritative!==true||p.identity_recipe?.creation!=='ha_object_id_prefix_32'||p.identity_recipe?.task_key_prefix!=='eva-admin-'||p.identity_recipe?.send!=='ha_revision_suffix_32'||p.identity_recipe?.terminal!=='exact_operation_id_from_registered_task_terminal_event')return unknown;
 const approved=p.enabled&&now/1000<p.expires_at;
 const ready=approved&&scope?.state==='observed'&&JSON.stringify(scope.topics)===JSON.stringify(['ha_notification','task_terminal'])&&terminal?.state==='observed';
 if(value.continuation_ready!==ready||value.approval_active!==approved||value.state!==(approved?'approved':p.enabled?'expired':'disabled')||value.collection_error!==null)return unknown;
 return {source:value.source,observed_at:value.observed_at,age_seconds:Math.max(0,(now-observed)/1000),state:value.state,collection_error:null,approval_active:approved,continuation_ready:ready,execution_proven:false,policy:p,coverage:['approval_not_executor_admission','scope_and_client_policy_only_not_backend_admission']};
}

export function projectTerminalSource(value, now=Date.now()) {
 const safe=new Set(['control_socket_changed','control_peer_changed','observer_boot_changed','legacy_policy_binding_changed','sealed_source_scope_changed','sealed_source_digest_changed','sealed_dependency_digest_changed','policy_changed_during_observation','unregistered_observation_refused','observation_deadline_exceeded','database_journal_requires_reconciliation','unsafe_registered_file','unsafe_state_directory','unsafe_lock','invalid_registered_terminal','invalid_terminal_receipt','registered_send_changed','duplicate_receipt_key','nonfinite_receipt','observation_transport_unconfirmed','observation_transport_timeout','task_coordinator_busy','observation_unconfirmed','terminal_registry_truncated']);
 const observed=Date.parse(value?.observed_at);
 if(value?.source==='registered_task_terminal_observer_v1'&&value.state==='observed'&&value.collection_error===null&&Number.isFinite(observed)&&observed<=now+1000&&now-observed<=120000)
  return {source:'registered_task_terminal_observer_v1',state:'observed',observed_at:value.observed_at,age_seconds:Math.max(0,(now-observed)/1000),collection_error:null,coverage:['bounded_24h_observer_not_complete_history','ingest_not_delivery_or_assistant_execution']};
 const reason=['not_collected','terminal_snapshot_unconfirmed','terminal_snapshot_stale','terminal_health_time_unconfirmed','terminal_source_collection_unavailable'].includes(value?.collection_error)?value.collection_error:'terminal_snapshot_unconfirmed';
 return {source:'registered_task_terminal_observer_v1',state:'unknown',observed_at:Number.isFinite(observed)?value.observed_at:null,age_seconds:Number.isFinite(observed)&&now>=observed?(now-observed)/1000:null,collection_error:reason,source_collection_error:safe.has(value?.source_collection_error)?value.source_collection_error:null,coverage:['not_household_outage_or_execution_proof']};
}

export function projectSubscriptionScope(value, now=Date.now()) {
 const unknown={source:'authenticated_active_subscription_scope',state:'unknown',topics:[],collection_error:'subscription_scope_unconfirmed',coverage:['not_execution_or_backend_admission']};
 const stamp=Date.parse(value?.observed_at),sha=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
 if(!value||value.source!=='authenticated_active_subscription_scope'||!Number.isFinite(stamp)||stamp>now+1000||now-stamp>20000||value.age_seconds!==0||value.collection_error!==null)return unknown;
 if(value.state==='inactive'&&Array.isArray(value.topics)&&value.topics.length===0&&value.subscription_id_sha256===null&&value.predecessor_id_sha256===null)
  return {source:value.source,state:'inactive',observed_at:value.observed_at,age_seconds:Math.max(0,(now-stamp)/1000),collection_error:null,topics:[],subscription_id_sha256:null,predecessor_id_sha256:null,coverage:['not_execution_or_backend_admission']};
 if(value.state!=='observed'||!Array.isArray(value.topics)||!['["ha_notification"]','["task_terminal"]','["ha_notification","task_terminal"]'].includes(JSON.stringify(value.topics))||!sha(value.subscription_id_sha256)||!(value.predecessor_id_sha256===null||sha(value.predecessor_id_sha256)))return unknown;
 return {source:value.source,state:'observed',observed_at:value.observed_at,age_seconds:Math.max(0,(now-stamp)/1000),collection_error:null,topics:value.topics.slice(),subscription_id_sha256:value.subscription_id_sha256,predecessor_id_sha256:value.predecessor_id_sha256,coverage:['not_execution_or_backend_admission']};
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
  latest_delivery_receipt:projectLatestDeliveryReceipt(status,now),
  ...(status.subscription_scope?{subscription_scope:projectSubscriptionScope(status.subscription_scope,now)}:{}),
  ...(status.client_execution_policy?{client_execution_policy:projectClientExecutionPolicy(status.client_execution_policy,now,projectSubscriptionScope(status.subscription_scope,now),projectTerminalSource(status.terminal_source_health,now))}:{}),
  ...(status.terminal_source_health?{terminal_source_health:projectTerminalSource(status.terminal_source_health,now)}:{}),
  coverage:['live_subscription_and_dispatch_status_only',status.terminal_source_health?'scoped_HA_and_registered_terminal_sources':'HA_sanitized_notices_only',
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

// Pure final projection after the existing actual frontend tools/list discovery.
// This cannot turn a denied/unknown admission into an allowed action.
export function finalizeOperatingPolicy(policy, catalogue, now=Date.now()) {
 const value=structuredClone(policy);
 if(value?.schema_version!==1||value?.client_neutral!==true||!Array.isArray(value.actions))return value;
 const tools=new Set(Array.isArray(catalogue)?catalogue.filter(x=>typeof x==='string'):[]);
 const permitted=new Set(['ready','blocked','unsupported','requires_confirmation']);
 for(const action of value.actions){
  if(typeof action.tool!=='string')continue;
  if(!tools.has(action.tool)){
   action.state='unsupported';action.reason='tool_not_in_current_frontend_catalogue';
  }else if(permitted.has(action.admission_state)){
   action.state=action.admission_state;action.reason=action.admission_reason;
  }else{
   action.state='blocked';action.reason='canonical_admission_decision_missing';
  }
  if(['privileged_task','workspace_task'].includes(action.role)&&action.state!=='unsupported'){
   const at=Date.parse(value.evidence?.task_admission?.observed_at);
   const workspace=action.role==='workspace_task';
   const expires=workspace?value.authority?.workspace_expires_at:(value.authority?.administrative_expires_at??value.authority?.expires_at);
   const active=workspace?value.authority?.workspace_admission_active:value.authority?.admission_active;
   const persistentWorkspace=workspace&&expires===null&&active===true&&value.authority?.revoked===false&&
     value.authority?.task_policy_schema==='raspberry-task-policy-v2'&&
     value.authority?.task_policy_lease_kind==='persistent_revocable'&&
     value.evidence?.task_admission?.state==='observed'&&value.evidence?.task_admission?.collection_error===null;
   const temporalActive=persistentWorkspace||(typeof expires==='number'&&Number.isFinite(expires)&&now<expires*1000);
   if(active!==true||value.authority?.revoked===true||!temporalActive||
     !Number.isFinite(at)||at>now||now-at>120000){
    action.state='blocked';action.reason='fresh_existing_admission_required';
   }
  }
  // An interface confirmation is NEVER satisfied by this metadata projection.
  if(action.interface_confirmation_required===true&&action.state==='ready'){
   action.state='requires_confirmation';action.reason='existing_interface_confirmation_required';
  }
  action.tool_availability_source='actual_frontend_catalogue';
 }
 value.coverage=[...(value.coverage??[]),'actual_frontend_catalogue_verified_without_widening_admission'];
 return value;
}
