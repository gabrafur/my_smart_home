"""Fixed authenticated native-file key read into a private parent pipe; never MCP."""
import datetime,hashlib,json,os,resource,signal,stat,sys,time
from pathlib import Path
BASE=Path('/run/raspberry-offsite-integrity-reconciliation-binding')
OPERATION=Path('/var/lib/raspberry-offsite-integrity-operation-binding/stdin-recovery-r2')
STATE=Path('/var/lib/raspberry-offsite-integrity-key-reconciliation-binding')
SOURCE=Path('/mnt/data/docker/homeassistant/.storage/backup')
OP='OPERATION_ID_BINDING'
ARTIFACT='ARTIFACT_ID_SHA256_BINDING'
EXPIRY=1793048374+764524/1000000
SIZE=20480

def need(v,r):
 if not v:raise ValueError(r)
def safe_read(path,owner=0,mode=0o644,limit=1048576,metadata=False):
 directory=os.open('/',os.O_PATH|os.O_DIRECTORY)
 try:
  for part in path.parts[1:-1]:
   fd=os.open(part,os.O_PATH|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=directory);os.close(directory);directory=fd
  fd=os.open(path.name,os.O_RDONLY|os.O_NONBLOCK|os.O_NOFOLLOW,dir_fd=directory)
  try:
   before=os.fstat(fd);need(stat.S_ISREG(before.st_mode)and before.st_uid==owner and stat.S_IMODE(before.st_mode)==mode and before.st_nlink==1 and before.st_size<=limit,'fixed_source_metadata_invalid')
   if metadata:return {'owner_uid':owner,'mode':oct(mode),'size_bytes':before.st_size}
   raw=os.read(fd,limit+1);after=os.fstat(fd);current=os.stat(path.name,dir_fd=directory,follow_symlinks=False)
   need(len(raw)<=limit and(before.st_dev,before.st_ino,before.st_size,before.st_mtime_ns)==(after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns)and(current.st_dev,current.st_ino)==(before.st_dev,before.st_ino),'fixed_source_changed');return raw
  finally:os.close(fd)
 finally:os.close(directory)
def authority(margin):
 sys.path[:0]=['/usr/local/lib/raspberry-task-control','/usr/local/lib/raspberry-mcp']
 import task_control,codex_control
 p,legacy=task_control.policy(codex_control);admin=p.get('admin_delegation',{})
 need(p['enabled']is True and admin.get('enabled')is True and admin.get('dedicated_uid')==977 and admin.get('executor_uid')==1001 and p['expires_at']==admin.get('expires_at')==legacy['expires_at']==EXPIRY,'existing_authority_changed')
 need(time.time()+margin<EXPIRY,'existing_authority_expired')
 for revoked in [BASE/'revoked',Path('/var/lib/raspberry-mcp-operations/task-control/revoked'),Path('/var/lib/raspberry-admin-executor/revoked')]:need(not os.path.lexists(revoked),'existing_authority_revoked')
def manifest():
 for p in(BASE,*BASE.parents):
  s=p.lstat();need(stat.S_ISDIR(s.st_mode)and s.st_uid==0 and not s.st_mode&0o022,'unsafe_sealed_parent')
 raw=safe_read(BASE/'MANIFEST.json');pin=safe_read(BASE/'MANIFEST.sha256').decode().strip();need(hashlib.sha256(raw).hexdigest()==pin,'manifest_changed');m=json.loads(raw)
 need(m['operation_id']==OP and m['artifact_id_sha256']==ARTIFACT and m['encrypted_size_bytes']==SIZE and m['deadline']==('2026-10-26T20:59:34.'+'764524Z'),'artifact_binding_changed')
 for name,digest in m['files'].items():need('/'not in name and hashlib.sha256(safe_read(BASE/name)).hexdigest()==digest,'sealed_source_changed')
 import importlib.util
 spec=importlib.util.spec_from_file_location('sealed_recovery_guard',BASE/'recovery_guard.py');guard=importlib.util.module_from_spec(spec);spec.loader.exec_module(guard);guard.original();guard.original_key();guard.approval(pin)
 return m,pin
def operation_binding(pin):
 s=OPERATION.lstat();need(stat.S_ISDIR(s.st_mode)and s.st_uid==1001 and stat.S_IMODE(s.st_mode)==0o700,'operation_identity_changed')
 row=json.loads(safe_read(OPERATION/'receipt.json',1001,0o600,65536));download=row.get('download',{})
 need(row.get('operation_id')==OP and row.get('manifest_sha256')==pin and row.get('phase')=='existing_key_read_intent'and download.get('backup_id_sha256')==ARTIFACT and download.get('encrypted_bytes')==SIZE and download.get('downloads')==1 and download.get('encrypted_sha256')=='CIPHER_SHA256_BINDING'and row.get('container_stdin_open')is True and row.get('container_tty')is False,'download_and_input_transport_unconfirmed')
 s=(OPERATION/'backup.tar').lstat();need(stat.S_ISREG(s.st_mode)and s.st_uid==1001 and s.st_nlink==1 and stat.S_IMODE(s.st_mode)==0o600 and s.st_size==SIZE,'fixed_cipher_file_changed')
def persist(path,row):
 fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
 try:
  with os.fdopen(os.dup(fd),'w')as f:json.dump(row,f,sort_keys=True);f.write('\n');f.flush();os.fsync(f.fileno())
 finally:os.close(fd)
 fd=os.open(path.parent,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
 try:os.fsync(fd)
 finally:os.close(fd)
def secret_from(raw):
 row=json.loads(raw);value=row.get('data',{}).get('config',{}).get('create_backup',{}).get('password')
 need(isinstance(value,str)and 0<len(value)<=4096,'existing_key_shape_invalid');body=(json.dumps({'password':value})+'\n').encode();need(len(body)<=8192,'existing_key_output_limit');return body

def main():
 need(os.geteuid()==0 and Path(__file__)==BASE/'native_key_reader.py'and sys.argv[1:]in([],['preflight']),'fixed_authenticated_native_entrypoint_required');resource.setrlimit(resource.RLIMIT_CORE,(0,0));resource.setrlimit(resource.RLIMIT_AS,(128*1024**2,128*1024**2));resource.setrlimit(resource.RLIMIT_CPU,(5,5));signal.alarm(15);preflight=bool(sys.argv[1:]);m,pin=manifest();authority(1200 if preflight else 690)
 need(not os.path.lexists(STATE),'existing_key_intent_requires_reconciliation');meta=safe_read(SOURCE,0,0o600,1048576,metadata=True)
 if preflight:return {'state':'native_key_source_metadata_verified_not_read','source_metadata':meta,'key_read':False,'new_access':False}
 operation_binding(pin);STATE.mkdir(mode=0o700);fd=os.open(STATE.parent,os.O_RDONLY|os.O_DIRECTORY)
 try:os.fsync(fd)
 finally:os.close(fd)
 binding={'operation_id':OP,'artifact_id_sha256':ARTIFACT,'manifest_sha256':pin,'observed_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'automatic_retry':False}
 persist(STATE/'intent.json',{**binding,'state':'intent_before_single_native_key_read'})
 try:
  body=secret_from(safe_read(SOURCE,0,0o600,1048576));written=0
  while written<len(body):written+=os.write(1,body[written:])
  body=None;persist(STATE/'receipt.json',{**binding,'state':'delivered_to_private_parent_pipe','key_stored':False,'Docker_root_exec':False})
 except BaseException:
  persist(STATE/'uncertain.json',{**binding,'state':'native_key_or_pipe_outcome_unconfirmed','key_stored':False});raise
 return None
if __name__=='__main__':
 try:
  result=main()
  if result is not None:print(json.dumps(result))
 except Exception:print(json.dumps({'error':'fixed_native_key_reader_unconfirmed','raw_error_withheld':True,'automatic_retry':False}));raise SystemExit(1)
