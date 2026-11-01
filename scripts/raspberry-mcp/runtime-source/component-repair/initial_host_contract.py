"""Closed initial-host contract and one data-only registration.

The candidate is the exact Root-installed/pinned public-source template. The
caller supplies IDs only. No source, path, shell, approval boolean, grant,
credential, effect or terminal proof comes from the model. Registration does
not validate, seal, deploy or grant a native effect.
"""
import hashlib,json,os,re,stat,time
from pathlib import Path
from component_jobs import need,ident,protected
from source_writer import read,raw,sha,write_new,protected_dir,SourceWriter
from preparer import normalized,scope,candidate_delta
from validation_profile import Validator
from preparation_storage import PreparationStorage,CAP
LIB=Path('/usr/local/lib/raspberry-component-repair')
STATE=Path('/var/lib/raspberry-component-repair')
TEMPLATE=LIB/'initial-host-proposal.json'
PURPOSE='register-initial-host-proposal'
ROOT_REQUEST_FIELDS={'schema_version','operation_id','task_id','send_id','component_id','proposal_id','root_decision_id','expected_loaded_sha256','expires_at','approval_reference_sha256'}
REGRESSION_GATES=['source_consistency','pure_function_regression','dry_run_regression','layout','left_margin','render_review','manual_tests','observability','unchanged_scope','rollback']
def _root_json(path,limit=16384):return json.loads(read(path,0,0o600,limit=limit))
def template_id(policy):
 value=policy['dependencies'][str(TEMPLATE)];ident(value,64);return value[:32]
def public_before(profile,library=LIB):
 path=Path(library)/'profiles/observacao_host/runtime/public-flow.json'
 data=read(path,0,0o444,limit=8*1048576)
 need(sha(data)==profile['harness_hashes']['public-flow.json'],'initial_public_flow_hash_changed')
 rows=scope(json.loads(data));need(0<len(rows)<=2048,'initial_public_scope_bound');return rows
def project_contract(policy,profile,canonical,registry,stamp,policy_sha,profile_sha,before_sha):
 """Pure allowlist projection; never serializes policy/profile/record objects."""
 for value in(policy_sha,profile_sha,before_sha):ident(value,64)
 names=profile['editable_sources'];need(len(names)==9 and len(set(names))==9,'initial_source_inventory_changed')
 proposal_id=template_id(policy);fixed_hash=policy['dependencies'][str(TEMPLATE)]
 sources=[]
 for name in names:
  need(type(name)is str and(name=='nodered/tools/install-host-observer-flow.mjs'or re.fullmatch(r'nodered/tools/functions/host-observer-[a-z-]+\.js',name)),'initial_source_path_changed')
  expected=profile['snapshot_hashes'][name];ident(expected,64)
  sources.append({'source_id':sha(name.encode())[:32],'public_source_key':name,'before_sha256':expected,'matches_before':canonical.get(name)==expected})
 harness_names=('validate_profile.mjs','functional_probe.mjs','sandbox_probe.py','resource-safe.sh','attestation_model.cjs','effects/nodered_effect.cjs')
 harness={name:profile['harness_hashes'][name]for name in harness_names}
 for value in harness.values():ident(value,64)
 safe_records=[]
 for row in registry['requests']:
  record={key:row[key]for key in('operation_id','task_id','send_id','proposal_id','state','expires_at')}
  for key in('operation_id','task_id','send_id','proposal_id'):ident(record[key])
  need(record['state']in('registered','uncertain_intent'),'contract_registry_state_invalid');record['workflow_state']=row.get('workflow_state','unknown');safe_records.append(record)
 safe_registry={key:registry[key]for key in('source','observed_at','age_seconds','collection_error','coverage','records','truncated')};safe_registry['requests']=safe_records
 ready=[r for r in safe_records if r['state']=='registered'and r['workflow_state']in('not_prepared','prepared')and r['proposal_id']==proposal_id and r['expires_at']>stamp+190]
 frozen_source_matches=all(s['matches_before']for s in sources)
 registry_ok=registry['collection_error']is None
 return {'schema_version':1,'state':'observed','source':'protected_initial_host_execution_contract','observed_at':stamp,'age_seconds':0,'collection_error':None,
  'coverage':['closed_initial_template_and_typed_routes','Root_registration_metadata','live_TaskBudget_and_native_identity_rechecked_at_invocation','not_validation_deploy_or_Eva_execution_receipt'],
  'component_id':'observacao_host','profile_sha256':profile_sha,'policy_sha256':policy_sha,'public_source_commit':profile['public_source_commit'],
  'expected_before_scoped_sha256':before_sha,'source_id_namespace':'protected_profile_public_source_v1;not_project_read_file_id','sources':sources,
  'immutable_harness_sha256':harness,'public_snapshot_manifest_sha256':sha(raw(profile['snapshot_hashes'])),
  'initial_template':{'proposal_id':proposal_id,'sha256':fixed_hash,'scope':'one reviewed initial host reset-status fix','client_source_or_path_input':False},
  'registry':safe_registry,'prepare_invocable':bool(ready and frozen_source_matches and registry_ok),
  'prepare_admission_semantics':'Root request registered; current owner/task/send/resources and native baseline must still pass live gates',
  'first_read_only_step':{'tool':'maintenance_capabilities','arguments':{'host':'raspberry'},'result_path':'evidence.data.protected_component_maintenance.execution_contract','native_effects':0},
  'typed_cli':{'executable':'/usr/bin/python3','flags':['-I','-S','-B'],'entrypoint':str(LIB/'root_bootstrap.py'),'entrypoint_sha256':policy['source_hashes']['root_bootstrap.py'],
   'privilege':'Root only through the existing approved owner route; helper does not acquire privileges',
   'privilege_route':{'existing_prefix':['/usr/bin/sudo','-n'],'caller_uid':1001,'run_as_uid':0,'scope':'only this typed helper within the current approved owner goal','password_or_new_sudo_rule_requested':False,'helper_rechecks_actual_owner_grant':True},
   'describe_argv':[policy_sha,'describe'],
   'register_argv':[policy_sha,PURPOSE,'<operation_id_32hex>','<existing_task_id_32hex>','<current_send_id_32hex>',proposal_id],
   'phase_argv':[policy_sha,'task','<registered_operation_id_32hex>','<closed_purpose>'],
   'closed_purposes':['prepare','validate','seal','apply','rollback','status','reconcile','verify','cancel','release']},
  'registration':{'caller_fields':['operation_id','task_id','send_id','proposal_id'],'proposal_id_must_equal':proposal_id,'data_only':True,'request_created_by':'Root typed helper from the pinned template; no manual Parent staging required',
   'task_send_must_be_currently_running':True,'principal':'derived from the authenticated local worker and protected policy; shared owner identity',
   'root_fields_derived_not_exposed':['approval_reference_sha256','root_decision_id','expiry'],'maximum_registrations':4,'followup_policy':'at most three same-task fresh-send followups after all prior operations released with native or protected preregistration forensic no-effect proof; no automatic retry','duplicate_same_ids':'observe existing receipt only','uncertain_intent':'inspect; never replay',
   'new_user_authorization_requested':False,'validation_seal_deploy_performed':False},
  'phases':{'register':'IDs only; fresh live TaskBudget, grant, public before and immutable harness checks; immutable metadata write',
   'prepare':'exact registered request/proposal; fresh scoped Node-RED GET and source snapshot; no candidate code execution',
   'validate':'one isolated UID65534 run; no credentials/network/household effects; passed still requires Root review',
   'seal':'actual source diff and actual render hashes reviewed by the authorized Root operator; registration creates no approval',
   'apply':'second live admission, source/runtime CAS and one native POST with durable intent',
   'rollback':'only the exact owned before, bound receipts and native CAS; never a free path',
   'status_reconcile':'observe existing IDs; no test, launch or effect replay',
   'verify':'specific isolated reset-code proof plus native loaded identity; not full native-flow replay',
   'cancel_release':'only states admitted by the durable workflow; preserve receipts'},
  'preconditions':['current owner lease and exact boot/code/policy','same authenticated task and live send','registered immutable template/request','canonical public before unchanged','other executors idle and no uncertainty','operations/admin/task/maintenance locks','resource headroom'],
  'postconditions':['durable IDs and intent/results','source/runtime before-after identity','session revocation or explicit cleanup uncertainty','no repeated uncertain effect','functional proof separate from loaded config'],
  'limits':{'source_files':9,'source_text_each_bytes':131072,'candidate_nodes':2048,'candidate_nodes_bytes':1048576,'changed_nodes':16,'function_body_bytes':65536,'snapshot_bytes':profile['maximum_snapshot_bytes'],'preparation_slots':profile['max_preparation_slots'],
   'state_cap_bytes':134217728,'reserved_per_preparation_bytes':33554432,'minimum_available_memory_bytes':2147483648,'minimum_free_disk_fraction':0.15,'validation_memory_bytes':536870912,'validation_cpu_percent':50,'validation_wall_seconds':180,'request_lifetime_max_seconds':86400},
  'regression_gates':REGRESSION_GATES,'regression_source':'reviewed public nodered/tools/test-host-observer.mjs and immutable fixed validator/layout/manual/observability/render gates',
  'cost':{'new_paid_API':False,'core_model_inference':False,'task_transport':'existing included Codex adapter','shared_sends_per_24h':48,'minimum_send_spacing_seconds':60,'quota_reset':False},
  'recurring_execution_enabled':False,'other_components_enabled':False,'native_full_flow_replay':False,'operator_source_and_visual_review_still_required':True,
  'client_attribution':'authenticated owner principal; not a unique chatbot identity or execution proof'}

def registration_registry(state=STATE,clock=time.time):
 state=Path(state);folder=protected_dir(state/'registrations');records=[];count=0;error=None
 import sqlite3
 read(state/'workflow.sqlite3',0,0o600,limit=1048576);db=sqlite3.connect((state/'workflow.sqlite3').as_uri()+'?mode=ro',uri=True,timeout=2)
 try:
  db.execute('PRAGMA query_only=ON');states=dict(db.execute('SELECT id,state FROM operations').fetchall())
 finally:db.close()
 for path in sorted(folder.iterdir()):
  count+=1;need(count<=4,'initial_registration_capacity_changed')
  need(re.fullmatch('[a-f0-9]{32}\.json',path.name)is not None,'initial_registration_entry_invalid')
  row=_root_json(path);need(type(row)is dict and set(row)=={'schema_version','identity','request_sha256','state','created_at','result'}and row['schema_version']==1,'initial_registration_record_invalid')
  identity=row['identity'];need(type(identity)is dict and set(identity)=={'operation_id','task_id','send_id','proposal_id'}and identity['operation_id']==path.stem,'initial_registration_identity_invalid')
  for value in identity.values():ident(value)
  if row['state']=='registered':
   result=row['result'];need(type(result)is dict and result.get('operation_id')==path.stem and type(result.get('expires_at'))in(int,float),'initial_registration_result_invalid')
   request=_root_json(state/'requests'/(path.stem+'.json'));proposal=state/'proposals'/(identity['proposal_id']+'.json')
   need(set(request)==ROOT_REQUEST_FIELDS and sha(raw(request))==result['request_sha256']and sha(read(proposal,0,0o600,limit=1048576))==result['proposal_sha256'],'initial_registered_files_changed')
   records.append({**identity,'state':'registered','workflow_state':states.get(path.stem,'not_prepared'),'expires_at':result['expires_at'],'Root_review_created':False})
  else:
   need(row['state']=='intent'and row['result']is None,'initial_registration_state_invalid');records.append({**identity,'state':'uncertain_intent','expires_at':0,'Root_review_created':False});error='registration_intent_requires_reconciliation'
 return {'source':'protected_initial_registration_ledger','observed_at':clock(),'age_seconds':0,'collection_error':error,'coverage':['immutable_registration_and_files','not_live_task_budget_or_native_execution'],'requests':records,'records':count,'truncated':False}

def describe(factory,clock=time.time):
 p=factory.policy;profile_data=factory.verified[str(STATE/'profiles/observacao_host.json')];profile=json.loads(profile_data)
 need(sha(profile_data)==p['dependencies'][str(STATE/'profiles/observacao_host.json')],'contract_profile_pin_changed')
 current=SourceWriter(profile).current();before=normalized(public_before(profile))
 return project_contract(p,profile,{name:sha(value)for name,value in current.items()},registration_registry(clock=clock),clock(),sha(read(LIB/'policy.json',0,0o644)),sha(profile_data),before)

def assert_registered_request(factory,request,state=STATE):
 """Prepare cannot use a request left behind by an uncertain registration."""
 proposal_id=template_id(factory.policy);need(request['proposal_id']==proposal_id,'initial_template_policy_only')
 identity={key:request[key]for key in('operation_id','task_id','send_id','proposal_id')}
 row=_root_json(Path(state)/'registrations'/(request['operation_id']+'.json'))
 need(row.get('schema_version')==1 and row.get('identity')==identity and row.get('state')=='registered'and row.get('request_sha256')==sha(raw(identity)),'initial_registration_not_committed')
 result=row.get('result');need(type(result)is dict and result.get('request_sha256')==sha(raw(request))and result.get('proposal_sha256')==factory.policy['dependencies'][str(TEMPLATE)],'initial_registered_request_changed')
 need(sha(read(Path(state)/'proposals'/(proposal_id+'.json'),0,0o600,limit=1048576))==result['proposal_sha256'],'initial_registered_proposal_changed')
 return True

def initial_registration_slot(state,identity,flow,principal):
 """At most four immutable registrations; every prior effect must be absent.
 Each follow-up remains same-task/same-template with a fresh LIVE send. Unknown
 outcomes, cleanup gaps and attempted effects never permit another registration.
 """
 ident(principal,64);state=Path(state);entries=list((state/'registrations').iterdir())
 need(len(entries)<4,'initial_registration_capacity_or_reservation')
 for entry in entries:
  original=_root_json(entry);prior=original.get('identity',{})
  need(original.get('schema_version')==1 and original.get('state')=='registered'and type(prior)is dict and set(prior)=={'operation_id','task_id','send_id','proposal_id'},'initial_followup_registration_unconfirmed')
  for value in prior.values():ident(value)
  old=prior['operation_id'];need(entry.name==old+'.json'and original.get('request_sha256')==sha(raw(prior)),'initial_followup_original_identity_changed')
  need(identity['operation_id']!=old and identity['task_id']==prior['task_id']and identity['proposal_id']==prior['proposal_id']and identity['send_id']!=prior['send_id'],'initial_followup_requires_same_task_and_fresh_send')
  row=flow.row(old);result=json.loads(row['result'])if row.get('result')else{}
  need(row['state']=='released'and row['component']=='observacao_host'and row['task']==prior['task_id']and result.get('definitive_no_effect')is True and result.get('security_cleanup_confirmed')is True and result.get('pending_cleanup_actions')==[],'initial_followup_original_not_safely_released')
  native=state/'workers'/'apply'/old/'receipt.json'
  if os.path.lexists(native):receipt=_root_json(native)
  else:
   forensic=state/'reconciliations'/old
   envelope=_root_json(forensic/'receipt.json');evidence=read(forensic/'evidence.json',0,0o600,limit=65536)
   need(type(envelope)is dict and set(envelope)=={'schema_version','source','operation_id','evidence_sha256','receipt'}and envelope['schema_version']==1 and envelope['source']=='protected_preregistration_forensic_reconciliation_v1'and envelope['operation_id']==old and sha(evidence)==envelope['evidence_sha256'],'initial_followup_forensic_binding_unproved')
   receipt=envelope['receipt'];need(type(receipt)is dict and receipt.get('receipt_origin')==envelope['source']and receipt.get('original_worker_receipt_present')is False and receipt.get('historical_stdout_recovered')is False and receipt.get('forensic_evidence_sha256')==envelope['evidence_sha256']and result.get('receipt_origin')==envelope['source']and result.get('forensic_evidence_sha256')==envelope['evidence_sha256']and result.get('receipt_digest')==sha(raw(receipt).rstrip(b'\n')),'initial_followup_forensic_result_unproved')
  expected={'operation_id':old,'task_id':prior['task_id'],'component_id':'observacao_host','action':'apply','principal_sha256':principal,'before_sha256':row['base'],'after_sha256':row['candidate'],'state':'rejected_without_effect'}
  need(all(receipt.get(k)==v for k,v in expected.items())and receipt.get('receipt_verified')is True and receipt.get('executor_terminal')is True and receipt.get('definitive_no_effect')is True and receipt.get('effect_attempted')is False and receipt.get('session_revoked')is True and receipt.get('security_cleanup_confirmed')is True,'initial_followup_native_no_effect_unproved')

class InitialHostRegistration:
 def __init__(self,factory,state=STATE,clock=time.time):self.factory,self.state,self.clock=factory,Path(state),clock
 def template(self,proposal_id,profile):
  p=self.factory.policy;expected=p['dependencies'][str(TEMPLATE)];need(proposal_id==expected[:32],'initial_proposal_not_registered')
  data=self.factory.verified[str(TEMPLATE)];need(len(data)<=1048576 and sha(data)==expected,'initial_template_hash_changed')
  proposal=json.loads(data);need(type(proposal)is dict and set(proposal)=={'component_id','sources','candidate_nodes'}and proposal['component_id']=='observacao_host','initial_template_shape_changed')
  need(set(proposal['sources'])==set(profile['editable_sources'])and len(proposal['sources'])==9 and all(type(v)is str and len(v.encode())<=131072 for v in proposal['sources'].values()),'initial_template_source_scope_changed')
  before=public_before(profile);candidate_delta(before,proposal['candidate_nodes']);need(len(raw(proposal['candidate_nodes']))<=1048576,'initial_template_candidate_bound')
  return data,proposal,normalized(before)
 def existing(self,identity):
  path=self.state/'registrations'/(identity['operation_id']+'.json')
  if not path.exists():return None
  row=_root_json(path);need(row['identity']==identity,'initial_registration_id_conflict');need(row['state']=='registered','existing_registration_requires_reconciliation_no_retry')
  result=row['result'];request=_root_json(self.state/'requests'/(identity['operation_id']+'.json'));data=read(self.state/'proposals'/(identity['proposal_id']+'.json'),0,0o600,limit=1048576)
  need(sha(raw(request))==result['request_sha256']and sha(data)==result['proposal_sha256'],'existing_registration_files_unconfirmed')
  return {**result,'duplicate':True,'metadata_repeated':False,'native_effects':0}
 def register(self,operation_id,task_id,send_id,proposal_id):
  identity={'operation_id':operation_id,'task_id':task_id,'send_id':send_id,'proposal_id':proposal_id}
  for value in identity.values():ident(value)
  need(os.geteuid()==os.getegid()==0,'initial_registration_Root_required')
  coord,flow,jobs,_,_=self.factory.make(read_only=True)
  try:
   ctx=self.factory.context
   with ctx['executor'].locked(),ctx['budget'].locked(),ctx['maintenance']:
    protected_dir(self.state/'registrations');previous=self.existing(identity)
    if previous:return previous
    initial_registration_slot(self.state,identity,flow,self.factory.policy['principal_sha256'])
    need(not os.path.lexists(self.state/'requests'/(operation_id+'.json')),'initial_request_id_preexists')
    need(not os.path.lexists(self.state/'operator-decisions'/(operation_id+'.json')),'initial_review_id_preexists')
    need(not any(r['id']==operation_id for r in jobs.db.execute('SELECT id FROM preparations')),'initial_preparation_id_preexists')
    need(flow.db.execute('SELECT 1 FROM operations WHERE id=?',(operation_id,)).fetchone()is None,'initial_workflow_id_preexists')
    binding={'operation_id':operation_id,'task_id':task_id,'component_id':'observacao_host'}
    ctx['resources']();task=ctx['budget'].observe(binding,send_id)
    _,_,_,sends,_,_=ctx['budget'].inspect();live=next((r for r in sends if r['id']==send_id),None)
    need(live is not None and live['task']==task_id and live['state']in('accepted','inProgress'),'initial_registration_requires_live_send')
    ctx['executor'].existing_snapshot();ctx['reciprocal'].check('NodeRED_reader_binding',operation_id)
    profile=ctx['profile'];need(profile['component_id']=='observacao_host','initial_profile_not_supported')
    data,proposal,before=self.template(proposal_id,profile)
    current=SourceWriter(profile,self.state).current()
    for name,value in current.items():
     need(sha(value)==profile['snapshot_hashes'][name],'initial_public_before_changed');info=(Path('/mnt/data/docker')/name).lstat()
     need({'uid':info.st_uid,'gid':info.st_gid,'mode':stat.S_IMODE(info.st_mode)}==profile['sources_owners'][name],'initial_public_before_metadata_changed')
    Validator(profile,state_root=self.state,clock=self.clock).trusted()
    now=self.clock();expires=min(now+86400,self.factory.policy['expires_at'],profile['owner_authorization_expires_at'],task['expires_at'])
    need(now+190<expires,'initial_registration_completion_margin')
    request={'schema_version':1,**identity,'component_id':'observacao_host','root_decision_id':operation_id,'expected_loaded_sha256':before,'expires_at':expires,'approval_reference_sha256':profile['approval_reference_sha256']}
    request_data=raw(request);need(len(request_data)<=8192,'initial_request_bound')
    used,_,_=PreparationStorage(self.state).usage();need(used+len(data)+len(request_data)+16384<=CAP,'initial_registration_storage_capacity')
    journal={'schema_version':1,'identity':identity,'request_sha256':sha(raw(identity)),'state':'intent','created_at':now,'result':None}
    path=self.state/'registrations'/(operation_id+'.json');write_new(path,raw(journal))
    proposal_path=self.state/'proposals'/(proposal_id+'.json')
    if proposal_path.exists():need(read(proposal_path,0,0o600,limit=1048576)==data,'initial_registered_proposal_conflict')
    else:write_new(proposal_path,data,limit=1048576)
    write_new(self.state/'requests'/(operation_id+'.json'),request_data)
    ctx['executor'].check_locks();ctx['resources']()
    need(read(self.state/'requests'/(operation_id+'.json'),0,0o600)==request_data and read(proposal_path,0,0o600,limit=1048576)==data,'initial_registration_afterimage_unconfirmed')
    result={'state':'registered_initial_template_prepare_pending','operation_id':operation_id,'task_id':task_id,'send_id':send_id,'proposal_id':proposal_id,'expires_at':expires,'request_sha256':sha(request_data),'proposal_sha256':sha(data),'native_effects':0,'authentication_calls':0,'new_task_sends':0,'quotas_reset':False,'Root_review_created':False,'validation_performed':False,'automatic_retry':False,'full_goal_complete':False}
    new={**journal,'state':'registered','result':result};temp=path.with_name('.'+path.name+'.terminal')
    write_new(temp,raw(new));need(read(path,0,0o600)==raw(journal),'initial_registration_journal_changed');os.replace(temp,path)
    fd=os.open(path.parent,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    try:os.fsync(fd)
    finally:os.close(fd)
    return result
  finally:flow.close();jobs.close()
