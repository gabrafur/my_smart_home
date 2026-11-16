import contextlib,json,sqlite3,tempfile,types,unittest
from pathlib import Path
from unittest.mock import patch
import repair_control as c
from repair_store import Store,TASK,digest
class UnknownTimeTests(unittest.TestCase):
 def make(self,db):
  db.execute('CREATE TABLE jobs(id TEXT PRIMARY KEY,created REAL,thread TEXT,intent TEXT,state TEXT,updated REAL,attempts INTEGER,turn TEXT,result TEXT)')
  s=Store(db);s.reserve('a'*32);h=s.terminal('a'*32,{'operation_state':'failed','outcome':'preflight_refused_no_send','automatic_retry':False});s.reconcile('a'*32,h)
  return Store(db,standing=True)
 def test_settled_unknown_always_charged_preserves_null_and_hash(self):
  db=sqlite3.connect(':memory:',isolation_level=None);s=self.make(db)
  before=tuple(db.execute('SELECT * FROM repair_receipts').fetchone())
  for now in (100000,200000,9999999999):self.assertEqual(s.rolling_count(now),1)
  self.assertEqual(Store.rolling_accounting(db,200000)['unknown_timestamp_reserved_count'],1)
  self.assertEqual(tuple(db.execute('SELECT * FROM repair_receipts').fetchone()),before)
  s.clock=lambda:200000;s.reserve('b'*32);self.assertEqual(s.rolling_count(200000),2)
  self.assertEqual(s.rolling_count(300000),1)
 def test_unknown_unsettled_corrupt_or_nonterminal_refuses(self):
  for change in ("ack=0","result_hash='wrong'","result='{}'","result=NULL","task='other'"):
   db=sqlite3.connect(':memory:',isolation_level=None);s=self.make(db);db.execute('UPDATE repair_receipts SET '+change)
   with self.assertRaisesRegex(ValueError,'historical_repair_timestamp_unconfirmed'):s.rolling_count(100000)
 def test_readonly_observation_after_revocation_preserves_database(self):
  with tempfile.TemporaryDirectory()as td:
   path=Path(td)/'db';db=sqlite3.connect(path,isolation_level=None);s=self.make(db);db.commit();db.close();before=path.read_bytes()
   tasks=types.SimpleNamespace(LEGACY_DB=path,read=lambda *a:None)
   result=c.quota_observation(tasks)
   self.assertEqual(result['unknown_timestamp_reserved_count'],1);self.assertEqual(path.read_bytes(),before)
 def test_no_timestamp_is_not_compacted_or_forged(self):
  db=sqlite3.connect(':memory:',isolation_level=None);s=self.make(db)
  self.assertEqual(s.archive_ready(9999999999),[])
  self.assertIsNone(db.execute('SELECT created FROM repair_receipts').fetchone()[0])
