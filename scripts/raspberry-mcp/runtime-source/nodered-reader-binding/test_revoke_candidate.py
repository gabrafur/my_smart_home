"""Revocation tests using in-memory adapters and a disposable local directory."""
import os
from pathlib import Path
import tempfile
import unittest

import controller
import durable_store
from test_candidate import ARGS, POLICY, Manager, Store

class MemoryStore(Store):
    def __init__(self): super().__init__(); self.marker = False
    def revoked(self): return self.marker
    def revoke(self):
        old = self.marker
        self.marker = True
        return old

class RevocationTests(unittest.TestCase):
    def setUp(self):
        self.store = MemoryStore(); self.manager = Manager(); self.now = 100000
        self.engine = controller.Controller(POLICY, self.store, self.manager, lambda: self.now)
    def request(self, tool, action, **extra):
        return self.engine.request(tool, {**ARGS, 'action': action, **extra})
    def test_revocation_is_idempotent_and_preserves_pending_plan(self):
        self.request('admin_action_apply', 'nodered_plan_reader_binding')
        before = self.store.history()[:]
        first = self.request('admin_action_revoke', 'nodered_revoke_reader_binding')
        self.assertEqual(first['state'], 'revoked'); self.assertFalse(first['duplicate'])
        self.assertTrue(self.request('admin_action_revoke', 'nodered_revoke_reader_binding')['duplicate'])
        self.assertEqual(self.store.history(), before)
        with self.assertRaises(controller.Refused):
            self.request('admin_action_apply', 'nodered_apply_reader_binding')
        self.assertEqual(self.manager.writes, 0)
        self.assertEqual(self.request('admin_action_status', 'nodered_apply_reader_binding')['state'], 'planned')
    def test_revocation_during_uncertainty_preserves_reconcile_and_budget(self):
        self.request('admin_action_apply', 'nodered_plan_reader_binding')
        self.manager.fail = True
        self.assertEqual(self.request('admin_action_apply', 'nodered_apply_reader_binding')['state'], 'outcome_unknown')
        self.request('admin_action_revoke', 'nodered_revoke_reader_binding')
        out = self.request('admin_action_reconcile', 'nodered_apply_reader_binding')
        self.assertEqual(out['state'], 'not_applied_observed')
        self.assertEqual(self.manager.writes, 1)
        self.assertEqual(len(self.store.history()[0]['effects']), 1)
        with self.assertRaises(controller.Refused):
            self.request('admin_action_apply', 'nodered_plan_reader_binding', idempotency_key='nodered-peer-'+'f'*32)
    def test_wrong_tool_action_and_extra_arguments_refused(self):
        for tool, action in [('admin_action_apply', 'nodered_revoke_reader_binding'),
                             ('admin_action_revoke', 'nodered_apply_reader_binding'),
                             ('admin_action_status', 'nodered_revoke_reader_binding')]:
            with self.subTest(tool=tool, action=action), self.assertRaises(controller.Refused):
                self.request(tool, action)
        with self.assertRaises(controller.Refused):
            self.request('admin_action_revoke', 'nodered_revoke_reader_binding', path='/tmp')
        self.assertFalse(self.store.revoked())

class DurableRevocationTests(unittest.TestCase):
    def test_marker_is_durable_fixed_and_never_mutates_ledger(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); state = root/'state'; state.mkdir(mode=0o700)
            common = root/'common'; common.write_bytes(b''); common.chmod(0o600)
            s = common.stat(); identity = (s.st_dev,s.st_ino,s.st_uid,s.st_gid,s.st_mode & 0o777)
            store = durable_store.Store(state, common, identity, owner=os.getuid())
            with store.lock():
                store.save({'id':'a'*32,'state':'apply_intent','effects':[{'kind':'apply','at':1}], 'observed_at_unix':1})
                original = (state/'ledger.json').read_bytes()
                self.assertFalse(store.revoke()); self.assertTrue(store.revoke())
                self.assertEqual((state/'ledger.json').read_bytes(), original)
                self.assertTrue(store.revoked())
                self.assertEqual((state/'revoked').stat().st_mode & 0o777, 0o600)
            with durable_store.Store(state, common, identity, owner=os.getuid()).lock() as reopened:
                self.assertTrue(reopened.revoked()); self.assertEqual((state/'ledger.json').read_bytes(), original)
    def test_revoke_requires_lock(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = durable_store.Store(Path(tmp)/'state', Path(tmp)/'common', (), owner=os.getuid())
            with self.assertRaises(durable_store.Refused): store.revoke()

if __name__ == '__main__': unittest.main()
