import fcntl,hashlib,importlib.util,json,os,re,stat,subprocess,sys,time
from pathlib import Path
STAGE=Path('/run/raspberry-host-observer-integration-20261025-r2')
STATE=Path('/var/lib/raspberry-eva-repair-install-20261024')
MANIFEST_SHA='${APPROVED_HOST_OBSERVER_MANIFEST_SHA256}'
EXPIRY=(1792941922 + 2443945 / 10000000)
INTENT=STATE/'host-observer-integration-r2-intent.json'
RECEIPT=STATE/'host-observer-integration-r2.json'
def need(value,reason):
 if not value:raise ValueError(reason)
def digest(value):return hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()).hexdigest()
def main():
 need(os.geteuid()==0 and Path(__file__).absolute()==STAGE/'apply.py' and sys.argv[1:] in (['apply'],['reconcile']),'fixed_action_required')
 src=Path('/run/raspberry-eva-repair-20261024/install.py');need(hashlib.sha256(src.read_bytes()).hexdigest()=='53295b03ad358f70e454be81eb02102bd0a075fa0e691cbfff997b8fb8967f1d','reader_changed')
 spec=importlib.util.spec_from_file_location('sealed',src);base=importlib.util.module_from_spec(spec);spec.loader.exec_module(base)
 def read(path,limit=8388608):
  base.parents(path)
  fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
  try:
   info=os.fstat(fd);need(stat.S_ISREG(info.st_mode) and info.st_uid==0 and info.st_gid==0 and stat.S_IMODE(info.st_mode)==0o644 and info.st_nlink==1 and info.st_size<=limit,'unsafe_stage')
   raw=os.read(fd,limit+1);need(len(raw)<=limit,'stage_limit');return raw
  finally:os.close(fd)
 raw=read(STAGE/'MANIFEST.json');need(base.sha(raw)==MANIFEST_SHA,'manifest_changed');m=json.loads(raw)
 need(m['expires_at']==EXPIRY and m['services_restarted']==m['household_actuator_effects']==m['artificial_events']==0 and m['original_subscription_and_budget_unchanged'] is True,'scope_changed')
 for name,sha in m['files'].items():need(base.sha(read(STAGE/name))==sha,'stage_changed')
 action=sys.argv[1]
 if action=='apply' and RECEIPT.exists():print(base.read(RECEIPT,0o600).decode());return
 lock=os.open('/mnt/data/docker/.daily-maintenance.lock',os.O_WRONLY|os.O_NOFOLLOW)
 try:
  if action=='apply':
   fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
   need(time.time()<EXPIRY,'lease_expired');need(not INTENT.exists(),'existing_intent_requires_reconciliation')
   root=Path('/mnt/data/docker');need(not list((root/'homeassistant/.daily-update-trigger').glob('*processing')) and not (root/'homeassistant/.git-backup-trigger/processing').exists(),'native_worker_processing')
   mem=int(next(line.split()[1]for line in Path('/proc/meminfo').read_text().splitlines()if line.startswith('MemAvailable:')))*1024;disk=os.statvfs(root)
   need(mem>=2147483648 and disk.f_bavail/disk.f_blocks>=.15,'resource_gate')
   sys.path[:0]=['/usr/local/lib/raspberry-task-control','/usr/local/lib/raspberry-mcp'];import task_control as tasks;import codex_control as old;tasks.policy(old)
   with tasks.locked():base.idle_databases(tasks)
   need(digest(json.loads((root/'nodered/flows.json').read_text()))==m['before_loaded_sha256'],'disk_baseline_changed')
   need(hashlib.sha256((root/'nodered/tools/read-host-observation.mjs').read_bytes()).hexdigest()==m['fixed_reader_sha256'],'fixed_reader_changed')
   base.atomic(INTENT,(json.dumps({'state':'intent_before_single_node_deployment','at':time.time(),'manifest_sha256':MANIFEST_SHA,'automatic_retry':False})+'\n').encode(),0o600)
  user='admin'
  for line in Path('/mnt/data/docker/.env').read_text().splitlines():
   if line.startswith('NODE_RED_ADMIN_USER='):user=line.split('=',1)[1].strip().strip('\"\'')
  need(re.fullmatch(r'[a-zA-Z0-9_.@-]{1,64}',user) is not None,'username_invalid')
  request={'action':'deploy' if action=='apply' else 'read','password':Path('/mnt/data/docker/.local-secrets/node-red-admin-password.txt').read_text().strip()}
  if action=='apply':request.update(expected_loaded_sha256=m['before_loaded_sha256'],proposed_loaded_sha256=m['after_loaded_sha256'],flows=json.loads(read(STAGE/'flows.candidate.json')))
  result=subprocess.run(['/usr/bin/node','--max-old-space-size=96',str(STAGE/'flow_client.cjs')],input=json.dumps(request).encode(),capture_output=True,timeout=55,env={'PATH':'/usr/bin:/bin','NODE_RED_ADMIN_USER':user})
  need(result.returncode==0 and len(result.stdout)<4096,'api_outcome_unconfirmed');proof=json.loads(result.stdout)
  need(proof.get('verified') is True and proof.get('session_revoked') is True,'api_outcome_unconfirmed')
  proof.update(disk_loaded_sha256=digest(json.loads(Path('/mnt/data/docker/nodered/flows.json').read_text())),manifest_sha256=MANIFEST_SHA,at=time.time(),services_restarted=0,household_actuator_effects=0,artificial_events=0,expiry_unchanged=True,original_subscription_and_budget_unchanged=True,automatic_retry=False)
  proof['matches_after']=proof['loaded_sha256']==proof['disk_loaded_sha256']==m['after_loaded_sha256']
  if action=='apply':
   need(proof['matches_after'],'loaded_or_disk_result_unconfirmed');proof['state']='host_observer_policy_deployed_no_natural_fault_acceptance_yet'
   base.atomic(RECEIPT,(json.dumps(proof,sort_keys=True)+'\n').encode(),0o600)
  else:proof['state']='readonly_reconciliation'
  print(json.dumps(proof))
 finally:os.close(lock)
if __name__=='__main__':
 try:main()
 except Exception as e:print(json.dumps({'state':'unconfirmed','exception_kind':type(e).__name__,'raw_error_withheld':True,'automatic_retry':False}));raise SystemExit(1)
