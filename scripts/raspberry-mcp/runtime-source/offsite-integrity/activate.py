"""Root activation of a separately approved, single known-no-cipher reconciliation."""
import hashlib,importlib.util,json,os,stat,sys,time
from pathlib import Path
BASE=Path('/run/raspberry-offsite-integrity-reconciliation-binding')
OP='OPERATION_ID_BINDING'
EXPIRY=1793048374+764524/1000000

def need(v,r):
 if not v:raise ValueError(r)
def read(path):
 for p in path.parents:
  s=p.lstat();need(stat.S_ISDIR(s.st_mode)and s.st_uid==0 and not s.st_mode&0o022,'unsafe_root_parent')
 fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
 try:
  s=os.fstat(fd);need(stat.S_ISREG(s.st_mode)and s.st_uid==0 and stat.S_IMODE(s.st_mode)==0o644 and s.st_nlink==1 and s.st_size<=1048576,'unsafe_root_source');b=os.read(fd,1048577);need(len(b)<=1048576,'source_limit');return b
 finally:os.close(fd)
def load(name):
 spec=importlib.util.spec_from_file_location('reconciliation_'+name,BASE/(name+'.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
def checked():
 raw=read(BASE/'MANIFEST.json');pin=read(BASE/'MANIFEST.sha256').decode().strip();need(hashlib.sha256(raw).hexdigest()==pin,'manifest_changed');m=json.loads(raw)
 need(m['operation_id']==OP and m['reconciliation_revision']=='stdin_r2'and m['additional_downloads_allowed']==m['additional_key_reads_allowed']==1 and m['deadline']==('2026-10-26T20:59:34.'+'764524Z'),'specific_reconciliation_scope_changed')
 for name,digest in m['files'].items():need('/'not in name and hashlib.sha256(read(BASE/name)).hexdigest()==digest,'sealed_reconciliation_source_changed')
 guard=load('recovery_guard');guard.original();guard.original_key();reader=load('native_key_reader');reader.authority(1200)
 need(not os.path.lexists(BASE/'RECOVERY-APPROVAL.json')and not os.path.lexists(reader.STATE)and not os.path.lexists(reader.OPERATION),'existing_recovery_intent_requires_reconciliation');return pin,guard

def main():
 need(os.geteuid()==0 and Path(__file__)==BASE/'activate.py'and sys.argv[1:]in(['preflight'],['apply-approved']),'fixed_root_activation_required');pin,guard=checked()
 if sys.argv[1]=='preflight':return {'state':'recovery_package_preflight_passed_not_activated','key_read':False,'download_started':False,'same_operation_id':OP,'specific_approval_required':True}
 row={'operation_id':OP,'manifest_sha256':pin,'original_receipt_sha256':guard.ORIGINAL_RECEIPT,'additional_downloads':1,'additional_key_reads':1,'expires_at':EXPIRY};fd=os.open(BASE/'RECOVERY-APPROVAL.json',os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o644)
 try:
  os.fchmod(fd,0o644)
  with os.fdopen(os.dup(fd),'w')as f:json.dump(row,f,sort_keys=True);f.write('\n');f.flush();os.fsync(f.fileno())
 finally:os.close(fd)
 fd=os.open(BASE,os.O_RDONLY|os.O_DIRECTORY)
 try:os.fsync(fd)
 finally:os.close(fd)
 guard.approval(pin);return {'state':'specific_known_failure_reconciliation_activated','operation_id':OP,'new_MCP_access':False,'new_accounts':0,'deadline':EXPIRY,'original_receipts_preserved':True,'key_read':False,'download_started':False}
if __name__=='__main__':
 try:print(json.dumps(main()))
 except Exception as e:print(json.dumps({'state':'not_accepted','exception_kind':type(e).__name__,'reason':str(e)if type(e)is ValueError else'withheld','automatic_retry':False}));raise SystemExit(1)
