"""Synthetic existing-socket frames and broker composition; no native effects."""
import copy
import importlib.util
import json
from pathlib import Path
import struct
import sys
import types
import unittest
from unittest.mock import Mock, patch

HERE = Path(__file__).parent


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, HERE / file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


control = load('binding_transport_controller', 'controller.py')
with patch.dict(sys.modules, {'controller': control}):
    server = load('binding_transport_server', 'server.py')
    client = load('binding_transport_client', 'client.py')
    broker = load('binding_transport_broker', 'broker.py')


def arguments():
    return {'host': 'raspberry', 'action': 'nodered_plan_reader_binding',
            'idempotency_key': 'nodered-peer-' + 'a' * 32}


class Peer:
    def __init__(self, raw, uid=1001):
        self.raw = raw
        self.uid = uid
        self.sent = []
        self.detached = False
        self.reads = 0

    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass

    def settimeout(self, value):
        self.timeout = value

    def getsockopt(self, *args):
        return struct.pack('3i', 123, self.uid, 1001)

    def recv(self, count, flags=0):
        self.reads += 1
        value = self.raw[:count]
        if not flags:
            self.raw = self.raw[count:]
        return value

    def sendall(self, raw):
        self.sent.append(raw)

    def connect(self, path):
        self.path = path

    def detach(self):
        self.detached = True


class Delegated(BaseException):
    pass


class Transport(unittest.TestCase):
    def setUp(self):
        self.runtime = types.SimpleNamespace(load_policy=Mock(return_value={'sealed': True}),
            previous_identity=Mock(), LEGACY_SERVER='/usr/local/lib/raspberry-mcp-storage/server.py',
            dispatch=Mock(return_value={'state': 'synthetic_plan', 'automatic_retry': False}))

    def invoke_server(self, peer, execute=None, uid=0):
        with patch.dict(sys.modules, {'runtime': self.runtime}), \
                patch.object(server.os, 'geteuid', return_value=uid), \
                patch.object(server, '__file__', '/usr/local/lib/raspberry-nodered-binding/server.py'), \
                patch.object(server.socket, 'socket', return_value=peer), \
                patch.object(server.os, 'execv', side_effect=execute or Delegated):
            server.main(self.runtime)

    def test_preparation_workspace_cannot_be_used_as_Root_entrypoint(self):
        with patch.object(server.os, 'geteuid', return_value=0), \
                patch.dict(sys.modules, {'runtime': self.runtime}):
            with self.assertRaisesRegex(ValueError, 'sealed_native_binding_entrypoint'):
                server.main()
        self.runtime.load_policy.assert_not_called()
        self.runtime.dispatch.assert_not_called()

    def test_closed_frame_dispatches_once_on_existing_socket(self):
        q = {'tool': 'admin_action_apply', **arguments()}
        raw = (json.dumps(q) + '\n').encode()
        peer = Peer(raw)
        self.invoke_server(peer)
        self.runtime.dispatch.assert_called_once_with('admin_action_apply', arguments())
        self.assertEqual(peer.raw, b'')
        self.assertEqual(json.loads(peer.sent[0])['state'], 'synthetic_plan')
        self.assertFalse(peer.detached)

    def test_unrelated_storage_and_legacy_frames_are_never_consumed_or_reinterpreted(self):
        for action in ('storage_plan_npm_logs', 'legacy_reviewed_action'):
            raw = (json.dumps({'tool': 'admin_action_apply', **arguments(), 'action': action}) + '\n').encode()
            peer = Peer(raw)
            with self.assertRaises(Delegated):
                self.invoke_server(peer)
            self.assertEqual(peer.raw, raw)
            self.assertTrue(peer.detached)
            self.runtime.dispatch.assert_not_called()
            self.runtime.previous_identity.assert_called_with({'sealed': True}, self.runtime.LEGACY_SERVER)

    def test_wrong_unprivileged_peer_or_nonroot_entry_refused_without_dispatch(self):
        peer = Peer(b'{"tool":"binding_metadata_observe","host":"raspberry"}\n', uid=1002)
        with self.assertRaisesRegex(ValueError, 'unexpected_binding_peer'):
            self.invoke_server(peer)
        with self.assertRaisesRegex(ValueError, 'root_socket_activation'):
            self.invoke_server(peer, uid=1001)
        self.runtime.dispatch.assert_not_called()

    def test_oversize_multiple_frames_and_duplicate_keys_refused(self):
        for raw in [b'x' * 4097, b'{}\n{}\n', b'{"tool":"a","tool":"b"}\n']:
            with self.subTest(raw=raw[:80]), self.assertRaises(ValueError):
                self.invoke_server(Peer(raw))
        self.runtime.dispatch.assert_not_called()

    def test_dispatch_failure_does_not_export_raw_error_or_retry(self):
        self.runtime.dispatch.side_effect = RuntimeError('private path and credential shaped detail')
        peer = Peer((json.dumps({'tool': 'admin_action_apply', **arguments()}) + '\n').encode())
        self.invoke_server(peer)
        self.assertNotIn('credential', peer.sent[0].decode().replace('credentials', ''))
        value = json.loads(peer.sent[0])
        self.assertEqual(value['state'], 'unavailable')
        self.assertFalse(value['automatic_retry'])
        self.assertIsNone(value['observed_at'])
        self.runtime.dispatch.assert_called_once()

    def test_only_enumerated_sanitized_reasons_are_visible_to_Eva(self):
        for exception, expected in [(ValueError('binding_catalogue_revoked'), 'binding_catalogue_revoked'),
                                    (ValueError('private_opaque_value'),
                                     'binding_operation_unconfirmed_inspect_existing_receipt')]:
            self.runtime.dispatch.side_effect = exception
            peer = Peer((json.dumps({'tool': 'admin_action_apply', **arguments()}) + '\n').encode())
            self.invoke_server(peer)
            self.assertEqual(json.loads(peer.sent[0])['collection_error'], expected)
        self.runtime.load_policy.assert_not_called()

    def test_client_validates_before_connect_and_uses_only_fixed_socket(self):
        peer = Peer(b'{"state":"synthetic_plan"}\n')
        with patch.object(client.socket, 'socket', return_value=peer) as constructor:
            with self.assertRaises(control.Refused):
                client.request('admin_action_apply', {**arguments(), 'path': '/free'})
            constructor.assert_not_called()
            result = client.request('admin_action_apply', arguments())
        self.assertEqual(result, {'state': 'synthetic_plan'})
        self.assertEqual(peer.path, '/run/raspberry-admin-executor.sock')
        self.assertEqual(json.loads(peer.sent[0]), {'tool': 'admin_action_apply', **arguments()})

    def test_client_rejects_bad_response_or_timeout_without_retry(self):
        for raw in [b'', b'{}\n{}\n', b'[]\n', b'x' * 32769]:
            peer = Peer(raw)
            with patch.object(client.socket, 'socket', return_value=peer) as constructor:
                with self.subTest(raw=raw[:50]), self.assertRaises(ValueError):
                    client.request('admin_action_apply', arguments())
                constructor.assert_called_once()
        peer = Peer(b'')
        peer.recv = Mock(side_effect=TimeoutError('synthetic'))
        with patch.object(client.socket, 'socket', return_value=peer) as constructor:
            with self.assertRaises(TimeoutError):
                client.request('admin_action_apply', arguments())
            constructor.assert_called_once()
            self.assertEqual(len(peer.sent), 1)

    def test_metadata_client_does_not_accept_extra_fields(self):
        with patch.object(client.socket, 'socket') as constructor:
            with self.assertRaises(ValueError):
                client.request('binding_metadata_observe', {'host': 'raspberry', 'approved': True})
            constructor.assert_not_called()


class Prior:
    def __init__(self):
        self.calls = []

    def handle(self, name, args):
        self.calls.append((name, args))
        if name == 'maintenance_capabilities':
            return {'evidence': {'data': {'original': 'preserved'}}}
        return {'legacy_name': name, 'legacy_args': args}


class BrokerComposition(unittest.TestCase):
    def setUp(self):
        catalogue = patch.object(broker, 'component_catalogue_observe', return_value={'source': 'synthetic_catalogue'})
        catalogue.start()
        self.addCleanup(catalogue.stop)

    def test_binding_only_intercepts_its_closed_family(self):
        rpc = types.SimpleNamespace(request=Mock(return_value={'state': 'synthetic'}))
        instance = broker.compose(Prior, rpc)()
        self.assertEqual(instance.handle('admin_action_apply', arguments()), {'state': 'synthetic'})
        self.assertEqual(instance.calls, [])
        rpc.request.assert_called_once_with('admin_action_apply', arguments())

    def test_events_notifications_subscriptions_and_storage_preserved(self):
        rpc = types.SimpleNamespace(request=Mock(side_effect=AssertionError('unexpected new route')))
        instance = broker.compose(Prior, rpc)()
        for name in ('events_status', 'ha_notifications', 'events_subscribe', 'codex_thread_status',
                     'admin_action_apply', 'disk_space'):
            args = {**arguments(), 'action': 'storage_plan_npm_logs'}
            self.assertEqual(instance.handle(name, args), {'legacy_name': name, 'legacy_args': args})
        self.assertEqual(len(instance.calls), 6)
        rpc.request.assert_not_called()

    def test_metadata_adds_only_closed_admission_preserving_prior_data(self):
        rpc = types.SimpleNamespace(request=Mock(return_value={'execution_active': False}))
        result = broker.compose(Prior, rpc)().handle('maintenance_capabilities', {'host': 'raspberry'})
        self.assertEqual(result['evidence']['data']['original'], 'preserved')
        self.assertEqual(result['evidence']['data']['limited_NodeRED_reader_binding_catalogue'],
                         {'execution_active': False})
        rpc.request.assert_called_once_with('binding_metadata_observe', {'host': 'raspberry'})

    def test_failed_admission_read_is_unknown_without_breaking_prior_capabilities(self):
        rpc = types.SimpleNamespace(request=Mock(side_effect=TimeoutError('private detail')))
        result = broker.compose(Prior, rpc)().handle('maintenance_capabilities', {'host': 'raspberry'})
        self.assertEqual(result['evidence']['data']['original'], 'preserved')
        admission = result['evidence']['data']['limited_NodeRED_reader_binding_catalogue']
        self.assertFalse(admission['execution_active'])
        self.assertEqual(admission['state'], 'unknown')
        self.assertNotIn('private detail', json.dumps(result))


if __name__ == '__main__':
    unittest.main()
