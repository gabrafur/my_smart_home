"""Synthetic task ledger tests; no real services or paths."""
import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('task_store_candidate',Path(__file__).with_name('task_store.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
TASK='a'*32;SEND='b'*32

def receipt():return {'operation_state':'not_dispatched','send_called':False,'execution_proven':False,'reason':'preflight_unconfirmed','automatic_retry':False}

class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.store=m.Store(':memory:',clock=lambda:100.0);self.addCleanup(self.store.close)
        self.store.db.execute('INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?)',(TASK,'eva-admin-fixture','d'*64,'11111111-1111-1111-1111-111111111111','created',1,1,0))
        self.add_send(SEND,receipt())
    def add_send(self,op,result,state='not_dispatched',reconciled=0,turn=None,input_hash='c'*64):
        self.store.db.execute('INSERT INTO sends VALUES(?,?,?,?,?,?,?,?,?)',(op,TASK,input_hash,state,turn,1,1,json.dumps(result,sort_keys=True),reconciled))
    def test_exact_proof_releases_same_task_atomically_and_duplicate(self):
        h=m.fingerprint(receipt());self.store.reconcile(SEND,h)
        self.assertEqual(self.store.row('tasks',TASK)['reconciled'],1)
        self.assertEqual(self.store.row('sends',SEND)['reconciled'],1)
        self.store.idle();self.store.reconcile(SEND,h)
        self.assertEqual(self.store.row('sends',SEND)['state'],'not_dispatched')
    def test_legacy_already_reconciled_releases_reservation(self):
        self.store.db.execute('UPDATE sends SET reconciled=1 WHERE id=?',(SEND,))
        self.store.reconcile(SEND,m.fingerprint(receipt()));self.store.idle()
        self.assertEqual(self.store.row('tasks',TASK)['reconciled'],1)
    def test_invalid_proof_or_hash_never_releases(self):
        for changes,turn in (({'send_called':True},None),({'execution_proven':True},None),({'operation_state':'unknown'},None),({},'11111111-1111-1111-1111-111111111111')):
            with self.subTest(changes=changes,turn=turn):
                value=receipt()|changes;self.store.db.execute('UPDATE sends SET result=?,turn=? WHERE id=?',(json.dumps(value),turn,SEND))
                with self.assertRaises(ValueError):self.store.reconcile(SEND,m.fingerprint(value))
                self.assertEqual(self.store.row('tasks',TASK)['reconciled'],0)
        with self.assertRaises(ValueError):self.store.reconcile(SEND,'f'*64)
    def test_other_uncertain_or_unreconciled_send_blocks_release(self):
        for state,reconciled in [('send_unknown',0),('completed',0),('accepted',1)]:
            self.store.db.execute('DELETE FROM sends WHERE id!=?',(SEND,));self.add_send('e'*32,{},state,reconciled)
            with self.subTest(state=state),self.assertRaisesRegex(ValueError,'task_has_other_unresolved_sends'):
                self.store.reconcile(SEND,m.fingerprint(receipt()))
            self.assertEqual(self.store.row('tasks',TASK)['reconciled'],0)
    def test_transaction_failure_rolls_back_both_updates(self):
        with patch.object(self.store,'audit',side_effect=RuntimeError('simulated')):
            with self.assertRaises(RuntimeError):self.store.reconcile(SEND,m.fingerprint(receipt()))
        self.assertEqual(self.store.row('tasks',TASK)['reconciled'],0);self.assertEqual(self.store.row('sends',SEND)['reconciled'],0)
    def test_historical_zero_hash_retry_does_not_dispatch(self):
        self.store.db.execute('UPDATE sends SET input_hash=? WHERE id=?',('0'*64,SEND))
        result=self.store.send({'operation_id':SEND,'task_id':TASK,'text':'different'},lambda *_:self.fail('no call'),lambda *_:self.fail('no admission'),lambda:self.fail('no dispatch'))
        self.assertTrue(result['duplicate']);self.assertFalse(result['execution_replay_allowed'])

if __name__=='__main__':unittest.main()
