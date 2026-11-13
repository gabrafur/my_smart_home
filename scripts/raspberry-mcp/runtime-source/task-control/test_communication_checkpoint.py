"""Actual Store integration, synthetic SQLite and native transport only."""
import copy,json,unittest
import test_workspace_messages as fixtures
S=fixtures.S

class CommunicationCheckpointTests(unittest.TestCase):
 def setUp(self):
  self.f=fixtures.WorkspaceTests('test_no_task_creation_or_schema_migration_and_global_counter')
  self.f.setUp();self.store=self.f.store
 def tearDown(self):self.f.tearDown()
 def invoke(self,q):
  if q['mode']=='workspace_message_observe':
   return {**self.f.context(),'operation_state':self.observed_state,'turn_id':fixtures.TURN,
    'input_accepted':True,'answer_withheld':True,
    'completion_scope':'receiver_turn_and_bounded_agent_reply',
    'assistant_acknowledged':True,'acknowledgement_evidence':{
     'source':'exact_operation_reference_after_delivery','operation_id':q['operation_id'],
     'turn_id':fixtures.TURN,'item_id':'msg_fixture'},
    'agent_reply':{'state':'unknown','text':None,'collection_error':'reply_not_in_bounded_page'}}
  return self.f.invoke(q)
 def start(self,state='inProgress'):
  self.f.send();self.observed_state=state
  return self.store.observe(fixtures.OP,self.invoke)
 def follow(self,invoke=None,admission=None):
  return self.store.send({**self.f.q,'operation_id':'4'*32},invoke or self.invoke,
   admission or (lambda c,t:None),lambda:None,allow_workspace=True)
 def test_acknowledged_followup_does_not_release_old_turn(self):
  old=self.start();before=copy.deepcopy(old);seen=[]
  new=self.follow(admission=lambda c,t:seen.append((c,t)))
  self.assertEqual(new['state'],'accepted');self.assertEqual(self.store.row('sends',fixtures.OP),before)
  self.assertEqual(old['state'],'inProgress');self.assertEqual(old['reconciled'],0)
  self.assertEqual(seen,[(1,1000.0)])
 def test_idle_started_ack_allows_same_turn_active_followup(self):
  self.f.plan.update(delivery_mode='idle_start',expected_turn_id=None)
  old=self.start();before=copy.deepcopy(old)
  self.f.plan.update(delivery_mode='active_steer',expected_turn_id=fixtures.TURN)
  new=self.follow()
  self.assertEqual(new['state'],'accepted')
  self.assertEqual(json.loads(old['result'])['delivery_mode'],'idle_start')
  self.assertEqual(self.store.row('sends',fixtures.OP),before)
  self.assertEqual(self.f.calls[-1]['expected_turn_id'],fixtures.TURN)
 def test_prior_active_delivery_must_match_recorded_turn(self):
  old=self.start();v=json.loads(old['result']);v['expected_turn_id']=fixtures.THREAD
  self.store.db.execute('UPDATE sends SET result=? WHERE id=?',(json.dumps(v),fixtures.OP))
  before=len(self.f.calls)
  with self.assertRaisesRegex(ValueError,'workspace_followup_turn_changed'):self.follow()
  self.assertEqual(len(self.f.calls),before)
 def test_missing_ack_blocks_without_native_dispatch(self):
  self.f.send();before=len(self.f.calls)
  with self.assertRaisesRegex(ValueError,'prior_task_requires_reconciliation'):self.follow()
  self.assertEqual(len(self.f.calls),before)
 def test_unknown_send_blocks(self):
  self.start();self.store.db.execute("UPDATE sends SET state='send_unknown' WHERE id=?",(fixtures.OP,))
  with self.assertRaisesRegex(ValueError,'prior_task_requires_reconciliation'):self.follow()
 def test_registered_task_reservation_blocks(self):
  self.start();self.store.db.execute('INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?)',('5'*32,'fixture','0'*64,fixtures.THREAD,'created',900,900,0))
  with self.assertRaisesRegex(ValueError,'prior_task_requires_reconciliation'):self.follow()
 def test_changed_native_turn_is_confirmed_non_dispatch(self):
  self.start()
  def changed(q):
   if q['mode']=='workspace_message_preflight':return {**self.f.plan,'expected_turn_id':fixtures.THREAD}
   return self.invoke(q)
  row=self.follow(changed);self.assertEqual(row['state'],'not_dispatched')
  self.assertFalse(json.loads(row['result'])['send_called'])
  self.assertEqual(self.store.row('sends',fixtures.OP)['state'],'inProgress')
 def test_forged_operation_ack_blocks(self):
  old=self.start();v=json.loads(old['result']);v['acknowledgement_evidence']['operation_id']='9'*32
  self.store.db.execute('UPDATE sends SET result=? WHERE id=?',(json.dumps(v),fixtures.OP))
  with self.assertRaisesRegex(ValueError,'workspace_ack_evidence_unconfirmed'):self.follow()
 def test_completed_without_text_gets_durable_checkpoint(self):
  row=self.start('completed');checkpoint=row['central_checkpoint']
  self.assertFalse(checkpoint['reply_text_available']);self.assertFalse(checkpoint['functional_recovery_proven'])
  self.assertEqual(checkpoint['result_hash'],S.fingerprint(json.loads(row['result'])))
  self.store.close();self.f.store=S.Store(self.f.path,clock=lambda:1001);self.store=self.f.store
  self.assertEqual(self.store.row('sends',fixtures.OP)['central_checkpoint'],checkpoint)
 def test_reconcile_records_historical_terminal_without_client_write(self):
  self.f.send();v={'operation_state':'completed','agent_reply':{'state':'unknown','text':None}}
  self.store.db.execute('UPDATE sends SET state=?,result=? WHERE id=?',('completed',json.dumps(v),fixtures.OP))
  r=self.store.reconcile(fixtures.OP,S.fingerprint(v));self.assertTrue(r['reconciled'])
  self.assertTrue(self.store.row('sends',fixtures.OP)['central_checkpoint']['ready_for_reconciliation'])
 def test_hash_mismatch_cannot_checkpoint_or_reconcile(self):
  self.f.send();self.store.db.execute('UPDATE sends SET state=?,result=? WHERE id=?',('completed','{}',fixtures.OP))
  with self.assertRaisesRegex(ValueError,'result_hash_conflict'):self.store.reconcile(fixtures.OP,'0'*64)
  self.assertEqual(self.store.db.execute('SELECT count(*) FROM result_checkpoints').fetchone()[0],0)
 def test_reconcile_rollback_is_atomic(self):
  row=self.start('completed');self.store.db.execute('DELETE FROM result_checkpoints');old=self.store.audit
  def fail(*args):raise RuntimeError('synthetic audit fault')
  self.store.audit=fail
  try:
   with self.assertRaisesRegex(RuntimeError,'synthetic audit fault'):self.store.reconcile(fixtures.OP,S.fingerprint(json.loads(row['result'])))
  finally:self.store.audit=old
  self.assertEqual(self.store.row('sends',fixtures.OP)['reconciled'],0)
  self.assertEqual(self.store.db.execute('SELECT count(*) FROM result_checkpoints').fetchone()[0],0)
 def test_running_reconciliation_still_refused(self):
  row=self.start()
  with self.assertRaisesRegex(ValueError,'not_terminal'):self.store.reconcile(fixtures.OP,S.fingerprint(json.loads(row['result'])))
 def test_pending_followup_limit_is_bounded(self):
  self.start()
  for n in range(2,9):
   v=json.loads(self.store.row('sends',fixtures.OP)['result']);op=f'{n:032x}';v['acknowledgement_evidence']['operation_id']=op
   self.store.db.execute('INSERT INTO sends VALUES(?,?,?,?,?,?,?,?,0)',(op,'workspace:'+fixtures.THREAD,'0'*64,'inProgress',fixtures.TURN,1000,1000,json.dumps(v)))
  with self.assertRaisesRegex(ValueError,'workspace_followup_pending_limit'):self.follow()

if __name__=='__main__':unittest.main()
