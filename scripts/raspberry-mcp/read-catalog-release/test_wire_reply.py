"""Exercise the real broker entry point without a service or privileged access."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import struct
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('reviewed_operations', Path(__file__).with_name('operations.py'))
operations = importlib.util.module_from_spec(spec)
spec.loader.exec_module(operations)


class SyntheticSocket:
    def __init__(self):
        self.request = (json.dumps({'name': 'project_files', 'arguments': {'host': 'raspberry', 'category': 'docs', 'offset': 0}}) + '\n').encode()
        self.sent = b''

    def getsockopt(self, *args):
        return struct.pack('3i', 1, 1234, 1)

    def settimeout(self, timeout):
        self.timeout = timeout

    def recv(self, size):
        value, self.request = self.request[:size], self.request[size:]
        return value

    def sendall(self, value):
        self.sent += value


class WireReplyTests(unittest.TestCase):
    def call_main(self, result=None, failure=None):
        conn = SyntheticSocket()
        audit = io.StringIO()
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            manifest = state / 'catalog.json'
            manifest.write_text('{}')
            class Broker:
                def __init__(self, *args):
                    pass
                def handle(self, name, arguments):
                    if failure:
                        raise failure
                    return result
            with patch.object(operations, 'STATE', state), patch.object(operations, 'MANIFEST', manifest), \
                 patch.object(operations, 'Broker', Broker), patch.object(operations.socket, 'socket', return_value=conn), \
                 patch.object(operations.os, 'dup', return_value=0), patch('pwd.getpwnam') as account, \
                 contextlib.redirect_stderr(audit):
                account.return_value.pw_uid = 1234
                operations.main()
        self.assertEqual(conn.sent.count(b'\n'), 1)
        self.assertTrue(conn.sent.endswith(b'\n'))
        audit_line = audit.getvalue()
        self.assertEqual(audit_line.count('\n'), 1)
        self.assertIn(': ', audit_line)  # Audit serialization remains unchanged.
        return conn.sent, json.loads(audit_line)

    def test_large_success_round_trips_below_existing_transport_limit(self):
        result = {'rows': [123] * 15000, 'nested': {'unicode': 'ação', 'value': None}}
        wire, audit = self.call_main(result=result)
        expected = {'ok': True, 'result': result}
        self.assertEqual(json.loads(wire), expected)
        self.assertGreater(len((json.dumps(expected) + '\n').encode()), 65536)
        self.assertLess(len(wire), 65536)
        self.assertEqual(audit['outcome'], 'ok')

    def test_safe_error_round_trips(self):
        wire, audit = self.call_main(failure=ValueError('invalid_parameters'))
        self.assertEqual(json.loads(wire), {'ok': False, 'error': 'invalid_parameters'})
        self.assertEqual(audit['outcome'], 'rejected')


if __name__ == '__main__':
    unittest.main()
