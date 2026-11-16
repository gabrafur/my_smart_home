import sys,json,tempfile,unittest,sqlite3
from pathlib import Path
sys.path.insert(0,str(Path(__file__).parent))
from task_store import Store,fingerprint,HISTORY_RESULT,history_read
class Retention(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.now=200000.;self.s=Store(str(Path(self.tmp.name)/'tasks.sqlite3'),clock=lambda:self.now)
 def tearDown(self):self.s.close();self.tmp.cleanup()
 def task(self,n=1,updated=1,state='created',reconciled=1):
  key=f'{n:032x}';thread=f'{n:08x}-0000-0000-0000-000000000000'
  self.s.db.execute('INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?)',(key,'task-'+key,'s'*64,thread,state,1,updated,reconciled));return key,thread
 def send(self,task,n=100,state='completed',reconciled=1,checkpoint=True,updated=2):
  key=f'{n:032x}';body={'state':state,'reply':'safe'}
  self.s.db.execute('INSERT INTO sends VALUES(?,?,?,?,?,?,?,?,?)',(key,task,'a'*64,state,None,1,updated,json.dumps(body),reconciled))
  if checkpoint:self.s.db.execute('INSERT INTO result_checkpoints VALUES(?,?,?,?,?)',(key,fingerprint(body),state,1,updated))
  return key
 def test_archive_hydrates_exact_receipt_checkpoint_and_task_id(self):
  t,_=self.task();s=self.send(t);before=self.s.row('sends',s)
  self.s.archive_terminal_history();after=self.s.row('sends',s)
  self.assertEqual(before['result'],after['result']);self.assertEqual(before['central_checkpoint'],after['central_checkpoint'])
  self.assertEqual(self.s.db.execute('SELECT state FROM tasks').fetchone()[0],'archived');self.assertEqual(self.s.row('tasks',t)['state'],'created')
 def test_uncertain_unacknowledged_recent_never_archive(self):
  for n,(state,ack,updated) in enumerate([('outcome_unknown',1,1),('completed',0,1),('completed',1,self.now)],1):
   t,_=self.task(n);self.send(t,100+n,state,ack,updated=updated)
  self.s.archive_terminal_history();self.assertEqual(self.s.db.execute('SELECT count(*)FROM history_refs').fetchone()[0],0)
 def test_missing_checkpoint_preserves_gap(self):
  t,_=self.task();s=self.send(t,checkpoint=False);self.s.archive_terminal_history()
  self.assertNotEqual(self.s.db.execute('SELECT result FROM sends').fetchone()[0],HISTORY_RESULT);self.assertEqual(self.s.db.execute('SELECT state FROM tasks').fetchone()[0],'created')
 def test_not_dispatched_keeps_state_budget_timestamp(self):
  t,_=self.task();s=self.send(t,state='not_dispatched');self.s.archive_terminal_history()
  r=self.s.db.execute('SELECT state,created,updated FROM sends').fetchone();self.assertEqual(tuple(r),('not_dispatched',1,2))
 def test_reactivation_keeps_unique_identity_and_history(self):
  t,thread=self.task();self.send(t);self.s.archive_terminal_history();self.s.activate_task(t);self.s.archive_terminal_history()
  self.assertEqual(self.s.db.execute('SELECT state,thread,updated FROM tasks').fetchone()[:],('created',thread,self.now));self.assertIsNotNone(history_read(self.s.db,'tasks',t))
  with self.assertRaises(sqlite3.IntegrityError):self.task()
 def test_history_tamper_fails_closed(self):
  t,_=self.task();s=self.send(t);self.s.archive_terminal_history()
  db=sqlite3.connect(Path(self.tmp.name)/'task-history.sqlite3');db.execute("UPDATE snapshots SET body=x'0000'WHERE kind='sends'");db.commit();db.close()
  with self.assertRaises(Exception):self.s.row('sends',s)
 def test_archive_write_then_cas_failure_preserves_primary(self):
  t,_=self.task();s=self.send(t);original=self.s._archive_snapshot
  def race(kind,identity,snapshot):
   result=original(kind,identity,snapshot)
   if kind=='sends':self.s.db.execute('UPDATE sends SET updated=3 WHERE id=?',(identity,))
   return result
  self.s._archive_snapshot=race
  with self.assertRaisesRegex(ValueError,'CAS'):self.s.archive_terminal_history()
  self.assertNotEqual(self.s.db.execute('SELECT result FROM sends').fetchone()[0],HISTORY_RESULT)
  self.s._archive_snapshot=original;self.s.archive_terminal_history();self.assertEqual(self.s.row('sends',s)['updated'],3)
 def test_profiles_old_receipts_do_not_consume_active_slots(self):
  t,thread=self.task();s=self.send(t)
  for n in range(260):self.s.db.execute('INSERT INTO profile_transitions VALUES(?,?,?,?,?,?,?,?,?)',(f'{n+1000:032x}',s,thread,'a'*64,'send','confirmed','{}',1,2))
  self.s.archive_terminal_history(limit=300)
  self.assertEqual(self.s.db.execute("SELECT count(*)FROM profile_transitions WHERE state!='archived'").fetchone()[0],0)
  old=self.s.begin_profile_transition(f'{1000:032x}',s,thread,'a'*64,'send');self.assertEqual(old['state'],'confirmed')
  self.assertIsNone(self.s.begin_profile_transition('f'*32,'e'*32,thread,'a'*64,'send'))
 def test_unknown_profile_blocks_other_resume_without_evict(self):
  t,thread=self.task();self.s.begin_profile_transition('a'*32,t,thread,'b'*64,'send');self.s.finish_profile_transition('a'*32,'uncertain',None)
  with self.assertRaisesRegex(ValueError,'uncertain'):self.s.begin_profile_transition('c'*32,t,thread,'b'*64,'send')
  self.now+=1000000;self.s.archive_terminal_history();self.assertEqual(self.s.db.execute('SELECT state FROM profile_transitions').fetchone()[0],'uncertain')
 def test_more_than_old_window_preserves_ids(self):
  for i in range(1,131):self.task(i)
  self.s.archive_terminal_history(limit=140)
  self.assertEqual(self.s.db.execute("SELECT count(*)FROM tasks WHERE state!='archived'").fetchone()[0],0)
  self.assertEqual(self.s.row('tasks',f'{130:032x}')['id'],f'{130:032x}')
 def test_source_rollback_restores_receipts_atomically_preserves_archive(self):
  t,_=self.task();op=self.send(t);self.s.archive_terminal_history()
  result=self.s.restore_history_for_source_rollback();self.assertEqual(result['state'],'exact_history_restored')
  self.assertEqual(self.s.db.execute('SELECT state FROM tasks').fetchone()[0],'created')
  self.assertNotEqual(self.s.db.execute('SELECT result FROM sends').fetchone()[0],HISTORY_RESULT)
  self.assertEqual(self.s.db.execute('SELECT count(*)FROM result_checkpoints').fetchone()[0],1)
  self.assertIsNotNone(history_read(self.s.db,'sends',op))
  self.s.restore_history_for_source_rollback()
 def test_source_rollback_conflict_does_not_partially_restore(self):
  t,_=self.task();self.send(t);self.s.archive_terminal_history();self.s.db.execute('UPDATE sends SET turn=?',('foreign',))
  with self.assertRaisesRegex(ValueError,'tombstone_changed'):self.s.restore_history_for_source_rollback()
  self.assertEqual(self.s.db.execute('SELECT state FROM tasks').fetchone()[0],'archived')
  self.assertEqual(self.s.db.execute('SELECT result FROM sends').fetchone()[0],HISTORY_RESULT)
if __name__=='__main__':unittest.main()
