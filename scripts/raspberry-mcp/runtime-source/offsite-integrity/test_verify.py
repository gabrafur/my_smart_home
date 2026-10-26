import hashlib,importlib.util,json,os,subprocess,tempfile,types,unittest
from pathlib import Path
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('verification',Path(__file__).with_name('verify.py'));v=importlib.util.module_from_spec(spec);spec.loader.exec_module(v)
class VerificationTests(unittest.TestCase):
 def test_existing_operation_is_never_repeated(self):
  raw=b'{"files":{},"operation_id":"fixture"}'
  with tempfile.TemporaryDirectory()as tmp,patch.object(v,'ROOT',Path(tmp)),patch.object(v,'sealed_file',return_value=raw),patch.object(v,'sources'),patch.object(v,'__file__',str(v.BASE/'verify.py')),patch.object(v.sys,'argv',['verify.py',hashlib.sha256(raw).hexdigest()]),patch.object(v,'run')as run:
   with self.assertRaisesRegex(ValueError,'existing_operation_requires_readonly_reconciliation'):v.preflight()
   run.assert_not_called()
 def test_hash_streaming_and_identity(self):
  with tempfile.TemporaryDirectory()as tmp:
   p=Path(tmp)/'cipher';data=b'x'*200000;p.write_bytes(data);p.chmod(0o600)
   with patch.object(v,'MANIFEST',{'encrypted_size_bytes':len(data)}):
    self.assertEqual(v.cipher_hash(p),hashlib.sha256(data).hexdigest())
    p.chmod(0o644)
    with self.assertRaises(ValueError):v.cipher_hash(p)
 def test_metadata_reader_refuses_large_input(self):
  with self.assertRaisesRegex(ValueError,'metadata_limit'):v.file(Path('/unused'),1048577)
 def test_failed_child_never_exports_private_text_or_key(self):
  result=types.SimpleNamespace(returncode=1,stdout=b'PRIVATE_SECRET',stderr=b'PRIVATE_ERROR')
  with patch.object(v.subprocess,'run',return_value=result),patch.object(v,'RECEIPT',{'phase':'existing_key_read_intent'}),patch.object(v,'record')as record:
   with self.assertRaises(ValueError):v.run(['docker','exec','fixed'])
   self.assertNotIn('PRIVATE',str(record.call_args));self.assertEqual(record.call_args.kwargs['child_failure']['stdout_bytes'],14)
 def test_uncertain_container_inspection_does_not_remove(self):
  with patch.object(v,'MANIFEST',{'operation_id':'fixture','image':'fixture-image'}),patch.object(v.subprocess,'run',return_value=types.SimpleNamespace(returncode=1,stdout=b'',stderr=b'cannot connect')),patch.object(v,'run')as run:
   with self.assertRaises(ValueError):v.cleanup_container()
   run.assert_not_called()
 def test_cleanup_only_matches_own_label_and_image(self):
  manifest={'operation_id':'fixture','image':'fixture-image'}
  for label,image,allowed in [('other','fixture-image',False),('fixture','other-image',False),('fixture','fixture-image',True)]:
   result=types.SimpleNamespace(returncode=0,stdout=(json.dumps({v.LABEL:label})+' '+image).encode(),stderr=b'')
   with patch.object(v,'MANIFEST',manifest),patch.object(v.subprocess,'run',return_value=result),patch.object(v,'run')as run:
    if allowed:v.cleanup_container();self.assertEqual(run.call_args.args[0],['docker','rm','--force','offsite-integrity-fixture'])
    else:
     with self.assertRaises(ValueError):v.cleanup_container()
     run.assert_not_called()
 def test_crypto_failure_reason_is_retained_without_raw_error(self):
  import importlib.util
  spec=importlib.util.spec_from_file_location('safe_projection',Path(__file__).with_name('crypto_diagnostic.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
  data={'authenticated':False,'error':'plaintext_size_limit','exception_kind':'ValueError','raw_error_withheld':True,'automatic_retry':False}
  result=types.SimpleNamespace(returncode=1,stdout=json.dumps(data).encode(),stderr=b'PRIVATE_SECRET')
  with patch.object(v.subprocess,'run',return_value=result),patch.object(v,'SAFE_CRYPTO_PROJECTOR',m.project),patch.object(v,'RECEIPT',{'phase':'authentication_intent'}),patch.object(v,'record')as record:
   with self.assertRaisesRegex(ValueError,'fixed_child_failed'):v.run(['docker','start','--attach','--interactive','synthetic'])
   failure=record.call_args.kwargs['child_failure'];self.assertEqual(failure['authentication']['reason'],'plaintext_size_limit');self.assertNotIn('PRIVATE',str(failure))
 def test_unclassified_crypto_error_stays_unknown(self):
  import importlib.util
  spec=importlib.util.spec_from_file_location('safe_unknown_projection',Path(__file__).with_name('crypto_diagnostic.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
  result=types.SimpleNamespace(returncode=1,stdout=b'PRIVATE_SECRET',stderr=b'')
  with patch.object(v.subprocess,'run',return_value=result),patch.object(v,'SAFE_CRYPTO_PROJECTOR',m.project),patch.object(v,'RECEIPT',{'phase':'authentication_intent'}),patch.object(v,'record')as record:
   with self.assertRaises(ValueError):v.run(['docker','start','--attach','--interactive','synthetic'])
   failure=record.call_args.kwargs['child_failure'];self.assertEqual(failure['authentication']['reason'],'authentication_reason_unavailable');self.assertNotIn('PRIVATE',str(failure))
 def test_headroom_uses_actual_download_filesystem_and_keeps_limits(self):
  for free,used,total,allowed in [(3*1024**3,3*1024**3,6*1024**3,True),(1024**3,3*1024**3,4*1024**3,False),(3*1024**3,30*1024**3,33*1024**3,False)]:
   with patch.object(v.shutil,'disk_usage',return_value=types.SimpleNamespace(free=free,used=used,total=total))as usage:
    if allowed:v.disk_preflight()
    else:
     with self.assertRaisesRegex(ValueError,'insufficient_disk_headroom'):v.disk_preflight()
    usage.assert_called_once_with(v.ROOT.parent)
 def test_operation_deadline_caps_child_and_allows_bounded_cleanup(self):
  result=types.SimpleNamespace(returncode=0,stdout=b'{}',stderr=b'')
  with patch.object(v,'OPERATION_DEADLINE',200),patch.object(v,'CLEANING_UP',False),patch.object(v.time,'monotonic',return_value=100),patch.object(v.time,'time',return_value=v.EXPIRY-1000),patch.object(v.subprocess,'run',return_value=result)as run:
   v.run(['fixed'],timeout=510);self.assertEqual(run.call_args.kwargs['timeout'],100)
  with patch.object(v,'OPERATION_DEADLINE',90),patch.object(v,'CLEANING_UP',False),patch.object(v.time,'monotonic',return_value=100),patch.object(v.time,'time',return_value=v.EXPIRY-1000),patch.object(v.subprocess,'run',return_value=result)as run:
   with self.assertRaisesRegex(ValueError,'operation_deadline_reached'):v.run(['fixed'])
   run.assert_not_called()
  with patch.object(v,'OPERATION_DEADLINE',90),patch.object(v,'CLEANING_UP',True),patch.object(v.time,'time',return_value=v.EXPIRY-1000),patch.object(v.subprocess,'run',return_value=result)as run:
   v.run(['fixed'],timeout=15);self.assertEqual(run.call_args.kwargs['timeout'],15)
if __name__=='__main__':unittest.main()
