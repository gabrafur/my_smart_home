"""UNACTIVATED closed maintenance core. Manager/store adapters are not installed.

One fixed diagnostics unit and reviewed Compose service; each preview pins the
current container/image. No paths,
commands, IPs or policy overrides supplied by the MCP caller. No scheduler.
"""
import copy
import datetime
import hashlib
import json
import math
import ipaddress
import re

UNIT='raspberry-nodered-diagnostics.service'
TOOLS=('admin_action_apply','admin_action_status','admin_action_reconcile','admin_action_revoke')
ACTIONS=('nodered_plan_reader_binding','nodered_apply_reader_binding',
 'nodered_plan_restore_reader_binding','nodered_restore_reader_binding','nodered_revoke_reader_binding')
BUSY=('apply_intent','outcome_unknown','restore_intent','restore_unknown')
MAXIMUM_PER_24H=4
MINIMUM_SPACING=600
PLAN_SECONDS=900

class Refused(ValueError):pass
def need(value,reason):
 if not value:raise Refused(reason)

def validate(tool,args):
 need(tool in TOOLS and type(args)is dict and set(args)=={'host','action','idempotency_key'},'fixed_request_required')
 need(args['host']=='raspberry'and args['action']in ACTIONS and type(args['idempotency_key'])is str and re.fullmatch(r'nodered-peer-[a-f0-9]{32}',args['idempotency_key'])is not None,'binding_scope_refused')
 need((tool=='admin_action_revoke') == (args['action']=='nodered_revoke_reader_binding'),'binding_scope_refused')
 return args['idempotency_key'][13:]

def networks(values):
 need(type(values)is list and len(values)<=8 and all(type(v)is str for v in values),'invalid_network_metadata')
 return sorted(str(ipaddress.ip_network(v,strict=False))for v in values)

def valid_clock(value):
 return type(value) in (int,float) and math.isfinite(value) and 0<=value<=253402300799

def incident_key(row):
 # Only verified server metadata/receipts enter this domain-separated digest.
 # Instance IDs provide entropy; no additional secret, policy or file is used.
 instance=row.get('instance')
 need(type(instance)is dict and set(instance)=={'container_id','image_id'} and
  all(type(v)is str and re.fullmatch('[a-f0-9]{64}',v) for v in instance.values()),'incident_instance_unconfirmed')
 unit_hash=row.get('unit_sha256')
 need(type(unit_hash)is str and re.fullmatch('[a-f0-9]{64}',unit_hash),'incident_unit_unconfirmed')
 # A reviewed code revision or a duplicate ACL entry is not a new incident.
 # Current unit admission is still checked independently by inspect().
 value={'domain':'fixed-nodered-reader-incident-v1','unit':UNIT,
  'instance':instance,'before':sorted(set(networks(row['before']))),
  'after':sorted(set(networks(row['after'])))}
 return 'nri1-'+hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':')).encode()).hexdigest()

class Controller:
 def __init__(self,policy,store,manager,clock):
  self.policy=copy.deepcopy(policy);self.store=store;self.manager=manager;self.clock=clock
  need(set(policy)=={'enabled','recurring_execution_enabled','target_kind','network_id','network_name','subnet','base_allow','seed_peers','unit_hashes'},'fixed_policy_fields_required')
  need(policy['target_kind']=='fixed_compose_nodered_service_on_existing_listener','fixed_logical_service_required')
  need(policy['network_name']=='docker_default'and type(policy['enabled'])is bool and type(policy['recurring_execution_enabled'])is bool,'fixed_policy_required')
  need(type(policy['network_id'])is str and re.fullmatch('[a-f0-9]{64}',policy['network_id']),'fixed_network_identity_required')
  need(type(policy['unit_hashes'])is list and 1<=len(policy['unit_hashes'])<=2 and all(re.fullmatch('[a-f0-9]{64}',v)for v in policy['unit_hashes']),'fixed_unit_hashes_required')
  self.subnet=ipaddress.IPv4Network(policy['subnet'],strict=True)
  need(self.subnet.is_private and self.subnet.prefixlen>=16,'private_network_boundary_required')
  self.base=networks(policy['base_allow'])
  need(len(self.base)==3 and '127.0.0.0/8'in self.base and '::1/128'in self.base,'reviewed_base_networks_required')
  host=set(self.base)-{'127.0.0.0/8','::1/128'};need(len(host)==1,'single_host_listener_required')
  host=ipaddress.ip_network(next(iter(host)));need(host.version==4 and host.prefixlen==32 and host.is_private,'single_private_host_listener_required')
  need(type(policy['seed_peers'])is list and 1<=len(policy['seed_peers'])<=2,'fixed_seed_peers_required')
  self.seeds={str(ipaddress.IPv4Address(v))for v in policy['seed_peers']}
  need(all(ipaddress.IPv4Address(v)in self.subnet for v in self.seeds),'seed_outside_reviewed_network')

 def inspect(self):
  value=self.manager.inspect()
  need(set(value)=={'container_id','image_id','network_id','network_name','peer_ipv4','running','unit_sha256','unit_active','deny_all','allowed','logical_service_verified'},'fixed_manager_metadata_required')
  for k in ('network_id','network_name'):need(value[k]==self.policy[k],'identity_changed_specific_owner_review_required')
  need(value['logical_service_verified']is True,'reviewed_logical_NodeRED_service_not_verified')
  need(all(type(value[k])is str and re.fullmatch('[a-f0-9]{64}',value[k])for k in('container_id','image_id')),'observed_instance_identity_unconfirmed')
  need(value['running']is True and value['unit_sha256']in self.policy['unit_hashes']and value['deny_all']is True and value['unit_active']in('active','inactive'),'reviewed_unit_or_container_unavailable')
  peer=ipaddress.IPv4Address(value['peer_ipv4'])
  need(peer in self.subnet and not(peer.is_multicast or peer.is_loopback or peer.is_unspecified or peer==self.subnet.network_address or peer==self.subnet.broadcast_address),'peer_outside_reviewed_container_network')
  allowed=networks(value['allowed']);need(set(self.base)<=set(allowed),'base_networks_changed')
  other=set(allowed)-set(self.base);need(len(other)==1,'unexpected_network_permission_set')
  old=ipaddress.IPv4Network(next(iter(other)),strict=True);need(old.prefixlen==32 and old.network_address in self.subnet,'single_peer_only')
  # A durable intent authorizes recognition of its exact derived peer while
  # checking a write or reconciling a lost reply; a mere plan does not.
  approved=self.seeds|{row['after_peer']for row in self.store.history()if row.get('state')in(*BUSY,'applied','restore_planned','restored')}
  need(str(old.network_address)in approved,'foreign_binding_requires_reconciliation')
  return {'peer':str(peer),'allowed':allowed,'unit_active':value['unit_active'],'unit_sha256':value['unit_sha256'],
   'instance':{'container_id':value['container_id'],'image_id':value['image_id']}}

 def admission(self,now):
  need(self.policy['enabled']and not self.store.revoked(),'binding_catalogue_revoked')
  history=self.store.history();need(len(history)<=64,'binding_history_capacity')
  need(not any(row['state']in BUSY for row in history),'uncertain_binding_operation_requires_reconciliation')
  effects=[effect['at']for row in history for effect in row.get('effects',[])]
  need(all(type(at)in(int,float)and at<=now+1 for at in effects),'clock_reversal_requires_reconciliation')
  need(sum(now-86400<=at<=now for at in effects)<MAXIMUM_PER_24H,'binding_daily_budget_exhausted')
  need(not effects or now-max(effects)>=MINIMUM_SPACING,'binding_minimum_spacing')
  need(self.manager.headroom(),'host_headroom_unconfirmed')

 def _receipt_view(self,row):
  # Neither the private container/network IDs nor IPs enter the MCP result.
  age=self.clock()-row['observed_at_unix']
  effect_at=row.get('last_effect_observed_at');effect_age=None if effect_at is None else self.clock()-effect_at
  return {'source':'fixed_NodeRED_reader_binding_catalogue_candidate','observed_at':datetime.datetime.fromtimestamp(row['observed_at_unix'],datetime.timezone.utc).isoformat(),'age_seconds':age if age>=0 else None,'collection_error':None if age>=0 else'clock_order_unconfirmed','operation_id':row['id'],'state':row['state'],'target':UNIT,'reviewed_logical_service_only':True,'current_instance_pinned_in_each_preview':True,'proposed_effect':'restore_only_own_previous_return_peer'if row['state']=='restore_planned'else'replace_only_one_derived_container_ipv4_return_peer','maximum_write_calls_per_request':1,'maximum_total_writes_per_operation':2,'service_restarts':0,'automatic_retry':False,'recurring_execution_enabled':self.policy['recurring_execution_enabled'],'interface_confirmation_preserved':True,'dry_run':row['state']in('planned','no_change','restore_planned'),'prior_uncertainty':row.get('reconciled_from'),'effect_evidence':row.get('last_effect_evidence','no_confirmed_native_effect'),'effect_observed_at':None if effect_at is None else datetime.datetime.fromtimestamp(effect_at,datetime.timezone.utc).isoformat(),'effect_age_seconds':effect_age if effect_age is not None and effect_age>=0 else None,'restore_preview_revision':len(row.get('restore_previews',[])),'coverage':['durable_receipt_clock_not_current_network_health','network_binding_only_not_NodeRED_application_repair','not_Eva_execution_or_whole_goal_acceptance']}

 def view(self,row,association='stored_receipt_not_current_target',matched=False):
  now=self.clock()
  need(valid_clock(now) and valid_clock(row['observed_at_unix']),'clock_order_unconfirmed')
  result=self._receipt_view(row)
  planned=row.get('planned_at');expires=row.get('expires_at')
  clock_ok=valid_clock(planned) and valid_clock(expires) and planned<=row['observed_at_unix']<=now and planned<expires
  effects=row.get('effects',[])
  clock_ok=clock_ok and all(valid_clock(e.get('at')) and e['at']<=now for e in effects)
  preview='not_applicable'
  if not clock_ok:preview='clock_invalid'
  elif row['state']=='planned':preview='valid' if now<expires else 'expired_without_effect' if not effects else 'expired'
  if not clock_ok:result.update(age_seconds=None,collection_error='clock_order_unconfirmed')
  result['incident_correlation']={'key':incident_key(row),'association_source':association,
   'existing_operation':matched,'observe_only':matched or row['state']!='planned' or preview!='valid',
   'preview_status':preview,'clock_order_confirmed':clock_ok,'prior_effect_or_intent':bool(effects) or row['state'] in (*BUSY,'applied','restore_planned','restored','not_applied_observed'),
   'correlation_grants_effect':False,'new_key_apply_for_existing_incident':False}
  prior=row.get('prior_no_effect_preview')
  if prior is not None:
   need(type(prior)is str and re.fullmatch('[a-f0-9]{32}',prior),'incident_prior_preview_unconfirmed')
   result['incident_correlation']['prior_no_effect_preview_operation_id']=prior
  return result

 def renewable_no_effect_preview(self,row,now):
  planned=row.get('planned_at');expires=row.get('expires_at');observed=row.get('observed_at_unix')
  return row['state']=='planned' and not row.get('effects') and all(valid_clock(v)for v in(planned,expires,observed)) and planned<=observed<=now and planned<expires<=now

 def correlation_read_admission(self,now):
  # Matching is observation only; all original admission checks remain below
  # for new plans AND on every effect. No manager is built by passive discovery.
  need(self.policy['enabled'] and not self.store.revoked(),'binding_catalogue_revoked')
  need(valid_clock(now),'clock_order_unconfirmed')
  history=self.store.history();need(len(history)<=64,'binding_history_capacity')
  need(not any(row['state'] in BUSY for row in history),'uncertain_binding_operation_requires_reconciliation')
  need(all(valid_clock(e.get('at')) and e['at']<=now+1 for r in history for e in r.get('effects',[])),
   'clock_reversal_requires_reconciliation')
  need(self.manager.headroom(),'host_headroom_unconfirmed')

 def matching_incident(self,actual,after):
  matches=[]
  for row in self.store.history():
   if row.get('instance')!=actual['instance']:continue
   incident_key(row) # Validate before deriving or comparing any legacy record.
   before=sorted(set(networks(row['before'])));wanted=sorted(set(networks(row['after'])))
   if wanted==sorted(set(after)) and sorted(set(actual['allowed'])) in (before,wanted):
    matches.append(row)
  if not matches:return None
  used=[r for r in matches if r.get('effects') or r['state'] in (*BUSY,'applied','restore_planned','restored','not_applied_observed')]
  need(len(used)<=1,'ambiguous_incident_history_requires_review')
  # A fresh, untouched preview can replace expired no-effect previews without
  # extending or rewriting their receipts. Effects/intents always take priority.
  active=[r for r in matches if r['state']=='planned' and not r.get('effects')
   and all(valid_clock(r.get(k))for k in('planned_at','expires_at','observed_at_unix'))
   and r['planned_at']<=r['observed_at_unix']<=self.clock()<r['expires_at']]
  pool=used or active or matches
  need(all(valid_clock(r.get('planned_at')) for r in pool),'incident_receipt_clock_unconfirmed')
  return min(pool,key=lambda r:(r['planned_at'],r['id']))

 def request(self,tool,args):
  identifier=validate(tool,args);now=self.clock()
  with self.store.lock():
   if tool=='admin_action_revoke':
    duplicate=self.store.revoke()
    return {'source':'fixed_NodeRED_reader_binding_revocation','state':'revoked',
     'observed_at':datetime.datetime.fromtimestamp(now,datetime.timezone.utc).isoformat(),
     'age_seconds':0,'collection_error':None,'duplicate':duplicate,
     'execution_active':False,'automatic_retry':False,
     'coverage':['ledger_and_uncertain_intents_preserved','no_reactivation_or_network_effect']}
   row=self.store.get(identifier)
   if tool=='admin_action_status':
    need(row is not None,'binding_operation_not_found');return self.view(row)
   if tool=='admin_action_reconcile':
    need(row is not None,'binding_operation_not_found')
    if row['state']in BUSY:
     actual=self.inspect();old=row['state'];kind='restore'if old in('restore_intent','restore_unknown')else'apply'
     need(actual['instance']==row['instance'],'instance_changed_uncertain_operation_requires_reconciliation')
     expected=row['before']if kind=='restore'else row['after']
     if actual['allowed']==expected:row['state']='restored'if kind=='restore'else'applied'
     elif actual['allowed']==(row['after']if kind=='restore'else row['before']):row['state']='not_applied_observed'
     else:raise Refused('foreign_binding_preserved_no_replay')
     row['reconciled_from']=old;row['observed_at_unix']=self.clock();row['last_effect_evidence']='state_observed_after_uncertain_intent_actor_unconfirmed';row['last_effect_observed_at']=row['observed_at_unix'];self.store.save(row)
    return self.view(row)
   action=args['action']
   if action=='nodered_plan_reader_binding':
    if row is not None:return self.view(row,matched=True)
    self.correlation_read_admission(now)
    actual=self.inspect();after=sorted([*self.base,str(ipaddress.IPv4Address(actual['peer']))+'/32'])
    existing=self.matching_incident(actual,after)
    prior=None
    if existing is not None:
     if not self.renewable_no_effect_preview(existing,now):return self.view(existing,association='current_target_verified_by_existing_preview',matched=True)
     prior=existing['id']
    self.admission(now);need(len(self.store.history())<64,'binding_history_capacity')
    row={'id':identifier,'state':'no_change'if actual['allowed']==after else'planned','planned_at':now,'observed_at_unix':now,'expires_at':now+PLAN_SECONDS,'before':actual['allowed'],'after':after,'after_peer':actual['peer'],'unit_sha256':actual['unit_sha256'],'instance':actual['instance'],'effects':[]}
    if prior is not None:row['prior_no_effect_preview']=prior
    self.store.save(row);return self.view(row,association='current_target_verified_by_existing_preview')
   need(row is not None,'plan_required_before_effect')
   if action=='nodered_plan_restore_reader_binding':
    if row['state']not in('applied','restore_planned'):return self.view(row)
    previews=row.get('restore_previews',[])
    if row['state']=='restore_planned'and previews[-1]['at']<=now<previews[-1]['expires_at']:return self.view(row)
    self.admission(now);need(len(previews)<8,'restore_preview_capacity')
    actual=self.inspect();need(actual['instance']==row['instance'],'instance_changed_since_original_effect');need(actual['allowed']==row['after']and actual['peer']==row['after_peer'],'restore_binding_conflict')
    previews.append({'at':now,'expires_at':now+PLAN_SECONDS,'unit_sha256':actual['unit_sha256'],'peer':actual['peer']})
    row['restore_previews']=previews;row['state']='restore_planned';row['observed_at_unix']=now;self.store.save(row);return self.view(row)
   restoring=action=='nodered_restore_reader_binding'
   if restoring and row['state']=='applied':return {**self.view(row),'required_before_restore':'fresh_restore_plan'}
   if row['state']in BUSY or (not restoring and row['state']!='planned')or(restoring and row['state']!='restore_planned'):return self.view(row)
   self.admission(now)
   preview=row['restore_previews'][-1]if restoring else{'at':row['planned_at'],'expires_at':row['expires_at'],'unit_sha256':row['unit_sha256'],'peer':row['after_peer']}
   need(preview['at']<=now<preview['expires_at'],'restore_plan_expired'if restoring else'binding_plan_expired')
   self.manager.wait_inactive()
   now=self.clock();self.admission(now)
   need(preview['at']<=now<preview['expires_at'],'restore_plan_expired'if restoring else'binding_plan_expired')
   actual=self.inspect();need(actual['unit_active']=='inactive','reader_active_no_effect_performed')
   need(actual['instance']==row['instance'],'instance_changed_since_preview')
   need(actual['peer']==preview['peer']and actual['unit_sha256']==preview['unit_sha256'],'binding_changed_since_plan')
   expected=row['after']if restoring else row['before'];wanted=row['before']if restoring else row['after']
   need(actual['allowed']==expected,'binding_compare_conflict')
   if not restoring:
    canonical=self.matching_incident(actual,row['after'])
    need(canonical is not None and canonical['id']==identifier,'incident_already_has_canonical_operation')
   now=self.clock();self.admission(now);need(preview['at']<=now<preview['expires_at'],'restore_plan_expired'if restoring else'binding_plan_expired')
   row['state']='restore_intent'if restoring else'apply_intent';row['effects'].append({'kind':'restore'if restoring else'apply','at':now});row['observed_at_unix']=now;row['last_effect_evidence']='unconfirmed_intent';row['last_effect_observed_at']=now;self.store.save(row)
   try:
    self.manager.set_allow(expected,wanted)
    verified=self.inspect();need(verified['allowed']==wanted and verified['instance']==row['instance'],'binding_write_postverification_unconfirmed')
   except Exception:
    row['state']='restore_unknown'if restoring else'outcome_unknown';row['observed_at_unix']=self.clock();self.store.save(row);return self.view(row)
   row['state']='restored'if restoring else'applied';row['observed_at_unix']=self.clock();row['last_effect_evidence']='native_command_ack_and_postverification';row['last_effect_observed_at']=row['observed_at_unix'];self.store.save(row);return self.view(row)
