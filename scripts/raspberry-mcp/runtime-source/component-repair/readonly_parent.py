"""Fixed NodeRED read-scope child under independent observation admission.
Authentication is the SAME protected callback used by the effect parent. No
HTTP/path/auth arguments enter from MCP. No effect grant is manufactured.
"""
import contextlib,hashlib,json,os,secrets,selectors,subprocess,time
from pathlib import Path
from admission import need,ident,safe_file
from worker_parent import child_limits,encoded
class PreparationReviews:
 """Root writer's preliminary task binding; never an effect permit.
 The writer creates this immutable record before the baseline read. It grants
 only scoped observation; task, lease, executor locks and resources are real.
 """
 def __init__(self,root,owner=0):self.root,self.owner=Path(root),owner
 def read(self,binding,principal):
  from worker_parent import folder,read_json
  ident(binding.get('operation_id'));ident(principal,64)
  need(binding.get('component_id')=='observacao_host'and binding.get('action')=='observe'and binding.get('principal_sha256')==principal,'preparation_observation_scope')
  folder(self.root,self.owner);folder(self.root/binding['operation_id'],self.owner)
  need(not os.path.lexists(self.root/'revoked'),'preparation_observation_revoked')
  row=read_json(self.root/binding['operation_id']/'preparation.json',self.owner)
  need(type(row)is dict and set(row)=={'binding','send_id','expires_at','expected_loaded_sha256'}and row['binding']==binding,'protected_preparation_binding_changed')
  ident(row['send_id']);ident(row['expected_loaded_sha256'],64)
  need(type(row['expires_at'])in(int,float),'protected_preparation_expiry')
  return row
class ObservationAdmission:
 def __init__(self,executor,tasks,maintenance,reviews,reciprocal,principal,resources,clock=time.time):
  self.executor,self.tasks,self.maintenance,self.reviews,self.reciprocal,self.principal,self.resources,self.clock=executor,tasks,maintenance,reviews,reciprocal,principal,resources,clock
 @contextlib.contextmanager
 def locked(self,binding):
  with self.executor.locked(),self.tasks.locked(),self.maintenance:
   def check():
    need(binding.get('principal_sha256')==self.principal,'observation_principal_mismatch')
    self.executor.check_locks();review=self.reviews.read(binding,self.principal);task=self.tasks.observe(binding,review['send_id'])
    need(self.clock()+90<min(task['expires_at'],review['expires_at']),'observation_lease_completion_margin')
    self.executor.existing_snapshot();self.reciprocal.check('NodeRED_reader_binding',binding['operation_id'])
    need(self.resources()is None,'resource_gate_contract_changed')
   check();yield check
class BoundReadOnlyParent:
 def __init__(self,entrypoint,source_hashes,admission,authentication,jobs,owner=0,clock=time.time):
  self.entry,self.hashes,self.admission,self.authentication,self.jobs,self.owner,self.clock=Path(entrypoint),dict(source_hashes),admission,authentication,jobs,owner,clock
 def sources(self):
  paths={'nodered_observe.cjs':self.entry,'nodered_effect.cjs':self.entry.with_name('nodered_effect.cjs'),'attestation_model.cjs':self.entry.parent.parent/'attestation_model.cjs'}
  need(set(self.hashes)==set(paths),'readonly_worker_source_scope')
  for name,path in paths.items():
   fd,_=safe_file(path,self.owner,0o644,1048576)
   try:raw=os.read(fd,1048577)
   finally:os.close(fd)
   need(hashlib.sha256(raw).hexdigest()==self.hashes[name],'readonly_worker_source_changed')
 def collect(self,binding,allowed):
  self.sources();need(binding.get('component_id')=='observacao_host','readonly_component_not_activated')
  need(not self.jobs.observation_cleanup_pending(),'observation_security_cleanup_pending')
  for key,n in [('operation_id',32),('task_id',32),('principal_sha256',64)]:ident(binding[key],n)
  need(type(allowed)is list and 0<len(allowed)<=2,'readonly_identity_set_required')
  for value in allowed:ident(value,64)
  request={'component_id':'observacao_host','operation_id':binding['operation_id'],'nonce':secrets.token_hex(16),'allowed_identities':allowed}
  proof=None;proc=None;auth_r=auth_w=None;launched=False;terminal_recorded=False
  with self.admission.locked(binding)as check:
   try:
    check();auth_r,auth_w=os.pipe();secret=encoded({'authentication':self.authentication()});need(len(secret)<=8192,'readonly_authentication_frame_limit')
    pid=os.getpid();proc=subprocess.Popen(['/usr/bin/node','--jitless','--no-expose-wasm','--max-old-space-size=64',str(self.entry)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,pass_fds=(auth_r,),close_fds=True,env={'PATH':'/usr/bin:/bin','LC_ALL':'C','COMPONENT_AUTH_FD':str(auth_r)},preexec_fn=lambda:child_limits(pid));launched=True
    os.close(auth_r);auth_r=None;view=memoryview(secret)
    while view:view=view[os.write(auth_w,view):]
    view=None;secret=None;os.close(auth_w);auth_w=None;proc.stdin.write(encoded(request));proc.stdin.close();out=bytearray();err=0;end=time.monotonic()+40
    with selectors.DefaultSelector()as selector:
     selector.register(proc.stdout,selectors.EVENT_READ,'out');selector.register(proc.stderr,selectors.EVENT_READ,'err')
     while selector.get_map():
      need(time.monotonic()<end,'readonly_worker_timeout')
      for key,_ in selector.select(.1):
       data=os.read(key.fileobj.fileno(),4096)
       if not data:selector.unregister(key.fileobj);continue
       if key.data=='out':out.extend(data);need(len(out)<=8192,'readonly_worker_output_limit')
       else:err+=len(data);need(err<=4096,'readonly_worker_error_limit')
    proc.wait(timeout=max(.01,end-time.monotonic()));need(proc.returncode==0 and out.count(b'\n')==1 and out.endswith(b'\n'),'readonly_worker_frame_invalid')
    proof=json.loads(out);need(proof.get('nonce')==request['nonce']and proof.get('operation_id')==binding['operation_id'],'readonly_worker_reply_identity')
    check();self.jobs.record_observation(binding,proof);terminal_recorded=True
    return self.jobs.latest_observation(binding)
   finally:
    if proc is not None and proc.poll()is None:proc.kill();proc.wait(timeout=2)
    for fd in (auth_r,auth_w):
     if fd is not None:os.close(fd)
    if proc is not None:
     for stream in (proc.stdin,proc.stdout,proc.stderr):
      if stream is not None and not stream.closed:stream.close()
    # No valid terminal revocation receipt after launch conservatively retains
    # a durable cleanup block, even when the GET result itself was lost.
    if launched and not terminal_recorded:
     unknown={'source':'protected_NodeRED_read_session','component_id':'observacao_host','operation_id':binding['operation_id'],'nonce':request['nonce'],'state':'unknown','collection_error':'read_session_revocation_unconfirmed','observed_at':self.clock(),'loaded_sha256':None,'identity_kind':'nodered_scoped_configuration_v1','session_revoked':False,'functional_health':'unknown','automatic_retry':False}
     self.jobs.record_observation(binding,unknown)
