import base64
import hashlib
import http.client
import importlib.util
import json
from pathlib import Path
import threading
import unittest
from urllib.parse import parse_qs, urlencode, urlsplit


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


HERE = Path(__file__).parent
e = load('edge', HERE / 'edge.py')
g = load('gateway', HERE.parent / 'portable-http' / 'gateway.py')
CATALOG = json.loads((HERE.parent / 'portable-http' / 'catalog.template.json').read_text())
BASE = 'https://example.invalid'  # PRIVACY_TEST_FIXTURE
REDIRECT = 'https://claude.ai/api/mcp/auth_callback'
SECRET = base64.b32encode(b'0123456789abcdefghij').decode()
SALT = b'\x01' * 16
PASSPHRASE = 'correct horse'  # PRIVACY_TEST_FIXTURE
OWNER = {'salt': SALT.hex(), 'hash': e.scrypt_hash(PASSPHRASE, SALT).hex(), 'totp': SECRET}


class Backend:
    def __init__(self):
        self.messages, self.closed = [], False

    def forward(self, q):
        self.messages.append(q)
        if 'id' not in q:
            return None
        if q['method'] == 'initialize':
            result = {'protocolVersion': g.PROTOCOL, 'capabilities': {'tools': {}}}
        elif q['method'] == 'tools/list':
            result = {'tools': [{'name': t['name']} for t in CATALOG['tools']]}
        else:
            result = {'ok': True}
        return {'jsonrpc': '2.0', 'id': q['id'], 'result': result}

    def close(self):
        self.closed = True


class EdgeTests(unittest.TestCase):
    def setUp(self):
        self.now = 1_000_000.0
        self.backends = []

        def factory():
            self.backends.append(Backend())
            return self.backends[-1]

        self.gateway = g.Gateway(('127.0.0.1', 0), 'b' * 64, factory, edge_token='c' * 64)
        self.edge = e.Edge(('127.0.0.1', 0), BASE, OWNER, 'c' * 64, e.Store(None, lambda: self.now),
                           lambda: self.now, self.gateway.server_address)
        self.threads = [threading.Thread(target=s.serve_forever, kwargs={'poll_interval': 0.01}, daemon=True)
                        for s in (self.gateway, self.edge)]
        for t in self.threads:
            t.start()

    def tearDown(self):
        for s in (self.edge, self.gateway):
            s.shutdown()
            s.server_close()

    def call(self, method, path, body=None, headers=None, form=None):
        c = http.client.HTTPConnection(*self.edge.server_address, timeout=5)
        values = dict(headers or {})
        if form is not None:
            body, values['Content-Type'] = urlencode(form), 'application/x-www-form-urlencoded'
        elif body is not None:
            body, values['Content-Type'] = json.dumps(body), 'application/json'
        c.request(method, path, body, values)
        r = c.getresponse()
        raw = r.read()
        c.close()
        return r.status, dict(r.getheaders()), raw

    def code(self):
        return e.totp(SECRET, int(self.now // 30))

    def register(self):
        status, _, raw = self.call('POST', '/register', {'redirect_uris': [REDIRECT]})
        self.assertEqual(status, 201)
        return json.loads(raw)['client_id']

    def authorize(self, client_id, verifier='v' * 50, passphrase=PASSPHRASE, code=None):
        challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b'=').decode()
        form = {'client_id': client_id, 'redirect_uri': REDIRECT, 'response_type': 'code', 'state': 's1',
                'code_challenge': challenge, 'code_challenge_method': 'S256',
                'passphrase': passphrase, 'code': code or self.code()}
        return self.call('POST', '/authorize', form=form)

    def tokens(self):
        client = self.register()
        status, headers, _ = self.authorize(client)
        self.assertEqual(status, 302)
        query = parse_qs(urlsplit(headers['Location']).query)
        self.assertEqual(query['state'], ['s1'])
        status, _, raw = self.call('POST', '/token', form={
            'grant_type': 'authorization_code', 'code': query['code'][0], 'client_id': client,
            'redirect_uri': REDIRECT, 'code_verifier': 'v' * 50})
        self.assertEqual(status, 200)
        return client, json.loads(raw)

    def rpc(self, token, q, sid=None):
        headers = {'Authorization': 'Bearer ' + token, 'Accept': 'application/json, text/event-stream'}
        if sid:
            headers['Mcp-Session-Id'] = sid
        status, response, raw = self.call('POST', '/mcp', q, headers)
        return status, response, json.loads(raw) if raw else None

    def init(self, token, version='2099-01-01'):
        status, headers, body = self.rpc(token, {'jsonrpc': '2.0', 'id': 1, 'method': 'initialize',
                                                 'params': {'protocolVersion': version}})
        self.assertEqual(status, 200)
        return headers['Mcp-Session-Id']

    def test_metadata_points_to_the_public_base(self):
        _, _, raw = self.call('GET', '/.well-known/oauth-authorization-server')
        meta = json.loads(raw)
        self.assertEqual(meta['issuer'], BASE)
        self.assertEqual(meta['code_challenge_methods_supported'], ['S256'])
        _, _, raw = self.call('GET', '/.well-known/oauth-protected-resource')
        self.assertEqual(json.loads(raw)['resource'], BASE + '/mcp')

    def test_registration_only_accepts_claude_callbacks(self):
        self.assertEqual(self.call('POST', '/register', {'redirect_uris': ['https://evil.invalid/cb']})[0], 400)
        self.assertEqual(self.call('POST', '/register', {'redirect_uris': []})[0], 400)
        self.register()

    def test_full_flow_then_refresh_rotates(self):
        client, tokens = self.tokens()
        self.assertEqual(self.rpc(tokens['access_token'], {'jsonrpc': '2.0', 'id': 1, 'method': 'ping'},)[0], 404)
        status, _, raw = self.call('POST', '/token', form={'grant_type': 'refresh_token', 'client_id': client,
                                                          'refresh_token': tokens['refresh_token']})
        self.assertEqual(status, 200)
        self.assertNotEqual(json.loads(raw)['refresh_token'], tokens['refresh_token'])
        again = self.call('POST', '/token', form={'grant_type': 'refresh_token', 'client_id': client,
                                                  'refresh_token': tokens['refresh_token']})
        self.assertEqual(again[0], 400)

    def test_code_is_single_use_and_needs_the_pkce_verifier(self):
        client = self.register()
        _, headers, _ = self.authorize(client)
        code = parse_qs(urlsplit(headers['Location']).query)['code'][0]
        form = {'grant_type': 'authorization_code', 'code': code, 'client_id': client,
                'redirect_uri': REDIRECT, 'code_verifier': 'w' * 50}
        self.assertEqual(self.call('POST', '/token', form=form)[0], 400)
        form['code_verifier'] = 'v' * 50
        self.assertEqual(self.call('POST', '/token', form=form)[0], 400)  # Already consumed.

    def test_wrong_passphrase_never_locks_but_wrong_code_after_it_does(self):
        client = self.register()
        for _ in range(e.AUTHORIZE_PER_MINUTE - 1):
            self.assertEqual(self.authorize(client, passphrase='wrong')[0], 200)
        self.now += 61
        self.assertEqual(self.authorize(client)[0], 302)  # An anonymous flood cannot lock the owner out.
        self.now += 61
        for _ in range(e.LOCKOUT_FAILURES):
            self.assertEqual(self.authorize(client, code='000000')[0], 200)
            self.now += 7
        self.assertEqual(self.authorize(client)[0], 429)
        self.now += e.LOCKOUT_WINDOW + 1
        self.assertEqual(self.authorize(client)[0], 302)

    def test_non_numeric_code_is_refused_before_the_expensive_hash(self):
        client = self.register()
        self.assertEqual(self.authorize(client, code='\u00e9')[0], 200)
        self.assertEqual(self.authorize(client, code='12345')[0], 200)
        self.assertEqual(self.authorize(client)[0], 302)

    def test_authorize_attempts_are_rate_limited(self):
        client = self.register()
        for _ in range(e.AUTHORIZE_PER_MINUTE):
            self.authorize(client, passphrase='wrong')
        self.assertEqual(self.authorize(client)[0], 429)

    def test_unused_clients_are_evicted_but_used_ones_survive(self):
        client, _ = self.tokens()
        for _ in range(e.MAX_CLIENTS + 5):
            self.now += 1
            self.edge.register_limit.hits.clear()
            self.call('POST', '/register', {'redirect_uris': [REDIRECT]})
        self.assertLessEqual(len(self.edge.store.data['clients']), e.MAX_CLIENTS)
        self.assertIn(client, self.edge.store.data['clients'])
        self.assertEqual(self.call('POST', '/register', {'redirect_uris': [REDIRECT]})[0], 201)
        self.now += e.UNUSED_CLIENT_TTL + 1
        self.edge.store.prune()
        self.assertEqual(list(self.edge.store.data['clients']), [client])

    def test_reused_refresh_token_revokes_the_family(self):
        client, tokens = self.tokens()
        first = self.call('POST', '/token', form={'grant_type': 'refresh_token', 'client_id': client,
                                                  'refresh_token': tokens['refresh_token']})
        fresh = json.loads(first[2])
        self.assertEqual(self.rpc(fresh['access_token'], {'jsonrpc': '2.0', 'id': 1, 'method': 'ping'})[0], 404)
        self.call('POST', '/token', form={'grant_type': 'refresh_token', 'client_id': client,
                                          'refresh_token': tokens['refresh_token']})  # Replay.
        self.assertEqual(self.rpc(fresh['access_token'], {'jsonrpc': '2.0', 'id': 1, 'method': 'ping'})[0], 401)
        self.assertEqual(self.call('POST', '/token', form={'grant_type': 'refresh_token', 'client_id': client,
                                                           'refresh_token': fresh['refresh_token']})[0], 400)

    def test_resource_must_name_this_server(self):
        client = self.register()
        challenge = 'c' * 43
        query = {'response_type': 'code', 'code_challenge': challenge, 'code_challenge_method': 'S256',
                 'client_id': client, 'redirect_uri': REDIRECT}
        self.assertEqual(self.call('GET', '/authorize?' + urlencode(dict(query, resource='https://other.invalid/mcp')))[0], 400)
        self.assertEqual(self.call('GET', '/authorize?' + urlencode(dict(query, resource=BASE + '/mcp')))[0], 200)

    def test_authorize_page_warns_about_a_never_used_client(self):
        client = self.register()
        query = {'response_type': 'code', 'code_challenge': 'c' * 43, 'code_challenge_method': 'S256',
                 'client_id': client, 'redirect_uri': REDIRECT}
        self.assertIn(b'NUNCA autorizado', self.call('GET', '/authorize?' + urlencode(query))[2])

    def test_a_call_without_id_is_not_forwarded(self):
        _, tokens = self.tokens()
        access = tokens['access_token']
        sid = self.init(access)
        status, _, _ = self.rpc(access, {'jsonrpc': '2.0', 'method': 'tools/call',
                                         'params': {'name': 'service_health'}}, sid)
        self.assertEqual(status, 400)
        self.assertEqual(self.rpc(access, {'jsonrpc': '2.0', 'method': 'notifications/initialized'}, sid)[0], 202)

    def test_busy_edge_answers_503_instead_of_starving(self):
        for _ in range(e.MAX_CONCURRENT):
            self.assertTrue(self.edge.slots.acquire(blocking=False))
        c = http.client.HTTPConnection(*self.edge.server_address, timeout=5)
        c.request('GET', '/.well-known/oauth-authorization-server')
        self.assertEqual(c.getresponse().status, 503)
        for _ in range(e.MAX_CONCURRENT):
            self.edge.slots.release()
        self.assertEqual(self.call('GET', '/.well-known/oauth-authorization-server')[0], 200)

    def test_the_edge_key_cannot_reach_write_tools_even_directly(self):
        def direct(key, q, sid=None):
            c = http.client.HTTPConnection(*self.gateway.server_address, timeout=5)
            headers = {'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json',
                       'Accept': 'application/json, text/event-stream'}
            if sid:
                headers.update({'Mcp-Session-Id': sid, 'MCP-Protocol-Version': g.PROTOCOL})
            c.request('POST', '/mcp', json.dumps(q), headers)
            r = c.getresponse()
            raw = r.read()
            return r.status, dict(r.getheaders()), json.loads(raw) if raw else None
        status, headers, _ = direct('c' * 64, {'jsonrpc': '2.0', 'id': 1, 'method': 'initialize',
                                               'params': {'protocolVersion': g.PROTOCOL}})
        self.assertEqual(status, 200)
        sid = headers['Mcp-Session-Id']
        for name in ['change_apply', 'codex_task_create', 'project_read']:
            self.assertEqual(direct('c' * 64, {'jsonrpc': '2.0', 'id': 2, 'method': 'tools/call',
                                               'params': {'name': name}}, sid)[0], 403)
        self.assertEqual(direct('c' * 64, {'jsonrpc': '2.0', 'id': 3, 'method': 'resources/read'}, sid)[0], 403)
        self.assertEqual(direct('b' * 64, {'jsonrpc': '2.0', 'id': 4, 'method': 'tools/list'}, sid)[0], 404)
        _, _, listing = direct('c' * 64, {'jsonrpc': '2.0', 'id': 5, 'method': 'tools/list'}, sid)
        self.assertEqual({t['name'] for t in listing['result']['tools']}, g.EDGE_TOOLS)
        self.assertEqual(g.EDGE_TOOLS, e.ALLOWED_TOOLS)
        self.assertEqual([m['method'] for m in self.backends[0].messages], ['initialize', 'tools/list'])

    def test_totp_code_is_single_use(self):
        client = self.register()
        self.assertEqual(self.authorize(client)[0], 302)
        self.assertEqual(self.authorize(client)[0], 200)  # Same code replayed.

    def test_mcp_requires_a_live_token(self):
        q = {'jsonrpc': '2.0', 'id': 1, 'method': 'tools/list'}
        status, headers, _ = self.rpc('nope', q)
        self.assertEqual(status, 401)
        self.assertIn('resource_metadata', headers['WWW-Authenticate'])
        _, tokens = self.tokens()
        self.now += e.ACCESS_TTL + 1
        self.assertEqual(self.rpc(tokens['access_token'], q)[0], 401)
        self.assertEqual(self.backends, [])

    def test_only_read_only_tools_are_listed_and_callable(self):
        _, tokens = self.tokens()
        access = tokens['access_token']
        sid = self.init(access)
        self.assertEqual(self.backends[0].messages[0]['params']['protocolVersion'], g.PROTOCOL)
        _, _, reply = self.rpc(access, {'jsonrpc': '2.0', 'id': 2, 'method': 'tools/list'}, sid)
        names = {t['name'] for t in reply['result']['tools']}
        self.assertEqual(names, e.ALLOWED_TOOLS)
        for name in ['change_apply', 'operation_submit', 'codex_task_create', 'admin_action_apply', 'project_read']:
            _, _, reply = self.rpc(access, {'jsonrpc': '2.0', 'id': 3, 'method': 'tools/call',
                                            'params': {'name': name, 'arguments': {}}}, sid)
            self.assertEqual(reply['error']['message'], 'tool_not_enabled_remotely')
        status, _, reply = self.rpc(access, {'jsonrpc': '2.0', 'id': 4, 'method': 'tools/call',
                                             'params': {'name': 'service_health', 'arguments': {}}}, sid)
        self.assertEqual((status, reply['result']), (200, {'ok': True}))
        self.assertEqual([m['params']['name'] for m in self.backends[0].messages if m['method'] == 'tools/call'],
                         ['service_health'])

    def test_allowlist_is_read_only_in_the_catalog(self):
        tools = {t['name']: t for t in CATALOG['tools']}
        self.assertTrue(e.ALLOWED_TOOLS <= set(tools))
        for name in e.ALLOWED_TOOLS:
            self.assertTrue(tools[name]['annotations']['readOnlyHint'], name)
            self.assertFalse(tools[name]['annotations']['destructiveHint'], name)

    def test_unlisted_methods_are_refused_and_a_new_session_replaces_the_old(self):
        _, tokens = self.tokens()
        access = tokens['access_token']
        first = self.init(access)
        _, _, reply = self.rpc(access, {'jsonrpc': '2.0', 'id': 2, 'method': 'resources/read'}, first)
        self.assertEqual(reply['error']['message'], 'method_not_enabled_remotely')
        second = self.init(access)
        self.assertNotEqual(first, second)
        self.assertTrue(self.backends[0].closed)

    def test_bad_inputs_do_not_reach_the_backend(self):
        _, tokens = self.tokens()
        h = {'Authorization': 'Bearer ' + tokens['access_token']}
        self.assertEqual(self.call('POST', '/mcp', '[]', h)[0], 400)
        self.assertEqual(self.call('POST', '/mcp', {'jsonrpc': '2.0', 'id': 1, 'method': 'tools/list'},
                                   dict(h, **{'Mcp-Session-Id': 'x'}))[0], 400)
        self.assertEqual(self.call('GET', '/mcp')[0], 405)
        self.assertEqual(self.call('GET', '/elsewhere')[0], 404)
        self.assertEqual(self.backends, [])

    def test_authorize_rejects_unknown_clients_and_redirects(self):
        client = self.register()
        challenge = 'c' * 43
        base = {'response_type': 'code', 'code_challenge': challenge, 'code_challenge_method': 'S256'}
        for query in [dict(base, client_id='unknown', redirect_uri=REDIRECT),
                      dict(base, client_id=client, redirect_uri='https://evil.invalid/cb'),
                      dict(base, client_id=client, redirect_uri=REDIRECT, code_challenge_method='plain')]:
            self.assertEqual(self.call('GET', '/authorize?' + urlencode(query))[0], 400)
        self.assertEqual(self.call('GET', '/authorize?' + urlencode(dict(base, client_id=client, redirect_uri=REDIRECT)))[0], 200)

    def test_public_bind_and_http_base_are_refused(self):
        with self.assertRaises(ValueError):
            e.Edge(('0.0.0.0', 0), BASE, OWNER, 'c' * 64, e.Store(None))
        with self.assertRaises(ValueError):
            e.Edge(('127.0.0.1', 0), 'http://example.invalid', OWNER, 'c' * 64, e.Store(None))

    def test_store_persists_only_hashes(self):
        import tempfile
        with tempfile.TemporaryDirectory() as directory:
            store = e.Store(Path(directory) / 'store.json', lambda: self.now)
            issued = store.issue('client')
            saved = (Path(directory) / 'store.json').read_text()
            self.assertNotIn(issued['access_token'], saved)
            self.assertNotIn(issued['refresh_token'], saved)
            self.assertTrue(e.Store(Path(directory) / 'store.json', lambda: self.now).valid_access(issued['access_token']))


if __name__ == '__main__':
    unittest.main()


class ReleaseTests(unittest.TestCase):
    def test_manifest_matches_files_and_admin_hash_matches_edge(self):
        manifest = json.loads((HERE / 'release.json').read_text())
        for name, digest in manifest['files'].items():
            self.assertEqual(hashlib.sha256((HERE / name).read_bytes()).hexdigest(), digest, name)
        self.assertTrue(manifest['loopback_only'] and not manifest['automatic_activation'])
        text = (HERE / 'edge_admin.py').read_text()
        self.assertIn("n=2 ** 14, r=8, p=1, dklen=32", text)
        self.assertIn("n=2 ** 14, r=8, p=1, dklen=32".split(',')[0], (HERE / 'edge.py').read_text())
