import fcntl,hashlib,importlib.util,json,os,pwd,re,sqlite3,stat,subprocess,sys,time
from pathlib import Path
STAGE=Path('/run/raspberry-host-MCP-health-20261025')
STATE=Path('/var/lib/raspberry-eva-repair-install-20261024')
MANIFEST_SHA='${APPROVED_HOST_MCP_METADATA_MANIFEST_SHA256}'
UNITS={'events':'raspberry-mcp-events.service','tunnel':'raspberry-mcp-tunnel.service'}
def need(value,reason):
 if not value:raise ValueError(reason)
def metadata():
 root=Path('/var/lib/raspberry-mcp-events');uid=pwd.getpwnam('raspberry-mcp-events').pw_uid;info=root.lstat();need(stat.S_ISDIR(info.st_mode)and info.st_uid==uid and stat.S_IMODE(info.st_mode)==0o700,'unsafe_event_state')
 file=root/'events.sqlite3';info=file.lstat();need(stat.S_ISREG(info.st_mode)and info.st_uid==uid and info.st_nlink==1 and stat.S_IMODE(info.st_mode)==0o600,'unsafe_event_database')
 with sqlite3.connect('file:'+str(file)+'?mode=ro',uri=True,timeout=2)as db:
  db.execute('PRAGMA query_only=ON');db.execute('BEGIN')
  leases=db.execute('SELECT id,owner,args,started,expires,active FROM subscriptions ORDER BY id').fetchall()
  rows=db.execute('SELECT subscription,event,state,at FROM dispatch ORDER BY subscription,event').fetchall()
  count=db.execute('SELECT count(*) FROM events').fetchone()[0]
 hashes=lambda values:hashlib.sha256(json.dumps(values,sort_keys=True,separators=(',',':')).encode()).hexdigest()
 return {'subscription_metadata_sha256':hashes(leases),'dispatch_fingerprints':[hashes(row)for row in rows],
  'dispatch_rows':len(rows),'event_rows':count,'recent_uncertain':sum(row[2]=='uncertain'and row[3]>time.time()-120 for row in rows)}
def main():
 need(os.geteuid()==0 and Path(__file__).absolute()==STAGE/'activate.py' and len(sys.argv)==2 and sys.argv[1]in[*UNITS,'reconcile'],'fixed_action_required')
 src=Path('/run/raspberry-eva-repair-20261024/install.py');need(hashlib.sha256(src.read_bytes()).hexdigest()=='53295b03ad358f70e454be81eb02102bd0a075fa0e691cbfff997b8fb8967f1d','reader_changed')
 spec=importlib.util.spec_from_file_location('sealed',src);base=importlib.util.module_from_spec(spec);spec.loader.exec_module(base)
 raw=base.read(STAGE/'MANIFEST.json');need(base.sha(raw)==MANIFEST_SHA,'manifest_changed');m=json.loads(raw)
 need(base.sha(base.read(STAGE/'install.py'))=='892ccf248c57409c97b4374ec396c07ed10b0c413eb6a9293b98b2a399594129','installer_changed')
 spec=importlib.util.spec_from_file_location('reviewed_install',STAGE/'install.py');installer=importlib.util.module_from_spec(spec);spec.loader.exec_module(installer)
 for name,target in installer.TARGETS.items():need(base.sha(base.read(Path(target)))==m['files'][name]['after_sha256'],'applied_source_changed')
 need(json.loads(base.read(STATE/'host-MCP-health-install.json',0o600))['state']=='host_and_event_metadata_code_installed_activation_pending','installation_unconfirmed')
 action=sys.argv[1]
 if action=='reconcile':
  print(json.dumps({'state':'readonly_service_reconciliation','services':{name:{'active':subprocess.check_output(['/usr/bin/systemctl','is-active',unit],text=True,timeout=5).strip(),'main_pid':int(subprocess.check_output(['/usr/bin/systemctl','show',unit,'-p','MainPID','--value'],text=True,timeout=5))}for name,unit in UNITS.items()},'metadata':metadata(),'automatic_retry':False}));return
 receipt=STATE/('host-MCP-health-'+action+'-activation.json');intent=STATE/('host-MCP-health-'+action+'-activation-intent.json')
 if receipt.exists():print(base.read(receipt,0o600).decode());return
 need(not intent.exists(),'existing_intent_requires_readonly_reconciliation')
 need(time.time()<(1792941922 + 2443945 / 10000000),'original_lease_expired')
 if action=='tunnel':need(json.loads(base.read(STATE/'host-MCP-health-events-activation.json',0o600))['service_running']is True,'events_activation_unconfirmed')
 lock=os.open('/mnt/data/docker/.daily-maintenance.lock',os.O_WRONLY|os.O_NOFOLLOW)
 try:
  fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB);need(not list(Path('/mnt/data/docker/homeassistant/.daily-update-trigger').glob('*processing')),'native_worker_processing')
  sys.path[:0]=['/usr/local/lib/raspberry-task-control','/usr/local/lib/raspberry-mcp'];import task_control as tasks;import codex_control as old;tasks.policy(old)
  with tasks.locked():base.idle_databases(tasks)
  unit=UNITS[action];before_pid=int(subprocess.check_output(['/usr/bin/systemctl','show',unit,'-p','MainPID','--value'],text=True,timeout=5));need(before_pid>1,'service_not_running')
  before=metadata();need(before['recent_uncertain']==0,'dispatch_in_flight_or_recently_uncertain')
  base.atomic(intent,(json.dumps({'state':'intent_before_fixed_infrastructure_service_activation','at':time.time(),'unit':unit,'before_main_pid':before_pid,'before_metadata':before,'manifest_sha256':MANIFEST_SHA,'automatic_retry':False})+'\n').encode(),0o600)
  result=subprocess.run(['/usr/bin/systemctl','restart',unit],capture_output=True,timeout=25);need(result.returncode==0,'activation_result_uncertain')
  after_pid=int(subprocess.check_output(['/usr/bin/systemctl','show',unit,'-p','MainPID','--value'],text=True,timeout=5));active=subprocess.check_output(['/usr/bin/systemctl','is-active',unit],text=True,timeout=5).strip()
  need(active=='active'and after_pid>1 and after_pid!=before_pid,'activation_identity_unconfirmed')
  after=metadata();preserved=before['subscription_metadata_sha256']==after['subscription_metadata_sha256']and set(before['dispatch_fingerprints'])<=set(after['dispatch_fingerprints'])
  proof={'state':'fixed_infrastructure_activation_completed_MCP_acceptance_pending','at':time.time(),'unit':unit,'before_main_pid':before_pid,'after_main_pid':after_pid,'service_running':True,'existing_subscription_and_dispatch_metadata_preserved':preserved,'before_metadata':before,'after_metadata':after,'household_services_restarted':0,'Codex_daemon_restarted':False,'new_events_generated':0,'new_inference_requested_by_package':False,'limits_and_expiry_unchanged':True,'automatic_retry':False}
  base.atomic(receipt,(json.dumps(proof,sort_keys=True)+'\n').encode(),0o600);print(json.dumps(proof))
 finally:os.close(lock)
if __name__=='__main__':
 try:main()
 except Exception as e:
  message=str(e);print(json.dumps({'state':'activation_unconfirmed','exception_kind':type(e).__name__,'reason':message if re.fullmatch('[a-z_]{1,80}',message)else'withheld','raw_error_withheld':True,'automatic_retry':False}));raise SystemExit(1)
