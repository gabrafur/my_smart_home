"""Only synthetic files in TemporaryDirectory; never collect/process production."""
import contextlib
import fcntl
import hashlib
import importlib.util
import io
import os
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import Mock,patch
PUBLIC=Path(__file__).resolve().parent.parent
H=PUBLIC/'runtime-source/procmon-observability'
def load(name,path):
 spec=importlib.util.spec_from_file_location(name,path);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
W=load('canonical_procmon_wrapper',H/'observed_collector.py')
class Repeated(unittest.TestCase):
 def setUp(self):
  self.mod=load('immutable_collector_fixture',PUBLIC/'procmon-observability/collector.source.py')
  self.assertEqual(hashlib.sha256((PUBLIC/'procmon-observability/collector.source.py').read_bytes()).hexdigest(),W.COLLECTOR_SHA)
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.state=Path(self.tmp.name)
  for name in ('history','hours','public'):(self.state/name).mkdir(mode=0o700)
  self.fd=os.open(self.state/'lock',os.O_RDWR|os.O_CREAT|os.O_EXCL,0o600)
  os.fchmod(self.fd,0o600);fcntl.flock(self.fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
  self.addCleanup(lambda:os.close(self.fd))
  self.source=self.state/'public/health.json.tmp'
  self.archive=self.state/'interrupted';self.archive.mkdir(mode=0o700)
  self.digest=hashlib.sha256(b'').hexdigest()
  self.prior=self.archive/('public--health.json--'+self.digest+'.tmp');self.write(self.prior,b'',0o640)
 def write(self,path,body,mode):path.write_bytes(body);path.chmod(mode)
 def preserve(self):
  with contextlib.redirect_stderr(io.StringIO()):return W.preserve_repeated(self.mod,self.mod.preserve_interrupted,self.state)
 def test_distinct_empty_same_name_preserves_both_and_does_not_promote(self):
  self.write(self.source,b'',0o640);before=self.source.stat();old=self.prior.stat()
  rows=self.preserve();bucket=self.state/W.REPEATED_DIRECTORY
  self.assertEqual(len(rows),1);self.assertFalse(self.source.exists());self.assertTrue(self.prior.exists())
  self.assertEqual(self.prior.stat().st_ino,old.st_ino);self.assertEqual(len(list(bucket.iterdir())),1)
  saved=next(bucket.iterdir());self.assertEqual(saved.stat().st_ino,before.st_ino)
  self.assertEqual(saved.read_bytes(),b'');self.assertFalse(rows[0]['promoted_to_observation'])
  self.assertFalse((self.state/'public/health.json').exists())
 def test_repeated_empty_writes_get_distinct_live_inode_names(self):
  names=[]
  for _ in range(3):
   self.write(self.source,b'',0o640);self.preserve();names.append({p.name for p in (self.state/W.REPEATED_DIRECTORY).iterdir()})
  self.assertEqual([len(n) for n in names],[1,2,3]);self.assertEqual(self.preserve(),[])
 def test_original_legacy_preservation_still_handles_nonconflicting_content(self):
  body=b'{"synthetic":true}'
  self.write(self.source,body,0o640);rows=self.preserve()
  self.assertEqual(len(rows),1);self.assertFalse(self.source.exists())
  self.assertFalse((self.state/W.REPEATED_DIRECTORY).exists());self.assertEqual(len(list(self.archive.iterdir())),2)
 def test_same_digest_filename_with_different_body_is_not_adopted(self):
  self.write(self.prior,b'forged',0o640);self.write(self.source,b'',0o640)
  with self.assertRaisesRegex(ValueError,'interrupted_archive_conflict'):self.preserve()
  self.assertTrue(self.source.exists());self.assertEqual(self.prior.read_bytes(),b'forged')
 def test_both_buckets_and_pending_share_global_count_cap(self):
  self.write(self.source,b'',0o640);self.preserve();self.write(self.source,b'',0o640)
  self.mod.INTERRUPTED_COUNT=2
  with self.assertRaisesRegex(ValueError,'interrupted_archive_full'):self.preserve()
  self.assertTrue(self.source.exists());self.assertEqual(len(list(self.archive.iterdir())),1)
  self.assertEqual(len(list((self.state/W.REPEATED_DIRECTORY).iterdir())),1)
 def test_both_buckets_and_pending_share_global_byte_cap(self):
  self.write(self.source,b'',0o640);self.preserve();self.write(self.source,b'x',0o640)
  self.mod.INTERRUPTED_CAP=0
  with self.assertRaisesRegex(ValueError,'interrupted_archive_full'):self.preserve()
  self.assertEqual(self.source.read_bytes(),b'x')
 def test_invalid_bucket_mode_name_inode_or_link_preserved(self):
  self.write(self.source,b'',0o640);self.preserve();bucket=self.state/W.REPEATED_DIRECTORY
  saved=next(bucket.iterdir());saved.chmod(0o600)
  with self.assertRaisesRegex(ValueError,'unsafe_interrupted_archive'):self.preserve()
  self.assertTrue(saved.exists())
 def test_missing_kernel_flock_refused_before_original_or_move(self):
  self.write(self.source,b'',0o640);fcntl.flock(self.fd,fcntl.LOCK_UN)
  original=Mock()
  with self.assertRaisesRegex(ValueError,'collector_mutex_not_held'):W.preserve_repeated(self.mod,original,self.state)
  original.assert_not_called();self.assertTrue(self.source.exists())
 def test_nonreplace_race_never_overwrites_target(self):
  source=self.state/'synthetic-source';target=self.state/'synthetic-target'
  self.write(source,b'new',0o600);self.write(target,b'existing',0o600)
  with self.assertRaisesRegex(ValueError,'interrupted_archive_conflict'):W._rename_preserved_no_replace(source,target)
  self.assertEqual(source.read_bytes(),b'new');self.assertEqual(target.read_bytes(),b'existing')
 def test_wrapper_install_preserves_original_hash_limits_and_sampler_order(self):
  W.Observer().install(self.mod)
  self.assertEqual(self.mod.INTERRUPTED_COUNT,64);self.assertEqual(self.mod.INTERRUPTED_CAP,8*1048576)
  self.assertEqual(self.mod.MAX_SAMPLE,1048576)
  self.write(self.source,b'',0o640)
  with contextlib.redirect_stderr(io.StringIO()):rows=self.mod.preserve_interrupted(self.state)
  self.assertEqual(len(rows),1)
  self.assertEqual(W.COLLECTOR_SHA,'d53a173123b0d6d96406e56bd73559fd5fd00d6dd040bf36cf2c21b978e1b277')
if __name__=='__main__':unittest.main()
