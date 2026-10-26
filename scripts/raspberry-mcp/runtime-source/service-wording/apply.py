"""Fixed ambiguous-service wording repair; same approved sanitized content."""
import ast,contextlib,fcntl,hashlib,json,os,sqlite3,stat,subprocess,sys,time
from pathlib import Path
STAGE=Path('/__OPERATOR_STAGE__/service-wording')
STATE=Path('/__OPERATOR_STATE__/service-wording')
EXPIRY=0
MANIFEST_SHA='0000000000000000000000000000000000000000000000000000000000000000'
TARGETS={'diagnostic_templates.json': '/usr/local/lib/raspberry-ha-notices/diagnostic_templates.json', 'repair-policy.json': '/usr/local/lib/raspberry-repair-control/policy.json'}
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
 p=Path(p);t=p.with_name('.'+p.name+'.contract-new');fd=os.open(t,os.O_CREAT|os.O_EXCL|os.O_WRONLY|os.O_NOFOLLOW,mode)
 try:
  os.fchmod(fd,mode)
  with os.fdopen(os.dup(fd),'wb')as f:f.write(b);f.flush();os.fsync(f.fileno())
 finally:os.close(fd)
 os.replace(t,p);sync(p.parent)
def proposed(before,template):
 old=json.loads(before['diagnostic_templates.json']);new=json.loads(template);repair=json.loads(before['repair-policy.json'])
 need(repair['enabled']is True and repair['expires_at']==EXPIRY and repair['maximum_submissions']==2,'authority_or_limits_changed')
 expected=json.loads(before['diagnostic_templates.json']);expected['fragments']['service_unavailable']='Serviço indisponível; origem não comprovada';expected['fragments']['check_service']='Confira o serviço registrado, o handler e suas dependências; a mensagem genérica não comprova serviço ausente nem identifica o provedor indisponível.'
 need(new==expected and set(old)==set(new),'template_changes_exceed_reviewed_wording')
 target=TARGETS['diagnostic_templates.json'];need(target in repair['dependencies'],'template_pin_missing');repair['dependencies'][target]=sha(template)
 return {'diagnostic_templates.json':template,'repair-policy.json':raw(repair)}

def load():
 m=read(STAGE/'MANIFEST.json');need(sha(m)==MANIFEST_SHA,'manifest_changed');m=json.loads(m)
 need(set(m)=={'revision','expiry','targets','new_access','limits_changed'}and m['revision']=='r1'and m['expiry']==EXPIRY and m['new_access']is False and m['limits_changed']is False and set(m['targets'])==set(TARGETS),'manifest_scope_changed')
 after={}
 for n,p in TARGETS.items():
  need(set(m['targets'][n])=={'target','before','after'}and m['targets'][n]['target']==p,'target_changed');after[n]=read(STAGE/n);need(sha(after[n])==m['targets'][n]['after'],'candidate_changed')
 return m,after
def baseline(m,which='before'):
 b={n:read(Path(p))for n,p in TARGETS.items()}
 need(all(sha(v)==m['targets'][n][which]for n,v in b.items()),'baseline_changed');return b
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

def main():
 need(os.geteuid()==0 and Path(__file__)==STAGE/'apply.py'and sys.argv[1:]in(['preflight'],['apply-approved'],['status'],['rollback']),'fixed_authenticated_entrypoint_required');action=sys.argv[1];m,after=load()
 if action=='status':
  p=STATE/'receipt.json'if(STATE/'receipt.json').exists()else STATE/'intent.json';print(read(p,0o600).decode());return
 need(time.time()+90<EXPIRY,'administrative_authority_expired');tasks=chains()
 with locks(tasks):
  if action=='rollback':
   need(STATE.exists()and not(STATE/'rollback-intent.json').exists(),'rollback_requires_reconciliation');baseline(m,'after')
   before={n:read(STATE/'before'/n,0o600)for n in TARGETS};need(all(sha(b)==m['targets'][n]['before']for n,b in before.items()),'rollback_backup_changed')
   atomic(STATE/'rollback-intent.json',raw({'state':'rollback_intent','at':time.time(),'automatic_retry':False}),0o600)
   for n,p in TARGETS.items():atomic(Path(p),before[n])
   chains();atomic(STATE/'rollback.json',raw({'state':'rolled_back_contract_only','ledger_preserved':True,'automatic_retry':False}),0o600);return
  before=baseline(m);need(after==proposed(before,after['diagnostic_templates.json']),'policy_changes_exceed_pins')
  need(not STATE.exists(),'existing_intent_requires_reconciliation')
  if action=='preflight':print(json.dumps({'state':'preflight_passed','targets':2,'new_access':False,'production_changes':False}));return
  STATE.mkdir(mode=0o700);sync(STATE.parent);(STATE/'before').mkdir(mode=0o700)
  atomic(STATE/'intent.json',raw({'state':'intent_before_contract_repair','at':time.time(),'manifest_sha256':MANIFEST_SHA,'automatic_retry':False}),0o600)
  for n,b in before.items():atomic(STATE/'before'/n,b,0o600)
  try:
   for n,p in TARGETS.items():atomic(Path(p),after[n])
   baseline(m,'after');chains();need(time.time()+30<EXPIRY,'administrative_authority_expired')
   receipt={'state':'installed_pending_actual_MCP_wording_read','observed_at':time.time(),'manifest_sha256':MANIFEST_SHA,'targets':{n:sha(b)for n,b in after.items()},'new_access':False,'authority_expiry':EXPIRY,'ledger_mutations':0,'webhooks_invoked':0,'automatic_retry':False,'reconnections':0,'household_service_actions':[]}
   atomic(STATE/'receipt.json',raw(receipt),0o600);print(json.dumps(receipt))
  except BaseException:
   atomic(STATE/'receipt.json',raw({'state':'wording_or_policy_outcome_unconfirmed_reconcile_same_intent','automatic_retry':False,'ledger_preserved':True}),0o600);raise
if __name__=='__main__':
 try:main()
 except Exception as e:print(json.dumps({'state':'not_accepted_or_unconfirmed','exception_kind':type(e).__name__,'reason':str(e)if type(e)is ValueError else'withheld','automatic_retry':False}));raise SystemExit(1)
