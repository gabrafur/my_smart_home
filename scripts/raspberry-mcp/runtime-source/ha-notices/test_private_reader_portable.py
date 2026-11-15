"""Portable relative-source fixtures. No credentials, store, policy or socket calls."""
import importlib.util
import json
from pathlib import Path
import struct
import sys
import types
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
HERE = Path(__file__).parent


def module(name):
    spec = importlib.util.spec_from_file_location('fixture_' + name, HERE / (name + '.py'))
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


reader = module('private_content_reader')
store = module('private_store')
server = module('private_reader_server')


class Connection:
    family = server.socket.AF_UNIX

    def __init__(self, uid, gid, arguments):
        self.uid = uid
        self.gid = gid
        self.frame = json.dumps({'arguments': arguments}).encode() + b'\n'
        self.response = None

    def getsockopt(self, *_):
        return struct.pack('3i', 42, self.uid, self.gid)

    def settimeout(self, _):
        pass

    def recv(self, _):
        result, self.frame = self.frame, b''
        return result

    def sendall(self, raw):
        self.response = json.loads(raw)


class PrivateReaderContracts(unittest.TestCase):
    def test_python_canonical_storage_reorders_nested_text_keys(self):
        original = {'text': {'title': 'Fixture title', 'message': 'Fixture body'}}
        restored = json.loads(store.canonical(original))
        self.assertEqual(list(restored['text']), ['message', 'title'])
        self.assertEqual(restored, original)

    def test_public_template_requires_internal_composition_before_private_read(self):
        self.assertIsNone(server.OPERATIONS_UID)
        with patch.object(server.sys, 'argv', ['fixture_reader']), \
                patch.object(server.sys, 'flags', types.SimpleNamespace(isolated=True, no_site=True)), \
                patch.object(server.pwd, 'getpwnam', side_effect=AssertionError('identity lookup before composition')):
            with self.assertRaisesRegex(ValueError, 'private_reader_binding_not_composed'):
                server.main()

    def test_peer_uid_and_gid_are_injected_internal_contracts(self):
        accepted = Connection(20001, 20002, {'host': 'raspberry', 'view': 'current'})
        server.serve(accepted, lambda args: {'view': args['view']}, 20001, 20002)
        self.assertEqual(accepted.response, {'ok': True, 'result': {'view': 'current'}})
        refused = Connection(20003, 20002, {'host': 'raspberry', 'view': 'current'})
        with self.assertRaisesRegex(ValueError, 'private_reader_peer_refused'):
            server.serve(refused, lambda _: self.fail('handler invoked for wrong peer'), 20001, 20002)

    def test_client_cannot_supply_paths_policy_or_execution_identity(self):
        for field, value in [('path', '../private'), ('execution_uid', 20001),
                             ('policy', {'enabled': True}), ('source_hashes', {})]:
            with self.assertRaises(ValueError):
                reader.parameters({'host': 'raspberry', 'view': 'current', field: value})

    def test_pagination_requires_original_digest(self):
        with self.assertRaisesRegex(ValueError, 'store_digest_required_for_next_page'):
            reader.parameters({'host': 'raspberry', 'view': 'current', 'offset': 1})
        with self.assertRaisesRegex(ValueError, 'content_digest_required_for_next_chunk'):
            reader.parameters({'host': 'raspberry', 'object_id': 'a' * 64,
                               'revision': 'b' * 64, 'offset': 1})

    def test_retained_current_listing_preserves_snapshot_time_and_digest(self):
        observed = '2026-01-01T00:00:00Z'
        snapshot = {'observed_at': observed, 'records': [], 'current': {}}
        loaded = {'snapshot': snapshot, 'digest': 'a' * 64, 'collection_error': None}
        result = reader.render_current({'host': 'raspberry', 'view': 'current'}, loaded,
                                       clock=lambda: 1767225610)
        self.assertEqual(result['observed_at'], observed)
        self.assertEqual(result['age_seconds'], 10)
        self.assertEqual(result['store_digest'], 'a' * 64)
        self.assertFalse(result['recovery_proven'])
        self.assertFalse(result['execution_authority'])


if __name__ == '__main__':
    unittest.main()
