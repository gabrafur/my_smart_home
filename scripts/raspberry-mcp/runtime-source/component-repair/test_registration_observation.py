"""The read-side inventory must cover all four already admitted registrations."""
import json,sqlite3,sys,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parent))
import initial_host_contract as c
class InventoryTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.root=Path(self.tmp.name);(self.root/'registrations').mkdir()
  db=sqlite3.connect(self.root/'workflow.sqlite3');db.execute('CREATE TABLE operations(id TEXT,state TEXT)');db.close()
  for p in [patch.object(c,'protected_dir',side_effect=Path),patch.object(c,'read',side_effect=lambda p,*a,**k:Path(p).read_bytes()),patch.object(c,'_root_json',side_effect=lambda p,*a,**k:json.loads(Path(p).read_bytes()))]:p.start();self.addCleanup(p.stop)
 def add(self,n):
  op=('%x'%n)*32;row={'schema_version':1,'identity':{'operation_id':op,'task_id':'a'*32,'send_id':'b'*32,'proposal_id':'c'*32},'request_sha256':'d'*64,'state':'intent','created_at':1,'result':None};(self.root/'registrations'/(op+'.json')).write_text(json.dumps(row))
 def test_fourth_registration_remains_observable(self):
  for n in range(1,5):self.add(n)
  out=c.registration_registry(self.root,lambda:10);self.assertEqual(out['records'],4);self.assertFalse(out['truncated']);self.assertEqual(out['collection_error'],'registration_intent_requires_reconciliation')
 def test_fifth_registration_still_fails_closed(self):
  for n in range(1,6):self.add(n)
  with self.assertRaisesRegex(ValueError,'capacity_changed'):c.registration_registry(self.root,lambda:10)
if __name__=='__main__':unittest.main()
