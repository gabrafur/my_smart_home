"""Sealed factory/admission fixtures only. No policy install or native effect."""
import copy
import hashlib
import json
import os
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import Mock, patch

import controller
import durable_store
import native_manager
import runtime
from test_controller import policy as controller_policy


def policy():
    return {'schema_version': 1, 'project': '/mnt/data/docker', 'approved_until_revoked': True,
        'source_hashes': {name: 'a' * 64 for name in runtime.FILES},
        'controller_policy': controller_policy(),
        'binary_hashes': {p: 'b' * 64 for p in (native_manager.SYSTEMCTL,)},
        'dependency_hashes': {p: 'c' * 64 for p in (native_manager.SIDECAR, native_manager.SNAPSHOT)},
        'common_lock_identity': [1, 2, 1001, 1001, 0o664],
        'legacy_server_sha256': 'd' * 64, 'legacy_broker_sha256': 'd' * 64}


class RuntimePolicy(unittest.TestCase):
    def read(self, value, changed=None):
        def reader(path, **kwargs):
            if path == str(runtime.POLICY):
                return 'e' * 64, json.dumps(value).encode(), ()
            return ('f' * 64 if path == changed else 'a' * 64), b'fixed source fixture', ()
        with patch.object(native_manager, 'root_file', side_effect=reader), \
                patch.object(runtime, '_BOOT_POLICY_SHA256', hashlib.sha256(json.dumps(value).encode()).hexdigest()):
            return runtime.load_policy()

    def test_exact_sealed_policy_fields_and_sources_accepted(self):
        value = policy()
        self.assertEqual(self.read(value), value)

    def test_changed_code_hash_unknown_files_and_policy_fields_refused(self):
        with self.assertRaisesRegex(ValueError, 'source_identity'):
            self.read(policy(), changed=str(runtime.LIB / 'server.py'))
        for key in ('source_hashes', 'arbitrary_path'):
            value = policy()
            if key == 'source_hashes':
                value[key]['free.py'] = 'a' * 64
            else:
                value[key] = '/tmp/free'
            with self.subTest(key=key), self.assertRaises(ValueError):
                self.read(value)

    def test_recurrence_and_nonboolean_authority_refused(self):
        for key, val in [('recurring_execution_enabled', True), ('enabled', 1)]:
            value = policy()
            value['controller_policy'][key] = val
            with self.subTest(key=key), self.assertRaises(ValueError):
                self.read(value)

    def test_changed_project_approval_or_common_lock_identity_refused(self):
        for key, value in [('project', '/other'), ('approved_until_revoked', False),
                           ('common_lock_identity', [1, 2, 0, 0, 0o666])]:
            changed = policy()
            changed[key] = value
            with self.subTest(key=key), self.assertRaises(ValueError):
                self.read(changed)

    def test_previous_delegate_is_exact_hash_and_fixed_path_only(self):
        with patch.object(native_manager, 'root_file', return_value=('d' * 64, b'fixture', ())):
            runtime.previous_identity(policy(), runtime.LEGACY_SERVER)
            runtime.previous_identity(policy(), runtime.LEGACY_BROKER)
            with self.assertRaisesRegex(ValueError, 'fixed_legacy'):
                runtime.previous_identity(policy(), '/tmp/free')
        with patch.object(native_manager, 'root_file', return_value=('f' * 64, b'foreign', ())):
            with self.assertRaisesRegex(ValueError, 'hash_changed'):
                runtime.previous_identity(policy(), runtime.LEGACY_SERVER)

    def test_closed_dispatch_rejects_free_args_before_building_executor(self):
        with patch.object(runtime, 'load_policy', return_value=policy()), \
                patch.object(runtime, 'components') as components, \
                patch.object(runtime, 'metadata') as metadata:
            with self.assertRaises(controller.Refused):
                runtime.dispatch('admin_action_apply', {'host': 'raspberry', 'command': 'anything'})
            with self.assertRaises(ValueError):
                runtime.dispatch('binding_metadata_observe', {'host': 'raspberry', 'path': '/free'})
            components.assert_not_called()
            metadata.assert_not_called()

    def test_missing_or_changed_bootstrap_policy_pin_refuses_semantically_valid_policy(self):
        raw = json.dumps(policy()).encode()
        with patch.object(native_manager, 'root_file', return_value=('e' * 64, raw, ())):
            for pin in (None, '0' * 64):
                with self.subTest(pin=pin), patch.object(runtime, '_BOOT_POLICY_SHA256', pin):
                    with self.assertRaisesRegex(ValueError, 'bootstrap_missing'):
                        runtime.load_policy()

    def test_native_preflight_is_readonly_and_requires_disabled_policy(self):
        value = policy()
        store = Mock()
        context = Mock(__enter__=Mock(return_value=store), __exit__=Mock(return_value=False))
        store.lock.return_value = context
        store.revoked.return_value = False
        engine = Mock()
        engine.manager.headroom.return_value = True
        with patch.object(runtime, 'load_policy', return_value=value), \
                patch.object(runtime, 'components', return_value=(store, engine)) as factory:
            with self.assertRaisesRegex(ValueError, 'disabled_policy'):
                runtime.dispatch('binding_native_preflight_observe', {'host': 'raspberry'})
            factory.assert_not_called()
            value['controller_policy']['enabled'] = False
            result = runtime.dispatch('binding_native_preflight_observe', {'host': 'raspberry'})
        self.assertEqual(result['native_write_calls'], 0)
        self.assertFalse(result['execution_active'])
        engine.inspect.assert_called_once()
        engine.request.assert_not_called()
        store.save.assert_not_called()

    def test_native_preflight_rejects_free_args_revocation_or_low_resources(self):
        value = policy()
        value['controller_policy']['enabled'] = False
        store = Mock()
        store.lock.return_value = Mock(__enter__=Mock(return_value=store), __exit__=Mock(return_value=False))
        engine = Mock()
        with patch.object(runtime, 'load_policy', return_value=value), \
                patch.object(runtime, 'components', return_value=(store, engine)):
            with self.assertRaises(ValueError):
                runtime.dispatch('binding_native_preflight_observe', {'host': 'raspberry', 'path': '/free'})
            store.revoked.return_value = True
            with self.assertRaisesRegex(ValueError, 'revoked'):
                runtime.dispatch('binding_native_preflight_observe', {'host': 'raspberry'})
            store.revoked.return_value = False
            engine.manager.headroom.return_value = False
            with self.assertRaisesRegex(ValueError, 'headroom'):
                runtime.dispatch('binding_native_preflight_observe', {'host': 'raspberry'})
            engine.request.assert_not_called()


class RuntimeAdmission(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        base = Path(self.temp.name)
        self.state = base / 'state'
        self.state.mkdir(mode=0o700)
        common = base / 'common.lock'
        common.write_bytes(b'fixed fixture')
        common.chmod(0o600)
        s = common.stat()
        self.store = durable_store.Store(self.state, common,
            (s.st_dev, s.st_ino, s.st_uid, s.st_gid, s.st_mode & 0o777), owner=os.getuid())
        self.now = 100000.

    def observe(self, value=None):
        with patch.object(runtime.durable_store, 'Store', return_value=self.store), \
                patch.object(runtime.time, 'time', return_value=self.now), \
                patch.object(runtime, 'components', side_effect=AssertionError('metadata must not build native manager')):
            return runtime.metadata(policy() if value is None else value)

    def row(self, state='applied', at=99000):
        return {'id': 'a' * 32, 'state': state, 'effects': [{'kind': 'apply', 'at': at}]}

    def test_passive_admission_does_not_build_native_executor_or_claim_health(self):
        result = self.observe()
        self.assertTrue(result['execution_active'])
        self.assertTrue(result['new_plan_admission_active'])
        self.assertEqual(result['remaining_writes'], 4)
        self.assertTrue(result['live_identity_and_resource_preflight_required'])
        self.assertFalse(result['recurring_execution_enabled'])
        self.assertNotIn('container_id', result)

    def test_uncertain_intent_and_budget_are_preserved_and_close_admission(self):
        with self.store.lock():
            self.store.save(self.row(state='apply_intent'))
        result = self.observe()
        self.assertFalse(result['execution_active'])
        self.assertEqual(result['unresolved_operations'], 1)
        self.assertEqual(result['remaining_writes'], 3)

    def test_revoke_disabled_policy_and_spacing_close_admission(self):
        value = policy()
        value['controller_policy']['enabled'] = False
        self.assertFalse(self.observe(value)['execution_active'])
        with self.store.lock():
            self.store.save(self.row(at=self.now - 100))
        self.assertFalse(self.observe()['spacing_ready'])
        self.now += 600
        self.assertTrue(self.observe()['execution_active'])
        (self.state / 'revoked').write_bytes(b'owner revoked')
        self.assertTrue(self.observe()['revoked'])
        self.assertFalse(self.observe()['execution_active'])

    def test_clock_reversal_keeps_budget_unknown_instead_of_resetting(self):
        with self.store.lock():
            self.store.save(self.row(at=self.now + 10))
        result = self.observe()
        self.assertFalse(result['clock_order_confirmed'])
        self.assertFalse(result['execution_active'])
        self.assertIsNone(result['writes_last_24h'])
        self.assertIsNone(result['remaining_writes'])

    def test_full_history_blocks_new_plans_without_hiding_existing_effect_admission(self):
        with self.store.lock():
            for i in range(64):
                self.store.save({'id': format(i, '032x'), 'state': 'planned', 'effects': []})
        result = self.observe()
        self.assertFalse(result['new_plan_admission_active'])
        self.assertTrue(result['execution_active'])


if __name__ == '__main__':
    unittest.main()
