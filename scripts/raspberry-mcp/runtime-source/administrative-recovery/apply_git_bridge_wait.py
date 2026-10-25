MANIFEST_SHA256='${REVIEW_MANIFEST_SHA256}'
import hashlib,importlib.util,json,os,re,stat,subprocess,sys,time
from pathlib import Path
STAGE=Path('/run/raspberry-git-bridge-wait-20261025')
STATE=Path('/var/lib/raspberry-eva-repair-install-20261024')
INTENT=STATE/'git-bridge-wait-intent.json'
RECEIPT=STATE/'git-bridge-wait.json'
def need(ok,reason):
 if not ok:raise ValueError(reason)
def main():
 need(os.geteuid()==0 and Path(__file__).absolute()==STAGE/'apply.py' and sys.argv[1:] in (['inspect'],['apply'],['reconcile']),'fixed_stage_required')
 source=Path('/run/raspberry-eva-repair-20261024/install.py');need(hashlib.sha256(source.read_bytes()).hexdigest()=='53295b03ad358f70e454be81eb02102bd0a075fa0e691cbfff997b8fb8967f1d','reader_changed')
 spec=importlib.util.spec_from_file_location('sealed',source);base=importlib.util.module_from_spec(spec);spec.loader.exec_module(base)
 raw=base.read(STAGE/'MANIFEST.json');need(base.sha(raw)==MANIFEST_SHA256,'manifest_changed');m=json.loads(raw)
 def staged(name):
  if name!='flows.candidate.json':return base.read(STAGE/name)
  path=STAGE/name;base.parents(path);fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
  try:
   s=os.fstat(fd);need(stat.S_ISREG(s.st_mode)and s.st_uid==0 and s.st_gid==0 and stat.S_IMODE(s.st_mode)==0o644 and s.st_nlink==1 and s.st_size<=8388608,'unsafe_flow_stage');data=os.read(fd,8388609);need(len(data)<=8388608,'flow_limit');return data
  finally:os.close(fd)
 for name,expected in m['files'].items():need(base.sha(staged(name))==expected,'stage_changed')
 action=sys.argv[1]
 if action=='apply'and RECEIPT.exists():print(base.read(RECEIPT,0o600).decode());return
 if action=='apply':
  need(not INTENT.exists(),'uncertain_deployment_requires_readonly_reconciliation');need(time.time()<(1792941922 + 2443945 / 10000000) and m['expires_at']==(1792941922 + 2443945 / 10000000),'expired')
  sys.path[:0]=['/usr/local/lib/raspberry-task-control','/usr/local/lib/raspberry-mcp'];import task_control as tasks;import codex_control as old;tasks.policy(old)
  with tasks.locked():base.idle_databases(tasks)
  for file in ['homeassistant/.daily-update-trigger/offsite-backup-processing','homeassistant/.git-backup-trigger/processing','homeassistant/.git-backup-trigger/requested']:need(not Path('/mnt/data/docker',file).exists(),'worker_active')
  base.atomic(INTENT,(json.dumps({'state':'intent_before_flow_wait_budget_update','at':time.time(),'manifest_sha256':base.sha(raw),'automatic_retry':False})+'\n').encode(),0o600)
 username='admin'
 with Path('/mnt/data/docker/.env').open()as config:
  for line in config:
   if line.startswith('NODE_RED_ADMIN_USER='):username=line.split('=',1)[1].strip().strip('\"\'')
 need(re.fullmatch(r'[a-zA-Z0-9_.@-]{1,64}',username)is not None,'invalid_configured_identity')
 request={'action':'deploy'if action=='apply'else'read','password':Path('/mnt/data/docker/.local-secrets/node-red-admin-password.txt').read_text().strip()}
 if action=='apply':request.update(expected_loaded_sha256=m['before_loaded_sha256'],proposed_loaded_sha256=m['after_loaded_sha256'],flows=json.loads(staged('flows.candidate.json')))
 result=subprocess.run(['/usr/bin/node','--max-old-space-size=96',str(STAGE/'flow_client.cjs')],input=json.dumps(request).encode(),capture_output=True,timeout=55,env={'PATH':'/usr/bin:/bin','HOME':'/nonexistent','NODE_RED_ADMIN_USER':username})
 need(result.returncode==0 and len(result.stdout)<4096,'api_unconfirmed');proof=json.loads(result.stdout);need(proof.get('verified')is True and proof.get('session_revoked')is True,'api_unconfirmed')
 if action=='apply':
  need(proof['loaded_sha256']==m['after_loaded_sha256'],'loaded_unconfirmed');persist=json.dumps(json.loads(Path('/mnt/data/docker/nodered/flows.json').read_text()),sort_keys=True,separators=(',',':'),ensure_ascii=False).encode();need(base.sha(persist)==m['after_loaded_sha256'],'persisted_unconfirmed')
  proof.update(state='git_bridge_fixed_wait_budget_applied',at=time.time(),manifest_sha256=base.sha(raw),helper_wait_seconds=600,exec_timeout_seconds=660,services_restarted=0,new_Git_requests=0,new_residential_events=0,automatic_retry=False,privileged_scope_and_expiry_unchanged=True)
  base.atomic(RECEIPT,(json.dumps(proof,sort_keys=True)+'\n').encode(),0o600)
 else:proof.update(action=action,matches_before=proof['loaded_sha256']==m['before_loaded_sha256'],matches_after=proof['loaded_sha256']==m['after_loaded_sha256'])
 print(json.dumps(proof))
if __name__=='__main__':
 try:main()
 except Exception as e:print(json.dumps({'state':'unconfirmed','exception_kind':type(e).__name__,'raw_error_withheld':True,'automatic_retry':False}));raise SystemExit(1)
