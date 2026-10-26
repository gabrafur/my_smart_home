"""Reviewed fixed readonly MCP expansion; approval required before install."""
import ast,datetime,fcntl,hashlib,importlib.util,json,os,stat,subprocess,sys,time
from pathlib import Path
STAGE=Path('/__OPERATOR_STAGE__/nodered-readonly');STATE=Path('/var/lib/raspberry-nodered-diagnostics');BUNDLE=STATE/'bundle'
if Path(__file__)==BUNDLE/'install.py':STAGE=BUNDLE
EXPIRY=0;PIN='0000000000000000000000000000000000000000000000000000000000000000'
ROOT=Path('/usr/local/lib/raspberry-nodered-diagnostics');REPAIR=Path('/usr/local/lib/raspberry-repair-control')
MODULES=['collector.cjs','ha-collector.cjs','nodered_model.cjs','virtual-resources.cjs','kia_model.cjs','root_snapshot.py','sidecar.cjs','config.json']
TARGETS={**{n:ROOT/n for n in MODULES},'runtime_client.py':REPAIR/'nodered_runtime.py','repair-broker.py':REPAIR/'repair-broker.py','repair-policy.json':REPAIR/'policy.json','raspberry-nodered-diagnostics.socket':Path('/etc/systemd/system/raspberry-nodered-diagnostics.socket'),'raspberry-nodered-diagnostics.service':Path('/etc/systemd/system/raspberry-nodered-diagnostics.service'),'raspberry-nodered-diagnostics.conf':Path('/etc/tmpfiles.d/raspberry-nodered-diagnostics.conf')}
def need(v,r):
 if not v:raise ValueError(r)
def sha(b):return hashlib.sha256(b).hexdigest()
def raw(v):return(json.dumps(v,sort_keys=True,indent=2)+'\n').encode()
def read(p,mode=0o644):
 for q in p.parents:need(q.is_dir()and not q.is_symlink(),'unsafe_parent')
 fd=os.open(p,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
 try:
  s=os.fstat(fd);need(stat.S_ISREG(s.st_mode)and s.st_uid==0 and stat.S_IMODE(s.st_mode)==mode and s.st_nlink==1 and s.st_size<=1048576,'unsafe_fixed_file');b=os.read(fd,1048577);need(len(b)<=1048576,'source_limit');return b
 finally:os.close(fd)
def sync(p):
 fd=os.open(p,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
 try:os.fsync(fd)
 finally:os.close(fd)
def atomic(p,b,mode=0o644):
 t=p.with_name('.'+p.name+'.readonly-new');fd=os.open(t,os.O_CREAT|os.O_EXCL|os.O_WRONLY|os.O_NOFOLLOW,mode)
 try:
  os.fchmod(fd,mode)
  with os.fdopen(os.dup(fd),'wb')as f:f.write(b);f.flush();os.fsync(f.fileno())
 finally:os.close(fd)
 os.replace(t,p);sync(p.parent)
def command(argv,timeout=10):
 r=subprocess.run(argv,capture_output=True,timeout=timeout);need(r.returncode==0,'fixed_command_unconfirmed');return r.stdout

def load():
 b=read(STAGE/'MANIFEST.json');need(sha(b)==PIN,'manifest_changed');m=json.loads(b)
 need(m['revision']=='r1'and m['install_expires_at']==EXPIRY and m['read_scope_until_revoked']is True and m['new_OS_accounts']==m['new_long_lived_credentials']==m['new_MCP_tools']==m['household_effects']==0 and set(m['targets'])==set(TARGETS),'scope_changed');after={}
 for n,p in TARGETS.items():
  row=m['targets'][n];need(row['path']==str(p),'target_changed');after[n]=read(STAGE/n);need(sha(after[n])==row['after'],'candidate_changed')
 return m,after
def helper():
 p=STAGE/'sealed_helpers.py';need(sha(read(p))=='0000000000000000000000000000000000000000000000000000000000000000','helper_changed');s=importlib.util.spec_from_file_location('readonly_source_helpers',p);h=importlib.util.module_from_spec(s);s.loader.exec_module(h);return h
def baseline(m,which):
 for n,p in TARGETS.items():
  row=m['targets'][n]
  if row[which]is None:need(not os.path.lexists(p),'unexpected_target')
  else:need(sha(read(p))==row[which],'target_baseline_changed')
def save(row):atomic(STATE/'receipt.json',raw(row),0o600)
def public_reference_root_directory(h):
 # Reference adaptation: mkdir can be reduced to0750 by an inherited umask.
 # chmod only a newly created directory, then verify with the sealed helper.
 if not os.path.lexists(ROOT):
  ROOT.mkdir(mode=0o755);os.chmod(ROOT,0o755)
 h.directory(ROOT,0o755)

def main(action):
 m,after=load();need(os.geteuid()==0,'Root_required')
 if action=='status':
  out={'source':'fixed_readonly_extension_state','observed_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'receipt':json.loads(read(STATE/'receipt.json',0o600))if(STATE/'receipt.json').exists()else None,'automatic_retry':False};print(json.dumps(out));return
 need(time.time()+90<EXPIRY and not os.path.lexists('/var/lib/raspberry-admin-executor/revoked')and not os.path.lexists(STATE/'revoked'),'valid_existing_admission_required');h=helper();tasks=h.chains()
 with h.locks(tasks):
  if action=='preflight':
   need(not STATE.exists(),'existing_intent_requires_reconciliation');baseline(m,'before');command(['/usr/bin/systemd-analyze','verify',str(STAGE/'raspberry-nodered-diagnostics.service'),str(STAGE/'raspberry-nodered-diagnostics.socket')]);print(json.dumps({'state':'preflight_passed_not_installed','targets':len(TARGETS),'requires_specific_scope_approval':True,'production_changes':False}));return
  if action=='install-approved':
   need(not STATE.exists(),'existing_intent_requires_reconciliation');baseline(m,'before');h.directory(STATE,0o755);h.directory(STATE/'before',0o700);h.directory(BUNDLE,0o700);public_reference_root_directory(h)
   before={n:read(p)if m['targets'][n]['before']is not None else None for n,p in TARGETS.items()}
   for n,b in before.items():
    if b is not None:atomic(STATE/'before'/n,b,0o600)
   for n in ['install.py','MANIFEST.json','sealed_helpers.py',*TARGETS]:atomic(BUNDLE/n,read(STAGE/n))
   row={'operation_id':m['operation_id'],'manifest_sha256':PIN,'state':'intent_before_install','observed_at':time.time(),'activation_attempted':False,'automatic_retry':False};atomic(STATE/'install-intent.json',raw(row),0o600);save(row)
   for n,p in TARGETS.items():
    expected=m['targets'][n]['before'];need((not os.path.lexists(p))if expected is None else sha(read(p))==expected,'target_changed_before_write');atomic(p,after[n])
   baseline(m,'after');h.chains();row.update(state='installed_socket_not_activated',observed_at=time.time());save(row);print(json.dumps(row));return
  if action=='activate-approved':
   row=json.loads(read(STATE/'receipt.json',0o600));need(row['state']=='installed_socket_not_activated'and not row['activation_attempted']and not(STATE/'activation-intent.json').exists(),'activation_requires_reconciliation');baseline(m,'after');row.update(state='intent_before_socket_activation',activation_attempted=True,observed_at=time.time());atomic(STATE/'activation-intent.json',raw(row),0o600);save(row)
   command(['/usr/bin/systemd-tmpfiles','--create','/etc/tmpfiles.d/raspberry-nodered-diagnostics.conf']);command(['/usr/bin/systemctl','daemon-reload']);command(['/usr/bin/systemctl','enable','--now','raspberry-nodered-diagnostics.socket']);command(['/usr/bin/systemctl','is-active','raspberry-nodered-diagnostics.socket']);row.update(state='socket_active_actual_MCP_acceptance_pending',observed_at=time.time());save(row);print(json.dumps(row));return
  if action=='rollback':
   row=json.loads(read(STATE/'receipt.json',0o600));need(not(STATE/'rollback-intent.json').exists(),'rollback_requires_reconciliation');restore={};current={}
   for n,p in TARGETS.items():
    meta=m['targets'][n];current[n]=sha(read(p))if os.path.lexists(p)else None;need(current[n]in(meta['before'],meta['after']),'unknown_target_requires_reconciliation')
    if meta['before']is not None and current[n]!=meta['before']:
     restore[n]=read(STATE/'before'/n,0o600);need(sha(restore[n])==meta['before'],'backup_changed')
   atomic(STATE/'rollback-intent.json',raw({'at':time.time(),'automatic_retry':False}),0o600)
   if row['activation_attempted']:
    command(['/usr/bin/systemctl','disable','--now','raspberry-nodered-diagnostics.socket']);command(['/usr/bin/systemctl','stop','raspberry-nodered-diagnostics.service'])
   for n,p in TARGETS.items():
    meta=m['targets'][n]
    if current[n]==meta['before']:continue
    need(sha(read(p))==current[n],'target_changed_during_rollback')
    if meta['before']is None:p.unlink();sync(p.parent)
    else:atomic(p,restore[n])
   command(['/usr/bin/systemctl','daemon-reload']);baseline(m,'before');h.chains();row.update(state='rolled_back_no_household_restart',observed_at=time.time());save(row);print(json.dumps(row));return
  raise ValueError('fixed_action_required')
if __name__=='__main__':
 try:
  need(Path(__file__)==STAGE/'install.py'and sys.argv[1:]in([a]for a in ['preflight','install-approved','activate-approved','status','rollback']),'fixed_entrypoint_required');main(sys.argv[1])
 except Exception as e:print(json.dumps({'state':'unconfirmed','exception_class':type(e).__name__,'reason':str(e)if type(e)is ValueError else'withheld','automatic_retry':False}));raise SystemExit(1)
