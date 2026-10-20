import importlib.util,pathlib,tempfile,unittest
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('update',pathlib.Path(__file__).with_name('update-evidence-1.1.1.py'))
u=importlib.util.module_from_spec(spec);spec.loader.exec_module(u)
class UpdateTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.root=pathlib.Path(self.tmp.name)
  for name,value in {'SOURCE':self.root/'source','TARGET':self.root/'target','BACKUP':self.root/'backup','OLD':u.digest(b'old'),'NEW':u.digest(b'new')}.items():
   p=patch.object(u,name,value);p.start();self.addCleanup(p.stop)
  u.SOURCE.write_bytes(b'new');u.TARGET.write_bytes(b'old')
 def test_preflight_no_mutation(self):
  self.assertEqual(u.preflight(),b'new');self.assertEqual(u.TARGET.read_bytes(),b'old');self.assertFalse(u.BACKUP.exists())
 def test_source_conflict(self):
  u.SOURCE.write_bytes(b'other')
  with self.assertRaisesRegex(RuntimeError,'source_changed'):u.preflight()
 def test_target_conflict(self):
  u.TARGET.write_bytes(b'other')
  with self.assertRaisesRegex(RuntimeError,'installed_changed'):u.preflight()
 def test_atomic_replace_and_recovery(self):
  u.replace(u.OLD,b'new');self.assertEqual(u.TARGET.read_bytes(),b'new')
  u.replace(u.NEW,b'old');self.assertEqual(u.TARGET.read_bytes(),b'old')
 def test_concurrent_change_preserved(self):
  u.TARGET.write_bytes(b'concurrent')
  with self.assertRaisesRegex(RuntimeError,'concurrent_change'):u.replace(u.OLD,b'new')
  self.assertEqual(u.TARGET.read_bytes(),b'concurrent');self.assertFalse((self.root/'.evidence-1.1.1.tmp').exists())
 def test_symlink_rejected(self):
  u.TARGET.unlink();u.TARGET.symlink_to(u.SOURCE)
  with self.assertRaises(OSError):u.preflight()
if __name__=='__main__':unittest.main()
