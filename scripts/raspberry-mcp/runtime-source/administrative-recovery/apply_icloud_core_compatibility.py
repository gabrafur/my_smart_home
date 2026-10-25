import datetime,fcntl,hashlib,json,os,stat,subprocess,sys,time
from pathlib import Path
STAGE=Path('/run/raspberry-icloud-core-compatibility-20261025')
STATE=Path('/var/lib/raspberry-icloud-core-compatibility-20261025')
REPO=Path('/mnt/data/docker')
MANIFEST_SHA='${APPROVED_OPERATOR_MANIFEST_SHA256}'
NAMES=('device_owner.py','upstream.json','release_identity.py','docker-auto-update.mjs','custom-integration-compatibility.mjs','icloud-image-preflight.py')
HA=REPO/'homeassistant'
def need(value,reason):
 if not value:raise ValueError(reason)
def raw(p):
 need(p.absolute()==p and all(not a.is_symlink()for a in [p,*p.parents]),'symlink_refused')
 fd=os.open(p,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
 try:
  st=os.fstat(fd);need(stat.S_ISREG(st.st_mode)and st.st_nlink==1 and st.st_size<=1048576,'file_shape_refused');return os.read(fd,1048577)
 finally:os.close(fd)
def sha(p):return hashlib.sha256(raw(p)).hexdigest()
def sealed():
 need(os.geteuid()==0 and Path(__file__).parent==STAGE and not sys.argv[1:],'fixed_root_entrypoint_required')
 need(time.time()<(1792941922+2443945/10000000),'administrative_lease_expired')
 need(sha(STAGE/'MANIFEST.json')==MANIFEST_SHA,'manifest_changed');m=json.loads(raw(STAGE/'MANIFEST.json'));need(set(m['files'])==set(NAMES),'target_set_changed')
 for name,item in m['files'].items():
  expected=('scripts/'if name in NAMES[3:]else'homeassistant/custom_components/icloud/')+name;need(item['target']==expected,'target_changed');need(sha(STAGE/name)==item['after_sha256'],'candidate_changed')
 return m
def run(args):return subprocess.run(args,check=True,capture_output=True,text=True,timeout=90)
def container():return json.loads(run(['/usr/bin/docker','inspect','homeassistant','--format','{{json .}}']).stdout)
def storage():
 out={}
 for name in ('core.entity_registry','core.device_registry','core.config_entries'):
  p=HA/'.storage'/name;out[name]=sha(p)
 p=HA/'home-assistant_v2.db';st=p.stat();out['recorder']={'inode':st.st_ino,'device':st.st_dev,'size':st.st_size};return out
def atomic(p,data,uid=0,gid=0,mode=0o600):
 tmp=p.with_name(p.name+'.icloud-compat-tmp-'+str(os.getpid()));fd=os.open(tmp,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,mode)
 try:
  os.fchown(fd,uid,gid);os.fchmod(fd,mode)
  with os.fdopen(fd,'wb')as f:f.write(data);f.flush();os.fsync(f.fileno())
  os.replace(tmp,p);fd=os.open(p.parent,os.O_RDONLY|os.O_DIRECTORY)
  try:os.fsync(fd)
  finally:os.close(fd)
 finally:
  if tmp.exists():tmp.unlink()
def save(row):atomic(STATE/'receipt.json',(json.dumps(row,sort_keys=True)+'\n').encode())
def main():
 m=sealed();lock=os.open(REPO/'.daily-maintenance.lock',os.O_WRONLY|os.O_NOFOLLOW)
 try:
  fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB);need(not list((HA/'.daily-update-trigger').glob('*processing')),'native_worker_processing')
  need(not STATE.exists(),'existing_intent_requires_readonly_reconciliation')
  for name,item in m['files'].items():need(sha(REPO/item['target'])==item['before_sha256'],'live_source_changed')
  before=container();need(before['State']['Running']and before['Image']==m['expected_image'],'container_identity_changed');preserved=storage()
  os.mkdir(STATE,0o700);os.mkdir(STATE/'before',0o700)
  row={'operation_id':m['operation_id'],'manifest_sha256':MANIFEST_SHA,'phase':'source_install_intent','activation_attempted':False,'before_started_at':before['State']['StartedAt'],'before_image':before['Image'],'storage_before':preserved,'updated_at':datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds'),'automatic_retry':False};save(row)
  for name in NAMES:atomic(STATE/'before'/name,raw(REPO/m['files'][name]['target']))
  for name in ('.mcp-icloud-activation.json','.mcp-icloud-proof.json'):
   if (HA/name).exists():atomic(STATE/'before'/name,raw(HA/name))
  for name,item in m['files'].items():atomic(REPO/item['target'],raw(STAGE/name),item['after_uid'],item['after_gid'],item['mode'])
  request={'schema_version':1,'operation_id':m['operation_id'],'release_revision':m['release_revision']};atomic(HA/'.mcp-icloud-activation.json',(json.dumps(request)+'\n').encode(),0,0,0o644)
  need(all(sha(REPO/i['target'])==i['after_sha256']for i in m['files'].values()),'installed_source_unconfirmed');need(storage()==preserved,'storage_changed_during_source_install')
  row.update(phase='source_installed_activation_not_attempted',production_configuration_modified=False,account_credentials_modified=False,services_restarted=0);save(row);print(json.dumps({k:row[k]for k in ('operation_id','phase','services_restarted','automatic_retry')}))
 finally:os.close(lock)
if __name__=='__main__':
 try:main()
 except Exception as exc:print(json.dumps({'state':'unconfirmed','exception_kind':type(exc).__name__,'reason':str(exc)if type(exc)is ValueError else'withheld','automatic_retry':False}));raise SystemExit(1)
