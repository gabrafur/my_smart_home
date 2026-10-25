import json
from pathlib import Path
import sqlite3
import tempfile
import types
import unittest
from unittest.mock import patch
import task_list as listing
from task_store import Store,fingerprint

NOW=1792889000
A='00000000-0000-7000-8000-000000000001'
B='00000000-0000-7000-8000-000000000002'
TASK_A='a'*32
TASK_B='b'*32
SEND='c'*32

class ListingTests(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.path=Path(self.temp.name)
  self.store=Store(self.path/'jobs.sqlite3',clock=lambda:NOW)
  self.store.db.execute('INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?)',(TASK_A,'older', '0'*64,A,'created',NOW-200,NOW-150,1))
  self.store.db.execute('INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?)',(TASK_B,'newer', '1'*64,B,'cancelled_before_first_send',NOW-100,NOW-20,1))
  self.store.db.execute('INSERT INTO sends VALUES(?,?,?,?,?,?,?,?,?)',(SEND,TASK_A,'2'*64,'completed','00000000-0000-7000-8000-000000000003',NOW-60,NOW-5,json.dumps({'operation_state':'completed','started_at':NOW-60,'completed_at':NOW-30}),1))
  self.legacy=self.path/'legacy.sqlite3';db=sqlite3.connect(self.legacy);db.execute('CREATE TABLE jobs(id,thread,state,turn,created,updated,result)');db.commit();db.close()
  self.tasks=types.SimpleNamespace(STATE=self.path,LEGACY_DB=self.legacy,read=lambda *args:b'')
  self.calls=[]
 def tearDown(self):self.store.close();self.temp.cleanup()
 def invoke(self,q):
  self.calls.append(q)
  return {'rows':[{'thread_id':i,'status':'notLoaded' if i==B else 'idle','can_accept_direct_input':i!=B,'created_at':NOW-100 if i==B else NOW-200,'updated_at':NOW-40 if i==B else NOW-10,'durable':True,'collection_error':None} for i in q['thread_ids']]}
 def get(self,size=2,cursor=None,invoke=None):
  return listing.collect({'host':'raspberry','page_size':size,'cursor':cursor},self.tasks,invoke or self.invoke,NOW)
 def test_existing_new_old_order_and_separate_latest_execution(self):
  page=self.get(16)
  self.assertEqual(len(page['threads']),5)
  self.assertEqual(page['latest_created_thread']['thread_id'],B)
  self.assertEqual(page['latest_executed_thread']['thread_id'],A)
  dates=[r['last_activity_at'] for r in page['threads']]
  self.assertEqual(dates,sorted(dates,reverse=True))
  self.assertTrue(page['coverage_partial'])
  for row in page['threads']:
   self.assertIsNone(row['open_link']);self.assertEqual(row['compatible_platforms'],[])
   self.assertNotIn('operations',row)
 def test_pagination_has_no_duplicates_or_omissions(self):
  seen=[];cursor=None
  while True:
   page=self.get(1,cursor);seen.extend(r['thread_id'] for r in page['threads']);cursor=page['next_cursor']
   if not cursor:break
  self.assertEqual(len(seen),5);self.assertEqual(len(set(seen)),5)
 def test_not_loaded_not_terminal_or_input_ready(self):
  row=next(r for r in self.get(16)['threads'] if r['thread_id']==B)
  self.assertEqual(row['state'],'notLoaded');self.assertFalse(row['notLoaded_is_terminal']);self.assertFalse(row['can_accept_input'])
  self.assertEqual(row['adapter_creation_state'],'cancelled_before_first_send')
 def test_collection_failure_preserves_registry_and_unknown(self):
  def fail(q):raise TimeoutError()
  page=self.get(16,invoke=fail)
  self.assertEqual(page['collection_error'],'partial_collection_failure')
  self.assertTrue(all(r['state']=='unknown' and not r['can_accept_input'] for r in page['threads']))
 def test_changed_snapshot_requires_restart(self):
  page=self.get(1);self.store.db.execute('UPDATE tasks SET updated=updated+1 WHERE id=?',(TASK_A,))
  changed=self.get(1,page['next_cursor']);self.assertEqual(changed['collection_error'],'snapshot_changed');self.assertEqual(changed['threads'],[])
 def test_invalid_cursor_and_page_size_fail_closed(self):
  for size,cursor in [(True,None),(0,None),(17,None),(1,'not json'),(1,'e30')]:
   with self.assertRaises(ValueError):self.get(size,cursor)
 def test_listing_never_mutates_sqlite_or_resumes(self):
  before=self.store.db.total_changes;contents=(self.path/'jobs.sqlite3').read_bytes()
  self.get(16)
  self.assertEqual(self.store.db.total_changes,before);self.assertEqual((self.path/'jobs.sqlite3').read_bytes(),contents)
  self.assertTrue(all(c['mode']=='metadata_batch' for c in self.calls))
 def test_collector_cannot_inject_unauthorized_identity(self):
  page=self.get(16,invoke=lambda q:{'rows':[{'thread_id':'00000000-0000-7000-8000-000000000099','status':'idle'}]})
  self.assertEqual(page['collection_error'],'partial_collection_failure')
  self.assertEqual(len(page['threads']),5)
 def test_observation_poll_is_not_thread_activity(self):
  row=next(r for r in self.get(16)['threads'] if r['thread_id']==A)
  self.assertEqual(row['last_activity_at'],listing.iso(NOW-10))
  self.assertEqual(row['last_executed_at'],listing.iso(NOW-30))
  self.assertNotEqual(row['last_activity_at'],listing.iso(NOW-5))
 def test_cancelled_thread_technical_readiness_does_not_reopen_adapter(self):
  def idle(q):
   r=self.invoke(q)
   for row in r['rows']:row.update(status='idle',can_accept_direct_input=True)
   return r
  row=next(r for r in self.get(16,invoke=idle)['threads'] if r['thread_id']==B)
  self.assertTrue(row['daemon_can_accept_input']);self.assertFalse(row['can_accept_input'])
  self.assertEqual(row['adapter_send_admission'],'closed')
 def test_completed_protocol_turn_can_have_blocked_task_outcome(self):
  self.store.db.execute('UPDATE sends SET result=? WHERE id=?',(json.dumps({'operation_state':'completed','completed_at':NOW-30,'answer':{'state':'blocked','summary':'MUST_NOT_EXPORT'}}),SEND))
  page=self.get(16);row=next(r for r in page['threads'] if r['thread_id']==A)
  self.assertTrue(row['adapter_execution_proven']);self.assertEqual(row['last_executed_outcome'],'blocked')
  self.assertEqual(page['latest_executed_thread']['last_executed_outcome'],'blocked')
  self.assertNotIn('MUST_NOT_EXPORT',json.dumps(page))

class RefusalTests(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.store=Store(Path(self.temp.name)/'jobs.sqlite3',clock=lambda:NOW)
  self.store.db.execute('INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?)',(TASK_A,'existing','0'*64,A,'created',NOW-200,NOW-200,0))
  self.q={'operation_id':SEND,'task_id':TASK_A,'text':'bounded authorized task'};self.calls=[]
 def tearDown(self):self.store.close();self.temp.cleanup()
 def refused(self,q):self.calls.append(q);raise ValueError('thread_profile_changed')
 def test_no_send_receipt_survives_response_loss_and_dedupes(self):
  first=self.store.send(self.q,self.refused,lambda *a:None,lambda:None)
  self.assertEqual(first['state'],'not_dispatched');self.assertIsNone(first['turn'])
  duplicate=self.store.send(self.q,self.refused,lambda *a:None,lambda:None)
  self.assertTrue(duplicate['duplicate']);self.assertEqual(len(self.calls),1)
  row=self.store.observe(SEND,lambda q:self.fail('observation must not invoke RPC'))
  result=json.loads(row['result']);self.assertFalse(result['send_called'])
  self.store.reconcile(SEND,fingerprint(result))
  self.assertEqual(self.store.row('sends',SEND)['reconciled'],1)
 def test_wrong_hash_and_conflicting_input_do_not_release(self):
  self.store.send(self.q,self.refused,lambda *a:None,lambda:None)
  with self.assertRaises(ValueError):self.store.reconcile(SEND,'f'*64)
  with self.assertRaises(ValueError):self.store.send({**self.q,'text':'different'},self.refused,lambda *a:None,lambda:None)
 def test_uncertain_send_is_not_misclassified_as_not_dispatched(self):
  def invoke(q):
   if q['mode']=='send_preflight':return {}
   raise TimeoutError()
  first=self.store.send(self.q,invoke,lambda *a:None,lambda:None)
  self.assertEqual(first['state'],'send_unknown')
  with self.assertRaises(ValueError):self.store.reconcile(SEND,'0'*64)
 def test_cancelled_creation_is_never_reopened_or_sent(self):
  self.store.db.execute("UPDATE tasks SET state='cancelled_before_first_send',reconciled=1 WHERE id=?",(TASK_A,))
  with self.assertRaises(ValueError):self.store.send(self.q,self.refused,lambda *a:None,lambda:None)
  row=self.store.observe_creation(TASK_A,lambda q:self.fail('cancelled task must not resume'))
  self.assertEqual(row['state'],'cancelled_before_first_send')
 def test_present_not_ready_does_not_invent_missing_creation(self):
  row=self.store.observe_creation(TASK_A,lambda q:{'state':'present_not_ready','thread_id':A,'reason':'thread_profile_changed'})
  self.assertEqual(json.loads(row['result'])['state'],'present_not_ready')
  with self.assertRaises(ValueError):self.store.reconcile_creation(TASK_A,fingerprint(json.loads(row['result'])),lambda q:None)

if __name__=='__main__':unittest.main()
