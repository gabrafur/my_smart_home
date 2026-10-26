"""Candidate internal parent: pinned worker, private socketpair, protected receipts.
No installed entrypoint, daemon, sudo rule or MCP registration. Production
bootstrap must pin root-owned sources, fixed paths and authenticated principal.
The request surface of run() is operation ID and apply/rollback only. Operator
bindings and dependencies below are never MCP parameters.
"""
import contextlib,ctypes,fcntl,hashlib,json,math,os,resource,selectors,signal,socket,stat,subprocess,time
from pathlib import Path
from admission import need,ident,safe_file,ProtectedAdmission

_prctl=ctypes.CDLL(None,use_errno=True).prctl
def child_limits(parent_pid):
 # The fixed child cannot outlive the process holding the admission locks.
 if _prctl(1,signal.SIGKILL,0,0,0)!=0 or os.getppid()!=parent_pid:os._exit(125)
 resource.setrlimit(resource.RLIMIT_CORE,(0,0));resource.setrlimit(resource.RLIMIT_CPU,(20,20));resource.setrlimit(resource.RLIMIT_NOFILE,(32,32))
def encoded(value):return (json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=False)+'\n').encode()
def sha(value):return hashlib.sha256(encoded(value).rstrip(b'\n')).hexdigest()
def folder(path,owner):
 path=Path(path)
 for p in(path,*path.parents):need(not p.is_symlink(),'unsafe_worker_state_parent')
 s=path.stat();need(stat.S_ISDIR(s.st_mode)and s.st_uid==owner and stat.S_IMODE(s.st_mode)==0o700,'unsafe_worker_state_folder');return path
def read_json(path,owner,limit=16384):
 fd,_=safe_file(path,owner,0o600,limit)
 try:return json.loads(os.read(fd,limit+1))
 finally:os.close(fd)
def sync_folder(path):
 fd=os.open(path,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
 try:os.fsync(fd)
 finally:os.close(fd)
def write_new(path,value):
 raw=encoded(value);need(len(raw)<=16384,'parent_receipt_limit');fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
 try:
  with os.fdopen(os.dup(fd),'wb')as stream:stream.write(raw);stream.flush();os.fsync(stream.fileno())
 finally:os.close(fd)
 sync_folder(Path(path).parent)

def admission_context(executor,tasks,maintenance,reviews,principal,resources,clock=time.time):
 """Nonblocking order: operations/admin -> tasks -> native maintenance.
 Caller must launch this job after the admitting MCP request releases its lock.
 """
 @contextlib.contextmanager
 def locked():
  with executor.locked(),tasks.locked(),maintenance:
   gate=ProtectedAdmission(tasks,maintenance,reviews,principal,executor,resources,clock)
   yield gate.check
 return locked

class BoundNodeRedParent:
 def __init__(self,entrypoint,source_hashes,prepared_root,state_root,locked_admission,existing_authentication,owner=0,timeout=75,clock=time.time):
  self.entry=Path(entrypoint);self.hashes=source_hashes;self.prepared_root=Path(prepared_root);self.state_root=Path(state_root);self.admission=locked_admission;self.auth=existing_authentication;self.owner=owner;self.timeout=timeout;self.clock=clock
  need(type(timeout)in(int,float)and 0<timeout<=75,'parent_deadline_refused')
 def sources(self):
  expected={'nodered_job.cjs':self.entry,'nodered_effect.cjs':self.entry.parent/'nodered_effect.cjs','attestation_model.cjs':self.entry.parent.parent/'attestation_model.cjs'}
  need(set(self.hashes)==set(expected),'worker_source_scope_changed')
  for name,path in expected.items():
   fd,_=safe_file(path,self.owner,0o644,1048576)
   try:raw=os.read(fd,1048577)
   finally:os.close(fd)
   need(hashlib.sha256(raw).hexdigest()==self.hashes[name],'sealed_worker_source_changed')
 def prepared(self,op,action):
  ident(op);need(action in('apply','rollback'),'worker_action_refused');folder(self.prepared_root,self.owner)
  p=read_json(self.prepared_root/(op+'-'+action+'.json'),self.owner,1048576+8192)
  fields={'operation_id','task_id','principal_sha256','component_id','before_sha256','after_sha256','candidate_nodes'}
  need(isinstance(p,dict)and set(p)==fields and p['operation_id']==op,'protected_prepared_record_refused');ident(p['task_id']);ident(p['principal_sha256'],64);ident(p['before_sha256'],64);ident(p['after_sha256'],64)
  need(p['component_id']in('localizacao_pessoas','observacao_host')and isinstance(p['candidate_nodes'],list),'protected_prepared_scope_refused')
  return p,{**{k:v for k,v in p.items()if k!='candidate_nodes'},'action':action}
 def state(self,action):folder(self.state_root,self.owner);return folder(self.state_root/action,self.owner)
 def previous(self,binding):
  target=self.state(binding['action'])/binding['operation_id']
  if not os.path.lexists(target):return None
  folder(target,self.owner)
  unknown={**binding,'state':'uncertain','executor_terminal':False,'receipt_verified':False,'automatic_retry':False,'effect_repeated':False,'collection_error':'existing_worker_record_without_verified_terminal_receipt'}
  if not os.path.lexists(target/'identity.json'):return unknown
  identity=read_json(target/'identity.json',self.owner);need(identity.get('request_sha256')==sha(binding),'operation_id_conflict')
  if not os.path.lexists(target/'receipt.json'):return unknown
  r=read_json(target/'receipt.json',self.owner);need(isinstance(r,dict)and all(r.get(k)==v for k,v in binding.items()),'worker_receipt_identity_mismatch')
  need(r.get('state')in('applied','rejected_without_effect','uncertain')and type(r.get('executor_terminal'))is bool and type(r.get('session_revoked'))is bool and r.get('security_cleanup_confirmed')is r['session_revoked']and r.get('receipt_verified')is True,'worker_receipt_shape_refused')
  at=r.get('worker_finished_at');need(type(at)in(int,float)and math.isfinite(at)and 0<=at<=self.clock()+1,'worker_receipt_time_unconfirmed')
  allowed=set(binding)|{'state','collection_error','executor_terminal','definitive_no_effect','loaded_sha256','other_scope_preserved_by_submission','effect_attempted','session_revoked','security_cleanup_confirmed','worker_finished_at','automatic_retry','receipt_verified'}
  reasons={None,'revision_conflict','effect_outcome_unconfirmed','pre_effect_validation_or_collection_failed','parent_admission_or_setup_refused','protected_admission_refused_before_authentication','worker_exit_without_verified_receipt'}
  need(set(r)<=allowed and r.get('automatic_retry')is False and type(r.get('effect_attempted'))is bool and r.get('collection_error')in reasons,'worker_receipt_content_refused')
  if r['state']=='uncertain':need(r['executor_terminal']is False and r.get('definitive_no_effect')is not True,'worker_uncertainty_shape_refused')
  if r['state']=='applied':need(r.get('loaded_sha256')==binding['after_sha256']and r['executor_terminal']is True,'worker_receipt_loaded_version_mismatch')
  if r['state']=='rejected_without_effect':need(r.get('definitive_no_effect')is True and r['executor_terminal']is True,'worker_no_effect_receipt_unconfirmed')
  return r
 def rejected(self,binding,reason):
  # Only before launch, or after exit with zero positive admission grants.
  # Pinned NodeRedWorker authenticates only after its initial grant succeeds.
  state=self.state(binding['action']);entries=list(state.iterdir());need(len(entries)<64,'operation_capacity')
  total=sum(p.stat(follow_symlinks=False).st_size for d in entries if d.is_dir()for p in d.iterdir());need(total+32768<=32*1048576,'state_storage_capacity')
  target=state/binding['operation_id'];target.mkdir(mode=0o700);sync_folder(state)
  write_new(target/'identity.json',{**binding,'request_sha256':sha(binding)})
  receipt={**binding,'state':'rejected_without_effect','executor_terminal':True,'definitive_no_effect':True,'effect_attempted':False,'session_revoked':True,'security_cleanup_confirmed':True,'worker_finished_at':self.clock(),'automatic_retry':False,'receipt_verified':True,'collection_error':reason}
  write_new(target/'receipt.json',receipt);return self.previous(binding)
 def run(self,op,action):
  self.sources();prepared,binding=self.prepared(op,action);old=self.previous(binding)
  if old is not None:return {**old,'duplicate':True,'effect_repeated':False}
  launched=False;grants=0;proc=None;failure='parent_admission_or_setup_refused';parent=None;child=None;auth_r=None;auth_w=None;stack=contextlib.ExitStack()
  try:
   check=stack.enter_context(self.admission())
   check(binding)  # Before reading existing credentials or starting a child.
   parent,child=socket.socketpair();auth_r,auth_w=os.pipe();operator={'authentication':self.auth(),'state_folder':str(self.state(action))};secret=encoded(operator);need(len(secret)<=8192,'operator_binding_limit')
   env={'PATH':'/usr/bin:/bin','LC_ALL':'C','COMPONENT_ADMISSION_FD':str(child.fileno()),'COMPONENT_AUTH_FD':str(auth_r)}
   parent_pid=os.getpid()
   proc=subprocess.Popen(['/usr/bin/node','--jitless','--no-expose-wasm','--max-old-space-size=32',str(self.entry)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,pass_fds=(child.fileno(),auth_r),env=env,close_fds=True,preexec_fn=lambda:child_limits(parent_pid))
   launched=True;deadline=time.monotonic()+self.timeout;child.close();child=None;os.close(auth_r);auth_r=None
   view=memoryview(secret)
   while view:view=view[os.write(auth_w,view):]
   view=None;secret=None;operator=None;os.close(auth_w);auth_w=None
   body=encoded({'action':action,'prepared':prepared});need(len(body)<=1048576+8192,'prepared_input_limit');proc.stdin.write(body);proc.stdin.close()
   buffer=b'';sequence=0;stdout_bytes=stderr_bytes=0
   with selectors.DefaultSelector()as selector:
    selector.register(parent,selectors.EVENT_READ,'admission');selector.register(proc.stdout,selectors.EVENT_READ,'stdout');selector.register(proc.stderr,selectors.EVENT_READ,'stderr')
    while selector.get_map():
     need(time.monotonic()<deadline,'worker_deadline_unknown')
     for key,_ in selector.select(min(.1,max(0,deadline-time.monotonic()))):
      data=os.read(key.fileobj.fileno(),4096)
      if not data:selector.unregister(key.fileobj);continue
      if key.data=='stdout':stdout_bytes+=len(data);need(stdout_bytes<=16384,'worker_stdout_limit')
      elif key.data=='stderr':stderr_bytes+=len(data);need(stderr_bytes<=8192,'worker_stderr_limit')
      else:
       buffer+=data;need(len(buffer)<=4096,'admission_frame_limit')
       if b'\n'not in buffer:continue
       raw,buffer=buffer.split(b'\n',1);need(not buffer,'one_admission_request_at_a_time');request=json.loads(raw)
       need(isinstance(request,dict)and set(request)=={'version','sequence','binding'}and request['version']==1 and type(request['sequence'])is int and request['sequence']==sequence+1 and sequence<2 and request['binding']==binding,'admission_frame_binding_refused');sequence+=1
       try:grant=check(binding);reply={'version':1,'sequence':sequence,'ok':True,'grant':grant};grants+=1
       except Exception:reply={'version':1,'sequence':sequence,'ok':False}
       parent.sendall(encoded(reply))
   proc.wait(timeout=max(.01,deadline-time.monotonic()));need(not buffer,'partial_admission_frame');failure='worker_exit_without_verified_receipt'
   receipt=self.previous(binding)
   if receipt is not None:return receipt
   if grants==0:return self.rejected(binding,'protected_admission_refused_before_authentication')
  except BaseException as error:
   if proc is not None and proc.poll()is None:
    proc.kill();proc.wait(timeout=2)
   if not isinstance(error,Exception):raise
   receipt=self.previous(binding)
   if receipt is not None:return receipt
   if not launched or grants==0:
    try:return self.rejected(binding,failure)
    except Exception:pass
  finally:
   if proc is not None and proc.poll()is None:
    proc.kill();proc.wait(timeout=2)
   for obj in(parent,child):
    if obj is not None:obj.close()
   for fd in(auth_r,auth_w):
    if fd is not None:os.close(fd)
   if proc is not None:
    for stream in(proc.stdin,proc.stdout,proc.stderr):
     if stream is not None and not stream.closed:stream.close()
   stack.close()
  return {**binding,'state':'uncertain','executor_terminal':False,'receipt_verified':False,'automatic_retry':False,'effect_repeated':False,'collection_error':'parent_worker_outcome_unconfirmed'}
