"""Fixed native contract upgrade. No caller paths, commands, retries or new tools."""
import datetime,hashlib,importlib.util,json,os,stat,subprocess,sys,time
from pathlib import Path
STAGE=Path('/run/raspberry-procmon-post-budget-capture-20261026')
STATE=Path('/var/lib/raspberry-procmon-post-budget-capture-20261026')
BUNDLE=STATE/'bundle'
if Path(__file__)==BUNDLE/'upgrade.py':STAGE=BUNDLE
EXPIRY=1793138354 + 2133384 / 10_000_000
MANIFEST_SHA='344cad4b3e800f42ee61b98d5e904b924db314c5362d749b6a3db2323075488a'
REPO=Path('/mnt/data/docker');HA=REPO/'homeassistant'
TARGETS={
 'capture.py':Path('/usr/local/lib/raspberry-procmon-acceptance/capture.py'),
 'health_summary.py':Path('/usr/local/lib/raspberry-repair-control/health_summary.py'),
 'raspberry-procmon-acceptance.timer':Path('/etc/systemd/system/raspberry-procmon-acceptance.timer'),
 'repair-policy.json':Path('/usr/local/lib/raspberry-repair-control/policy.json'),
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
 p=STAGE/'sealed_helpers.py';need(sha(read(p,0,0o644))=='7df4d1f378479f3c03bbd5b4efe7420fb2c5ff4661f357881311380f57f33ebb','historical_helper_changed');s=importlib.util.spec_from_file_location('sealed_readiness_upgrade_helpers',p);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m
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
 need(m['expires_at']==EXPIRY and m['new_MCP_tools']==0 and m['maximum_HA_restarts']==0 and m['maximum_rollback_HA_restarts']==0 and m['new_credentials']==0 and m['budget_changes']is False and set(m['targets'])==set(TARGETS),'manifest_scope_changed');data={}
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
def reports():
 return {str(p):sha(read(p,0,0o644,16384))for p in Path('/var/lib/raspberry-procmon-acceptance').glob('window-*.json')}
def timer_state():
 return run(['/usr/bin/systemctl','show','raspberry-procmon-acceptance.timer','-p','ActiveState','-p','NextElapseUSecRealtime'],5).decode()
def main(action):
 m,data=load();gate();h=helper();tasks=h.chains()
 with h.locks(tasks):
  if action=='preflight':
   need(not STATE.exists(),'existing_intent_requires_reconciliation');before=baselines(m,'before')
   expected=json.loads(before['repair-policy.json']);expected['source_hashes']['health_summary.py']=sha(data['health_summary.py'])
   for name in ['capture.py','raspberry-procmon-acceptance.timer']:expected['dependencies'][str(TARGETS[name])]=sha(data[name])
   need(expected==json.loads(data['repair-policy.json']),'policy_authority_or_limits_changed')
   need(reports()==m['reports_before'],'historical_reports_changed');need('ActiveState=active'in timer_state(),'timer_not_active')
   print(json.dumps({'state':'preflight_passed','new_capture':'2026-10-27T23:00:00Z','collector_or_instrumentation_changed':False,'new_access_or_expiry_extension':False}));return
  if action=='apply':
   need(not STATE.exists(),'existing_intent_requires_reconciliation');before=baselines(m,'before');need(reports()==m['reports_before'],'historical_reports_changed');h.directory(STATE,0o700);h.directory(STATE/'before',0o700);h.directory(BUNDLE,0o700)
   for name in ['MANIFEST.json','upgrade.py','sealed_helpers.py',*TARGETS]:atomic(BUNDLE/name,read(STAGE/name,0,0o644),mode=0o644)
   row={'state':'intent_before_readonly_post_budget_window','operation_id':m['operation_id'],'at':time.time(),'automatic_retry':False};save(row)
   for name,b in before.items():atomic(STATE/'before'/name,b)
   for name,p in TARGETS.items():
    need(sha(read(p,0,0o644))==m['targets'][name]['before'],'target_changed_before_write');atomic(p,data[name],mode=0o644)
   baselines(m,'after');h.chains();need(reports()==m['reports_before'],'historical_reports_changed');row.update(state='sources_installed_timer_activation_not_attempted',at=time.time());save(row);print(json.dumps(row));return
  if action=='activate':
   row=json.loads(read(STATE/'receipt.json',0,0o600));need(row['state']=='sources_installed_timer_activation_not_attempted'and not(STATE/'timer-activation-intent.json').exists(),'timer_activation_requires_reconciliation');baselines(m,'after')
   atomic(STATE/'timer-activation-intent.json',raw({'at':time.time(),'automatic_retry':False}));run(['/usr/bin/systemctl','daemon-reload'],10);run(['/usr/bin/systemctl','restart','raspberry-procmon-acceptance.timer'],8)
   actual=timer_state();need('ActiveState=active'in actual and'2026-10-27 23:00:00'in actual,'timer_activation_unconfirmed');need(reports()==m['reports_before'],'historical_reports_changed');row.update(state='post_budget_readonly_capture_armed_natural23UTC_pending',at=time.time(),services_restarted=0,collector_invoked=False,administrative_admission_extended=False);save(row);print(json.dumps(row));return
  if action=='observe':
   baselines(m,'after');need(all(reports().get(k)==v for k,v in m['reports_before'].items()),'historical_reports_changed');print(json.dumps({'state':'observed','historical_reports_unchanged':True,'timer_active':'ActiveState=active'in timer_state(),'new_report_exists':Path('/var/lib/raspberry-procmon-acceptance/window-2300.json').exists(),'collector_invoked':False,'full_goal_accepted':False}));return
  if action=='rollback':
   need(not(STATE/'rollback-intent.json').exists(),'rollback_requires_reconciliation');restore={};present={}
   for name,p in TARGETS.items():
    now=sha(read(p,0,0o644));present[name]=now;need(now in(m['targets'][name]['before'],m['targets'][name]['after']),'external_edit_requires_reconciliation');b=read(STATE/'before'/name,0,0o600);need(sha(b)==m['targets'][name]['before'],'backup_changed');restore[name]=b
   need(all(reports().get(k)==v for k,v in m['reports_before'].items()),'historical_reports_changed');atomic(STATE/'rollback-intent.json',raw({'at':time.time(),'automatic_retry':False}))
   for name,p in TARGETS.items():
    need(sha(read(p,0,0o644))==present[name],'target_changed_during_rollback');atomic(p,restore[name],mode=0o644)
   h.chains();run(['/usr/bin/systemctl','daemon-reload'],10);run(['/usr/bin/systemctl','restart','raspberry-procmon-acceptance.timer'],8);row=json.loads(read(STATE/'receipt.json',0,0o600));row.update(state='rolled_back_once',at=time.time());save(row);print(json.dumps({'state':'rolled_back_post_budget_schedule_prior_reports_preserved','collector_invoked':False,'services_restarted':0,'automatic_retry':False}));return
  raise ValueError('fixed_action_required')
if __name__=='__main__':
 try:
  need(Path(__file__)==STAGE/'upgrade.py'and sys.argv[1:]in([a]for a in ['preflight','apply','activate','observe','rollback']),'fixed_entrypoint_required');main(sys.argv[1])
 except Exception as exc:
  print(json.dumps({'state':'unconfirmed','exception_kind':type(exc).__name__,'reason':str(exc)if type(exc)is ValueError else'withheld','automatic_retry':False}));raise SystemExit(1)
