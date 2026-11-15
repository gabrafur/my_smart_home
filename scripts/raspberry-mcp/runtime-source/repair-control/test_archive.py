import json,os,sqlite3,sys,tempfile,types,unittest
from pathlib import Path
from unittest.mock import patch
S=Path(__file__).parent;sys.path.insert(0,str(S))
import repair_control as c
from repair_store import Store,TASK,THREAD
NOW=1794785200;OP='c'*32
class ArchiveTests(unittest.TestCase):
 def setUp(self):
  self.db=sqlite3.connect(':memory:',isolation_level=None)
  self.db.executescript('CREATE TABLE jobs(id TEXT PRIMARY KEY,thread TEXT,intent TEXT,state TEXT,created REAL,updated REAL,attempts INTEGER,turn TEXT,result TEXT);CREATE TABLE audit(seq INTEGER PRIMARY KEY,id TEXT,state TEXT,at REAL)')
  self.archives={};self.s=Store(self.db,clock=lambda:NOW-90000,standing=True,archive_reader=lambda op,h:self.archives[(op,h)])
  self.s.reserve(OP);r={'operation_state':'completed','turn_id':'11111111-1111-4111-8111-111111111111','answer_withheld':True};h=self.s.terminal(OP,r);self.s.reconcile(OP,h)
  self.db.execute('INSERT INTO jobs VALUES(?,?,?,?,?,?,?,?,?)',(OP,THREAD,TASK,'completed',NOW-90000,NOW-89000,1,r['turn_id'],json.dumps(r)))
  self.db.execute('INSERT INTO audit VALUES(?,?,?,?)',(7,OP,'completed',NOW-89000))
 def tearDown(self):self.db.close()
 def archive(self):
  row=self.s.archive_ready(NOW)[0];saved=self.s.archive_payload(row);h='d'*64;self.archives[(OP,h)]=saved;self.s.archive_commit(row,h);return h,saved
 def test_archive_preserves_result_id_and_quota_with_exact_inverse(self):
  h,saved=self.archive();self.assertIsNone(self.db.execute('SELECT 1 FROM jobs').fetchone());self.assertEqual(self.s.get(OP)['result'],saved['result']);self.assertFalse(self.s.reserve(OP));self.assertEqual(self.s.rolling_count(NOW),0)
  self.s.restore_archive(OP,h);self.assertEqual(self.db.execute('SELECT state FROM jobs').fetchone()[0],'completed');self.assertEqual(self.db.execute('SELECT seq FROM audit').fetchone()[0],7)
 def test_no_archive_before_readback(self):
  row=self.s.archive_ready(NOW)[0]
  with self.assertRaises(KeyError):self.s.archive_commit(row,'d'*64)
  self.assertIsNotNone(self.db.execute('SELECT 1 FROM jobs').fetchone())
 def test_successor_audit_collision_refuses_inverse_without_loss(self):
  h,saved=self.archive();self.db.execute('INSERT INTO audit VALUES(?,?,?,?)',(7,'e'*32,'accepted',NOW))
  with self.assertRaisesRegex(ValueError,'audit_conflict'):self.s.restore_archive(OP,h)
  self.assertEqual(self.s.get(OP)['result'],saved['result']);self.assertIsNone(self.db.execute('SELECT 1 FROM jobs').fetchone())
 def test_unacknowledged_or_recent_work_is_not_archived(self):
  self.db.execute('UPDATE repair_receipts SET ack=0');self.assertEqual(self.s.archive_ready(NOW),[])
  self.db.execute('UPDATE repair_receipts SET ack=1,created=?',(NOW-100,));self.assertEqual(self.s.archive_ready(NOW),[])
 def test_audit_race_prevents_compaction(self):
  row=self.s.archive_ready(NOW)[0];saved=self.s.archive_payload(row)
  def reader(op,h):
   self.db.execute('INSERT INTO audit VALUES(?,?,?,?)',(8,OP,'completed',NOW-88000));return saved
  self.s.archive_reader=reader
  with self.assertRaisesRegex(ValueError,'audit_cas_conflict'):self.s.archive_commit(row,'d'*64)
  self.assertIsNotNone(self.db.execute('SELECT 1 FROM jobs').fetchone())
class FileTests(unittest.TestCase):
 def test_partial_write_and_partial_link_recover_same_archive(self):
  # Only this isolated test module substitutes the owner UID; production
  # sources keep their exact protected owner checks. No installed import.
  fixture=types.ModuleType('archive_owner_fixture')
  source=(S/'repair_control.py').read_text().replace('1001',str(os.getuid()))
  exec(compile(source,str(S/'repair_control.py'),'exec'),fixture.__dict__)
  c=fixture
  with tempfile.TemporaryDirectory()as td:
   path=Path(td);r={'operation_state':'completed'};value={'schema':'fixed_repair_archive_v1','operation_id':OP,'task':TASK,'thread_id':THREAD,'terminal_state':'completed','result':r,'result_hash':c.digest(r)};raw=c.archive_bytes(value)
   with patch.object(c,'RECEIPTS',path),patch.object(c,'publish_receipt',return_value='fixed'),patch.object(c.os,'getuid',return_value=path.stat().st_uid):
    stage=path/('eva-health-archive-'+OP+'.json.staging');stage.write_bytes(raw[:20]);stage.chmod(0o600)
    # Fixed UID is substituted with the fixture UID in the isolated capsule.
    h=c.publish_archive(value);self.assertEqual(c.read_archive(OP,h),value);self.assertFalse(stage.exists())
    final=path/('eva-health-archive-'+OP+'.json');c.os.link(final,stage);self.assertEqual(c.publish_archive(value),h);self.assertFalse(stage.exists())
if __name__=='__main__':unittest.main()
