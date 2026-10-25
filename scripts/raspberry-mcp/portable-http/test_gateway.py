import http.client
import importlib.util
import json
from pathlib import Path
import threading
import unittest


spec = importlib.util.spec_from_file_location('portable_gateway', Path(__file__).with_name('gateway.py'))
g = importlib.util.module_from_spec(spec)
spec.loader.exec_module(g)
TOKEN = 'a' * 64  # PRIVACY_TEST_FIXTURE


class Session:
    def __init__(self):
        self.messages = []
        self.closed = False
        self.fail = False

    def forward(self, q):
        self.messages.append(q)
        if self.fail:
            raise TimeoutError('PRIVACY_TEST_FIXTURE')
        if 'id' not in q:
            return None
        result = {'protocolVersion': g.PROTOCOL, 'capabilities': {'tools': {}}} if q['method'] == 'initialize' else {'tools': []}
        return {'jsonrpc': '2.0', 'id': q['id'], 'result': result}

    def close(self):
        self.closed = True


class GatewayTests(unittest.TestCase):
    def setUp(self):
        self.backends = []
        self.now = 100

        def factory():
            session = Session()
            self.backends.append(session)
            return session

        self.server = g.Gateway(('127.0.0.1', 0), TOKEN, factory, lambda: self.now)
        self.thread = threading.Thread(target=self.server.serve_forever,
                                       kwargs={'poll_interval': 0.01}, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(2)

    def request(self, q=None, method='POST', sid=None, headers=None, path='/mcp', raw=None):
        c = http.client.HTTPConnection(*self.server.server_address, timeout=3)
        values = {'Authorization': 'Bearer ' + TOKEN, 'Content-Type': 'application/json',
                  'Accept': 'application/json, text/event-stream'}
        if sid:
            values.update({'Mcp-Session-Id': sid, 'MCP-Protocol-Version': g.PROTOCOL})
        if headers:
            values.update(headers)
        c.request(method, path, raw if raw is not None else json.dumps(q or {}), values)
        r = c.getresponse()
        body = r.read()
        result = r.status, dict(r.getheaders()), json.loads(body) if body else None
        c.close()
        return result

    def initialize(self):
        status, headers, _ = self.request({'jsonrpc': '2.0', 'id': 1, 'method': 'initialize',
                                          'params': {'protocolVersion': g.PROTOCOL}})
        self.assertEqual(status, 200)
        return headers['Mcp-Session-Id']

    def test_authentication_and_origin_refuse_before_backend(self):
        for headers in [{'Authorization': 'Bearer rejected'}, {'Origin': 'https://example.com'}]:
            status, _, _ = self.request(headers=headers)
            self.assertIn(status, [401, 403])
        self.assertEqual(self.backends, [])

    def test_initialize_notify_discover_and_delete(self):
        sid = self.initialize()
        self.assertEqual(self.request({'jsonrpc': '2.0', 'method': 'notifications/initialized'}, sid=sid)[0], 202)
        self.assertEqual(self.request({'jsonrpc': '2.0', 'id': 'list', 'method': 'tools/list'}, sid=sid)[0], 200)
        self.assertEqual(self.request(method='GET', sid=sid)[0], 405)
        self.assertEqual(self.request(method='DELETE', sid=sid)[0], 204)
        self.assertTrue(self.backends[0].closed)
        self.assertEqual(len(self.backends[0].messages), 3)

    def test_timeout_never_replays_or_recreates_backend(self):
        sid = self.initialize()
        self.backends[0].fail = True
        q = {'jsonrpc': '2.0', 'id': 2, 'method': 'tools/call', 'params': {'name': 'codex_task_send', 'arguments': {}}}
        self.assertEqual(self.request(q, sid=sid)[0], 504)
        self.assertEqual(self.request(q, sid=sid)[0], 404)
        self.assertEqual(len(self.backends), 1)
        self.assertEqual(len(self.backends[0].messages), 2)

    def test_session_expiry_closes_without_new_backend(self):
        sid = self.initialize()
        self.now += g.SESSION_TTL + 1
        self.assertEqual(self.request({'jsonrpc': '2.0', 'id': 2, 'method': 'tools/list'}, sid=sid)[0], 404)
        self.assertTrue(self.backends[0].closed)
        self.assertEqual(len(self.backends), 1)

    def test_session_limit_and_missing_session(self):
        for _ in range(g.MAX_SESSIONS):
            self.initialize()
        self.assertEqual(self.request({'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {'protocolVersion': g.PROTOCOL}})[0], 503)
        self.assertEqual(self.request({'jsonrpc': '2.0', 'id': 2, 'method': 'tools/list'})[0], 404)

    def test_bad_protocol_or_content_type_does_not_forward(self):
        sid = self.initialize()
        q = {'jsonrpc': '2.0', 'id': 2, 'method': 'tools/list'}
        self.assertEqual(self.request(q, sid=sid, headers={'MCP-Protocol-Version': 'future'})[0], 400)
        self.assertEqual(self.request(q, sid=sid, headers={'Content-Type': 'text/plain'})[0], 415)
        self.assertEqual(len(self.backends[0].messages), 1)

    def test_arrays_duplicate_keys_nan_and_oversize_are_refused(self):
        for raw in ['[]', '{"jsonrpc":"2.0","jsonrpc":"2.0","method":"initialize","id":1}',
                    '{"jsonrpc":"2.0","method":"x","id":NaN}']:
            self.assertEqual(self.request(raw=raw)[0], 400)
        self.assertEqual(self.request(raw='x' * (g.MAX_REQUEST + 1))[0], 413)
        self.assertEqual(self.backends, [])

    def test_unknown_paths_query_and_public_bind_are_refused(self):
        for path in ['/other', '/mcp?token=redacted']:
            self.assertEqual(self.request(path=path)[0], 404)
        with self.assertRaises(g.TransportError):
            g.Gateway(('0.0.0.0', 0), TOKEN)

    def test_response_loss_does_not_cancel_a_durable_task(self):
        sid = self.initialize()
        self.server.drop(sid)
        self.assertTrue(self.backends[0].closed)
        self.assertEqual([x['method'] for x in self.backends[0].messages], ['initialize'])


if __name__ == '__main__':
    unittest.main()
