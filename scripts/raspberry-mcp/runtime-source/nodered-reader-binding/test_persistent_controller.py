"""Controller with real disposable durable store; manager remains synthetic."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest

HERE = Path(__file__).parent


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, HERE / file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


c = load('persistent_binding_core', 'controller.py')
s = load('persistent_binding_store', 'durable_store.py')
fixtures = load('persistent_binding_fixtures', 'test_controller.py')


class Manager(fixtures.Manager):
    def set_allow(self, expected, wanted):
        # Read through a separate instance to prove the intent reached disk,
        # rather than merely existing in the controller's in-memory record.
        self.store.assert_locked()
        disk = json.loads((self.store.state / 'ledger.json').read_bytes())
        assert disk['operations'][-1]['state'] in ('apply_intent', 'restore_intent')
        assert c.networks(self.value['allowed']) == expected
        self.writes.append(list(wanted))
        if not self.failure:
            self.value['allowed'] = list(wanted)
        if self.failure or self.lose_reply:
            raise TimeoutError('synthetic writer outcome unconfirmed')


class PersistentController(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        base = Path(self.temp.name)
        state = base / 'state'
        state.mkdir(mode=0o700)
        common = base / 'common.lock'
        common.write_bytes(b'fixed disposable lock')
        common.chmod(0o600)
        v = common.stat()
        self.store = s.Store(state, common,
                             (v.st_dev, v.st_ino, v.st_uid, v.st_gid, v.st_mode & 0o777),
                             owner=os.getuid())
        self.manager = Manager(self.store)
        self.now = 100000.
        self.reopen()

    def reopen(self):
        self.controller = c.Controller(fixtures.policy(), self.store, self.manager,
                                       lambda: self.now)

    def call(self, verb='plan', key='a' * 32, tool='admin_action_apply'):
        return self.controller.request(tool, {'host': 'raspberry',
            'action': 'nodered_' + verb + '_reader_binding',
            'idempotency_key': 'nodered-peer-' + key})

    def test_durable_plan_then_one_effect_and_duplicate_after_controller_recreation(self):
        self.call()
        self.reopen()
        self.assertEqual(self.call('apply')['state'], 'applied')
        self.reopen()
        self.assertEqual(self.call('apply')['state'], 'applied')
        self.assertEqual(len(self.manager.writes), 1)

    def test_lost_reply_remains_unknown_after_recreation_and_only_reconciles(self):
        self.call()
        self.manager.lose_reply = True
        self.assertEqual(self.call('apply')['state'], 'outcome_unknown')
        self.reopen()
        with self.assertRaisesRegex(c.Refused, 'requires_reconciliation'):
            self.call(key='b' * 32)
        self.assertEqual(self.call('apply')['state'], 'outcome_unknown')
        self.assertEqual(self.call(tool='admin_action_reconcile')['state'], 'applied')
        self.assertEqual(len(self.manager.writes), 1)

    def test_durable_intent_without_writer_result_never_replays(self):
        self.call()
        with self.store.lock():
            row = self.store.get('a' * 32)
            row.update(state='apply_intent')
            row['effects'].append({'kind': 'apply', 'at': self.now})
            self.store.save(row)
        self.reopen()
        self.assertEqual(self.call('apply')['state'], 'apply_intent')
        self.assertEqual(self.call(tool='admin_action_reconcile')['state'],
                         'not_applied_observed')
        self.call('apply')
        self.assertEqual(self.manager.writes, [])

    def test_budget_and_spacing_survive_new_controller_instances(self):
        for key in ('a' * 32, 'b' * 32):
            # Independent verified instances represent separate incidents;
            # an applied/restored incident cannot gain a fresh effect by key.
            self.manager.value['container_id'] = key[0] * 64
            self.call(key=key)
            self.call('apply', key)
            self.now += 600
            self.reopen()
            self.call('plan_restore', key)
            self.call('restore', key)
            self.now += 600
            self.reopen()
        self.manager.value['container_id'] = 'c' * 64
        with self.assertRaisesRegex(c.Refused, 'daily_budget'):
            self.call(key='c' * 32)
        self.assertEqual(len(self.manager.writes), 4)

    def test_revoked_action_preserves_readable_existing_receipt(self):
        self.call()
        (self.store.state / 'revoked').write_bytes(b'owner revoked')
        with self.assertRaisesRegex(c.Refused, 'revoked'):
            self.call('apply')
        self.assertEqual(self.call(tool='admin_action_status')['state'], 'planned')
        self.assertEqual(self.manager.writes, [])

    def test_persisted_intent_budget_is_not_reset_when_wall_clock_reverses(self):
        self.call()
        self.call('apply')
        self.now -= 10
        with self.assertRaisesRegex(c.Refused, 'clock_reversal'):
            self.call(key='b' * 32)
        status = self.call(tool='admin_action_status')
        self.assertEqual(status['collection_error'], 'clock_order_unconfirmed')
        self.assertEqual(len(self.manager.writes), 1)

    def test_new_container_identity_blocks_existing_plan_after_recreation(self):
        self.call()
        self.manager.value['container_id'] = 'f' * 64
        self.reopen()
        with self.assertRaisesRegex(c.Refused, 'instance_changed'):
            self.call('apply')
        self.assertEqual(self.call(tool='admin_action_status')['state'], 'planned')
        self.assertEqual(self.manager.writes, [])


if __name__ == '__main__':
    unittest.main()
