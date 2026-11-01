"""Protected RevisionStore subprocess publication under real host locks.
No credentials, source execution, deploy, job send or caller-supplied proof.
"""
import hashlib,json,os,selectors,subprocess,time
from pathlib import Path
from admission import need,ident,safe_file
from worker_parent import child_limits,encoded
class RootPublisher:
 def __init__(self,entry,expected_sha256,executor,tasks,maintenance,reciprocal,jobs,principal,resources,owner=0,clock=time.time):
  self.entry,self.expected,self.executor,self.tasks,self.maintenance,self.reciprocal,self.jobs,self.principal,self.resources,self.owner,self.clock=Path(entry),expected_sha256,executor,tasks,maintenance,reciprocal,jobs,principal,resources,owner,clock
 def publish(self,op):
  ident(op);review=self.jobs.review(op);need(review['principal']==self.principal,'publication_principal_mismatch')
  fd,_=safe_file(self.entry,self.owner,0o644,1048576)
  try:need(hashlib.sha256(os.read(fd,1048577)).hexdigest()==self.expected,'protected_publisher_source_changed')
  finally:os.close(fd)
  with self.executor.locked(),self.tasks.locked(),self.maintenance:
   binding={'operation_id':op,'task_id':review['task'],'component_id':review['component']}
   task=self.tasks.observe(binding,review['send']);self.executor.existing_snapshot();self.reciprocal.check('NodeRED_reader_binding',op)
   need(self.resources()is None and self.clock()+90<min(task['expires_at'],review['expires']),'publication_resources_or_window_unconfirmed')
   holder=getattr(self.executor.operations,'pid',os.getpid())
   request={'operation_id':op,'review_sha256':review['review_sha256'],'expires_at':review['expires'],'root_parent_pid':os.getpid(),'operations_holder_pid':holder}
   proc=None;out=bytearray();err=0
   try:
    pid=os.getpid();proc=subprocess.Popen(['/usr/bin/node','--jitless','--no-expose-wasm','--max-old-space-size=32',str(self.entry)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,close_fds=True,env={'PATH':'/usr/bin:/bin','LC_ALL':'C'},preexec_fn=lambda:child_limits(pid));proc.stdin.write(encoded(request));proc.stdin.close();end=time.monotonic()+20
    with selectors.DefaultSelector()as sel:
     sel.register(proc.stdout,selectors.EVENT_READ,'out');sel.register(proc.stderr,selectors.EVENT_READ,'err')
     while sel.get_map():
      need(time.monotonic()<end,'publication_worker_deadline')
      for key,_ in sel.select(.1):
       b=os.read(key.fileobj.fileno(),4096)
       if not b:sel.unregister(key.fileobj);continue
       if key.data=='out':out.extend(b);need(len(out)<=16384,'publication_worker_output_limit')
       else:err+=len(b);need(err<=4096,'publication_worker_error_limit')
    proc.wait(timeout=max(.01,end-time.monotonic()));need(proc.returncode==0 and out.count(b'\n')==1 and out.endswith(b'\n'),'publication_worker_reply_unconfirmed')
    value=json.loads(out);need(value.get('operation_id')==op and value.get('review_sha256')==review['review_sha256']and value.get('state')=='protected_records_published_not_deployed','publication_worker_receipt_unconfirmed')
    self.executor.check_locks();return value
   finally:
    if proc is not None and proc.poll()is None:proc.kill();proc.wait(timeout=2)
    if proc is not None:
     for stream in (proc.stdin,proc.stdout,proc.stderr):
      if stream is not None and not stream.closed:stream.close()
