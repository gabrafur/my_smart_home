"""Fixed native construction. No bindings from chatbot or arbitrary paths.
Parent seals source writer/validator separately; this file builds execution and
readonly observation from the exact already-installed task/account boundaries.
"""
import contextlib,hashlib,json,os,re,sqlite3,stat,subprocess,sys,time,types
from pathlib import Path
from component_jobs import JobLedger,need,ident,protected
from workflow import Workflow,digest
from admission import MaintenanceLease,TaskBudgetPort
from executor_observer import ExistingLock,ExecutorObserver
from revision_review import PublishedNodeRedReviews
from worker_parent import BoundNodeRedParent,admission_context
from reciprocal_gate import ReciprocalGuard
from readonly_parent import BoundReadOnlyParent,ObservationAdmission,PreparationReviews
from root_coordinator import RootCoordinator
from canonical_worker import CanonicalWorker
LIB=Path('/usr/local/lib/raspberry-component-repair');STATE=Path('/var/lib/raspberry-component-repair')
class Maintenance(MaintenanceLease):
 def __init__(self):
  super().__init__('/mnt/data/docker/.daily-maintenance.lock',1001,())
  self.trigger_owners={Path('/mnt/data/docker/homeassistant/.daily-update-trigger'):1001,Path('/mnt/data/docker/homeassistant/.git-backup-trigger'):1001,Path('/mnt/data/docker/.local-state/kia-uvo-merge-trigger'):1000}
 def check(self):
  super().check()
  for path,owner in self.trigger_owners.items():
   for p in (path,*path.parents):need(not p.is_symlink(),'unsafe_trigger_parent')
   s=path.stat(follow_symlinks=False);need(stat.S_ISDIR(s.st_mode)and s.st_uid==owner and not s.st_mode&0o002,'native_trigger_identity_changed')
   need(not any('processing'in p.name for p in path.iterdir()),'native_maintenance_processing')
  return True
class JobAwareExecutor(ExecutorObserver):
 def __init__(self,*args,jobs,**kwargs):super().__init__(*args,**kwargs);self.jobs=jobs
 def existing_snapshot(self):
  value=super().existing_snapshot()
  from source_writer import read
  ledger=Path('/var/lib/raspberry-nodered-binding/ledger.json')
  body=json.loads(read(ledger,0,0o600,limit=131072))
  need(type(body)is dict and set(body)=={'schema_version','operations'}and body['schema_version']==1 and type(body['operations'])is list and len(body['operations'])<=64,'binding_executor_ledger_unconfirmed')
  allowed={'planned','no_change','applied','restore_planned','restored','not_applied_observed'}
  need(all(type(r)is dict and r.get('state')in allowed for r in body['operations']),'binding_executor_busy_or_uncertain')
  self.check_locks();value['data']['reader_binding']={'operations':len(body['operations']),'nonterminal_effects':0,'metadata_only':True}
  return value
 def components(self,binding):
  result=super().components(binding)
  need(all(r['operation']==binding['operation_id']and r['action']==binding['action']for r in self.jobs.pending_jobs()),'other_component_job_launch_or_effect_unknown')
  return result
class WorkflowView:
 def __init__(self,path,expiry):
  protected(path,0,0o600);self.db=sqlite3.connect(Path(path).as_uri()+'?mode=ro',uri=True,timeout=2,isolation_level=None);self.db.row_factory=sqlite3.Row;self.db.execute('PRAGMA query_only=ON');self.expiry=expiry
 def row(self,op):
  ident(op);r=self.db.execute('SELECT *FROM operations WHERE id=?',(op,)).fetchone();need(r is not None,'operation_not_found');return dict(r)
 def status(self,op):
  r=self.row(op);result=json.loads(r['result'])if r['result']else None
  return {'operation_id':op,'component_id':r['component'],'task_id':r['task'],'state':r['state'],'observed_at':time.time(),'updated_at':r['updated'],'administrative_admission_active':time.time()<self.expiry,'reservation_retained':r['state']!='released','result':result,'result_hash':digest(result)if result is not None else None,'automatic_retry':False,'notLoaded_is_completion':False}
 def close(self):self.db.close()
def module(name,path,verified):
 raw=verified[str(path)];m=types.ModuleType(name);m.__file__=str(path);m.__cached__=None;sys.modules[name]=m;exec(compile(raw,str(path),'exec'),m.__dict__);return m
def task_modules(verified):
 module('task_store',Path('/usr/local/lib/raspberry-task-control/task_store.py'),verified)
 tasks=module('bound_native_tasks',Path('/usr/local/lib/raspberry-task-control/task_control.py'),verified)
 old=module('bound_native_legacy',Path('/usr/local/lib/raspberry-mcp/codex_control.py'),verified)
 return tasks,old
class Factory:
 def __init__(self,policy,verified):self.policy,self.verified=policy,verified;self.caller_operations=None
 def authentication(self):
  # Same existing systemd credential, never a new account/copy. Do not expose it
  # through RPC, source review, environment values, argv or receipts.
  folder=os.environ.get('CREDENTIALS_DIRECTORY','')
  need(re.fullmatch(r'/run/credentials/raspberry-component-(?:repair|job)@[^/]{1,100}\.service',folder)is not None,'existing_systemd_credential_binding_required')
  parent=Path(folder);s=parent.lstat();need(stat.S_ISDIR(s.st_mode)and s.st_uid==0 and not s.st_mode&0o077,'unsafe_systemd_credential_directory')
  fd=os.open(parent/'node-red-password',os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
  try:
   s=os.fstat(fd);need(stat.S_ISREG(s.st_mode)and s.st_uid==0 and s.st_nlink==1 and not s.st_mode&0o077 and 0<s.st_size<=4096,'unsafe_systemd_credential');password=os.read(fd,4097).decode().strip()
  finally:os.close(fd)
  raw=self.verified['/usr/local/lib/raspberry-nodered-diagnostics/config.json'];username=json.loads(raw)['node_red_username']
  need(type(username)is str and re.fullmatch(r'[A-Za-z0-9_.@-]{1,64}',username)is not None and 0<len(password)<=4096,'existing_credential_shape_invalid')
  return {'host':'<NODE_RED_PEER>','port':1880,'username':username,'password':password}
 def launcher(self,op,action):
  ident(op);need(action in ('prepare','validate','seal','verify','apply','rollback'),'fixed_job_action_required')
  unit='raspberry-component-validate@'+op+'.service'if action=='validate'else'raspberry-component-job@'+op+'-'+action+'.service'
  result=subprocess.run(['/usr/bin/systemctl','start','--no-block',unit],stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=5,env={'PATH':'/usr/bin:/bin','LC_ALL':'C'})
  need(len(result.stdout)+len(result.stderr)<=4096,'fixed_job_launch_output_limit');return result.returncode==0
 def make(self,read_only=False,caller_operations=None):
  p=self.policy;tasks,old=task_modules(self.verified);jobs=JobLedger(STATE/'jobs.sqlite3',read_only=read_only)
  from owner_lease import assert_active
  native_resources=tasks.resources;owner_lease=json.loads(self.verified[str(STATE/'profiles/observacao_host.json')])['owner_lease']
  def resources():assert_active(owner_lease);return native_resources()
  flow=WorkflowView(STATE/'workflow.sqlite3',p['expires_at'])if read_only else Workflow(STATE/'workflow.sqlite3',time.time,p['expires_at'])
  maintenance=Maintenance();operations=caller_operations or self.caller_operations or ExistingLock('/var/lib/raspberry-mcp-operations/lock',1001,0o600);admin=ExistingLock('/var/lib/raspberry-admin-executor/executor.lock',0,0o600)
  executor=JobAwareExecutor(operations,admin,maintenance,'/var/lib/raspberry-admin-executor/receipt.json','/var/lib/raspberry-mcp-deploy/journal.sqlite3','/usr/local/lib/raspberry-mcp-deploy/release/activation.json','/var/lib/raspberry-mcp-jobs/jobs.sqlite3',983,STATE/'workflow.sqlite3',jobs=jobs)
  budget=TaskBudgetPort(tasks,old,'/var/lib/raspberry-mcp-operations/task-control/jobs.sqlite3','/var/lib/raspberry-mcp-operations/codex-control/jobs.sqlite3',1001)
  reviews=PublishedNodeRedReviews(STATE/'reviews',STATE/'prepared',STATE/'publication-journal',jobs.approved_reviews())
  reciprocal=ReciprocalGuard(STATE/'workflow.sqlite3',operations)
  gate=admission_context(executor,budget,maintenance,reviews,p['principal_sha256'],resources)
  worker=BoundNodeRedParent(LIB/'effects/nodered_job.cjs',{k:p['source_hashes']['effects/'+k]if k!='attestation_model.cjs'else p['source_hashes'][k]for k in ('nodered_job.cjs','nodered_effect.cjs','attestation_model.cjs')},STATE/'prepared',STATE/'workers',gate,self.authentication)
  # SourceWriter is the same pinned protected preparer component, never a client callback.
  from source_writer import SourceWriter
  profile_path=STATE/'profiles/observacao_host.json'
  raw_profile=self.verified[str(profile_path)]
  source_writer=SourceWriter(json.loads(raw_profile),state_root=STATE,repository=Path('/mnt/data/docker'))
  worker=CanonicalWorker(worker,source_writer)
  observation_gate=ObservationAdmission(executor,budget,maintenance,reviews,reciprocal,p['principal_sha256'],resources)
  readonly=BoundReadOnlyParent(LIB/'effects/nodered_observe.cjs',{k:p['source_hashes']['effects/'+k]if k!='attestation_model.cjs'else p['source_hashes'][k]for k in ('nodered_observe.cjs','nodered_effect.cjs','attestation_model.cjs')},observation_gate,self.authentication,jobs)
  def observe(row):
   action='rollback'if row['state']in ('applied_awaiting_functional_proof','verified')else'apply'
   before,after=(row['candidate'],row['base'])if action=='rollback'else(row['base'],row['candidate'])
   binding={'operation_id':row['id'],'task_id':row['task'],'principal_sha256':p['principal_sha256'],'component_id':row['component'],'before_sha256':before,'after_sha256':after,'action':action}
   proof=readonly.collect(binding,[row['base'],row['candidate']]);return {'loaded_sha256':proof['loaded_sha256'],'collection_error':proof['collection_error'],'backup_verified':action=='rollback'and worker.previous({**binding,'before_sha256':row['base'],'after_sha256':row['candidate'],'action':'apply'})is not None}
  from functional import HostResetFunctional
  functional=HostResetFunctional(json.loads(raw_profile),source_writer,readonly,observation_gate,STATE)
  from preparer import ComponentPreparer
  profile=json.loads(raw_profile);writer_policy={**p,'approval_reference_sha256':profile['approval_reference_sha256']}
  validator=ComponentPreparer(profile,None,None,writer_policy)
  def validate(op):
   prep=PreparationReviews(STATE/'sealed')
   row=jobs.preparation(op)
   binding={'operation_id':op,'task_id':row['task'],'principal_sha256':row['principal'],'component_id':row['component'],'action':'observe'}
   # Validation has no credentials/native API. It still holds the real host
   # maintenance lease for its entire sandbox run, serializing heavy work.
   with executor.locked(),budget.locked(),maintenance:
    record=prep.read(binding,p['principal_sha256']);task=budget.observe(binding,record['send_id'])
    need(time.time()+190<min(p['expires_at'],record['expires_at'],task['expires_at']),'validation_lease_completion_margin')
    executor.existing_snapshot();reciprocal.check('NodeRED_reader_binding',op);resources()
    result=validator.validate(op);executor.check_locks()
   need(result.get('state')in ('validation_passed_awaiting_root_review','validation_failed','validation_uncertain'),'protected_validation_state_unknown')
   return {**result,'household_effects':0,'executor_terminal':result['state']!='validation_uncertain'}
  coord=RootCoordinator(flow,jobs,reviews,worker,observe,functional,self.launcher,p['principal_sha256'],p['expires_at'],resources,validator=validate)
  baseline_gate=ObservationAdmission(executor,budget,maintenance,PreparationReviews(STATE/'sealed'),reciprocal,p['principal_sha256'],resources)
  baseline=BoundReadOnlyParent(LIB/'effects/nodered_observe.cjs',{k:p['source_hashes']['effects/'+k]if k!='attestation_model.cjs'else p['source_hashes'][k]for k in ('nodered_observe.cjs','nodered_effect.cjs','attestation_model.cjs')},baseline_gate,self.authentication,jobs)
  self.context={'executor':executor,'budget':budget,'maintenance':maintenance,'reciprocal':reciprocal,'resources':resources,'profile':profile,'writer_policy':writer_policy}
  return coord,flow,jobs,readonly,baseline
 def prepare_operation(self,binding,send_id,expires_at,expected_loaded_sha256,proposal_id):
  from preparer import ComponentPreparer,normalized
  from source_writer import read
  ident(proposal_id);ident(send_id);ident(expected_loaded_sha256,64)
  need(type(binding)is dict and set(binding)=={'operation_id','task_id','principal_sha256','component_id','action'}and binding['component_id']=='observacao_host'and binding['action']=='observe'and binding['principal_sha256']==self.policy['principal_sha256'],'closed_preparation_request')
  ident(binding['operation_id']);ident(binding['task_id'])
  coord,flow,jobs,_,baseline=self.make()
  try:
   ctx=self.context
   with ctx['executor'].locked(),ctx['budget'].locked(),ctx['maintenance']:
    task=ctx['budget'].observe(binding,send_id);ctx['executor'].existing_snapshot();ctx['reciprocal'].check('NodeRED_reader_binding',binding['operation_id'])
    need(time.time()+190<min(task['expires_at'],expires_at,self.policy['expires_at']),'preparation_completion_margin');ctx['resources']()
   # Reserve the exact component before baseline collection and snapshot copy.
   # Candidate nodes remain data and are validated structurally and in the jail.
   proposal=json.loads(read(STATE/'proposals'/(proposal_id+'.json'),0,0o600))
   candidate=normalized(proposal['candidate_nodes'])
   flow.prepare(binding['operation_id'],binding['component_id'],binding['task_id'],expected_loaded_sha256,candidate,{binding['task_id']})
   ctx=self.context;prep=ComponentPreparer(ctx['profile'],baseline,jobs,ctx['writer_policy'])
   result=prep.prepare(binding,send_id,expires_at,expected_loaded_sha256,proposal_id)
   registered={k:binding[k]for k in ('operation_id','task_id','principal_sha256','component_id')}
   registered.update(before_sha256=result['before_sha256'],after_sha256=result['after_sha256'])
   jobs.register_preparation(registered,result['preparation_sha256'],result['expires_at']);return result
  finally:flow.close();jobs.close()
 def seal_and_publish(self,op,root_decision_id):
  ident(op);ident(root_decision_id)
  from preparer import ComponentPreparer
  from publisher_parent import RootPublisher
  coord,flow,jobs,_,baseline=self.make()
  try:
   ctx=self.context;prep=ComponentPreparer(ctx['profile'],baseline,jobs,ctx['writer_policy'])
   sealed=prep.seal(op,root_decision_id)
   publisher=RootPublisher(LIB/'publication_bridge.cjs',self.policy['source_hashes']['publication_bridge.cjs'],ctx['executor'],ctx['budget'],ctx['maintenance'],ctx['reciprocal'],jobs,self.policy['principal_sha256'],ctx['resources'])
   publication=publisher.publish(op);row=flow.row(op)
   binding={'operation_id':op,'task_id':row['task'],'principal_sha256':self.policy['principal_sha256'],'component_id':row['component'],'before_sha256':row['base'],'after_sha256':row['candidate'],'action':'apply'}
   reader=PublishedNodeRedReviews(STATE/'reviews',STATE/'prepared',STATE/'publication-journal',jobs.approved_reviews())
   review=reader.read(binding,self.policy['principal_sha256'])
   result=flow.validate(op,lambda r:{'base_sha256':r['base'],'candidate_sha256':r['candidate'],'isolated_tests_passed':review['isolated_tests_passed'],'no_household_effects':True,'reviewed_scope':review['reviewed_scope']})
   return {'operation_id':op,'state':result['state'],'publication':publication,'automatic_retry':False,'functional_health':'unknown'}
  finally:flow.close();jobs.close()
