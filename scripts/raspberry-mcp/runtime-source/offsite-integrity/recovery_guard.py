"""Closed reconciliation guard. Original receipts remain immutable, no uncertain replay."""
import hashlib,json,os,stat,time
from pathlib import Path
BASE=Path('/run/raspberry-offsite-integrity-reconciliation-binding')
ORIGINAL=Path('/var/lib/raspberry-offsite-integrity-operation-binding')
ORIGINAL_STAGE=Path('/run/raspberry-offsite-integrity-original-binding')
ORIGINAL_KEY=Path('/var/lib/raspberry-offsite-integrity-key-original-binding')
OP='OPERATION_ID_BINDING'
ARTIFACT='ARTIFACT_ID_SHA256_BINDING'
ORIGINAL_MANIFEST='ORIGINAL_MANIFEST_SHA256_BINDING'
ORIGINAL_RECEIPT='ORIGINAL_RECEIPT_SHA256_BINDING'
ORIGINAL_KEY_RECEIPT='ORIGINAL_KEY_RECEIPT_SHA256_BINDING'
CIPHER_SHA='CIPHER_SHA256_BINDING'
EXPIRY=1793048374+764524/1000000

def need(v,r):
 if not v:raise ValueError(r)
def read(path,owner,mode,limit=1048576):
 for p in path.parents:need(not p.is_symlink(),'unsafe_reconciliation_parent')
 fd=os.open(path,os.O_RDONLY|os.O_NONBLOCK|os.O_NOFOLLOW)
 try:
  info=os.fstat(fd);need(stat.S_ISREG(info.st_mode)and info.st_uid==owner and stat.S_IMODE(info.st_mode)==mode and info.st_nlink==1 and info.st_size<=limit,'unsafe_reconciliation_file');raw=os.read(fd,limit+1);need(len(raw)<=limit,'reconciliation_input_limit');return raw
 finally:os.close(fd)
def original():
 raw=read(ORIGINAL/'receipt.json',1001,0o600,65536);need(hashlib.sha256(raw).hexdigest()==ORIGINAL_RECEIPT,'original_receipt_changed');r=json.loads(raw)
 need(r['operation_id']==OP and r['manifest_sha256']==ORIGINAL_MANIFEST and r['phase']=='failed_cleaned'and r['private_copy_removed']is True and r['disposable_container_removed']is True and r['service_start_times_unchanged']is True and r['new_artifact_integrity_proven']is False and r['services_restarted']==0,'original_operation_not_safe_to_reconcile')
 failure=r.get('child_failure',{});safe=failure.get('authentication',{});need(failure.get('stage')=='authentication_intent'and safe.get('reason')=='credential_input_limit'and safe.get('collection_error')is None and safe.get('authentication_proven')is False and safe.get('exception_kind')=='ValueError'and not r.get('authentication'),'original_cipher_execution_not_confirmed_absent')
 d=r['download'];need(d['backup_id_sha256']==ARTIFACT and d['encrypted_sha256']==CIPHER_SHA and d['encrypted_bytes']==20480 and d['downloads']==1,'original_artifact_proof_changed');need(not os.path.lexists(ORIGINAL/'backup.tar'),'original_private_copy_not_cleaned')
 raw=read(ORIGINAL_STAGE/'MANIFEST.json',0,0o644);need(hashlib.sha256(raw).hexdigest()==ORIGINAL_MANIFEST,'original_manifest_changed');m=json.loads(raw)
 for name,digest in m['files'].items():need('/'not in name and hashlib.sha256(read(ORIGINAL_STAGE/name,0,0o644)).hexdigest()==digest,'original_source_evidence_changed')
 return {'original_receipt_sha256':ORIGINAL_RECEIPT,'original_manifest_sha256':ORIGINAL_MANIFEST,'original_downloads':1,'original_key_reads':1,'cipher_authentication_before_failure':False}
def original_key():
 raw=read(ORIGINAL_KEY/'receipt.json',0,0o600);need(hashlib.sha256(raw).hexdigest()==ORIGINAL_KEY_RECEIPT,'original_key_receipt_changed');r=json.loads(raw);need(r['operation_id']==OP and r['manifest_sha256']==ORIGINAL_MANIFEST and r['state']=='delivered_to_private_parent_pipe'and r['key_stored']is False and not os.path.lexists(ORIGINAL_KEY/'uncertain.json'),'original_key_outcome_uncertain')
def approval(pin):
 raw=read(BASE/'RECOVERY-APPROVAL.json',0,0o644);r=json.loads(raw)
 need(set(r)=={'operation_id','manifest_sha256','original_receipt_sha256','additional_downloads','additional_key_reads','expires_at'},'reconciliation_approval_shape')
 need(r['operation_id']==OP and r['manifest_sha256']==pin and r['original_receipt_sha256']==ORIGINAL_RECEIPT and type(r['additional_downloads'])is int and r['additional_downloads']==1 and type(r['additional_key_reads'])is int and r['additional_key_reads']==1 and r['expires_at']==EXPIRY and time.time()<EXPIRY,'specific_reconciliation_approval_unconfirmed')
 need(not os.path.lexists(BASE/'revoked'),'reconciliation_revoked');return r
