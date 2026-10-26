import copy,hashlib,importlib.util,json,unittest
from pathlib import Path
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('guard',Path(__file__).with_name('recovery_guard.py'));g=importlib.util.module_from_spec(spec);spec.loader.exec_module(g)
class RecoveryGuard(unittest.TestCase):
 def fixture(self):return {'operation_id':g.OP,'manifest_sha256':g.ORIGINAL_MANIFEST,'phase':'failed_cleaned','private_copy_removed':True,'disposable_container_removed':True,'service_start_times_unchanged':True,'new_artifact_integrity_proven':False,'services_restarted':0,'child_failure':{'stage':'authentication_intent','authentication':{'reason':'credential_input_limit','collection_error':None,'authentication_proven':False,'exception_kind':'ValueError'}},'download':{'backup_id_sha256':g.ARTIFACT,'encrypted_sha256':g.CIPHER_SHA,'encrypted_bytes':20480,'downloads':1}}
 def run_original(self,row):
  raw=json.dumps(row).encode();source=b'synthetic_root_code';manifest=json.dumps({'files':{'authenticate.py':hashlib.sha256(source).hexdigest()}}).encode()
  with patch.object(g,'ORIGINAL_RECEIPT',hashlib.sha256(raw).hexdigest()),patch.object(g,'ORIGINAL_MANIFEST',hashlib.sha256(manifest).hexdigest()),patch.object(g,'read',side_effect=lambda path,*a:raw if path.name=='receipt.json'else manifest if path.name=='MANIFEST.json'else source),patch.object(g.os.path,'lexists',return_value=False):
   row['manifest_sha256']=g.ORIGINAL_MANIFEST;raw=json.dumps(row).encode()
   with patch.object(g,'ORIGINAL_RECEIPT',hashlib.sha256(raw).hexdigest()):return g.original()
 def test_only_confirmed_cleaned_pre_cipher_failure_allowed(self):self.assertFalse(self.run_original(self.fixture())['cipher_authentication_before_failure'])
 def test_uncertain_failed_crypto_success_or_unclean_result_rejected(self):
  changes=[lambda r:r.update(phase='outcome_unknown'),lambda r:r.update(private_copy_removed=False),lambda r:r.update(disposable_container_removed=False),lambda r:r.update(service_start_times_unchanged=False),lambda r:r.update(new_artifact_integrity_proven=True),lambda r:r.update(authentication={'authenticated':True}),lambda r:r['child_failure']['authentication'].update(reason='authentication_incomplete'),lambda r:r['child_failure']['authentication'].update(collection_error='unknown'),lambda r:r['download'].update(encrypted_sha256='0'*64),lambda r:r['download'].update(downloads=2)]
  for change in changes:
   r=self.fixture();change(r)
   with self.assertRaises(ValueError):self.run_original(r)
 def approval_row(self):return {'operation_id':g.OP,'manifest_sha256':'a'*64,'original_receipt_sha256':g.ORIGINAL_RECEIPT,'additional_downloads':1,'additional_key_reads':1,'expires_at':g.EXPIRY}
 def test_one_explicit_bound_approval_required(self):
  with patch.object(g,'read',return_value=json.dumps(self.approval_row()).encode()),patch.object(g.time,'time',return_value=g.EXPIRY-1200),patch.object(g.os.path,'lexists',return_value=False):self.assertEqual(g.approval('a'*64)['additional_downloads'],1)
 def test_changed_id_budget_lease_or_extra_fields_refused(self):
  for k,v in [('operation_id','b'*32),('manifest_sha256','b'*64),('additional_downloads',2),('additional_key_reads',True),('expires_at',g.EXPIRY+1),('extra','private')]:
   row=self.approval_row();row[k]=v
   with patch.object(g,'read',return_value=json.dumps(row).encode()),patch.object(g.time,'time',return_value=g.EXPIRY-1200),patch.object(g.os.path,'lexists',return_value=False):
    with self.assertRaises(ValueError):g.approval('a'*64)
 def test_expired_or_revoked_approval_refused(self):
  for now,revoked in [(g.EXPIRY,False),(g.EXPIRY-1200,True)]:
   with patch.object(g,'read',return_value=json.dumps(self.approval_row()).encode()),patch.object(g.time,'time',return_value=now),patch.object(g.os.path,'lexists',return_value=revoked):
    with self.assertRaises(ValueError):g.approval('a'*64)
 def test_no_approval_file_is_not_default_permission(self):
  with patch.object(g,'read',side_effect=FileNotFoundError):
   with self.assertRaises(FileNotFoundError):g.approval('a'*64)
if __name__=='__main__':unittest.main()
