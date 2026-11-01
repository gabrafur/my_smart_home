"""Metadata-only fixed-state quota; no prune, content scan or directory following."""
import contextlib,fcntl,json,os,re,stat,time
from pathlib import Path
from source_writer import need,read,raw,write_new,protected_dir
CAP=128*1024*1024;RESERVE=32*1024*1024;ENTRIES=8192
class PreparationStorage:
 def __init__(self,state):self.state=Path(state)
 def usage(self):
  count=0;total=0;perop={};queue=[(self.state,0)]
  while queue:
   folder,depth=queue.pop();need(depth<=10,'preparer_storage_depth_bound')
   for p in folder.iterdir():
    count+=1;need(count<=ENTRIES,'preparer_storage_inode_bound');s=p.lstat();rel=p.relative_to(self.state)
    if stat.S_ISLNK(s.st_mode):
     need(re.fullmatch(r'sealed/[a-f0-9]{32}/(?:validation-attempts/[a-f0-9]{32}/)?sandbox/root/(bin|sbin|lib|lib64)',str(rel))and os.readlink(p)=={'bin':'usr/bin','sbin':'usr/sbin','lib':'usr/lib','lib64':'usr/lib64'}[p.name],'unexpected_storage_symlink');size=s.st_size
    elif stat.S_ISDIR(s.st_mode):queue.append((p,depth+1));size=4096
    else:need(stat.S_ISREG(s.st_mode)and s.st_nlink==1 and s.st_size<=8*1024*1024,'unexpected_storage_file');size=max(s.st_size,s.st_blocks*512)
    total+=size
    if len(rel.parts)>1 and rel.parts[0]=='sealed'and re.fullmatch('[a-f0-9]{32}',rel.parts[1]):perop[rel.parts[1]]=perop.get(rel.parts[1],0)+size
    need(total<=CAP,'preparer_storage_capacity')
  return total,perop,count
 def reserve(self,op):return self._locked_reservation(op,False)
 def continue_reserved(self,op):return self._locked_reservation(op,True)
 @contextlib.contextmanager
 def _locked_reservation(self,op,existing):
  need(re.fullmatch('[a-f0-9]{32}',op),'storage_operation_id');protected_dir(self.state)
  fd=os.open(self.state/'preparer-storage.lock',os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600)
  try:
   s=os.fstat(fd);need(stat.S_ISREG(s.st_mode)and s.st_uid==0 and stat.S_IMODE(s.st_mode)==0o600 and s.st_nlink==1,'storage_lock_identity')
   try:fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
   except BlockingIOError:raise ValueError('preparer_storage_busy')
   folder=self.state/'reservations'
   if not folder.exists():folder.mkdir(mode=0o700)
   protected_dir(folder);reservation=folder/(op+'.json');need(reservation.exists()if existing else not reservation.exists(),'existing_storage_reservation_inspect_only');total,usage,count=self.usage();promised=0
   for p in folder.iterdir():
    need(re.fullmatch('[a-f0-9]{32}\.json',p.name),'unexpected_storage_reservation');row=json.loads(read(p,0,0o600));need(row['operation_id']==p.stem and row['reserved_bytes']==RESERVE,'storage_reservation_shape');promised+=max(0,RESERVE-usage.get(p.stem,0))
   need(total+promised+(0 if existing else RESERVE)<=CAP and count+1024<=ENTRIES,'preparer_storage_worstcase_capacity')
   if not existing:write_new(reservation,raw({'operation_id':op,'reserved_bytes':RESERVE,'created_at':time.time(),'automatic_release':False,'automatic_prune':False}))
   yield
  finally:os.close(fd)
