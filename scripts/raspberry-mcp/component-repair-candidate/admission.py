"""Internal candidate ports: existing task-budget reads and real maintenance flock.
No CLI, MCP route, task send, policy write, credential or shell entrypoint.
Only a future sealed root bootstrap may construct these ports. Paths/owners are
operator bindings, never request parameters. External admin observation remains
mandatory; a task-registry snapshot alone cannot establish global idleness.
"""
import contextlib,fcntl,json,math,os,re,sqlite3,stat,time
from pathlib import Path

BUSY=frozenset(('create_intent','create_unknown','send_intent','send_unknown','accepted','inProgress','outcome_unknown'))
TERMINAL=frozenset(('completed','failed','interrupted','not_dispatched'))
IDENTITY_KINDS={'localizacao_pessoas':'nodered_scoped_configuration_v1','observacao_host':'nodered_scoped_configuration_v1','external_heartbeat':'python_code_objects_v1','icloud_adapter':'python_code_objects_v1'}
def need(value,reason):
 if not value:raise ValueError(reason)
def ident(value,length=32):need(isinstance(value,str)and re.fullmatch('[a-f0-9]{'+str(length)+'}',value),'invalid_bound_identity')
def finite(value):return type(value)in(int,float)and math.isfinite(value)
def safe_file(path,owner,mode,limit):
 path=Path(path)
 for parent in path.parents:need(not parent.is_symlink(),'symlink_bound_parent')
 fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
 try:
  s=os.fstat(fd);need(stat.S_ISREG(s.st_mode)and s.st_uid==owner and stat.S_IMODE(s.st_mode)==mode and s.st_nlink==1 and s.st_size<=limit,'unsafe_bound_file')
  return fd,s
 except BaseException:os.close(fd);raise
@contextlib.contextmanager
def readonly_db(path,owner,mode=0o600):
 fd,info=safe_file(path,owner,mode,1048576);db=None
 try:
  db=sqlite3.connect(Path(path).resolve().as_uri()+'?mode=ro',uri=True,timeout=2,isolation_level=None)
  db.row_factory=sqlite3.Row;db.execute('PRAGMA query_only=ON');db.execute('BEGIN')
  current=Path(path).stat(follow_symlinks=False);need((info.st_dev,info.st_ino)==(current.st_dev,current.st_ino),'registry_identity_changed')
  yield db
  current=Path(path).stat(follow_symlinks=False);need((info.st_dev,info.st_ino)==(current.st_dev,current.st_ino),'registry_identity_changed')
 finally:
  if db is not None:db.close()
  os.close(fd)

class MaintenanceLease:
 """Pre-existing scheduler lock. Never creates/replaces a lock or trigger file."""
 def __init__(self,path,owner,trigger_directories):self.path=Path(path);self.owner=owner;self.triggers=tuple(map(Path,trigger_directories));self.fd=None;self.identity=None
 def check(self):
  need(self.fd is not None,'maintenance_lock_not_held');current=self.path.stat(follow_symlinks=False)
  need((current.st_dev,current.st_ino)==self.identity,'maintenance_lock_identity_changed')
  for folder in self.triggers:
   for parent in (folder,*folder.parents):need(not parent.is_symlink(),'unsafe_trigger_directory')
   info=folder.stat(follow_symlinks=False);need(stat.S_ISDIR(info.st_mode)and info.st_uid==self.owner and not info.st_mode&0o002,'unsafe_trigger_directory')
   need(not any('processing'in item.name for item in folder.iterdir()),'native_maintenance_processing')
  return True
 def __enter__(self):
  need(self.fd is None,'maintenance_lease_already_held');fd,info=safe_file(self.path,self.owner,0o664,0)
  try:
   try:fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
   except BlockingIOError:raise ValueError('maintenance_lock_busy')from None
   self.fd=fd;self.identity=(info.st_dev,info.st_ino);self.check();return self
  except BaseException:
   self.fd=None;self.identity=None;os.close(fd);raise
 def __exit__(self,*args):
  if self.fd is not None:os.close(self.fd)
  self.fd=None;self.identity=None

class TaskBudgetPort:
 def __init__(self,tasks,legacy,task_path,legacy_path,owner,clock=time.time):
  self.tasks,self.legacy=tasks,legacy;self.task_path=Path(task_path);self.legacy_path=Path(legacy_path);self.owner=owner;self.clock=clock;self.held=False
 @contextlib.contextmanager
 def locked(self):
  need(not self.held,'task_guard_already_held')
  with self.tasks.locked(read_only=True):
   self.held=True
   try:yield self
   finally:self.held=False
 def inspect(self):
  need(self.held,'task_guard_not_held');policy,legacy=self.tasks.policy(self.legacy)
  need(policy.get('enabled')is True and policy.get('max_sends_per_24h')==48 and policy.get('minimum_spacing_seconds')==60,'shared_task_policy_unconfirmed')
  need(not os.path.lexists(self.task_path.parent/'revoked'),'task_admission_revoked')
  now=self.clock();need(finite(now),'clock_unconfirmed')
  with readonly_db(self.task_path,self.owner)as db:
   tasks=[dict(r)for r in db.execute('SELECT id,task_key,thread,state,created,reconciled FROM tasks')]
   sends=[dict(r)for r in db.execute('SELECT id,task,state,turn,created,reconciled FROM sends')]
  with readonly_db(self.legacy_path,self.owner)as db:
   jobs=[dict(r)for r in db.execute('SELECT id,state,created,attempts FROM jobs')]
  for row in (*tasks,*sends,*jobs):need(finite(row['created'])and 0<=row['created']<=now+1,'registry_timestamp_unconfirmed')
  need(all(type(r['attempts'])is int and r['attempts']>=0 for r in jobs),'legacy_attempt_accounting_unconfirmed')
  count=sum(r['created']>now-86400 for r in sends)+sum(r['attempts']>0 and r['created']>now-86400 for r in jobs)
  return policy,legacy,tasks,sends,jobs,count
 def observe(self,binding,send_id):
  ident(binding['task_id']);ident(send_id);policy,legacy,tasks,sends,jobs,count=self.inspect();now=self.clock()
  admin=policy.get('admin_delegation');need(isinstance(admin,dict)and admin.get('enabled')is True and admin.get('executor_uid')==self.owner and admin.get('task_key_prefix')=='eva-admin-'and admin.get('expires_at')==policy['expires_at'],'admin_delegation_unconfirmed')
  task=next((r for r in tasks if r['id']==binding['task_id']),None);send=next((r for r in sends if r['id']==send_id),None)
  need(task is not None and task['state']=='created'and task['task_key'].startswith('eva-admin-')and task['reconciled']==1 and isinstance(task['thread'],str)and re.fullmatch('[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}',task['thread']),'task_identity_not_admitted')
  need(send is not None and send['task']==task['id']and send['state']in('accepted','inProgress','completed')and isinstance(send['turn'],str)and re.fullmatch('[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}',send['turn'])and now-86400<send['created']<=now,'recorded_task_send_unconfirmed')
  if send['state']=='completed':need(send['reconciled']==1,'parent_result_requires_reconciliation')
  need(count<=48,'shared_task_budget_exceeded')
  need(all(r['id']==task['id']or(r['state']not in BUSY and r['reconciled']==1)for r in tasks),'other_task_reserved_or_uncertain')
  need(all(r['id']==send_id or(r['state']in TERMINAL and r['reconciled']==1)for r in sends),'other_send_reserved_or_uncertain')
  need(all(r['state']in TERMINAL for r in jobs),'legacy_operation_busy_or_uncertain')
  return {'registered_task':True,'shared_budget_reserved':True,'existing_send_id':send_id,'shared_sends_last_24h':count,'maximum_shared_sends':48,'new_sends_reserved':0,'task_registry_idle_except_parent':True,'expires_at':min(policy['expires_at'],legacy['expires_at'])}

class ProtectedReview:
 def __init__(self,folder,owner=0):self.folder=Path(folder);self.owner=owner
 def read(self,binding,principal):
  ident(principal,64);ident(binding['operation_id']);need(binding.get('action')in('apply','rollback'),'review_action_refused')
  for parent in (self.folder,*self.folder.parents):need(not parent.is_symlink(),'unsafe_review_parent')
  s=self.folder.stat();need(stat.S_ISDIR(s.st_mode)and s.st_uid==self.owner and stat.S_IMODE(s.st_mode)==0o700,'unsafe_review_directory')
  need(not os.path.lexists(self.folder/'revoked'),'component_access_revoked')
  fd,_=safe_file(self.folder/(binding['operation_id']+'-'+binding['action']+'.json'),self.owner,0o600,16384)
  try:row=json.loads(os.read(fd,16385))
  finally:os.close(fd)
  need(set(row)=={'binding','send_id','identity_kind','isolated_tests_passed','reviewed_scope','expires_at'},'review_record_shape')
  need(row['binding']==binding and binding.get('principal_sha256')==principal and binding.get('component_id')in IDENTITY_KINDS and row['identity_kind']==IDENTITY_KINDS[binding['component_id']]and row['isolated_tests_passed']is True and row['reviewed_scope']is True,'protected_review_binding_mismatch')
  ident(row['send_id']);need(finite(row['expires_at']),'review_expiry_unconfirmed');return row

class ProtectedAdmission:
 """Only instantiated by the root parent job; never trusts MCP boolean flags.
 external_admin_observer must independently cover admin/durable/component jobs
 with fresh protected observations. This port does not manufacture that proof.
 """
 def __init__(self,tasks,maintenance,reviews,principal,external_admin_observer,resources,clock=time.time):
  self.tasks,self.maintenance,self.reviews=tasks,maintenance,reviews;self.principal=principal;self.external=external_admin_observer;self.resources=resources;self.clock=clock
 def check(self,binding):
  need(self.tasks.held and self.maintenance.check()is True,'execution_locks_unconfirmed')
  review=self.reviews.read(binding,self.principal);task=self.tasks.observe(binding,review['send_id']);now=self.clock();expiry=min(task['expires_at'],review['expires_at'])
  need(finite(expiry)and now+90<expiry,'administrative_lease_completion_margin')
  external=self.external(binding)
  need(isinstance(external,dict)and external.get('global_admin_idle')is True and external.get('root_verified')is True and external.get('coverage')==['legacy_admin_executor','durable_jobs','component_jobs']and external.get('collection_error')is None and finite(external.get('observed_at'))and 0<=now-external['observed_at']<=5,'external_admin_state_unconfirmed')
  # Existing resource gate raises on pressure; it must not be a caller boolean.
  need(self.resources()is None,'resource_gate_contract_changed')
  return {**binding,'identity_kind':review['identity_kind'],'registered_task':True,'reviewed_candidate':True,'principal_matches':True,'shared_budget_reserved':True,'global_admin_idle':True,'resources_available':True,'maintenance_lock_held':True,'observed_at':math.floor(self.clock()*1000)/1000,'expires_at':expiry,'existing_send_id':review['send_id'],'shared_sends_last_24h':task['shared_sends_last_24h'],'new_sends_reserved':0}
