"""Internal read-only ports for registered executors; no CLI or MCP registration.
Future sealed root bootstrap supplies fixed bindings, not caller paths. Locks
exclude registered adapter submissions and maintenance effects, not arbitrary
root activity or all processes on the host. No historical row is rewritten.
"""
import contextlib,hashlib,json,os,time
from pathlib import Path
from admission import safe_file,readonly_db,need

def digest(value):return hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':')).encode()).hexdigest()
def read_json(path,owner,mode=0o600,limit=65536):
 fd,_=safe_file(path,owner,mode,limit)
 try:return json.loads(os.read(fd,limit+1))
 finally:os.close(fd)
class ExistingLock:
 def __init__(self,path,owner,mode):self.path=Path(path);self.owner=owner;self.mode=mode;self.fd=None;self.identity=None
 def check(self):
  need(self.fd is not None,'executor_lock_not_held');s=self.path.stat(follow_symlinks=False);need((s.st_dev,s.st_ino)==self.identity,'executor_lock_identity_changed');return True
 def __enter__(self):
  import fcntl
  need(self.fd is None,'executor_lock_already_held');fd,s=safe_file(self.path,self.owner,self.mode,0)
  try:
   try:fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
   except BlockingIOError:raise ValueError('registered_executor_busy')from None
   self.fd=fd;self.identity=(s.st_dev,s.st_ino);self.check();return self
  except BaseException:self.fd=None;self.identity=None;os.close(fd);raise
 def __exit__(self,*args):
  if self.fd is not None:os.close(self.fd)
  self.fd=None;self.identity=None

class ExecutorObserver:
 def __init__(self,operations_lock,admin_lock,maintenance,admin_receipt,deployment_journal,deployment_contract,durable_jobs,durable_owner,component_journal,owner=0,clock=time.time):
  self.operations,self.admin,self.maintenance=operations_lock,admin_lock,maintenance
  self.admin_receipt,self.deployment_journal,self.deployment_contract=map(Path,(admin_receipt,deployment_journal,deployment_contract))
  self.durable_jobs,self.component_journal=map(Path,(durable_jobs,component_journal));self.owner=owner;self.durable_owner=durable_owner;self.clock=clock
 @contextlib.contextmanager
 def locked(self):
  with self.operations,self.admin:yield self
 def check_locks(self):need(self.operations.check()and self.admin.check()and self.maintenance.check(),'executor_exclusion_unconfirmed')
 def legacy_admin(self):
  row=read_json(self.admin_receipt,self.owner)
  need(isinstance(row,dict)and row.get('action')=='migrate_two_notice_aliases'and row.get('attempts')==1 and row.get('reconciliation_required')is not True and row.get('state')in('preparation_failed_original_resumed','rolled_back_original_resumed','applied_collector_active_mcp_validation_pending'),'legacy_admin_effect_busy_or_uncertain')
  return {'state':row['state'],'execution_terminal':True,'functional_acceptance':False}
 def deployment(self):
  contract=read_json(self.deployment_contract,self.owner,0o644);need(contract.get('host')=='raspberry'and contract.get('environment')=='approved_activation','deployment_contract_unconfirmed');revision=digest(contract)
  with readonly_db(self.deployment_journal,self.owner)as db:
   rows=[dict(r)for r in db.execute('SELECT * FROM operations')];resolved=0;spec=contract.get('correction');indexed={r['id']:r for r in rows}
   for prior in rows:
    if prior['phase']in('verified','contained','rejected'):continue
    need(isinstance(spec,dict)and prior['id']==spec.get('predecessor_operation_id'),'deployment_effect_busy_or_uncertain')
    row=db.execute('SELECT * FROM corrections WHERE predecessor=?',(prior['id'],)).fetchone();link=dict(row)if row else None;successor=indexed.get(spec.get('operation_id'))
    need(link is not None and successor is not None and link['successor']==spec['operation_id']and link['revision']==revision and link['prior_revision']==spec.get('prior_revision')and prior['revision']==spec.get('prior_revision')and digest(prior)==link['prior_row_sha256'],'historical_deployment_link_unconfirmed')
    audit=[tuple(r)for r in db.execute('SELECT seq,id,phase,reason,at,revision FROM audit WHERE id=? ORDER BY seq',(prior['id'],))]
    need(digest(audit)==link['prior_audit_sha256']and successor['revision']==revision and successor['phase']in('verified','contained'),'historical_deployment_correction_unconfirmed');resolved+=1
  return {'operations':len(rows),'historical_rows_resolved_by_verified_link':resolved,'journal_written':False,'runtime_health':'unknown'}
 def durable(self):
  terminal={'succeeded','failed','conflict','timed_out','interrupted'};allowed={'validate_mcp_python_sources','repair_mcp_docs_snapshot','validate_icloud_deployment','deploy_icloud_manual_auth','contain_icloud_manual_auth','recover_git_backup_once'}
  with readonly_db(self.durable_jobs,self.durable_owner,0o660)as db:
   rows=[dict(r)for r in db.execute('SELECT request,status FROM jobs')]
  for row in rows:
   request=json.loads(row['request']);need(isinstance(request,dict)and request.get('operation')in allowed and row['status']in terminal,'durable_effect_busy_or_uncertain')
   if request['operation']in('deploy_icloud_manual_auth','contain_icloud_manual_auth','recover_git_backup_once'):
    need(row['status']in('succeeded','failed','conflict'),'durable_effect_terminal_outcome_unconfirmed')
  return {'jobs':len(rows),'nonterminal_jobs':0,'journal_written':False}
 def existing_snapshot(self):
  self.check_locks();result={'legacy_admin_executor':self.legacy_admin(),'deployment':self.deployment(),'durable_jobs':self.durable()};self.check_locks()
  return {'observed_at':self.clock(),'existing_executors_idle':True,'collection_error':None,'root_verified':self.owner==0 and os.geteuid()==0,'data':result,'coverage':['legacy_admin_executor','deployment_journal_and_immutable_corrections','durable_jobs'],'not_all_root_activity_or_host_health':True,'component_job_exclusion_proven':False}
 def components(self,binding):
  with readonly_db(self.component_journal,self.owner)as db:
   rows=[dict(r)for r in db.execute('SELECT id,component,task,state,base,candidate,result FROM operations')]
  own=next((r for r in rows if r['id']==binding['operation_id']),None);action=binding['action'];need(action in('apply','rollback'),'component_action_unconfirmed')
  need(own is not None and own['component']==binding['component_id']and own['task']==binding['task_id']and own['state']==('apply_intent'if action=='apply'else'rollback_intent'),'own_component_job_unconfirmed')
  before,after=(own['base'],own['candidate'])if action=='apply'else(own['candidate'],own['base'])
  need(before==binding['before_sha256']and after==binding['after_sha256'],'component_version_binding_changed')
  allowed={'prepared','validated','applied_awaiting_functional_proof','verified','failed_without_effect','confirmed_not_applied','rolled_back','rollback_rejected_without_effect','released'}
  for row in rows:
   if row['id']==own['id']:continue
   need(row['state']in allowed and(row['component']!=own['component']or row['state']=='released'),'other_component_effect_busy_or_uncertain')
   result=json.loads(row['result'])if row['result']else{}
   need(result.get('security_cleanup_confirmed')is not False and not result.get('pending_cleanup_actions'),'other_component_security_cleanup_unconfirmed')
   if row['state']not in('prepared','validated'):need(result.get('security_cleanup_confirmed')is True,'other_component_terminal_proof_missing')
  return {'registered_component_jobs':len(rows),'other_effects_in_flight_or_unknown':0}
 def __call__(self,binding):
  existing=self.existing_snapshot();component=self.components(binding);self.check_locks()
  return {'global_admin_idle':True,'root_verified':existing['root_verified'],'collection_error':None,'observed_at':self.clock(),'coverage':['legacy_admin_executor','durable_jobs','component_jobs'],'evidence':{'existing':existing['data'],'components':component},'not_all_root_activity_or_host_health':True}
