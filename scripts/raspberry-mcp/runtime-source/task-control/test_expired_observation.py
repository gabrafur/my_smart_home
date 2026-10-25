import contextlib
import hashlib
import json
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import Mock, patch
import importlib.util
import sys

# Load the captured implementation without importing installed privileged code
# or colliding with the older candidate's module names in the shared suite.
def load_local(name, filename, bindings=None):
    source = Path(__file__).with_name(filename).read_text()
    for index, suffix in [(1, '10'), (2, '20'), (3, '30')]:
        source = source.replace('${AUTHORIZED_THREAD_ID_' + str(index) + '}',
                                '00000000-0000-7000-8000-' + suffix.zfill(12))
    spec = importlib.util.spec_from_loader(name, loader=None)
    module = importlib.util.module_from_spec(spec)
    module.__file__ = str(Path(__file__).with_name(filename))
    sys.modules[name] = module
    with patch.dict(sys.modules, bindings or {}):
        exec(compile(source, module.__file__, 'exec'), module.__dict__)
    return module

store_module = load_local('_mcp_active_expiry_store', 'task_store.py')
c = load_local('_mcp_active_expiry_control', 'task_control.py', {'task_store': store_module})
Store, fingerprint = store_module.Store, store_module.fingerprint
task_list = load_local('_mcp_active_expiry_list', 'task_list.py')
test_listing = load_local('_mcp_active_expiry_fixtures', '_listing_fixtures.py',
                          {'task_store': store_module, 'task_list': task_list})


class LeaseTests(unittest.TestCase):
    def old(self, error='control_lease_expired'):
        return types.SimpleNamespace(plan=Mock(side_effect=ValueError(error)),
                                     ROOT=Path('/legacy'), THREADS=('one', 'two'), peer=Mock())

    def legacy(self):
        return {'enabled': True, 'threads': ['one', 'two'], 'project': '/mnt/data/docker',
                'max_sends': 6, 'source_hashes': {n: hashlib.sha256(n.encode()).hexdigest()
                for n in ['codex_control.py', 'codex_control_rpc.cjs']}}

    def test_expired_observation_preserves_code_and_scope_checks(self):
        legacy = self.legacy()
        read = lambda p, *_: json.dumps(legacy).encode() if p == c.LEGACY_POLICY else p.name.encode()
        with patch.object(c, 'read', side_effect=read):
            result = c.observation_legacy(self.old())
        self.assertTrue(result['_observation_only'])
        self.assertEqual(result['source_hashes'], legacy['source_hashes'])

    def test_disabled_control_is_not_bypassed(self):
        with patch.object(c, 'read') as read:
            with self.assertRaisesRegex(ValueError, 'control_observation_refused'):
                c.observation_legacy(self.old('codex_control_disabled'))
            read.assert_not_called()

    def test_changed_legacy_code_and_scope_still_refuse(self):
        for changed in ['code', 'project']:
            legacy = self.legacy()
            if changed == 'project':
                legacy['project'] = '/other'
            def read(p, *_):
                return json.dumps(legacy).encode() if p == c.LEGACY_POLICY else b'changed'
            with patch.object(c, 'read', side_effect=read), self.assertRaises(ValueError):
                c.observation_legacy(self.old())

    def test_default_policy_does_not_allow_expired_admission(self):
        with self.assertRaisesRegex(ValueError, 'control_lease_expired'):
            c.policy(self.old())

    def test_observation_gate_cannot_send_create_resume_or_preflight(self):
        old = self.old()
        for mode in ['create', 'create_preflight', 'creation_probe', 'send', 'send_preflight']:
            with self.assertRaisesRegex(ValueError, 'expired_observation_only'):
                c.rpc({'mode': mode}, {'_observation_only': True}, old)
        old.peer.assert_not_called()

    def test_boot_change_cannot_contact_a_reused_peer(self):
        old = self.old()
        with self.assertRaisesRegex(ValueError, 'observation_peer_boot_unconfirmed'):
            c.rpc({'mode': 'metadata_batch'}, {'_observation_only': True, 'boot_id': 'other-boot'}, old)
        old.peer.assert_not_called()

    def test_read_only_rpc_never_reopens_admission(self):
        old = self.old()
        legacy = {'_observation_only': True, 'boot_id': Path('/proc/sys/kernel/random/boot_id').read_text().strip()}
        result = types.SimpleNamespace(returncode=0, stdout=b'{"ok":true,"result":{"rows":[]}}')
        with patch.object(c.subprocess, 'run', return_value=result):
            self.assertEqual(c.rpc({'mode': 'metadata_batch', 'thread_ids': []}, legacy, old), {'rows': []})
        old.plan.assert_not_called()
        old.peer.assert_called_once()


class HandleTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / 'jobs.sqlite3'
        self.db = Store(self.path)
        self.op = 'a' * 32
        self.send = 'b' * 32
        self.thread = '00000000-0000-7000-8000-000000000001'
        self.db.db.execute('INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?)',
                           (self.op, 'eva-admin-proof', '0' * 64, self.thread, 'created', 10, 10, 0))

    def tearDown(self):
        self.db.close()
        self.tmp.cleanup()

    def call(self, name, args, invoke):
        with patch.object(c, 'policy', return_value=({'enabled': True}, {'_observation_only': True})), \
             patch.object(c, 'locked', side_effect=lambda **_: contextlib.nullcontext()), \
             patch.object(c, 'store', return_value=self.db), \
             patch.object(c, 'STATE', Path(self.tmp.name)), \
             patch.object(c.os, 'geteuid', return_value=1001), \
             patch.object(c, 'rpc', side_effect=invoke):
            return c.handle(name, {'host': 'raspberry', **args}, object())

    def test_creation_status_never_resumes_an_expired_reservation(self):
        modes = []
        def invoke(q, *_):
            modes.append(q['mode'])
            self.assertEqual(q['mode'], 'metadata_batch')
            return {'rows': [{'thread_id': self.thread, 'status': 'idle', 'durable': True, 'collection_error': None}]}
        r = self.call('codex_task_status', {'kind': 'creation', 'operation_id': self.op}, invoke)
        self.assertEqual(modes, ['metadata_batch'])
        self.assertEqual(r['state'], 'created')
        self.assertEqual(r['send_admission'], 'closed')
        self.assertTrue(r['observation_without_admission'])

    def test_uncertain_live_read_returns_cached_state_without_dispatch(self):
        self.db.db.execute('INSERT INTO sends VALUES(?,?,?,?,?,?,?,?,?)',
                           (self.send, self.op, '1'*64, 'accepted', self.thread, 11, 11, None, 0))
        def invoke(q, *_):
            self.assertEqual(q['mode'], 'observe')
            raise TimeoutError()
        r = self.call('codex_task_status', {'kind': 'turn', 'operation_id': self.send}, invoke)
        self.assertEqual(r['state'], 'accepted')
        self.assertEqual(r['collection_error'], 'live_observation_unavailable_cached_state_only')
        self.assertFalse(r['automatic_retry'])

    def test_terminal_receipt_can_be_acknowledged_after_expiry(self):
        result = {'operation_state': 'completed'}
        self.db.db.execute('INSERT INTO sends VALUES(?,?,?,?,?,?,?,?,?)',
                           (self.send, self.op, '1'*64, 'completed', self.thread, 11, 12, json.dumps(result), 0))
        r = self.call('codex_task_reconcile', {'operation_id': self.send, 'result_hash': fingerprint(result)},
                      lambda *_: self.fail('acknowledgement must not contact the daemon'))
        self.assertTrue(r['reconciled'])


class ListTests(unittest.TestCase):
    def test_closed_admission_is_in_cursor_identity_and_does_not_fake_daemon_state(self):
        fixture = test_listing.ListingTests()
        fixture.setUp()
        try:
            args = {'host': 'raspberry', 'page_size': 1, 'cursor': None}
            open_page = task_list.collect(args, fixture.tasks, fixture.invoke, test_listing.NOW)
            closed = task_list.collect({**args, 'page_size': 16}, fixture.tasks, fixture.invoke,
                                       test_listing.NOW, admission_closed=True)
            self.assertTrue(closed['administrative_admission_closed'])
            self.assertTrue(all(r['adapter_send_admission'] == 'closed' and not r['can_accept_input'] for r in closed['threads']))
            self.assertTrue(any(r['daemon_can_accept_input'] for r in closed['threads']))
            changed = task_list.collect({**args, 'cursor': open_page['next_cursor']}, fixture.tasks, fixture.invoke,
                                        test_listing.NOW, admission_closed=True)
            self.assertEqual(changed['collection_error'], 'snapshot_changed')
        finally:
            fixture.tearDown()


class ScopedListingTests(test_listing.ListingTests):
    """Run scoped pagination and sanitization fixtures in canonical discovery."""


class ReconciliationTests(test_listing.RefusalTests):
    """Run preserved uncertain-send and consumed-creation regressions."""


if __name__ == '__main__':
    unittest.main()
