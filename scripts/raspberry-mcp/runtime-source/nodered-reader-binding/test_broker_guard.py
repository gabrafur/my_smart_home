"""Synthetic component-reservation guard and broker composition; no host socket."""
import json
from pathlib import Path
import socket
import stat
import struct
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
import broker


class Prior:
    def __init__(self):
        self.calls = []
    def handle(self, name, args):
        self.calls.append((name, args))
        if name == 'maintenance_capabilities':
            return {'evidence': {'data': {'prior': True}}}
        return {'prior': name}


class GuardTests(unittest.TestCase):
    def test_mutations_are_guarded_before_prior_or_binding_dispatch(self):
        rpc = Mock()
        instance = broker.compose(Prior, rpc)()
        for name, args, kind in [
            ('change_apply', {}, 'generic_project_source_mutation'),
            ('codex_task_send', {}, 'scoped_codex_task'),
            ('admin_action_apply', {'action': 'nodered_apply_reader_binding'}, 'NodeRED_reader_binding'),
            ('admin_action_apply', {'action': 'nodered_restore_reader_binding'}, 'NodeRED_reader_binding')]:
            with self.subTest(name=name, args=args), patch.object(broker, 'component_mutation_guard', side_effect=ValueError('closed')) as guard:
                with self.assertRaisesRegex(ValueError, 'closed'):
                    instance.handle(name, args)
                guard.assert_called_once_with(kind)
        self.assertEqual(instance.calls, [])
        rpc.request.assert_not_called()

    def test_previews_and_status_preserve_read_routes_without_guard(self):
        rpc = Mock(); rpc.request.return_value = {'state': 'planned'}
        instance = broker.compose(Prior, rpc)()
        with patch.object(broker, 'component_mutation_guard') as guard:
            instance.handle('admin_action_apply', {'action': 'nodered_plan_reader_binding'})
            instance.handle('admin_action_status', {'action': 'nodered_apply_reader_binding'})
            instance.handle('admin_action_reconcile', {'action': 'nodered_apply_reader_binding'})
            instance.handle('admin_action_apply', {'action': 'storage_plan_example'})
            guard.assert_not_called()
        self.assertEqual(rpc.request.call_count, 3)
        self.assertEqual(len(instance.calls), 1)

    def test_guard_requires_exact_source_and_explicit_admission(self):
        good = {'source': 'protected_component_reservation_ledger_under_operations_lock',
                'collection_error': None, 'admission_allowed': True}
        for change in ({'source': 'other'}, {'collection_error': 'unknown'}, {'admission_allowed': False}, {'admission_allowed': 1}):
            with self.subTest(change=change), patch.object(broker, 'component_guard_query', return_value={**good, **change}):
                with self.assertRaisesRegex(ValueError, 'component_scope_reserved_or_unconfirmed'):
                    broker.component_mutation_guard('NodeRED_reader_binding')
        with patch.object(broker, 'component_guard_query', return_value=good) as query:
            broker.component_mutation_guard('NodeRED_reader_binding')
            query.assert_called_once_with('_registered_mutation_guard', {'host': 'raspberry', 'kind': 'NodeRED_reader_binding'})

    def test_catalogue_failure_is_sanitized_and_prior_capabilities_remain(self):
        rpc = Mock(); rpc.request.return_value = {'execution_active': False}
        with patch.object(broker, 'component_guard_query', side_effect=RuntimeError('SYNTHETIC_SECRET')):
            result = broker.compose(Prior, rpc)().handle('maintenance_capabilities', {'host': 'raspberry'})
        self.assertTrue(result['evidence']['data']['prior'])
        self.assertEqual(result['evidence']['data']['protected_component_maintenance']['state'], 'unknown')
        self.assertNotIn('SYNTHETIC_SECRET', json.dumps(result))


class GuardSocket:
    def __init__(self, raw, uid=0):
        self.raw, self.uid, self.sent = raw, uid, []
    def __enter__(self): return self
    def __exit__(self, *args): pass
    def settimeout(self, value): self.timeout = value
    def connect(self, path): self.path = path
    def getsockopt(self, *args): return struct.pack('3i', 1, self.uid, 1)
    def sendall(self, data): self.sent.append(data)
    def recv(self, size):
        part, self.raw = self.raw[:size], self.raw[size:]
        return part


class GuardTransportTests(unittest.TestCase):
    def query(self, raw, uid=0, file_uid=0, mode=stat.S_IFSOCK | 0o660):
        peer = GuardSocket(raw, uid)
        self.peer = peer
        info = SimpleNamespace(st_uid=file_uid, st_mode=mode)
        with patch.object(Path, 'lstat', return_value=info), patch.object(socket, 'socket', return_value=peer) as factory:
            try:
                return broker.component_guard_query('_registered_mutation_guard', {'host': 'raspberry', 'kind': 'synthetic'})
            finally:
                self.factory = factory

    def test_valid_response_sends_one_compact_frame_and_returns_result(self):
        result = self.query(b'{"ok":true,"result":{"admission_allowed":true}}\n')
        self.assertEqual(result, {'admission_allowed': True})
        self.assertEqual(self.peer.path, '/run/raspberry-component-guard.sock')
        self.assertEqual(self.peer.timeout, 4)
        self.assertEqual(len(self.peer.sent), 1)
        self.assertEqual(self.peer.sent[0].count(b'\n'), 1)
        self.assertTrue(self.peer.sent[0].endswith(b'\n'))
        self.assertEqual(json.loads(self.peer.sent[0]), {'name': '_registered_mutation_guard', 'arguments': {'host': 'raspberry', 'kind': 'synthetic'}})
        self.factory.assert_called_once_with(socket.AF_UNIX, socket.SOCK_STREAM)

    def test_wrong_file_uid_mode_or_type_rejected_before_connect(self):
        for file_uid, mode in [(1, stat.S_IFSOCK | 0o660), (0, stat.S_IFSOCK | 0o666), (0, stat.S_IFREG | 0o660), (0, stat.S_IFLNK | 0o660)]:
            with self.subTest(uid=file_uid, mode=mode), self.assertRaisesRegex(ValueError, 'component_guard_identity_unconfirmed'):
                self.query(b'{}\n', file_uid=file_uid, mode=mode)
            self.factory.assert_not_called()
            self.assertEqual(self.peer.sent, [])

    def test_nonroot_peer_rejected_without_send(self):
        with self.assertRaisesRegex(ValueError, 'component_guard_peer_refused'):
            self.query(b'{}\n', uid=1001)
        self.assertEqual(self.peer.sent, [])

    def test_empty_eof_and_oversized_frames_rejected(self):
        for raw in (b'', b'{"ok":true}', b'x' * 16385 + b'\n'):
            with self.subTest(length=len(raw)), self.assertRaisesRegex(ValueError, 'component_guard_reply_unconfirmed'):
                self.query(raw)
            self.assertEqual(len(self.peer.sent), 1)

    def test_multiple_lines_trailing_data_and_invalid_json_rejected(self):
        for raw in (b'{}\n{}\n', b'{}\ntrailing', b'{invalid}\n'):
            with self.subTest(raw=raw), self.assertRaises(ValueError):
                self.query(raw)
            self.assertEqual(len(self.peer.sent), 1)

    def test_response_must_have_true_ok_and_dictionary_result(self):
        for value in ({'ok': False, 'result': {}}, {'ok': 1, 'result': {}}, {'ok': True, 'result': []}, {'ok': True}, []):
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, 'component_scope_reserved_or_unconfirmed'):
                self.query((json.dumps(value) + '\n').encode())
            self.assertEqual(len(self.peer.sent), 1)


if __name__ == '__main__':
    unittest.main()
