"""Receipt context regression with synthetic SQLite and no RPC dispatch."""
import copy,json,unittest
from unittest.mock import patch
import test_workspace_messages as F
S=F.S
NEW='4'*32;TURN='00000000-0000-0000-0000-000000000009'
class ContextTests(unittest.TestCase):
 def setUp(self):
  self.patch=patch.object(F,'S',S);self.patch.start();self.addCleanup(self.patch.stop)
  self.f=F.WorkspaceTests();self.f.setUp();self.addCleanup(self.f.tearDown);self.store=self.f.store;self.f.send()
  ack={**self.f.context(),'operation_state':'inProgress','turn_id':F.TURN,'input_accepted':True,'answer_withheld':True,'completion_scope':'receiver_turn_and_bounded_agent_reply','assistant_acknowledged':True,'acknowledgement_evidence':{'source':'exact_operation_reference_after_delivery','operation_id':F.OP,'turn_id':F.TURN,'item_id':'msg_fixture'}}
  self.store.observe(F.OP,lambda q:ack)
  calls=[]
  def changed(q):
   calls.append(q['mode'])
   if q['mode']=='workspace_message_preflight':return {**self.f.plan,'expected_turn_id':TURN}
   raise AssertionError('no dispatch allowed')
  self.row=self.store.send({**self.f.q,'operation_id':NEW},changed,lambda c,t:None,lambda:None,allow_workspace=True)
  self.assertEqual(calls,['workspace_message_preflight']);self.assertEqual(self.row['state'],'not_dispatched');self.value=json.loads(self.row['result']);self.assertEqual(self.value['expected_turn_id'],TURN)
 def assert_closed(self):
  self.assertEqual(self.store.row('sends',NEW)['reconciled'],0);self.assertEqual(self.store.row('sends',F.OP)['state'],'inProgress');self.assertEqual(self.store.row('sends',F.OP)['reconciled'],0)
 def test_turn_change_refusal_reconciles_without_releasing_old_turn(self):
  digest=S.fingerprint(self.value);r=self.store.reconcile(NEW,digest);self.assertTrue(r['reconciled']);self.assertEqual(self.store.row('sends',NEW)['central_checkpoint']['result_hash'],digest);self.assertEqual(self.store.row('sends',F.OP)['reconciled'],0);self.assertEqual(self.store.row('sends',F.OP)['state'],'inProgress')
 def test_malformed_or_foreign_context_cannot_reconcile(self):
  for delta in ({'delivery_mode':'evil'},{'expected_turn_id':None},{'expected_turn_id':'invalid'},{'profile_preserved':False},{'authority_changed':True},{'target_thread_id':TURN},{'delivery_mode':None}):
   with self.subTest(delta=delta):
    v={**self.value,**delta};self.store.db.execute('UPDATE sends SET result=? WHERE id=?',(json.dumps(v),NEW))
    with self.assertRaises(ValueError):self.store.reconcile(NEW,S.fingerprint(v))
    self.assert_closed()
 def test_false_no_dispatch_or_existing_turn_cannot_reconcile(self):
  for delta,turn in (({'send_called':True},None),({'execution_proven':True},None),({},TURN)):
   with self.subTest(delta=delta,turn=turn):
    v={**self.value,**delta};self.store.db.execute('UPDATE sends SET result=?,turn=? WHERE id=?',(json.dumps(v),turn,NEW))
    with self.assertRaises(ValueError):self.store.reconcile(NEW,S.fingerprint(v))
    self.assert_closed()
 def test_wrong_hash_does_not_reconcile(self):
  with self.assertRaisesRegex(ValueError,'result_hash_conflict'):self.store.reconcile(NEW,'0'*64)
  self.assert_closed()
 def test_audit_fault_rolls_back_checkpoint_and_ack(self):
  with patch.object(self.store,'audit',side_effect=RuntimeError('fixture')):
   with self.assertRaises(RuntimeError):self.store.reconcile(NEW,S.fingerprint(self.value))
  self.assert_closed();self.assertEqual(self.store.db.execute('SELECT count(*) FROM result_checkpoints').fetchone()[0],0)
 def test_idle_start_and_original_empty_context_still_reconcile(self):
  for mode,expected in (('idle_start',None),(None,None)):
   op=('a' if mode else 'b')*32;v={**self.value,'delivery_mode':mode,'expected_turn_id':expected};self.store.db.execute('INSERT INTO sends VALUES(?,?,?,?,?,?,?,?,0)',(op,'workspace:'+F.THREAD,'0'*64,'not_dispatched',None,1000,1000,json.dumps(v)));self.assertTrue(self.store.reconcile(op,S.fingerprint(v))['reconciled'])
 def test_duplicate_ack_is_idempotent_and_no_dispatch(self):
  h=S.fingerprint(self.value);self.store.reconcile(NEW,h);count=self.store.db.execute('SELECT count(*) FROM audit').fetchone()[0];self.store.reconcile(NEW,h);self.assertEqual(self.store.db.execute('SELECT count(*) FROM audit').fetchone()[0],count)
if __name__=='__main__':unittest.main()
