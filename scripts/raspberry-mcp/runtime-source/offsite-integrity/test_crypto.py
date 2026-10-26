"""Small synthetic archives only, in the existing pinned image without production data."""
import importlib.util,io,json,os,resource,signal,tarfile,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
from types import SimpleNamespace
from securetar import SecureTarArchive
spec=importlib.util.spec_from_file_location('authenticate','/review/authenticate.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
resource.setrlimit(resource.RLIMIT_AS,(512*1024**2,512*1024**2));resource.setrlimit(resource.RLIMIT_CPU,(10,10));signal.alarm(45)
class CryptoTests(unittest.TestCase):
 def make(self,root,version=3,name='homeassistant.tar.gz'):
  p=root/'backup.tar'
  with SecureTarArchive(name=p,mode='w',password='fixture-only',create_version=version)as archive:
   with archive.create_tar(name)as inner:
    data=b'synthetic-data-only'*64;row=tarfile.TarInfo('fixture.txt');row.size=len(data);inner.addfile(row,io.BytesIO(data))
  return p
 def test_full_stream(self):
  with tempfile.TemporaryDirectory()as tmp:
   proof=m.authenticate(self.make(Path(tmp)),'fixture-only');self.assertTrue(proof['authenticated']);self.assertGreater(proof['complete_plaintext_stream_bytes'],0);self.assertFalse(proof['archive_extracted']);self.assertFalse(proof['payloads_executed'])
 def test_wrong_key_and_corrupt_ciphertext_refused(self):
  with tempfile.TemporaryDirectory()as tmp:
   p=self.make(Path(tmp))
   with self.assertRaises(Exception):m.authenticate(p,'wrong-synthetic-password')
   with tarfile.open(p,'r')as archive:member=archive.getmembers()[0];offset=member.offset_data+member.size-16
   raw=bytearray(p.read_bytes());raw[offset]^=1;p.write_bytes(raw)
   with self.assertRaises(Exception):m.authenticate(p,'fixture-only')
 def test_legacy_and_unexpected_outer_refused(self):
  for version,name in [(2,'homeassistant.tar.gz'),(3,'unexpected.tar.gz')]:
   with tempfile.TemporaryDirectory()as tmp:
    with self.assertRaises(ValueError):m.authenticate(self.make(Path(tmp),version,name),'fixture-only')
 def test_declared_length_and_stream_bounds_refused(self):
  with tempfile.TemporaryDirectory()as tmp:
   p=self.make(Path(tmp))
   with patch('securetar.SecureTarHeader.from_bytes',return_value=SimpleNamespace(version=3,plaintext_size=m.MAX_PLAINTEXT_BYTES+1)):
    with self.assertRaises(ValueError):m.authenticate(p,'fixture-only')
   with patch.object(m,'MAX_PLAINTEXT_BYTES',1):
    with self.assertRaises(ValueError):m.authenticate(p,'fixture-only')
 def test_truncated_ciphertext_refused(self):
  with tempfile.TemporaryDirectory()as tmp:
   p=self.make(Path(tmp))
   with tarfile.open(p,'r')as archive:member=archive.getmembers()[0];cut=member.offset_data+member.size-16
   p.write_bytes(p.read_bytes()[:cut])
   with self.assertRaises(Exception):m.authenticate(p,'fixture-only')
if __name__=='__main__':
 assert os.geteuid()==1001
 suite=unittest.defaultTestLoader.loadTestsFromTestCase(CryptoTests);result=unittest.TextTestRunner(verbosity=0).run(suite)
 print(json.dumps({'tests':result.testsRun,'passed':result.wasSuccessful(),'production_mounts':False,'real_backup_verified':False}));raise SystemExit(0 if result.wasSuccessful()else 1)
