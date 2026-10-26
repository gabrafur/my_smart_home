"""Fixed native contract upgrade. No caller paths, commands, retries or new tools."""
import datetime,hashlib,importlib.util,json,os,stat,subprocess,sys,time
from pathlib import Path
STAGE=Path('/__OPERATOR_STAGE__/icloud-loaded-contract')
STATE=Path('/__OPERATOR_STATE__/icloud-loaded-contract')
BUNDLE=STATE/'bundle'
if Path(__file__)==BUNDLE/'upgrade.py':STAGE=BUNDLE
EXPIRY=0
MANIFEST_SHA='0000000000000000000000000000000000000000000000000000000000000000'
REPO=Path('/mnt/data/docker');HA=REPO/'homeassistant'
TARGETS={
 'ha-init.py':HA/'custom_components/icloud/__init__.py',
 'ha-proof.py':HA/'custom_components/icloud/loaded_proof.py',
 'ha-contract.py':HA/'custom_components/icloud/loaded_contract.py',
 'ha-release.py':HA/'custom_components/icloud/release_identity.py',
 'ha-upstream.json':HA/'custom_components/icloud/upstream.json',
 'bindings-init.py':HA/'custom_components/public_bindings/__init__.py',
 'root-readiness.py':Path('/usr/local/lib/raspberry-admin-executor/icloud_readiness.py'),
 'root-contract.py':Path('/usr/local/lib/raspberry-admin-executor/loaded_contract.py'),
 'root-executor.py':Path('/usr/local/lib/raspberry-admin-executor/executor.py'),
 'recovery.py':Path('/usr/local/lib/raspberry-admin-recovery/recovery.py'),
 'client-readiness.py':Path('/usr/local/lib/raspberry-repair-control/readiness_client.py'),
 'client-contract.py':Path('/usr/local/lib/raspberry-repair-control/loaded_contract.py'),
 'admin-policy.json':Path('/usr/local/lib/raspberry-admin-executor/policy.json'),
 'repair-policy.json':Path('/usr/local/lib/raspberry-repair-control/policy.json'),
 'gitignore':REPO/'.gitignore',
 'native-scope.json':HA/'.mcp-icloud-contract-scope.json',
 'activation.json':HA/'.mcp-icloud-activation.json',
}
SERVICES=('homeassistant','nodered','mosquitto','portainer','appdaemon','matter_server','zigbee2mqtt')
def need(v,r):
 if not v:raise ValueError(r)
def sha(b):return hashlib.sha256(b).hexdigest()
def raw(v):return(json.dumps(v,sort_keys=True,indent=2)+'\n').encode()
def read(p,uid,mode,limit=16777216):
 for q in p.parents:need(q.is_dir()and not q.is_symlink(),'unsafe_target_parent')
 fd=os.open(p,os.O_RDONLY|os.O_NONBLOCK|os.O_NOFOLLOW)
 try:
  s=os.fstat(fd);need(stat.S_ISREG(s.st_mode)and s.st_uid==uid and stat.S_IMODE(s.st_mode)==mode and s.st_nlink==1 and s.st_size<=limit,'unsafe_target_file');b=os.read(fd,limit+1);need(len(b)<=limit,'target_limit');return b
 finally:os.close(fd)
def sync(p):
 fd=os.open(p,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
 try:os.fsync(fd)
 finally:os.close(fd)
def atomic(p,b,uid=0,gid=0,mode=0o600):
 t=p.with_name('.'+p.name+'.contract-new');fd=os.open(t,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,mode)
 try:
  os.fchown(fd,uid,gid);os.fchmod(fd,mode)
  with os.fdopen(os.dup(fd),'wb')as f:f.write(b);f.flush();os.fsync(f.fileno())
 finally:os.close(fd)
 os.replace(t,p);sync(p.parent)
def helper():
 p=STAGE/'sealed_helpers.py';need(sha(read(p,0,0o644))=='0000000000000000000000000000000000000000000000000000000000000000','historical_helper_changed');s=importlib.util.spec_from_file_location('sealed_readiness_upgrade_helpers',p);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m
def run(argv,timeout=10):
 r=subprocess.run(argv,capture_output=True,timeout=timeout);need(r.returncode==0 and len(r.stdout)<=65536,'fixed_command_unconfirmed');return r.stdout
def services():
 out={}
 for name in SERVICES:
  row=run(['/usr/bin/docker','inspect','--format','{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}} {{.State.StartedAt}} {{.Image}}',name]).decode().strip().split()
  need(len(row)==4,'service_metadata_invalid');out[name]={'running':row[0]=='running','health':row[1],'started_at':row[2],'image':row[3]}
 return out
def identities():
 out={}
 for name,key in [('core.entity_registry','id'),('core.device_registry','id'),('core.config_entries','entry_id')]:
  p=HA/'.storage'/name;s=p.stat();v=json.loads(read(p,s.st_uid,stat.S_IMODE(s.st_mode)));rows=v['data']['entities'if name=='core.entity_registry'else'devices'if name=='core.device_registry'else'entries'];need(type(rows)is list and len(rows)<=100000,'registry_identity_limit')
  ids=[sha(row[key].encode())for row in rows if type(row)is dict and type(row.get(key))is str];need(len(ids)==len(rows)and len(set(ids))==len(ids),'registry_identity_invalid');out[name]=sorted(ids)
 p=HA/'home-assistant_v2.db';s=p.stat();out['recorder']={'device':s.st_dev,'inode':s.st_ino};return out
def load():
 b=read(STAGE/'MANIFEST.json',0,0o644);need(sha(b)==MANIFEST_SHA,'manifest_changed');m=json.loads(b)
 need(m['expires_at']==EXPIRY and m['new_MCP_tools']==0 and m['maximum_HA_restarts']==1 and m['maximum_rollback_HA_restarts']==1 and m['new_credentials']==0 and m['budget_changes']is False and set(m['targets'])==set(TARGETS),'manifest_scope_changed');data={}
 for name,p in TARGETS.items():
  row=m['targets'][name];need(row['path']==str(p)and row['uid']in(0,1001)and row['gid']in(0,1001)and row['mode']in(0o600,0o644),'target_scope_changed');data[name]=read(STAGE/name,0,0o644);need(sha(data[name])==row['after'],'candidate_changed')
 return m,data
def baselines(m,which):
 out={}
 for name,p in TARGETS.items():
  row=m['targets'][name];expected=row[which]
  if expected is None:need(not os.path.lexists(p),'unexpected_existing_target');out[name]=None
  else:out[name]=read(p,row['uid'],row['mode']);need(sha(out[name])==expected,'target_baseline_changed')
 return out
def gate():
 need(os.geteuid()==0 and time.time()+180<EXPIRY,'valid_root_authority_required')
 for p in ['/var/lib/raspberry-admin-executor/revoked','/var/lib/raspberry-mcp-operations/task-control/revoked',str(HA/'.mcp-icloud-contract-revoked')]:need(not os.path.lexists(p),'authority_or_native_scope_revoked')
 need(not Path('/run/raspberry-icloud-read/revoked').exists(),'readiness_scope_revoked')
 for action in ['is-active','is-enabled']:run(['/usr/bin/systemctl',action,'raspberry-admin-executor.socket'],3)
def save(row):
 history_path=STATE/'history.json';history=json.loads(read(history_path,0,0o600))if history_path.exists()else[]
 need(len(history)<256,'history_limit_requires_reconciliation');history.append({k:row.get(k)for k in ['state','operation_id','at','activation_attempted','services_restarted','automatic_retry']})
 atomic(history_path,raw(history));atomic(STATE/'receipt.json',raw(row))
def main(action):
 m,data=load();gate();h=helper();tasks=h.chains()
 with h.locks(tasks):
  if action=='observe':
   row=json.loads(read(STATE/'receipt.json',0,0o600));proof=json.loads(read(HA/'.mcp-icloud-proof.json',0,0o600,8192));now=time.time();at=datetime.datetime.fromisoformat(proof['observed_at']).timestamp();fresh=0<=now-at<=60 and proof.get('operation_id')==m['operation_id']and proof.get('release_revision')==m['release_revision']and proof.get('loaded_code_sha256')==m['expected_loaded_code_sha256']and proof.get('schema_version')==2
   after=identities();before=row['identities_before'];same={k:set(before[k])<=set(after[k])for k in before if k!='recorder'};same['recorder']=before['recorder']==after['recorder'];state=services();other=all(state[n]['started_at']==row['services_before'][n]['started_at']for n in SERVICES if n!='homeassistant')
   result={'state':'observed','fresh_expected_native_proof':fresh,'registry_prior_ids_preserved':same,'other_six_service_starts_unchanged':other,'same_image':state['homeassistant']['image']==m['expected_image'],'HA_running':state['homeassistant']['running'],'HA_health':state['homeassistant']['health'],'real_MCP_acceptance_required':True,'functional_recovery_proven':False,'automatic_retry':False}
   baselines(m,'after')
   if fresh and other and all(same.values())and row['activation_attempted']and state['homeassistant']['started_at']!=row['services_before']['homeassistant']['started_at']and state['homeassistant']['image']==m['expected_image']and state['homeassistant']['running']and state['homeassistant']['health']=='healthy':
    row.update(state='native_proof_and_preservation_verified_actual_MCP_pending',services_restarted=1,at=time.time());save(row)
   atomic(STATE/('observation-'+str(time.time_ns())+'.json'),raw(result));print(json.dumps(result));return
  if action=='preflight':
   need(not STATE.exists(),'existing_upgrade_intent_requires_reconciliation');baselines(m,'before');ss=services();need(all(v['running']and v['health']in('healthy','none')for v in ss.values())and ss['homeassistant']['image']==m['expected_image'],'services_not_ready');h.root_backend();print(json.dumps({'state':'preflight_passed','targets':len(TARGETS),'new_MCP_tools':0,'HA_restarts_planned':1,'expires_at':EXPIRY,'production_changes':False}));return
  if action=='apply':
   need(not STATE.exists(),'existing_upgrade_intent_requires_reconciliation');before=baselines(m,'before');ss=services();need(all(v['running']and v['health']in('healthy','none')for v in ss.values())and ss['homeassistant']['image']==m['expected_image'],'services_not_ready');historical=h.historical_receipts();ids=identities();h.directory(STATE,0o700);h.directory(STATE/'before',0o700);h.directory(BUNDLE,0o700)
   # Durable Root-owned recovery bundle survives loss of /run. No credentials.
   for name in ['MANIFEST.json','upgrade.py','sealed_helpers.py',*TARGETS]:atomic(BUNDLE/name,read(STAGE/name,0,0o644),mode=0o644)
   row={'state':'intent_before_source_install','operation_id':m['operation_id'],'manifest_sha256':MANIFEST_SHA,'at':time.time(),'expires_at':EXPIRY,'activation_attempted':False,'services_before':ss,'identities_before':ids,'historical_receipts':historical,'automatic_retry':False};atomic(STATE/'source-install-intent.json',raw(row));save(row)
   for name,b in before.items():
    if b is not None:atomic(STATE/'before'/name,b)
   atomic(STATE/'before'/'native-proof.json',read(HA/'.mcp-icloud-proof.json',0,0o600,8192))
   for name,p in TARGETS.items():
    meta=m['targets'][name]
    if meta['before']is None:need(not os.path.lexists(p),'unexpected_target_before_write')
    else:need(sha(read(p,meta['uid'],meta['mode']))==meta['before'],'target_changed_before_write')
    atomic(p,data[name],meta['uid'],meta['gid'],meta['mode'])
   baselines(m,'after');h.chains();h.root_backend();need(h.historical_receipts()==historical,'historical_receipts_changed');row.update(state='source_installed_activation_not_attempted',at=time.time(),services_restarted=0);save(row);print(json.dumps({'state':row['state'],'operation_id':m['operation_id'],'services_restarted':0,'new_MCP_tools':0,'expires_at':EXPIRY}));return
  if action=='activate':
   row=json.loads(read(STATE/'receipt.json',0,0o600));need(row['state']=='source_installed_activation_not_attempted'and row['activation_attempted']is False,'activation_requires_reconciliation');baselines(m,'after');ss=services();need(ss['homeassistant']['started_at']==row['services_before']['homeassistant']['started_at'],'HA_already_restarted_requires_reconciliation');need(not(STATE/'activation-intent.json').exists(),'activation_intent_requires_reconciliation');row.update(state='intent_before_one_HA_restart',activation_attempted=True,at=time.time());atomic(STATE/'activation-intent.json',raw({k:row[k]for k in ['state','operation_id','at','activation_attempted','automatic_retry']}));save(row)
   run(['/usr/bin/docker','restart','--time','30','homeassistant'],75);after=services();need(after['homeassistant']['running']and after['homeassistant']['started_at']!=ss['homeassistant']['started_at'],'HA_restart_unconfirmed');need(all(after[n]['started_at']==ss[n]['started_at']for n in SERVICES if n!='homeassistant'),'other_service_restart_observed');row.update(state='HA_restarted_natural_native_and_MCP_acceptance_pending',services_restarted=1,services_after=after,at=time.time());save(row);print(json.dumps({'state':row['state'],'services_restarted':1,'other_six_service_starts_unchanged':True,'real_MCP_acceptance_required':True,'automatic_retry':False}));return
  if action=='rollback':
   row=json.loads(read(STATE/'receipt.json',0,0o600));need(not (STATE/'rollback-intent.json').exists(),'rollback_requires_reconciliation')
   # Validate every target and backup before restoring any byte. A partial apply
   # accepts only known before/after hashes; an external edit still stops closed.
   restore={};present={}
   for name,p in TARGETS.items():
    meta=m['targets'][name]
    if os.path.lexists(p):
     current=read(p,meta['uid'],meta['mode']);present[name]=sha(current)
     need(present[name]in(meta['before'],meta['after']),'unknown_target_requires_reconciliation')
    else:present[name]=None;need(meta['before']is None,'required_target_missing')
    if meta['before']is None or present[name]==meta['before']:restore[name]=None
    else:
     old=read(STATE/'before'/name,0,0o600);need(sha(old)==meta['before'],'rollback_backup_changed');restore[name]=old
   ss=services();old_start=row['services_before']['homeassistant']['started_at']
   need(ss['homeassistant']['running']and ss['homeassistant']['image']==m['expected_image'],'HA_state_requires_reconciliation')
   need(all(ss[n]['started_at']==row['services_before'][n]['started_at']for n in SERVICES if n!='homeassistant'),'other_service_changed_requires_reconciliation')
   # An uncertain activation must be reconciled from the actual running process.
   restart_needed=ss['homeassistant']['started_at']!=old_start
   need(row['activation_attempted']or not restart_needed,'external_HA_restart_requires_reconciliation')
   atomic(STATE/'rollback-intent.json',raw({'at':time.time(),'restart_required':restart_needed,'reconciled_start':ss['homeassistant']['started_at'],'automatic_retry':False}))
   for name,p in TARGETS.items():
    meta=m['targets'][name]
    if present[name]==meta['before']:continue
    need(sha(read(p,meta['uid'],meta['mode']))==present[name],'target_changed_during_rollback')
    if restore[name]is None:p.unlink();sync(p.parent)
    else:atomic(p,restore[name],meta['uid'],meta['gid'],meta['mode'])
   baselines(m,'before');h.chains();h.root_backend()
   if restart_needed:run(['/usr/bin/docker','restart','--time','30','homeassistant'],75)
   row.update(state='rolled_back_once',rollback_at=time.time(),rollback_services_restarted=int(restart_needed));save(row);print(json.dumps({'state':row['state'],'rollback_services_restarted':int(restart_needed),'automatic_retry':False}));return
  raise ValueError('fixed_action_required')
if __name__=='__main__':
 try:
  need(Path(__file__)==STAGE/'upgrade.py'and sys.argv[1:]in([a]for a in ['preflight','apply','activate','observe','rollback']),'fixed_entrypoint_required');main(sys.argv[1])
 except Exception as exc:
  print(json.dumps({'state':'unconfirmed','exception_kind':type(exc).__name__,'reason':str(exc)if type(exc)is ValueError else'withheld','automatic_retry':False}));raise SystemExit(1)
