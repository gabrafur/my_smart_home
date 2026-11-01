"""Closed canonical source writer; never writes runtime flows or executes code."""
import base64,hashlib,json,os,re,stat,time
from pathlib import Path
LIMIT=2*1024*1024
def need(ok,reason):
 if not ok:raise ValueError(reason)
def sha(b):return hashlib.sha256(b).hexdigest()
def raw(v):return (json.dumps(v,sort_keys=True,separators=(',',':'),ensure_ascii=False)+'\n').encode()
def source_set(files):return sha(raw({p:sha(v)for p,v in sorted(files.items())}))
def identity(s):return(s.st_dev,s.st_ino,s.st_uid,s.st_gid,s.st_mode,s.st_nlink,s.st_size,s.st_mtime_ns,s.st_ctime_ns)
def parents(p):
 for q in (Path(p),*Path(p).parents):need(not q.is_symlink(),'source_symlink_refused')
def read(p,owner=None,mode=None,limit=LIMIT):
 p=Path(p);parents(p);fd=os.open(p,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
 try:
  before=os.fstat(fd);need(stat.S_ISREG(before.st_mode)and before.st_nlink==1 and before.st_size<=limit,'source_file_unsafe')
  if owner is not None:need(before.st_uid==owner and stat.S_IMODE(before.st_mode)==mode,'protected_file_identity')
  chunks=[];length=0
  while True:
   b=os.read(fd,min(65536,limit+1-length))
   if not b:break
   chunks.append(b);length+=len(b);need(length<=limit,'source_file_bound')
  need(length==before.st_size and identity(before)==identity(os.fstat(fd))==identity(p.lstat()),'source_changed_during_read');return b''.join(chunks)
 finally:os.close(fd)
def write_new(p,b,limit=LIMIT):
 p=Path(p);parents(p.parent);need(not p.exists()and len(b)<=limit,'existing_protected_artifact')
 fd=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
 try:
  offset=0
  while offset<len(b):offset+=os.write(fd,b[offset:])
  os.fsync(fd)
 finally:os.close(fd)
 fd=os.open(p.parent,os.O_RDONLY|os.O_DIRECTORY)
 try:os.fsync(fd)
 finally:os.close(fd)
def protected_dir(p):
 p=Path(p);parents(p);s=p.stat();need(stat.S_ISDIR(s.st_mode)and s.st_uid==0 and stat.S_IMODE(s.st_mode)==0o700,'unsafe_protected_directory');return p
def replace_owned(p,b,expected,metadata):
 p=Path(p);parents(p);before=p.lstat();need(sha(read(p))==expected,'source_CAS_conflict')
 need({'uid':before.st_uid,'gid':before.st_gid,'mode':stat.S_IMODE(before.st_mode)}==metadata,'source_metadata_CAS_conflict')
 temp=p.with_name(p.name+'.component-owned-'+str(os.getpid()));fd=os.open(temp,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
 try:
  offset=0
  while offset<len(b):offset+=os.write(fd,b[offset:])
  os.fchown(fd,metadata['uid'],metadata['gid']);os.fchmod(fd,metadata['mode']);os.fsync(fd);owned=identity(os.fstat(fd))
 finally:os.close(fd)
 try:
  need(identity(before)==identity(p.lstat())and sha(read(p))==expected and identity(before)==identity(p.lstat()),'source_CAS_at_replace_conflict')
  os.replace(temp,p)
 finally:
  if temp.exists()and identity(temp.lstat())==owned:temp.unlink()
 fd=os.open(p.parent,os.O_RDONLY|os.O_DIRECTORY)
 try:os.fsync(fd)
 finally:os.close(fd)
class SourceWriter:
 def __init__(self,profile,state_root=Path('/var/lib/raspberry-component-repair'),repository=Path('/mnt/data/docker'),clock=time.time):
  need(type(profile['component_id'])is str and re.fullmatch('[a-z][a-z0-9_]{1,63}',profile['component_id']),'source_profile_component_refused');self.profile=profile;self.state=Path(state_root);self.repo=Path(repository);self.clock=clock
  self.paths=tuple(profile['editable_sources']);need(len(set(self.paths))==len(self.paths)and 0<len(self.paths)<=64,'source_profile_bound')
  for p in self.paths:need(re.fullmatch(r'nodered/tools/(install-[a-z0-9-]+-flow\.mjs|functions/[a-z0-9-]+\.js)',p),'source_path_not_closed')
  self.profile_sha=sha(raw(profile))
 def location(self,op):need(type(op)is str and re.fullmatch('[a-f0-9]{32}',op),'operation_id_refused');return protected_dir(self.state/'sealed'/op)
 def bundle(self,op):
  folder=self.location(op);payload=read(folder/'sources.json',0,0o600);b=json.loads(payload)
  compatibility=self.profile.get('validation_compatibility');previous=False
  if compatibility is not None:
   need(type(compatibility)is dict and set(compatibility)=={'operation_id','sources_bundle_sha256','previous_profile_sha256','previous_validation_phase_sha256','candidate_flow_before_sha256'},'validation_compatibility_shape')
   previous=op==compatibility['operation_id']and sha(payload)==compatibility['sources_bundle_sha256']and b.get('profile_sha256')==compatibility['previous_profile_sha256']
  need(b['operation_id']==op and b['component_id']==self.profile['component_id']and(b['profile_sha256']==self.profile_sha or previous),'source_bundle_identity')
  before={p:base64.b64decode(v,validate=True)for p,v in b['before'].items()};after={p:base64.b64decode(v,validate=True)for p,v in b['after'].items()}
  need(set(before)==set(after)==set(self.paths)and source_set(before)==b['before_source_sha256']and source_set(after)==b['after_source_sha256'],'source_bundle_hash')
  need(all(len(v)<=131072 for v in [*before.values(),*after.values()]),'source_text_bound');return folder,b,before,after
 def current(self):return {p:read(self.repo/p)for p in self.paths}
 def status(self,op,action):
  need(action in ('apply','rollback'),'source_action_refused');folder,b,before,after=self.bundle(op);actual=source_set(self.current());start,end=(before,after)if action=='apply'else(after,before);a,z=source_set(start),source_set(end)
  attempted=(folder/('source-'+action+'-intent.json')).exists();receipt=folder/('source-'+action+'-result.json');restored=folder/('source-rejected-restore-'+action+'-result.json')
  terminal=actual==z and receipt.exists();untouched=actual==a and(not attempted or restored.exists())
  metadata_ok=all({'uid':(self.repo/p).lstat().st_uid,'gid':(self.repo/p).lstat().st_gid,'mode':stat.S_IMODE((self.repo/p).lstat().st_mode)}==b['metadata'][p]for p in self.paths)
  terminal=terminal and metadata_ok;untouched=untouched and metadata_ok
  return {'operation_id':op,'action':action,'source':'protected_canonical_source_writer','observed_at':self.clock(),'source_before_sha256':a,'source_after_sha256':z,'actual_source_sha256':actual,'source_consistency_confirmed':terminal or untouched,'state':'terminal'if terminal else'before'if untouched else'uncertain','canonical_source_effect':actual!=a,'executor_terminal':terminal or untouched,'own_rollback_confirmed':restored.exists()and actual==a,'automatic_retry':False}
 def commit(self,op,action,admission):
  need(os.geteuid()==0 and callable(getattr(admission,'check',None)),'root_admission_object_required');need(action in ('apply','rollback'),'source_action_refused');folder,b,before,after=self.bundle(op)
  admission.check();need(self.clock()<self.profile['owner_authorization_expires_at'],'source_owner_window_expired')
  need(action!='rollback'or(folder/'source-apply-result.json').exists(),'own_apply_source_receipt_required')
  review=json.loads(read(folder/'review.json',0,0o600));need(review['operation_id']==op and review['source_set_sha256']==source_set(after)and self.clock()<review['expires_at'],'source_review_not_current')
  if(folder/('source-'+action+'-intent.json')).exists():
   observed=self.status(op,action);need(observed['state']=='terminal'and observed['source_consistency_confirmed'],'existing_source_intent_requires_reconciliation');return observed
  start,end=(before,after)if action=='apply'else(after,before);need(self.current()==start,'canonical_source_baseline_changed')
  write_new(folder/('source-'+action+'-intent.json'),raw({'operation_id':op,'action':action,'before':source_set(start),'after':source_set(end),'observed_at':self.clock(),'automatic_retry':False}))
  for p in self.paths:
   admission.check();need(self.clock()<review['expires_at'],'source_review_expired_midoperation')
   if start[p]!=end[p]:replace_owned(self.repo/p,end[p],sha(start[p]),b['metadata'][p])
  admission.check();need(self.current()==end,'canonical_source_after_unconfirmed')
  write_new(folder/('source-'+action+'-result.json'),raw({'state':'source_committed','observed_at':self.clock(),'before':source_set(start),'after':source_set(end),'automatic_retry':False}));return self.status(op,action)
 def restore_after_rejected_native(self,op,admission,native_receipt):
  need(os.geteuid()==0 and callable(getattr(admission,'check',None)),'root_admission_object_required');admission.check()
  need(type(native_receipt)is dict and native_receipt.get('executor_terminal')is True and native_receipt.get('definitive_no_effect')is True and native_receipt.get('state')=='rejected_without_effect'and native_receipt.get('session_revoked')is True,'native_no_effect_not_proved')
  folder,b,before,after=self.bundle(op)
  need(native_receipt.get('operation_id')==op and native_receipt.get('component_id')==self.profile['component_id']and native_receipt.get('action')in('apply','rollback'),'native_compensation_binding')
  action=native_receipt['action'];start,end=(before,after)if action=='apply'else(after,before)
  need(self.clock()<self.profile['owner_authorization_expires_at'],'source_owner_window_expired')
  intent=folder/('source-rejected-restore-'+action+'-intent.json');result=folder/('source-rejected-restore-'+action+'-result.json')
  if intent.exists():return self.status(op,action)
  actual=self.current();need(all(actual[p]in(start[p],end[p])for p in self.paths),'source_foreign_change_blocks_restore')
  write_new(intent,raw({'action':action,'observed_at':self.clock(),'native_receipt_sha256':sha(raw(native_receipt)),'automatic_retry':False}))
  for p in self.paths:
   admission.check()
   if actual[p]!=start[p]:replace_owned(self.repo/p,start[p],sha(end[p]),b['metadata'][p])
  need(self.current()==start,'own_source_restore_unconfirmed');admission.check()
  write_new(result,raw({'action':action,'state':'own_sources_restored','observed_at':self.clock(),'automatic_retry':False}));return self.status(op,action)
