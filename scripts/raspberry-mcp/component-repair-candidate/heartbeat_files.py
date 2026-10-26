"""Candidate fixed heartbeat file/journal ports. Operator bindings, no MCP paths."""
import hashlib,json,os,stat,time
from pathlib import Path
from heartbeat_effect import SOURCE_FILES,EDITABLE,need,sha,source_set,BINDING,hexdigest,BeforeReplaceRefused

def encoded(value):return (json.dumps(value,sort_keys=True,separators=(',',':'))+'\n').encode()
def sync(folder):
 fd=os.open(folder,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
 try:os.fsync(fd)
 finally:os.close(fd)
def safe_dir(path,owner,private=False):
 for p in(path,*path.parents):need(not p.is_symlink(),'symlink_source_or_journal_parent')
 s=path.lstat();need(stat.S_ISDIR(s.st_mode)and s.st_uid==owner and(not s.st_mode&0o077 if private else not s.st_mode&0o022),'unsafe_source_or_journal_directory')
 if owner==0:
  for p in path.parents:
   s=p.lstat();need(s.st_uid==0 and not s.st_mode&0o022,'unsafe_root_source_parent')
def read(path,owner,mode,maximum):
 fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
 try:
  a=os.fstat(fd);need(stat.S_ISREG(a.st_mode)and a.st_uid==owner and stat.S_IMODE(a.st_mode)==mode and a.st_nlink==1 and a.st_size<=maximum,'unsafe_source_or_journal_file');data=os.read(fd,maximum+1);b=os.fstat(fd);need(len(data)<=maximum and(a.st_dev,a.st_ino,a.st_size,a.st_mtime_ns,a.st_ctime_ns)==(b.st_dev,b.st_ino,b.st_size,b.st_mtime_ns,b.st_ctime_ns),'source_changed_during_read');return data,(a.st_dev,a.st_ino,a.st_size,a.st_mtime_ns,a.st_ctime_ns)
 finally:os.close(fd)
def create(path,data):
 need(len(data)<=1048576,'journal_record_limit');fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
 try:
  with os.fdopen(os.dup(fd),'wb')as f:f.write(data);f.flush();os.fsync(f.fileno())
 finally:os.close(fd)
 sync(path.parent)
class FixedHeartbeatSources:
 def __init__(self,root,owner=0,clock=time.time,monotonic=time.monotonic):self.root=Path(root);self.owner=owner;self.clock=clock;self.mono=monotonic;self.pending={};safe_dir(self.root,owner)
 def snapshot(self):
  safe_dir(self.root,self.owner);return {n:read(self.root/n,self.owner,0o644,65536)[0]for n in sorted(SOURCE_FILES)}
 def temp(self,name,op,action):
  need(name in EDITABLE and hexdigest(op,32)and action in ('apply','rollback'),'fixed_source_target_refused');return self.root/('.'+name+'.component-'+op+'-'+action)
 def replace(self,name,candidate,before,op,action,barrier):
  need(name in EDITABLE and isinstance(candidate,bytes)and 0<len(candidate)<=65536,'fixed_source_edit_refused');safe_dir(self.root,self.owner);need(self.snapshot()==before,'source_compare_replace_conflict')
  path=self.root/name;_,identity=read(path,self.owner,0o644,65536);tmp=self.temp(name,op,action);fd=os.open(tmp,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600);created=os.fstat(fd);self.pending[(op,action)]=(tmp,created.st_dev,created.st_ino)
  try:
   os.fchmod(fd,0o644)
   with os.fdopen(os.dup(fd),'wb')as f:f.write(candidate);f.flush();os.fsync(f.fileno())
   _,current=read(path,self.owner,0o644,65536);need(current==identity and self.snapshot()==before,'source_compare_replace_conflict')
   try:barrier()
   except Exception:raise BeforeReplaceRefused('last_source_admission_refused')from None
   os.replace(tmp,path);at={'effect_applied_at':self.clock(),'effect_monotonic':self.mono()};sync(self.root);need(read(path,self.owner,0o644,65536)[0]==candidate,'written_source_not_confirmed');return at
  finally:
   os.close(fd)
   if os.path.lexists(tmp):
    current=tmp.lstat();need(current.st_uid==self.owner and stat.S_ISREG(current.st_mode)and current.st_nlink==1 and(current.st_dev,current.st_ino)==(created.st_dev,created.st_ino),'staging_cleanup_identity_unconfirmed');tmp.unlink();sync(self.root)
   self.pending.pop((op,action),None)
 def cleanup_confirmed(self,op,action):return (op,action)not in self.pending and not any(os.path.lexists(self.temp(n,op,action))for n in EDITABLE)
class HeartbeatJournal:
 def __init__(self,root,owner=0):self.root=Path(root);self.owner=owner;safe_dir(self.root,owner,True)
 def path(self,b):
  need(set(b)==BINDING and hexdigest(b['operation_id'],32)and b['component_id']=='external_heartbeat'and b['action']in ('apply','rollback'),'journal_binding_refused');return self.root/(b['operation_id']+'-'+b['action'])
 def load(self,path):return json.loads(read(path,self.owner,0o600,1048576)[0])
 def existing(self,b):
  p=self.path(b)
  if not os.path.lexists(p):return None
  safe_dir(p,self.owner,True);identity=self.load(p/'identity.json');need(identity==b,'journal_operation_identity_conflict');records=sorted(p.glob('receipt-*.json'))
  if not records:return {**b,'state':'uncertain','executor_terminal':False,'receipt_verified':False,'security_cleanup_confirmed':False,'collection_error':'incomplete_protected_journal','automatic_retry':False}
  r=self.load(records[-1]);need(all(r.get(k)==v for k,v in b.items()),'journal_receipt_binding_changed');return r
 def begin(self,b,backup):
  p=self.path(b);safe_dir(self.root,self.owner,True);entries=list(self.root.iterdir());need(all(x.is_dir()and not x.is_symlink()for x in entries),'journal_entry_unconfirmed');need(len(entries)<128 and len({x.name.split('-')[0]for x in entries}|{b['operation_id']})<=64,'journal_operation_capacity');need(sum(f.stat().st_size for d in entries for f in d.iterdir())+len(encoded(backup))+32768<=32*1048576,'journal_storage_capacity');p.mkdir(mode=0o700);sync(self.root);create(p/'identity.json',encoded(b));create(p/'backup.json',encoded(backup));create(p/'intent.json',encoded({'state':'intent_before_source_replace','automatic_retry':False}))
 def record(self,b,receipt):
  p=self.path(b);old=self.existing(b);need(old is not None,'journal_intent_missing')
  if encoded(old)==encoded(receipt):return old
  records=sorted(p.glob('receipt-*.json'));need(len(records)<8,'journal_receipt_capacity');need(all(receipt.get(k)==v for k,v in b.items()),'journal_receipt_identity_conflict');create(p/('receipt-%04d.json'%(len(records)+1)),encoded(receipt));return receipt
 def reject(self,b,result):
  old=self.existing(b)
  if old is not None:return old
  self.begin(b,{'rejected_before_write':True});return self.record(b,result)
 def backup(self,b):return self.load(self.path(b)/'backup.json')
