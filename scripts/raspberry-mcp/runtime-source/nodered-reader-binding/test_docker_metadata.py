"""Fixed local GET parser with synthetic socket data; no Docker connection."""
import json
import unittest
from unittest.mock import Mock, patch
import native_manager as n


def payload():
    return {'Id': '1' * 64, 'Image': 'sha256:' + '2' * 64, 'Name':'/nodered', 'State': {'Running': True},
        'NetworkSettings': {'Networks': {'docker_default': {'NetworkID': '3' * 64,
                                                           'IPAddress': '192.0.2.6'}},
                            'Ports':{'1880/tcp':[{'HostIp':'198.51.100.1','HostPort':'1880'}]}},
        'Config': {'Env': ['SYNTHETIC_PRIVATE_VALUE=not_for_export'],'Labels':dict(n.COMPOSE_LABELS)}}


def response(value=None, body=None, status=b'200 OK', extra=b''):
    body = json.dumps(payload() if value is None else value).encode() if body is None else body
    return b'HTTP/1.0 ' + status + b'\r\nContent-Length: ' + str(len(body)).encode() + \
           b'\r\n' + extra + b'\r\n' + body


class Peer:
    def __init__(self, raw):
        self.raw = raw
        self.sent = []

    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass

    def settimeout(self, value):
        self.timeout = value

    def setblocking(self, value):
        self.blocking = value

    def connect(self, address):
        self.address = address

    def sendall(self, raw):
        self.sent.append(raw)

    def recv(self, size):
        part, self.raw = self.raw[:size], self.raw[size:]
        return part


class DockerMetadata(unittest.TestCase):
    def collect(self, raw, timeout=False):
        self.peer = Peer(raw)
        self.factory = Mock(return_value=self.peer)
        selector = Mock()
        selector.select.return_value = [] if timeout else [('synthetic_ready',)]
        context = Mock(__enter__=Mock(return_value=selector), __exit__=Mock(return_value=False))
        with patch.object(n.selectors, 'DefaultSelector', return_value=context):
            return n.container_metadata(self.factory)

    def test_single_fixed_local_GET_exports_only_required_metadata(self):
        result = self.collect(response())
        self.assertEqual(self.peer.address, n.DOCKER_SOCKET)
        self.assertEqual(self.peer.sent, [n.DOCKER_REQUEST])
        self.assertEqual(self.peer.timeout, 2)
        self.assertFalse(self.peer.blocking)
        self.assertEqual(set(result), {'container_id', 'image_id', 'running', 'network_id', 'peer_ipv4','compose_service_verified','published_bindings'})
        self.assertTrue(result['compose_service_verified'])
        self.assertNotIn('Config', json.dumps(result))
        self.assertNotIn('not_for_export', json.dumps(result))
        self.assertEqual(result['container_id'], '1' * 64)
        self.factory.assert_called_once_with(n.socket.AF_UNIX, n.socket.SOCK_STREAM)

    def test_non_success_and_redirect_never_followed(self):
        for status in [b'404 Not Found', b'500 Failed', b'302 Found']:
            with self.subTest(status=status), self.assertRaisesRegex(n.Refused, 'not_success'):
                self.collect(response(status=status, extra=b'Location: https://outside.invalid/\r\n'))
            self.factory.assert_called_once()
            self.assertEqual(len(self.peer.sent), 1)

    def test_timeout_is_bounded_and_not_retried(self):
        with self.assertRaisesRegex(n.Refused, 'deadline'):
            self.collect(response(), timeout=True)
        self.factory.assert_called_once()
        self.assertEqual(len(self.peer.sent), 1)

    def test_oversize_raw_reply_and_header_refused_without_json_expansion(self):
        for raw in [b'x' * 270000, response(extra=b'X-Large: ' + b'x' * 8192 + b'\r\n')]:
            with self.subTest(length=len(raw)), self.assertRaises(n.Refused):
                self.collect(raw)

    def test_chunked_duplicate_headers_and_bad_content_length_refused(self):
        raw = response()
        cases = [response(extra=b'Transfer-Encoding: chunked\r\n'),
                 response(extra=b'Content-Length: 1\r\n'),
                 raw.replace(b'Content-Length: ', b'Content-Length: 999', 1)]
        for value in cases:
            with self.subTest(raw=value[:80]), self.assertRaises(n.Refused):
                self.collect(value)

    def test_duplicate_json_keys_and_nonfixed_networks_refused(self):
        value = payload()
        value['NetworkSettings']['Networks']['foreign'] = {}
        for raw in [response(value), response(body=b'{"Id":"one","Id":"two"}')]:
            with self.subTest(raw=raw[:100]), self.assertRaises(n.Refused):
                self.collect(raw)

    def test_missing_schema_fields_or_invalid_json_refused(self):
        for raw in [response(value={}), response(body=b'not json'), response(value={'State': []})]:
            with self.subTest(raw=raw[:100]), self.assertRaises(ValueError):
                self.collect(raw)

    def test_no_content_length_uses_eof_and_does_not_accept_trailing_response(self):
        body = json.dumps(payload()).encode()
        self.assertEqual(self.collect(b'HTTP/1.0 200 OK\r\nConnection: close\r\n\r\n' + body)['running'], True)
        with self.assertRaises(ValueError):
            self.collect(b'HTTP/1.0 200 OK\r\n\r\n' + body + b'HTTP/1.0 200 OK\r\n\r\n{}')

    def test_other_compose_service_project_path_or_name_not_verified(self):
        for key in n.COMPOSE_LABELS:
            value=payload();value['Config']['Labels'][key]='foreign'
            self.assertFalse(self.collect(response(value))['compose_service_verified'])
        value=payload();value['Name']='/other'
        self.assertFalse(self.collect(response(value))['compose_service_verified'])


if __name__ == '__main__':
    unittest.main()
