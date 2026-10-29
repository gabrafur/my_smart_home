"""Bounded metadata data-only recovery. Never copies authorization or source policy.

Caller is a separately reviewed Root recovery action, not an arbitrary path MCP
tool. Live snapshots lock the consumer and use SQLite's online backup API.
Restore refuses existing data and requires current authorization disabled.
"""
from pathlib import Path
import fcntl,hashlib,json,os,sqlite3,stat,time
from authorization_gate import AuthorizationGate,pairs
from handoff_ledger import HandoffLedger
MAX_DB=1048576
LIMITS={"state.sqlite3":MAX_DB,"consumer-state.json":131072,"consumer-ack.json":4096}
class RecoveryUnavailable(RuntimeError):pass
def require(ok,reason):
 if not ok:raise RecoveryUnavailable(reason)
def directory(path,uid,gid,mode):
 path=Path(path);s=path.lstat()
 require(path.is_absolute()and path.resolve()==path and stat.S_ISDIR(s.st_mode)
  and(s.st_uid,s.st_gid,stat.S_IMODE(s.st_mode))==(uid,gid,mode),"recovery_directory_unsafe")
 return path
def read(path,uid,gid,mode,limit):
 fd=os.open(path,os.O_RDONLY|os.O_NONBLOCK|os.O_NOFOLLOW|os.O_CLOEXEC)
 try:
  s=os.fstat(fd);require(stat.S_ISREG(s.st_mode)and s.st_nlink==1
   and(s.st_uid,s.st_gid,stat.S_IMODE(s.st_mode))==(uid,gid,mode)and s.st_size<=limit,"recovery_file_unsafe")
  with os.fdopen(os.dup(fd),"rb")as file:data=file.read(limit+1)
  require(len(data)==s.st_size and len(data)<=limit,"recovery_file_capacity")
  after=os.fstat(fd);require((s.st_dev,s.st_ino,s.st_size,s.st_mtime_ns,s.st_ctime_ns)==
   (after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns,after.st_ctime_ns),"recovery_file_changed")
  return data
 finally:os.close(fd)
def put(path,data,uid=0,gid=0):
 fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW|os.O_CLOEXEC,0o600)
 try:
  os.fchmod(fd,0o600);os.fchown(fd,uid,gid)
  with os.fdopen(fd,"wb",closefd=False)as out:out.write(data);out.flush();os.fsync(fd)
 finally:os.close(fd)
def syncdir(path):
 fd=os.open(path,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC)
 try:os.fsync(fd)
 finally:os.close(fd)
def checked_db(path):
 raw=read(path,0,0,0o600,MAX_DB);require(len(raw)>0,"recovery_ledger_invalid")
 # This is a sealed copy, not the live ledger. Immutable reads cannot create
 # new WAL/SHM files outside the snapshot's checksummed inventory.
 db=sqlite3.connect(Path(path).as_uri()+"?mode=ro&immutable=1",uri=True,timeout=0,isolation_level=None)
 try:
  db.execute("PRAGMA trusted_schema=OFF")
  rows=db.execute("SELECT id,body,sha256 FROM snapshot").fetchall()
  require(len(rows)==1 and rows[0][0]==1,"recovery_ledger_invalid")
  body,sha=rows[0][1:];require(len(body)<=131072 and hashlib.sha256(body.encode("ascii")).hexdigest()==sha,"recovery_ledger_invalid")
  value=json.loads(body);HandoffLedger.__new__(HandoffLedger)._validate(value);return value
 finally:db.close()
def snapshot_data(paths,destination):
 require(os.geteuid()==0,"recovery_role_invalid")
 directory(paths.state,0,0,0o700);directory(paths.consumer,1000,1000,0o700)
 destination=Path(destination);directory(destination.parent,0,0,0o700)
 destination.mkdir(mode=0o700);destination.chmod(0o700)
 lock=None;source=None;target=None
 try:
  lock=os.open(paths.consumer/"lock",os.O_RDONLY|os.O_NONBLOCK|os.O_NOFOLLOW|os.O_CLOEXEC)
  s=os.fstat(lock);require(stat.S_ISREG(s.st_mode)and s.st_nlink==1 and s.st_size==0
   and(s.st_uid,s.st_gid,stat.S_IMODE(s.st_mode))==(1000,1000,0o600),"recovery_lock_unsafe")
  try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
  except BlockingIOError:raise RecoveryUnavailable("consumer_busy")from None
  # Consumer state/ACK cannot advance while Root takes an online ledger copy.
  state=read(paths.consumer/"state.json",1000,1000,0o600,131072)
  try:ack=read(paths.consumer/"ack.json",1000,1000,0o600,4096)
  except FileNotFoundError:ack=None
  src=paths.ledger.lstat()
  require(stat.S_ISREG(src.st_mode)and src.st_nlink==1
   and(src.st_uid,src.st_gid,stat.S_IMODE(src.st_mode))==(0,0,0o600),"recovery_ledger_unsafe")
  put(destination/"state.sqlite3",b"")
  source=sqlite3.connect(paths.ledger.as_uri()+"?mode=ro",uri=True,timeout=0,isolation_level=None)
  source.execute("PRAGMA trusted_schema=OFF")
  target=sqlite3.connect(str(destination/"state.sqlite3"),timeout=0,isolation_level=None)
  until=time.monotonic()+5
  def progress(_status,remaining,total):
   require(time.monotonic()<until and 0<=remaining<=total<=256,"recovery_backup_capacity")
  source.backup(target,pages=16,progress=progress,sleep=0.01)
  require(target.execute('PRAGMA journal_mode=DELETE').fetchone()[0]=='delete','recovery_backup_journal_unconfirmed')
  target.close();target=None;source.close();source=None
  checked_db(destination/"state.sqlite3")
  fd=os.open(destination/"state.sqlite3",os.O_RDONLY|os.O_NOFOLLOW)
  try:os.fsync(fd)
  finally:os.close(fd)
  put(destination/"consumer-state.json",state)
  if ack is not None:put(destination/"consumer-ack.json",ack)
  names=["state.sqlite3","consumer-state.json"]+(["consumer-ack.json"]if ack is not None else[])
  manifest={"schema_version":1,"authorization_included":False,"source_policy_included":False,
   "prepared_proposals_included":False,"files":{n:{"sha256":hashlib.sha256(read(destination/n,0,0,0o600,LIMITS[n])).hexdigest(),
    "bytes":(destination/n).stat().st_size}for n in names}}
  put(destination/"manifest.json",json.dumps(manifest,sort_keys=True,separators=(",",":")).encode("ascii"))
  syncdir(destination);return manifest
 finally:
  if target is not None:target.close()
  if source is not None:source.close()
  if lock is not None:os.close(lock)
  # Failed snapshots are retained for review; retention is observe-only.
def validated_data(snapshot):
 snapshot=directory(snapshot,0,0,0o700)
 manifest=json.loads(read(snapshot/"manifest.json",0,0,0o600,8192),object_pairs_hook=pairs)
 require(type(manifest)is dict and set(manifest)=={"schema_version","authorization_included","source_policy_included","prepared_proposals_included","files"}
  and type(manifest["schema_version"])is int and manifest["schema_version"]==1 and manifest["authorization_included"]is False
  and manifest["source_policy_included"]is False and manifest["prepared_proposals_included"]is False,"recovery_manifest_invalid")
 files=manifest["files"]
 require(type(files)is dict and {"state.sqlite3","consumer-state.json"}<=set(files)<=set(LIMITS),"recovery_manifest_invalid")
 content={}
 for name,metadata in files.items():
  require(type(metadata)is dict and set(metadata)=={"sha256","bytes"},"recovery_manifest_invalid")
  data=read(snapshot/name,0,0,0o600,LIMITS[name])
  require(type(metadata["bytes"])is int and len(data)==metadata["bytes"]and hashlib.sha256(data).hexdigest()==metadata["sha256"],
   "recovery_digest_mismatch");content[name]=data
 checked_db(snapshot/"state.sqlite3")
 require({p.name for p in snapshot.iterdir()}==set(files)|{"manifest.json"},"recovery_inventory_changed")
 return content

def restore_data(paths,snapshot):
 require(os.geteuid()==0,"recovery_role_invalid")
 directory(paths.state,0,0,0o700);directory(paths.runtime,0,0,0o755)
 directory(paths.consumer,1000,1000,0o700);snapshot=directory(snapshot,0,0,0o700)
 gate=AuthorizationGate(paths.runtime,paths.authorization)
 try:
  current,_=gate._read();require(current["enabled"]is False,"restore_requires_disabled_authorization")
  gate.refresh()
 finally:gate.close()
 before=read(paths.authorization,0,0,0o600,4096)
 require(not paths.ledger.exists()and not any((paths.consumer/n).exists()for n in ["state.json","ack.json","prepared.json","lock"]),
  "restore_existing_state_refused")
 content=validated_data(snapshot)
 put(paths.ledger,content["state.sqlite3"])
 put(paths.consumer/"state.json",content["consumer-state.json"],1000,1000)
 if "consumer-ack.json"in content:put(paths.consumer/"ack.json",content["consumer-ack.json"],1000,1000)
 put(paths.consumer/"lock",b"",1000,1000);syncdir(paths.state);syncdir(paths.consumer)
 require(before==read(paths.authorization,0,0,0o600,4096),"restore_authorization_changed")
 return {"state":"data_restored_authorization_unchanged","authorization_enabled":False,"consumer_runtime_validation":"pending"}
