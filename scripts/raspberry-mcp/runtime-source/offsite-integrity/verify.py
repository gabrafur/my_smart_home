"""One exact new-artifact authentication; no generation, restore or service control."""
import datetime,fcntl,hashlib,json,os,re,resource,shutil,stat,subprocess,sys,time
from pathlib import Path
BASE=Path('/run/raspberry-offsite-integrity-reconciliation-binding')
ROOT=Path('/var/lib/raspberry-offsite-integrity-operation-binding/stdin-recovery-r2')
EXPIRY=1793048374+764524/1000000
SAFE_CRYPTO_PROJECTOR=None
OPERATION_DEADLINE=None
CLEANING_UP=False
RECEIPT={};MANIFEST={};SEALED={}
SERVICES=('homeassistant','nodered','mosquitto','portainer','appdaemon','matter_server','zigbee2mqtt')
LABEL='smart-home.offsite-integrity.operation'
def need(value,reason):
 if not value:raise ValueError(reason)
def file(path,limit=1048576):
 need(limit<=1048576,'metadata_limit')
 fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
 try:
  st=os.fstat(fd);need(stat.S_ISREG(st.st_mode)and st.st_uid==1001 and stat.S_IMODE(st.st_mode)==0o600 and st.st_nlink==1 and st.st_size<=limit,'unsafe_fixed_file');raw=os.read(fd,limit+1);need(len(raw)<=limit,'input_limit');return raw
 finally:os.close(fd)
def sealed_file(path,limit=1048576):
 need(limit<=1048576,'sealed_metadata_limit')
 for parent in path.parents:
  info=parent.lstat();need(stat.S_ISDIR(info.st_mode)and info.st_uid==0 and not info.st_mode&0o022,'unsafe_sealed_parent')
 fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
 try:
  info=os.fstat(fd);need(stat.S_ISREG(info.st_mode)and info.st_uid==0 and stat.S_IMODE(info.st_mode)==0o644 and info.st_nlink==1 and info.st_size<=limit,'unsafe_sealed_file');raw=os.read(fd,limit+1);need(len(raw)<=limit,'sealed_input_limit');return raw
 finally:os.close(fd)
def load_projector():
 import importlib.util
 spec=importlib.util.spec_from_file_location('sealed_crypto_diagnostic',BASE/'crypto_diagnostic.py');module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module.project
def recovery_guard():
 import importlib.util
 spec=importlib.util.spec_from_file_location('sealed_recovery_guard',BASE/'recovery_guard.py');module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module

def record(phase,**extra):
 RECEIPT.update(operation_id=MANIFEST['operation_id'],reconciliation_revision='stdin_r2',original_receipt_sha256='ORIGINAL_RECEIPT_SHA256_BINDING',phase=phase,observed_at=datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds'),automatic_retry=False,**extra)
 target=ROOT/'receipt.json';tmp=ROOT/'receipt.new';fd=os.open(tmp,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
 with os.fdopen(fd,'w')as stream:json.dump(RECEIPT,stream,sort_keys=True);stream.write('\n');stream.flush();os.fsync(stream.fileno())
 os.replace(tmp,target);directory=os.open(ROOT,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
 try:os.fsync(directory)
 finally:os.close(directory)
def run(args,timeout=15,input=None,parse=False):
 if OPERATION_DEADLINE is not None:
  remaining=EXPIRY-time.time()if CLEANING_UP else min(OPERATION_DEADLINE-time.monotonic(),EXPIRY-time.time()-180)
  need(remaining>0,'operation_deadline_reached');timeout=min(timeout,remaining)
 result=subprocess.run(args,capture_output=True,input=input,timeout=timeout)
 need(len(result.stdout)<=65536 and len(result.stderr)<=65536,'child_output_limit')
 if result.returncode:
  # Child outputs can contain names or secrets. Export only an enumerated stage.
  diagnostic={'stage':RECEIPT.get('phase'),'returncode':result.returncode,'stdout_bytes':len(result.stdout),'stderr_bytes':len(result.stderr)}
  if args[-1:]==[str(BASE/'download_backup.cjs')]:
   try:
    value=json.loads(result.stdout);v=value.get('diagnostic',{});stages={'not_started','inventory','request','headers','streaming','verify_length','fsync','completed'}
    if v.get('stage')in stages:
     diagnostic['download_stage']=v['stage']
     for key in ('bytes_received','bytes_written','expected_bytes','elapsed_ms','http_status'):
      if v.get(key)is None or type(v.get(key))is int and 0<=v[key]<=2**40:diagnostic[key]=v.get(key)
     if isinstance(v.get('reason'),str)and re.fullmatch('[a-z_]{1,60}',v['reason']):diagnostic['reason']=v['reason']
   except (ValueError,TypeError,AttributeError):pass
  if RECEIPT.get('phase')=='authentication_intent'and args[:3]==['docker','start','--attach']and SAFE_CRYPTO_PROJECTOR is not None:
   diagnostic['authentication']=SAFE_CRYPTO_PROJECTOR(result.stdout,result.returncode)
  if RECEIPT:record('child_failed',child_failure=diagnostic)
  raise ValueError('fixed_child_failed')
 return json.loads(result.stdout)if parse else result.stdout

def cipher_hash(path):
 fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
 try:
  before=os.fstat(fd);need(stat.S_ISREG(before.st_mode)and before.st_uid==1001 and before.st_nlink==1 and stat.S_IMODE(before.st_mode)==0o600 and before.st_size==MANIFEST['encrypted_size_bytes'],'download_file_identity_changed')
  digest=hashlib.sha256();total=0
  while chunk:=os.read(fd,65536):
   total+=len(chunk);need(total<=MANIFEST['encrypted_size_bytes'],'download_size_changed');digest.update(chunk)
  after=os.fstat(fd);need(total==MANIFEST['encrypted_size_bytes']and(before.st_dev,before.st_ino,before.st_size,before.st_mtime_ns,before.st_ctime_ns)==(after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns,after.st_ctime_ns),'download_changed_during_hash')
  return digest.hexdigest()
 finally:os.close(fd)

def sources():
 for name,sha in SEALED.items():need(hashlib.sha256(sealed_file(BASE/name)).hexdigest()==sha,'sealed_source_changed')
def service_state():
 output={}
 for name in SERVICES:
  row=run(['docker','inspect','--format','{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}} {{.State.StartedAt}}',name]).decode().strip().split()
  need(len(row)==3 and row[0]=='running'and row[1]in('healthy','none'),'production_service_not_ready')
  output[name]={'running':True,'health':row[1],'started_at':row[2]}
 return output

def disk_preflight():
 disk=shutil.disk_usage(ROOT.parent);need(disk.free>=2*1024**3 and disk.used/disk.total<.85,'insufficient_disk_headroom')

def preflight():
 global MANIFEST,SEALED,SAFE_CRYPTO_PROJECTOR
 need(Path(__file__)==BASE/'verify.py'and os.geteuid()==1001 and len(sys.argv)==2 and re.fullmatch('[a-f0-9]{64}',sys.argv[1]),'fixed_nonroot_manifest_command_required')
 raw=sealed_file(BASE/'MANIFEST.json');need(hashlib.sha256(raw).hexdigest()==sys.argv[1],'manifest_changed');MANIFEST=json.loads(raw);SEALED=MANIFEST['files'];sources()
 need(not os.path.lexists(ROOT),'existing_operation_requires_readonly_reconciliation')
 guard=recovery_guard();guard.original();guard.approval(sys.argv[1])
 need(time.time()+1200<EXPIRY,'existing_lease_completion_margin');SAFE_CRYPTO_PROJECTOR=load_projector()
 key_preflight=run(['/usr/bin/sudo','-n','-u','CODEX_DEDICATED_USER_BINDING','/usr/bin/sudo','-n','/usr/bin/python3','-I','-S','-B',str(BASE/'native_key_reader.py'),'preflight'],parse=True);need(key_preflight.get('key_read')is False and key_preflight.get('state')=='native_key_source_metadata_verified_not_read','native_key_preflight_unconfirmed')
 mem=dict(line.split(':',1)for line in Path('/proc/meminfo').read_text().splitlines());need(int(mem['MemAvailable'].split()[0])*1024>=2*1024**3,'insufficient_available_memory')
 disk_preflight()
 need(run(['docker','inspect','--format','{{.Image}}','homeassistant']).decode().strip()==MANIFEST['image'],'reviewed_image_changed')
 registry=json.loads(file(Path('/mnt/data/docker/.local-secrets/offsite-backup-retention.json')))
 matches=[row for row in registry['entries']if hashlib.sha256(row['backup_id'].encode()).hexdigest()==MANIFEST['artifact_id_sha256']]
 need(len(matches)==1 and matches[0]['backup_timestamp']==MANIFEST['artifact_timestamp']and matches[0]['size_bytes']==MANIFEST['encrypted_size_bytes']and matches[0]['protected']is True,'exact_registry_artifact_changed')
 need(not list(Path('/mnt/data/docker/homeassistant/.daily-update-trigger').glob('*processing'))and not list(Path('/mnt/data/docker/homeassistant/.git-backup-trigger').glob('*processing')),'native_worker_processing')
 return service_state()

def cleanup_container():
 name='offsite-integrity-'+MANIFEST['operation_id'];result=subprocess.run(['docker','inspect','--format','{{json .Config.Labels}} {{.Image}}',name],capture_output=True,timeout=10)
 if result.returncode:
  # A fixed name that does not exist needs no mutation. Other errors are unknown.
  need(result.returncode==1 and b'No such object:'in result.stderr and len(result.stderr)<=4096,'container_cleanup_unconfirmed');return
 labels,image=result.stdout.decode().strip().rsplit(' ',1);need(json.loads(labels).get(LABEL)==MANIFEST['operation_id']and image==MANIFEST['image'],'cleanup_identity_changed')
 run(['docker','rm','--force',name],timeout=20)

def verify_container_input(cid):
 config=run(['docker','inspect','--format','{{json .Config}}',cid],parse=True)
 need(config.get('OpenStdin')is True and config.get('Tty')is False and config.get('User')=='1001:1001','container_input_transport_unconfirmed')
 return True

def main():
 global OPERATION_DEADLINE,CLEANING_UP
 OPERATION_DEADLINE=time.monotonic()+1020
 lock=os.open('/mnt/data/docker/.daily-maintenance.lock',os.O_WRONLY|os.O_NOFOLLOW)
 try:
  fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB);before=preflight();ROOT.mkdir(mode=0o700);record('prepared',manifest_sha256=sys.argv[1],before_services=before,old_R5_repeated=False,production_changes=False)
  failure=None
  try:
   record('download_intent');proof=run(['/usr/bin/node','--max-old-space-size=64',str(BASE/'download_backup.cjs')],timeout=630,parse=True)
   need(proof.get('encrypted_bytes')==MANIFEST['encrypted_size_bytes']and proof.get('backup_id_sha256')==MANIFEST['artifact_id_sha256']and proof.get('downloads')==1,'download_identity_unconfirmed')
   need(proof.get('encrypted_sha256')==recovery_guard().CIPHER_SHA,'original_cipher_hash_mismatch');record('encrypted_download_verified',download=proof);sources()
   target=ROOT/'backup.tar';need(cipher_hash(target)==proof['encrypted_sha256'],'download_hash_changed')
   name='offsite-integrity-'+MANIFEST['operation_id'];record('container_create_intent',container_name=name)
   cid=run(['docker','create','--interactive','--pull=never','--name',name,'--label',LABEL+'='+MANIFEST['operation_id'],'--network','none','--user','1001:1001','--cap-drop','ALL','--security-opt','no-new-privileges','--read-only','--pids-limit','8','--cpus','0.15','--ulimit','core=0:0','--tmpfs','/tmp:rw,noexec,nosuid,nodev,size=16777216,mode=1777','--mount','type=bind,source='+str(BASE/'authenticate.py')+',target=/review/authenticate.py,readonly','--mount','type=bind,source='+str(target)+',target=/input/backup.tar,readonly','--entrypoint','python',MANIFEST['image'],'-I','-B','/review/authenticate.py'],timeout=30).decode().strip()
   need(re.fullmatch('[a-f0-9]{64}',cid)is not None,'container_identity_unconfirmed');record('container_created',container_id_sha256=hashlib.sha256(cid.encode()).hexdigest())
   verify_container_input(cid);record('container_input_verified',container_stdin_open=True,container_tty=False)
   record('existing_key_read_intent');secret=run(['/usr/bin/sudo','-n','-u','CODEX_DEDICATED_USER_BINDING','/usr/bin/sudo','-n','/usr/bin/python3','-I','-S','-B',str(BASE/'native_key_reader.py')],timeout=15);need(0<len(secret)<=8192,'key_input_limit')
   record('authentication_intent')
   try:auth=run(['docker','start','--attach','--interactive',cid],timeout=510,input=secret,parse=True)
   finally:secret=None
   need(auth.get('authenticated')is True and auth.get('securetar_version')==3 and auth.get('archive_extracted')is False and auth.get('payloads_executed')is False,'authentication_unconfirmed')
   record('full_stream_authenticated',authentication=auth)
  except Exception as exc:
   failure=type(exc).__name__;record('failed_reconciliation_required',exception_kind=failure,raw_error_withheld=True)
  finally:
   CLEANING_UP=True
   try:
    cleanup_container()
    target=ROOT/'backup.tar'
    if os.path.lexists(target):
     st=target.lstat();need(stat.S_ISREG(st.st_mode)and st.st_uid==1001 and st.st_nlink==1 and stat.S_IMODE(st.st_mode)==0o600,'cleanup_file_identity_changed');target.unlink()
    after=service_state();record('verified_cleaned'if failure is None else'failed_cleaned',private_copy_removed=True,disposable_container_removed=True,after_services=after,service_start_times_unchanged=before==after,payloads_executed=False,services_restarted=0,new_backup_generated=False,remote_retention_changed=False,new_artifact_integrity_proven=failure is None,restored_services_proven=False)
   except Exception as exc:
    failure='cleanup_requires_reconciliation';record(failure,exception_kind=type(exc).__name__,raw_error_withheld=True)
  print(json.dumps(RECEIPT,sort_keys=True));return 0 if failure is None else 1
 finally:os.close(lock)
if __name__=='__main__':
 try:raise SystemExit(main())
 except Exception as exc:print(json.dumps({'state':'incomplete','exception_kind':type(exc).__name__,'raw_error_withheld':True,'automatic_retry':False}));raise SystemExit(1)
