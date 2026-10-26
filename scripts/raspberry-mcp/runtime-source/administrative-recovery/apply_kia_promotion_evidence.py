"""Fixed diagnostic deployment through existing, explicitly scoped admin tasks."""
import contextlib,fcntl,hashlib,importlib.util,json,os,sqlite3,stat,subprocess,sys,time
from pathlib import Path
STAGE=Path('/run/raspberry-kia-promotion-evidence-20261026')
STATE=Path('/var/lib/raspberry-kia-promotion-evidence-20261026')
BUNDLE=STATE/'bundle'
EXPIRY=1793138354 + 2133384 / 10_000_000
MANIFEST_SHA='84f953c26e8566bb8f06f510513822dfd55315e58de073a8a479adac648f4238'
TARGETS={'promote-kia-uvo-candidate.mjs':Path('/mnt/data/docker/scripts/promote-kia-uvo-candidate.mjs'),
 'kia_model.cjs':Path('/usr/local/lib/raspberry-nodered-diagnostics/kia_model.cjs'),
 'repair-policy.json':Path('/usr/local/lib/raspberry-repair-control/policy.json')}
SERVICES=('homeassistant','nodered','mosquitto','portainer','appdaemon','matter_server','zigbee2mqtt')
DIAGNOSTICS='raspberry-nodered-diagnostics.service'
def need(v,reason):
 if not v:raise ValueError(reason)
def sha(b):return hashlib.sha256(b).hexdigest()
def raw(v):return(json.dumps(v,sort_keys=True,indent=2)+'\n').encode()
def read(p,uid=0,mode=0o644):
 p=Path(p)
 for parent in p.parents:need(parent.is_dir()and not parent.is_symlink(),'unsafe_parent')
 fd=os.open(p,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
 try:
  s=os.fstat(fd);need(stat.S_ISREG(s.st_mode)and s.st_uid==uid and stat.S_IMODE(s.st_mode)==mode and s.st_nlink==1 and s.st_size<=1048576,'unsafe_file');b=os.read(fd,1048577);need(len(b)<=1048576,'file_limit');return b
 finally:os.close(fd)
def helper():
 p=STAGE/'sealed_helpers.py';need(sha(read(p))=='7df4d1f378479f3c03bbd5b4efe7420fb2c5ff4661f357881311380f57f33ebb','helper_changed');s=importlib.util.spec_from_file_location('sealed_kia_evidence_helper',p);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m
def command(argv):
 r=subprocess.run(argv,capture_output=True,timeout=10);need(r.returncode==0 and len(r.stdout)<=65536,'fixed_command_unconfirmed');return r.stdout
def services():
 return {n:command(['/usr/bin/docker','inspect','--format','{{.State.Status}} {{.State.StartedAt}}',n]).decode().strip()for n in SERVICES}
def diagnostic_manager():
 b=command(['/usr/bin/systemctl','show',DIAGNOSTICS,'-p','MainPID','-p','ActiveState']);return dict(line.split('=',1)for line in b.decode().splitlines())
def fingerprint(v):return sha(json.dumps(v,sort_keys=True,ensure_ascii=False).encode())
def validate_task_context(m,phase,tasks,sends):
 """Exempt only the exact admitted operation performing this fixed effect."""
 expected=m['phases'][phase];target=[t for t in tasks if t['id']==expected['create']['operation_id']]
 need(len(target)==1,'scoped_task_missing');t=target[0]
 need(t['task_key']==expected['create']['task_key']and t['spec_hash']==fingerprint(expected['create'])and t['state']=='created'and t['thread']and t['reconciled']==1,'scoped_task_identity_unconfirmed')
 need(all(t['reconciled']==1 for t in tasks),'other_task_reserved')
 busy={'create_intent','create_unknown','send_intent','send_unknown','accepted','inProgress','outcome_unknown'}
 need(not any(x['state']in busy for x in tasks),'other_task_busy')
 need(not any(x['id']!=expected['send']['operation_id']and x['state']in busy for x in sends),'other_send_busy')
 active=[s for s in sends if not s['reconciled']]
 need(len(active)==1,'other_send_unresolved');s=active[0]
 need(s['id']==expected['send']['operation_id']and s['task']==t['id']and s['input_hash']==fingerprint(expected['send'])and s['state']in('accepted','inProgress')and s['turn']and s['result']is None,'scoped_send_unconfirmed')
def task_rows():
 c=sqlite3.connect('file:/var/lib/raspberry-mcp-operations/task-control/jobs.sqlite3?mode=ro',uri=True);c.row_factory=sqlite3.Row
 try:
  c.execute('PRAGMA query_only=ON');return([dict(x)for x in c.execute('select * from tasks')],[dict(x)for x in c.execute('select * from sends')])
 finally:c.close()
@contextlib.contextmanager
def locks(h,m,phase,preflight=False):
 tasks=h.chains();fds=[]
 try:
  for p in ['/mnt/data/docker/.daily-maintenance.lock','/var/lib/raspberry-mcp-operations/lock','/var/lib/raspberry-admin-executor/executor.lock']:
   fd=os.open(p,os.O_RDONLY|os.O_NOFOLLOW);fds.append(fd);fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
  with tasks.locked(read_only=True):
   need(tasks.legacy_summary()['busy']==0,'legacy_operation_unresolved')
   ts,ss=task_rows()
   if preflight:need(all(x['reconciled']==1 and x['state']not in('create_intent','create_unknown','send_intent','send_unknown','accepted','inProgress','outcome_unknown')for x in ts+ss),'operation_unresolved')
   else:validate_task_context(m,phase,ts,ss)
   for d in ['.daily-update-trigger','.git-backup-trigger']:need(not list((Path('/mnt/data/docker/homeassistant')/d).glob('*processing*')),'native_worker_processing')
   yield
 finally:
  for fd in reversed(fds):os.close(fd)
def load():
 b=read(STAGE/'MANIFEST.json');need(sha(b)==MANIFEST_SHA,'manifest_changed');m=json.loads(b)
 need(m['expires_at']==EXPIRY and set(m['targets'])==set(TARGETS)and set(m['phases'])=={'apply','rollback','reapply'},'manifest_scope_changed');data={}
 for n,p in TARGETS.items():
  row=m['targets'][n];need(row['path']==str(p),'target_path_changed');data[n]=read(STAGE/n);need(sha(data[n])==row['after'],'candidate_changed')
 return m,data
def frozen(m):
 for p,row in m['protected'].items():need(sha(read(p,row['uid'],row['mode']))==row['sha256'],'protected_source_or_original_receipt_changed')
def sources(m,which):
 return {n:checked_source(m,n,which)for n in TARGETS}
def checked_source(m,n,which):
 row=m['targets'][n];b=read(TARGETS[n],row['uid'],row['mode']);need(sha(b)==row[which],'target_baseline_changed');return b
def put(h,p,b,uid=0):
 h.atomic(p,b);os.chown(p,uid,0 if uid==0 else uid)
def record(h,name,row):
 need(not os.path.lexists(STATE/name),'existing_receipt_requires_reconciliation');h.atomic(STATE/name,raw(row),0o600)
def reload(h,phase):
 previous=diagnostic_manager();record(h,phase+'-restart-intent.json',{'at':time.time(),'previous_pid':previous['MainPID'],'previous_state':previous['ActiveState'],'automatic_retry':False});command(['/usr/bin/systemctl','restart',DIAGNOSTICS]);after=diagnostic_manager();need(after['ActiveState']=='active'and int(after['MainPID'])>1 and after['MainPID']!=previous['MainPID'],'diagnostics_restart_unconfirmed');return {'previous_pid':previous['MainPID'],'previous_state':previous['ActiveState'],'new_pid':after['MainPID']}
def main(action):
 m,data=load();h=helper()
 if action=='status':
  print(json.dumps({'state':'readonly_reconciliation','files':{n:sha(read(p,m['targets'][n]['uid']))for n,p in TARGETS.items()},'phase_receipts':{phase:(STATE/(phase+'-result.json')).exists()for phase in m['phases']},'diagnostics':diagnostic_manager(),'automatic_retry':False}));return
 need(os.geteuid()==0 and time.time()+120<EXPIRY,'valid_root_authority_required')
 for p in ['/var/lib/raspberry-admin-executor/revoked','/var/lib/raspberry-mcp-operations/task-control/revoked','/var/lib/raspberry-nodered-diagnostics/revoked']:need(not os.path.lexists(p),'authority_revoked')
 need(action in('preflight','apply','rollback','reapply'),'fixed_action_required')
 with locks(h,m,action,preflight=action=='preflight'):
  frozen(m)
  manager=diagnostic_manager();need(manager['ActiveState']in('active','inactive')and ((manager['ActiveState']=='active'and int(manager['MainPID'])>1)or(manager['ActiveState']=='inactive'and manager['MainPID']=='0')),'diagnostics_state_unconfirmed');command(['/usr/bin/systemctl','is-active','raspberry-nodered-diagnostics.socket'])
  if action in('preflight','apply'):
   need(not STATE.exists(),'existing_intent_requires_reconciliation');before=sources(m,'before');policy=json.loads(before['repair-policy.json']);policy['dependencies'][str(TARGETS['kia_model.cjs'])]=sha(data['kia_model.cjs']);need(policy==json.loads(data['repair-policy.json']),'policy_authority_or_limits_changed')
   if action=='preflight':print(json.dumps({'state':'preflight_passed','targets':3,'new_access':False,'original_promotion_not_replayed':True}));return
   h.directory(STATE,0o700);h.directory(STATE/'before',0o700);h.directory(BUNDLE,0o700)
   for n in ['apply.py','MANIFEST.json','sealed_helpers.py',*TARGETS]:h.atomic(BUNDLE/n,read(STAGE/n))
   for n,b in before.items():h.atomic(STATE/'before'/n,b,0o600)
   from_state,to_state='before','after';desired=data
  elif action=='rollback':
   need((STATE/'apply-result.json').exists(),'application_unconfirmed');sources(m,'after');from_state,to_state='after','before';desired={n:read(STATE/'before'/n,0,0o600)for n in TARGETS}
   for n,b in desired.items():need(sha(b)==m['targets'][n]['before'],'backup_changed')
  else:
   need((STATE/'rollback-result.json').exists(),'rollback_unconfirmed');sources(m,'before');from_state,to_state='before','after';desired=data
  need(not(STATE/(action+'-intent.json')).exists(),'phase_intent_requires_reconciliation');seven=services();need(all(v.startswith('running ')for v in seven.values()),'household_service_degraded');record(h,action+'-intent.json',{'state':'intent_before_fixed_diagnostic_change','at':time.time(),'operation_id':m['operation_id'],'phase':action,'manifest_sha256':MANIFEST_SHA,'household_service_state':seven,'automatic_retry':False})
  for n,p in TARGETS.items():checked_source(m,n,from_state);put(h,p,desired[n],m['targets'][n]['uid'])
  sources(m,to_state);h.chains();native=reload(h,action);frozen(m);need(services()==seven,'household_service_start_times_changed')
  row={'state':'confirmed_'+action+'_awaiting_actual_MCP_read','at':time.time(),'phase':action,'operation_id':m['operation_id'],'targets':3,'diagnostics_only_restart':native,'household_services_restarted':0,'old_promotion_receipt_unchanged':True,'integration_files_unchanged':True,'provider_or_vehicle_calls':0,'new_access_or_expiry':False,'automatic_retry':False};record(h,action+'-result.json',row);print(json.dumps(row))
if __name__=='__main__':
 try:
  if Path(__file__)==BUNDLE/'apply.py':STAGE=BUNDLE
  need(Path(__file__)==STAGE/'apply.py'and len(sys.argv)==2,'fixed_entrypoint_required');main(sys.argv[1])
 except Exception as exc:
  print(json.dumps({'state':'unconfirmed','exception_kind':type(exc).__name__,'reason':str(exc)if type(exc)is ValueError else'withheld','automatic_retry':False}));raise SystemExit(1)
