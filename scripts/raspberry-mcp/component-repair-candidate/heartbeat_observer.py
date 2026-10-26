"""Candidate fixed, read-only native heartbeat port; no sender or service action.
Only a sealed root bootstrap supplies expected code/binding identities. No port,
path, unit name, command or expected-proof boolean comes from MCP parameters.
"""
import datetime,hashlib,json,math,os,re,stat,subprocess,time
from native_binding import verified
from runtime_projection import project_heartbeat

UNIT='raspberry-host-heartbeat.service'
PROPERTIES=('InvocationID','ExecMainPID','ExecMainStartTimestampMonotonic','ExecMainExitTimestampMonotonic','ActiveState','SubState','Result')
NUMERIC=frozenset(('ExecMainPID','ExecMainStartTimestampMonotonic','ExecMainExitTimestampMonotonic'))
def need(value,reason):
 if not value:raise ValueError(reason)
def sha(value):return isinstance(value,str)and re.fullmatch('[a-f0-9]{64}',value)is not None
def finite(value):return type(value)in(int,float)and math.isfinite(value)
def parse_manager(raw):
 need(isinstance(raw,bytes)and len(raw)<=4096,'native_manager_output_limit');out={}
 for line in raw.decode('ascii').splitlines():
  key,value=line.split('=',1);need(key in PROPERTIES and key not in out,'native_manager_shape_refused')
  if key in NUMERIC:need(re.fullmatch('[0-9]{1,20}',value)is not None,'native_manager_number_refused');value=int(value)
  out[key]=value
 need(set(out)==set(PROPERTIES),'native_manager_incomplete');return out

def bounded(fd,limit):
 data=bytearray()
 while len(data)<=limit:
  part=os.read(fd,min(4096,limit+1-len(data)))
  if not part:break
  data.extend(part)
 need(len(data)<=limit,'native_snapshot_size_limit');return bytes(data)
def identity(info):return(info.st_dev,info.st_ino,info.st_size,info.st_mtime_ns,info.st_ctime_ns)
class FixedNativeHeartbeatPort:
 """Fixed root-owned directory chain and existing systemd metadata only."""
 def manager(self):
  argv=['/usr/bin/systemctl','show',UNIT]
  for name in PROPERTIES:argv+=['-p',name]
  result=subprocess.run(argv,capture_output=True,timeout=5,env={'PATH':'/usr/bin:/bin','LC_ALL':'C'},stdin=subprocess.DEVNULL)
  need(result.returncode==0 and not result.stderr,'native_manager_collection_failed');return parse_manager(result.stdout)
 def snapshot(self):
  # Open each segment relative to its verified parent. Never follow the public
  # StateDirectory symlink or accept a directory supplied by a chatbot.
  fds=[]
  try:
   parent=os.open('/',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW);fds.append(parent)
   for segment in ('var','lib','private'):
    parent=os.open(segment,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=parent);fds.append(parent);info=os.fstat(parent)
    need(info.st_uid==0 and not info.st_mode&0o022,'unsafe_native_snapshot_parent')
   parent=os.open('raspberry-host-heartbeat',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=parent);fds.append(parent);directory=os.fstat(parent)
   need(stat.S_IMODE(directory.st_mode)==0o700,'unsafe_native_snapshot_directory')
   fd=os.open('status.json',os.O_RDONLY|os.O_NONBLOCK|os.O_NOFOLLOW,dir_fd=parent);fds.append(fd);before=os.fstat(fd)
   need(stat.S_ISREG(before.st_mode)and before.st_uid==directory.st_uid and stat.S_IMODE(before.st_mode)==0o600 and before.st_nlink==1 and before.st_size<=4096,'unsafe_native_snapshot_file')
   raw=bounded(fd,4096);need(identity(before)==identity(os.fstat(fd)),'native_snapshot_changed_during_read');return json.loads(raw)
  finally:
   for fd in reversed(fds):os.close(fd)
 def boot(self):
  fd=os.open('/proc/sys/kernel/random/boot_id',os.O_RDONLY|os.O_NOFOLLOW)
  try:boot=bounded(fd,64).decode('ascii').strip()
  finally:os.close(fd)
  need(re.fullmatch('[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}',boot)is not None,'native_boot_identity_refused');return boot
 def collect(self):
  need(os.geteuid()==0,'root_native_read_port_required');first=self.manager();boot=self.boot();snapshot=self.snapshot();last=self.manager()
  need(first==last and boot==self.boot(),'native_invocation_changed_during_collection');return snapshot,last,boot

class HeartbeatNativeObserver:
 def __init__(self,port,critical_sha256,runtime_cache_tag,allowed_code_identities,clock=time.time,monotonic=time.monotonic):
  need(sha(critical_sha256)and isinstance(runtime_cache_tag,str)and re.fullmatch('cpython-[0-9]{2,4}',runtime_cache_tag),'protected_native_binding_refused')
  need(isinstance(allowed_code_identities,frozenset)and 1<=len(allowed_code_identities)<=2 and all(sha(v)for v in allowed_code_identities),'protected_native_code_scope_refused')
  self.port,self.critical,self.tag,self.allowed=port,critical_sha256,runtime_cache_tag,allowed_code_identities;self.clock,self.mono=clock,monotonic
 def __call__(self):
  now=self.clock();out={'source':'protected_loaded_component_attestation','component_id':'external_heartbeat','root_verified':False,'state':'unknown','observed_at':datetime.datetime.fromtimestamp(now,datetime.timezone.utc).isoformat(),'loaded_sha256':None,'loaded_identity_kind':'python_code_objects_v1','collection_error':'native_collection_or_binding_unconfirmed','native_invocation_verified':False,'critical_bindings_valid':False,'coverage':['fixed_native_snapshot_and_systemd_only','not_current_live_process_remote_health_or_assistant_execution']}
  try:
   status,manager,boot=self.port.collect();proof=status.get('last_loaded_identity');need(isinstance(proof,dict),'native_identity_missing')
   loaded=proof.get('loaded_code_sha256');need(sha(loaded)and loaded in self.allowed,'native_code_not_in_protected_review')
   mono=self.mono();at=proof.get('observed_monotonic');end=manager.get('ExecMainExitTimestampMonotonic');need(finite(at)and finite(mono)and 0<=mono-at<=120 and type(end)is int and end/1000000<=mono,'native_monotonic_binding_refused')
   need(verified(proof,manager,boot),'native_completed_invocation_unconfirmed')
   binding={'native_invocation_verified':True,'expected_loaded_sha256':loaded,'expected_critical_binding_sha256':self.critical,'expected_runtime_cache_tag':self.tag}
   projected=project_heartbeat(status,now,binding);need(projected.get('state')=='observed'and projected.get('collection_error')is None,'native_runtime_projection_unconfirmed')
   return {**projected,'root_verified':True,'native_invocation_verified':True,'critical_bindings_valid':True,'observed_monotonic':at,'invocation_started_monotonic':manager['ExecMainStartTimestampMonotonic']/1000000,'boot_id_sha256':hashlib.sha256(boot.encode()).hexdigest()}
  except Exception:return out
