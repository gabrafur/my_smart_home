"""Fixed reviewed readonly iCloud MCP extension. No free arguments or auto retry."""
import ast,contextlib,fcntl,hashlib,importlib.util,json,os,sqlite3,stat,subprocess,sys,time
from pathlib import Path
STAGE=Path('/__OPERATOR_STAGE__/icloud-readiness')
STATE=Path('/__OPERATOR_STATE__/icloud-readiness')
RUN_DIR=Path('/run/raspberry-icloud-read')
EXPIRY=0
MANIFEST_SHA='0000000000000000000000000000000000000000000000000000000000000000'
def need(v,r):
 if not v:raise ValueError(r)
def sha(b):return hashlib.sha256(b).hexdigest()
def raw(v):return (json.dumps(v,indent=2,sort_keys=True)+'\n').encode()
def read(p,mode=0o644,owner=0,limit=1048576):
 p=Path(p)
 for q in p.parents:
  s=q.lstat();need(stat.S_ISDIR(s.st_mode)and s.st_uid==0 and not s.st_mode&0o022,'unsafe_parent')
 fd=os.open(p,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
 try:
  s=os.fstat(fd);need(stat.S_ISREG(s.st_mode)and s.st_uid==owner and stat.S_IMODE(s.st_mode)==mode and s.st_nlink==1 and s.st_size<=limit,'unsafe_file');b=os.read(fd,limit+1);need(len(b)<=limit,'file_limit');return b
 finally:os.close(fd)
def sync(p):
 fd=os.open(p,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
 try:os.fsync(fd)
 finally:os.close(fd)
def atomic(p,b,mode=0o644):
 p=Path(p);t=p.with_name('.'+p.name+'.readiness-new');fd=os.open(t,os.O_CREAT|os.O_EXCL|os.O_WRONLY|os.O_NOFOLLOW,mode)
 try:
  os.fchmod(fd,mode)
  with os.fdopen(os.dup(fd),'wb')as f:f.write(b);f.flush();os.fsync(f.fileno())
 finally:os.close(fd)
 os.replace(t,p);sync(p.parent)
def chains():
 sys.path[:0]=['/usr/local/lib/raspberry-task-control','/usr/local/lib/raspberry-repair-control','/usr/local/lib/raspberry-mcp']
 import task_control,repair_control,codex_control
 task_control.policy(codex_control);repair_control.configuration(task_control);return task_control
@contextlib.contextmanager
def locks(tasks):
 fds=[]
 try:
  for p,mode,owner in [('/mnt/data/docker/.daily-maintenance.lock',0o664,1001),('/var/lib/raspberry-mcp-operations/lock',0o600,1001),('/var/lib/raspberry-admin-executor/executor.lock',0o600,0)]:
   fd=os.open(p,os.O_RDONLY|os.O_NOFOLLOW);fds.append(fd);s=os.fstat(fd);need(stat.S_ISREG(s.st_mode)and s.st_uid==owner and stat.S_IMODE(s.st_mode)==mode and s.st_nlink==1,'unsafe_lock')
   try:fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
   except BlockingIOError:raise ValueError({'/mnt/data/docker/.daily-maintenance.lock':'native_maintenance_lock_busy','/var/lib/raspberry-mcp-operations/lock':'registered_operations_lock_busy','/var/lib/raspberry-admin-executor/executor.lock':'administrative_executor_lock_busy'}[p])from None
  with tasks.locked(read_only=True):
   for p in ['/mnt/data/docker/homeassistant/.daily-update-trigger','/mnt/data/docker/homeassistant/.git-backup-trigger']:
    need(not list(Path(p).glob('*processing*')),'native_worker_processing')
   need(tasks.legacy_summary()['busy']==0,'legacy_operation_unresolved')
   db=sqlite3.connect('file:/var/lib/raspberry-mcp-operations/task-control/jobs.sqlite3?mode=ro',uri=True)
   try:
    db.execute('PRAGMA query_only=ON');need(all(db.execute('SELECT count(*) FROM '+t+' WHERE reconciled=0').fetchone()[0]==0 for t in ['tasks','sends']),'task_operation_unresolved')
   finally:db.close()
   yield
 finally:
  for fd in reversed(fds):os.close(fd)

def load():
 raw_manifest=read(STAGE/'MANIFEST.json');need(sha(raw_manifest)==MANIFEST_SHA,'manifest_changed');m=json.loads(raw_manifest)
 need(set(m)=={'revision','expiry','new_MCP_tools','access_expansion','limits_changed','targets','unchanged','package_model_sha256'}and m['revision']=='r2'and m['expiry']==EXPIRY and type(m['new_MCP_tools'])is int and m['new_MCP_tools']==0 and m['access_expansion']=='readonly_icloud_process_and_fixed_service_registration'and m['limits_changed']is False,'manifest_scope_changed')
 need(sha(read(STAGE/'package_model.py'))==m['package_model_sha256'],'package_model_changed');spec=importlib.util.spec_from_file_location('sealed_readiness_package_model',STAGE/'package_model.py');model=importlib.util.module_from_spec(spec);spec.loader.exec_module(model)
 need(set(m['targets'])==set(model.TARGETS)and set(m['unchanged'])==set(model.UNCHANGED),'manifest_target_scope_changed');after={}
 for name,path in model.TARGETS.items():
  row=m['targets'][name];need(set(row)=={'path','before','after'}and row['path']==path,'target_path_changed');after[name]=read(STAGE/name);need(sha(after[name])==row['after'],'candidate_changed')
  if name.endswith('.py'):ast.parse(after[name].decode())
  elif name.endswith('.json'):json.loads(after[name])
  elif name.endswith('.cjs'):subprocess.run(['/usr/bin/node','--check',str(STAGE/name)],check=True,capture_output=True,timeout=5)
 need(after['icloud-readiness.conf']==model.UNIT_CONF.encode(),'unit_scope_changed');return m,after,model

def baseline(m,which='before'):
 result={}
 for name,row in m['targets'].items():
  path=Path(row['path']);expected=row[which]
  if expected is None:need(not os.path.lexists(path),'unexpected_existing_target');result[name]=None
  else:result[name]=read(path);need(sha(result[name])==expected,'baseline_changed')
 return result

def unchanged(m):
 data={p:read(Path(p))for p in m['unchanged']};need(all(sha(data[p])==v for p,v in m['unchanged'].items()),'unchanged_profile_or_policy_changed');return data

def historical_receipts():
 paths=['/var/lib/raspberry-admin-executor/receipt.json','/var/lib/raspberry-admin-executor/__OPERATOR_LEGACY_RECOVERY_STATE__/receipt.json']
 return {p:sha(read(Path(p),0o600))for p in paths}

def directory(path,mode):
 if path.exists():
  s=path.lstat();need(not path.is_symlink()and stat.S_ISDIR(s.st_mode)and s.st_uid==0 and stat.S_IMODE(s.st_mode)==mode,'unsafe_fixed_directory')
 else:path.mkdir(mode=mode);sync(path.parent)

def active():
 result=subprocess.run(['/usr/bin/systemctl','is-active','raspberry-ha-notices.service'],capture_output=True,timeout=3);return result.returncode==0 and result.stdout.strip()==b'active'

def activate_service(action):
 need(time.time()+30<EXPIRY,'authority_completion_margin')
 restart_intent=STATE/(action+'-restart-intent.json');need(not restart_intent.exists(),'restart_intent_requires_reconciliation')
 atomic(restart_intent,raw({'at':time.time(),'unit':'raspberry-ha-notices.service','attempts':1,'automatic_retry':False}),0o600)
 subprocess.run(['/usr/bin/systemctl','daemon-reload'],capture_output=True,timeout=8,check=True)
 subprocess.run(['/usr/bin/systemctl','restart','raspberry-ha-notices.service'],capture_output=True,timeout=8,check=True)
 need(active(),'native_observer_restart_unconfirmed')

def root_backend():
 spec=importlib.util.spec_from_file_location('current_fixed_admin_recovery','/usr/local/lib/raspberry-admin-recovery/recovery.py');r=importlib.util.module_from_spec(spec);spec.loader.exec_module(r);module=r.load_executor();module.Backend()

def receipt(m,state,history):return {'state':state,'observed_at':time.time(),'manifest_sha256':MANIFEST_SHA,'original_receipt_hashes':history,'automatic_retry':False,'new_MCP_tools':0,'scope':'readonly_current_icloud_and_fixed_service_registration','authority_expiry':EXPIRY,'household_service_calls':0,'location_refresh_calls':0,'new_credentials':0,'new_subscriptions':0,'Root_socket_existing_limits_preserved':True,'procmon_observer_restarted':False,'actual_MCP_acceptance':False}

def main():
 need(os.geteuid()==0 and Path(__file__)==STAGE/'apply.py'and sys.argv[1:]in (['preflight'],['apply-approved'],['status'],['rollback']),'fixed_authenticated_entrypoint_required');action=sys.argv[1];m,after,model=load()
 if action=='status':
  path=STATE/'receipt.json'if(STATE/'receipt.json').exists()else STATE/'intent.json';print(read(path,0o600).decode());return
 need(time.time()+90<EXPIRY,'administrative_authority_expired');tasks=chains()
 with locks(tasks):
  frozen=unchanged(m);history=historical_receipts();root_backend();need(active(),'existing_native_HA_observer_not_active')
  if action=='rollback':
   need(STATE.exists()and not(STATE/'rollback-intent.json').exists(),'rollback_requires_reconciliation');baseline(m,'after');saved=json.loads(read(STATE/'intent.json',0o600));need(saved['original_receipt_hashes']==history,'original_receipts_changed')
   before={name:read(STATE/'before'/name,0o600)if row['before']is not None else None for name,row in m['targets'].items()};need(all(b is None or sha(b)==m['targets'][n]['before']for n,b in before.items()),'rollback_backup_changed')
   atomic(STATE/'rollback-intent.json',raw({'at':time.time(),'automatic_retry':False}),0o600)
   for name,row in reversed(list(m['targets'].items())):
    if before[name]is None:Path(row['path']).unlink();sync(Path(row['path']).parent)
    else:atomic(Path(row['path']),before[name])
   chains();root_backend();activate_service('rollback');need(historical_receipts()==history,'historical_receipts_changed');atomic(STATE/'rollback.json',raw(receipt(m,'rolled_back_readonly_extension_not_functional_recovery',history)),0o600);return
  before=baseline(m);need(after==model.proposed(before,after,frozen),'policy_or_scope_changes_exceed_review');need(not STATE.exists(),'existing_intent_requires_reconciliation');need(not(RUN_DIR/'revoked').exists(),'new_scope_already_revoked')
  if RUN_DIR.exists():
   s=RUN_DIR.lstat();need(stat.S_ISDIR(s.st_mode)and s.st_uid==0 and stat.S_IMODE(s.st_mode)==0o755 and not RUN_DIR.is_symlink(),'unsafe_fixed_runtime_directory')
  if action=='preflight':print(json.dumps({'state':'preflight_passed','targets':len(after),'new_MCP_tools':0,'access_activated':False,'specific_approval_required':True,'production_changes':False}));return
  directory(STATE,0o700);directory(STATE/'before',0o700);atomic(STATE/'intent.json',raw(receipt(m,'intent_before_readonly_extension_activation',history)),0o600)
  for n,b in before.items():
   if b is not None:atomic(STATE/'before'/n,b,0o600)
  try:
   directory(RUN_DIR,0o755)
   for name,row in m['targets'].items():need(time.time()+30<EXPIRY,'authority_completion_margin');atomic(Path(row['path']),after[name])
   baseline(m,'after');unchanged(m);chains();root_backend();activate_service('apply');need(historical_receipts()==history,'historical_receipts_changed');result=receipt(m,'installed_pending_actual_MCP_and_natural_read_acceptance',history);atomic(STATE/'receipt.json',raw(result),0o600);print(json.dumps(result))
  except BaseException:
   atomic(STATE/'receipt.json',raw(receipt(m,'activation_or_restart_outcome_unconfirmed_reconcile_same_intent',history)),0o600);raise
if __name__=='__main__':
 try:main()
 except Exception as e:print(json.dumps({'state':'not_accepted_or_unconfirmed','reason':str(e)if type(e)is ValueError else'withheld','exception_kind':type(e).__name__,'automatic_retry':False}));raise SystemExit(1)
